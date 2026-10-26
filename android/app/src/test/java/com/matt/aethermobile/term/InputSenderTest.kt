package com.matt.aethermobile.term

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class InputSenderTest {
    private val frames = ArrayList<Triple<String, Long, String>>()
    private val notSent = ArrayList<Int>()
    private var linkUp = true
    private var failAfter = Int.MAX_VALUE

    private val sender = InputSender(
        send = { s, c, d ->
            if (!linkUp || frames.size >= failAfter) false else { frames.add(Triple(s, c, d)); true }
        },
        nowMs = { 0L },
        onNotSent = { notSent.add(it) },
    )

    @Test fun cseqsAreConsecutiveAndPerSlot() {
        sender.send("claude", "a"); sender.send("claude", "b"); sender.send("codex", "c"); sender.send("claude", "d")
        assertEquals(listOf(1L, 2L, 1L, 3L), frames.map { it.second })
        assertEquals(listOf("claude", "claude", "codex", "claude"), frames.map { it.first })
    }

    @Test fun resetRestartsCseqAtOne() {
        sender.send("claude", "a"); sender.send("claude", "b")
        sender.reset()
        sender.send("claude", "c")
        assertEquals(1L, frames.last().second)
    }

    @Test fun maxPasteSplitsIntoChunksOfAtMost4096BytesWithJoinedPayloadEqualInput() {
        val text = "x".repeat(8192)
        val r = sender.send("claude", text)
        assertEquals(listOf(4096, 4096), frames.map { it.third.toByteArray().size })
        assertEquals(listOf(1L, 2L), frames.map { it.second })
        assertEquals(text, frames.joinToString("") { it.third })
        assertEquals(InputSender.SendResult(2, 8192, 0), r)
    }

    @Test fun chunksNeverSplitAMultiByteCodePointOrSurrogatePair() {
        val text = "😀".repeat(2000) // 4 bytes each: 8000 bytes
        sender.send("claude", text)
        assertEquals(2, frames.size)
        assertTrue(frames.all { it.third.toByteArray().size <= 4096 })
        assertTrue(frames.all { f -> f.third.none { Character.isSurrogate(it) } || f.third.length % 2 == 0 })
        assertEquals(text, frames.joinToString("") { it.third })
        frames.clear(); sender.reset()
        val euro = "€".repeat(2700) // 3 bytes each: 8100 bytes, chunk = 1365 chars (4095 bytes)
        sender.send("claude", euro)
        assertEquals(listOf(1365, 1335), frames.map { it.third.length })
    }

    @Test fun inputOver8192BytesIsRefusedWholeAndReportedNotSent() {
        val r = sender.send("claude", "x".repeat(8193))
        assertTrue(frames.isEmpty())
        assertEquals(InputSender.SendResult(0, 0, 8193), r)
        assertEquals(listOf(8193), notSent)
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
        val r = sender.send("claude", "x".repeat(8192))
        assertEquals(InputSender.SendResult(1, 4096, 4096), r)
        assertEquals(listOf(4096), notSent)
        linkUp = true; failAfter = Int.MAX_VALUE
        sender.send("claude", "y")
        assertEquals(2L, frames.last().second) // refused frame did not burn a cseq
    }
}
