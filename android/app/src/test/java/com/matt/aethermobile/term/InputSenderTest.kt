package com.matt.aethermobile.term

import com.matt.aethermobile.protocol.ControlProtocol.NakReason
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class InputSenderTest {
    private val frames = ArrayList<Triple<String, Long, String>>()
    private val notSent = ArrayList<Int>()
    private val refusals = ArrayList<InputSender.Refusal>()
    private var acks = 0
    private var linkUp = true
    private var failAfter = Int.MAX_VALUE

    private val sender = InputSender(
        send = { s, c, d ->
            if (!linkUp || frames.size >= failAfter) false else { frames.add(Triple(s, c, d)); true }
        },
        nowMs = { 0L },
        onNotSent = { notSent.add(it) },
        onRefused = { refusals.add(it) },
        onAcked = { acks++ },
    )

    @Test fun cseqsAreConsecutiveAndPerSlot() {
        sender.send("claude", "a"); sender.send("claude", "b"); sender.send("codex", "c"); sender.send("claude", "d")
        assertEquals(listOf(1L, 2L, 1L, 3L), frames.map { it.second })
        assertEquals(listOf("claude", "claude", "codex", "claude"), frames.map { it.first })
    }

    @Test fun maxPasteSplitsIntoChunksOfAtMost4096BytesWithJoinedPayloadEqualInput() {
        val text = "x".repeat(65536)
        val r = sender.send("claude", text)
        assertEquals(16, frames.size)
        assertTrue(frames.all { it.third.toByteArray().size <= 4096 })
        assertEquals((1L..16L).toList(), frames.map { it.second })
        assertEquals(text, frames.joinToString("") { it.third })
        assertEquals(InputSender.SendResult(16, 65536, 0), r)
    }

    @Test fun chunksNeverSplitAMultiByteCodePointOrSurrogatePair() {
        val text = "😀".repeat(2000) // 4 bytes each: 8000 bytes
        sender.send("claude", text)
        assertEquals(2, frames.size)
        assertTrue(frames.all { it.third.toByteArray().size <= 4096 })
        assertTrue(frames.all { f -> f.third.none { Character.isSurrogate(it) } || f.third.length % 2 == 0 })
        assertEquals(text, frames.joinToString("") { it.third })
        frames.clear()
        val euro = "€".repeat(2700) // 3 bytes each: 8100 bytes, chunk = 1365 chars (4095 bytes)
        sender.send("claude", euro)
        assertEquals(listOf(1365, 1335), frames.map { it.third.length })
        frames.clear()
        val maxEmoji = "😀".repeat(16384) // 65536 bytes
        assertEquals(16, sender.send("claude", maxEmoji).frames)
        assertTrue(frames.all { it.third.toByteArray().size <= 4096 && it.third.codePointCount(0, it.third.length) == 1024 })
        assertEquals(maxEmoji, frames.joinToString("") { it.third })
        frames.clear()
        val maxEuro = "€".repeat(21845) // 65535 bytes, 1365 chars (4095 bytes) per chunk: 17 frames
        assertEquals(17, sender.send("claude", maxEuro).frames)
        assertTrue(frames.all { it.third.toByteArray().size <= 4096 })
        assertEquals(maxEuro, frames.joinToString("") { it.third })
    }

    @Test fun inputOver65536BytesIsRefusedWholeAndReportedNotSent() {
        val r = sender.send("claude", "x".repeat(65537))
        assertTrue(frames.isEmpty())
        assertEquals(InputSender.SendResult(0, 0, 65537), r)
        assertEquals(listOf(65537), notSent)
        assertEquals(listOf(InputSender.Refusal.TOO_LARGE), refusals)
    }

    @Test fun maxPasteLeavesRoomForTwoMoreInTheDesktopRateWindow() {
        val limits = JSONObject(File("../../protocol/mobile-protocol.json").readText(Charsets.UTF_8)).getJSONObject("limits")
        val framesPerPaste = (InputSender.MAX_INPUT_BYTES + InputSender.CHUNK_BYTES - 1) / InputSender.CHUNK_BYTES
        assertTrue(framesPerPaste * 3 <= limits.getInt("inputMaxFramesPerSec"))
        assertTrue(InputSender.MAX_INPUT_BYTES.toLong() * 3 <= limits.getLong("inputMaxBytesPerSec"))
    }

    @Test fun inputWithALoneSurrogateIsRefusedAndNothingIsSent() {
        for (bad in listOf("ab\uD800", "\uDC00x", "\uD800\uD800")) {
            val r = sender.send("claude", bad)
            assertEquals(bad.length, r.notSentChars)
        }
        assertTrue(frames.isEmpty())
        assertEquals(3, notSent.size)
        assertEquals(1, run { sender.send("claude", "ok"); frames.single().second.toInt() }) // cseq not consumed by refusals
    }

    @Test fun ackClearsPendingSoDisconnectReportsNothing() {
        sender.send("claude", "abc"); sender.send("claude", "de")
        sender.onAck("claude", 2)
        sender.onDisconnected()
        assertTrue(notSent.isEmpty())
    }

    @Test fun ackIsCumulativeAndPerSlot() {
        sender.send("claude", "abc"); sender.send("claude", "de"); sender.send("codex", "f")
        sender.onAck("claude", 1)
        sender.onDisconnected()
        assertEquals(listOf(3), notSent) // claude c=2 (2 chars) + codex c=1 (1 char)
    }

    @Test fun disconnectWithTwoUnackedFramesReportsCharsAndNeverResends() {
        sender.send("claude", "abc"); sender.send("claude", "de")
        sender.onDisconnected()
        assertEquals(listOf(5), notSent)
        assertEquals(5, sender.unsentChars())
        val n = frames.size
        sender.onDisconnected()
        assertEquals(n, frames.size)
        assertEquals(listOf(5), notSent)
    }

    @Test fun linkRefusingAFrameStopsTheSendAndCountsTheRemainderNotSent() {
        failAfter = 1
        val r = sender.send("claude", "x".repeat(65536))
        assertEquals(InputSender.SendResult(1, 4096, 61440), r)
        assertEquals(listOf(61440), notSent)
        linkUp = true; failAfter = Int.MAX_VALUE
        sender.send("claude", "y")
        assertEquals(2L, frames.last().second) // refused frame did not burn a cseq
    }

    @Test fun refusalReportsItsReason() {
        sender.send("claude", "x".repeat(65537))
        sender.send("claude", "a" + 0xD83D.toChar())
        sender.send("claude", "ok")
        assertEquals(listOf(InputSender.Refusal.TOO_LARGE, InputSender.Refusal.LONE_SURROGATE), refusals)
    }

    @Test fun ackNotifiesOnlyWhenItRetiresAPendingFrame() {
        sender.send("claude", "abc")
        sender.onAck("claude", 1)
        sender.onAck("claude", 1)
        sender.onAck("codex", 5)
        assertEquals(1, acks)
    }

    @Test fun nakRemovesExactlyThatChunkAndReportsReasonThenCountNeverAnAck() {
        sender.send("claude", "abc"); sender.send("claude", "de")
        sender.onNak("claude", 2, NakReason.NOT_RUNNING)
        assertEquals(listOf(InputSender.Refusal.NOT_RUNNING), refusals)
        assertEquals(listOf(2), notSent)
        assertEquals(0, acks)
        assertEquals(2, sender.unsentChars())
        sender.onDisconnected()
        assertEquals(listOf(2, 3), notSent) // chunk 1 only; chunk 2 is not counted again
    }

    @Test fun nakMapsTypingOffAndIgnoresAnUnknownCseq() {
        sender.send("claude", "abc")
        sender.onNak("claude", 9, NakReason.TYPING_OFF)
        sender.onNak("codex", 1, NakReason.TYPING_OFF)
        assertTrue(refusals.isEmpty() && notSent.isEmpty())
        sender.onNak("claude", 1, NakReason.TYPING_OFF)
        assertEquals(listOf(InputSender.Refusal.TYPING_OFF), refusals)
        sender.onNak("claude", 1, NakReason.TYPING_OFF) // replay: already settled
        assertEquals(listOf(3), notSent)
    }

    @Test fun cseqKeepsAdvancingAfterANakAndALaterAckClearsOnlyTheOthers() {
        sender.send("claude", "a"); sender.send("claude", "bb"); sender.send("claude", "ccc")
        sender.onNak("claude", 2, NakReason.NOT_RUNNING)
        sender.send("claude", "d")
        assertEquals(listOf(1L, 2L, 3L, 4L), frames.map { it.second })
        sender.onAck("claude", 3)
        assertEquals(1, acks)
        sender.onDisconnected()
        assertEquals(listOf(2, 1), notSent) // nak'd chunk, then only the unacked c=4
        assertEquals(3, sender.unsentChars())
    }
}
