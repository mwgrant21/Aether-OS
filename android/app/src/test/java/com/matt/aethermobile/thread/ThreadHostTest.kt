package com.matt.aethermobile.thread

import com.matt.aethermobile.protocol.ControlProtocol
import com.matt.aethermobile.protocol.ControlProtocol.SessionInfo
import com.matt.aethermobile.protocol.ControlProtocol.SlotState
import com.matt.aethermobile.protocol.ControlProtocol.ThreadEntry
import com.matt.aethermobile.protocol.ControlProtocol.ThreadFrame
import com.matt.aethermobile.protocol.ControlProtocol.ThreadMeta
import com.matt.aethermobile.protocol.ControlProtocol.ToolState
import com.matt.aethermobile.protocol.ControlProtocol.Why
import com.matt.aethermobile.protocol.ControlProtocol.Work
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadHostTest {
    private val calls = ArrayList<String>()
    private val changed = ArrayList<String>()
    private var sendOk = true
    private val host = ThreadHost(
        attach = { calls += "attach $it"; sendOk },
        detach = { calls += "detach $it"; sendOk },
        get = { s, id -> calls += "get $s $id"; sendOk },
        onChanged = { changed += it },
    )

    private val caps = setOf(ControlProtocol.CAP_THREAD)
    private val sessions = listOf("claude", "terminal2", "codex").map { SessionInfo(it, it, SlotState.RUNNING, 80, 24, 0) }

    private fun meta(tok: Long? = null) = ThreadMeta(null, null, Work.IDLE, null, tok, null, null)
    private fun user(id: String, x: String = "hi") = ThreadEntry.User(id, 0, x, false)
    private fun tool(id: String, st: ToolState = ToolState.RUN) = ThreadEntry.Tool(id, 0, "Bash", "ls", st, null, true)
    private fun snap(q: Long, vararg e: ThreadEntry, s: String = "claude", avail: Boolean = true, why: Why? = null) =
        ThreadFrame.Snap(s, q, avail, why, e.toList(), meta())
    private fun detail(id: String, x: String? = "out", input: String? = "in") = ThreadFrame.Detail("claude", id, input, 0, x, 0)

    private fun attached(slot: String = "claude") {
        host.onSessions(caps, sessions)
        host.select(slot)
    }

    @Test fun snapshotReplacesThenAddsAppendInOrder() {
        attached()
        host.onFrame(snap(5, user("1:0"), user("2:0")))
        host.onFrame(ThreadFrame.Add("claude", 6, user("3:0")))
        host.onFrame(ThreadFrame.Add("claude", 7, user("4:0")))
        assertEquals(listOf("1:0", "2:0", "3:0", "4:0"), host.state("claude").entries.map { it.id })
        host.onFrame(snap(20, user("9:0")))
        assertEquals(listOf("9:0"), host.state("claude").entries.map { it.id })
    }

    @Test fun addWithExistingIdReplacesInPlaceAndDuplicateQIsDropped() {
        attached()
        host.onFrame(snap(5, user("1:0", "a"), user("2:0")))
        host.onFrame(ThreadFrame.Add("claude", 6, user("1:0", "b")))
        assertEquals(listOf("1:0", "2:0"), host.state("claude").entries.map { it.id })
        assertEquals("b", (host.state("claude").entries[0] as ThreadEntry.User).x)
        host.onFrame(ThreadFrame.Add("claude", 6, user("3:0")))
        assertEquals(2, host.state("claude").entries.size)
    }

    @Test fun updReplacesInPlaceAndUnknownIdIsIgnored() {
        attached()
        host.onFrame(snap(5, user("1:0"), tool("2:0")))
        host.onFrame(ThreadFrame.Upd("claude", 6, tool("2:0", ToolState.OK)))
        host.onFrame(ThreadFrame.Upd("claude", 7, tool("0:0", ToolState.OK)))
        val e = host.state("claude").entries
        assertEquals(2, e.size)
        assertEquals(ToolState.OK, (e[1] as ThreadEntry.Tool).st)
    }

    @Test fun metaReplacesMeta() {
        attached()
        host.onFrame(snap(1))
        host.onFrame(ThreadFrame.Meta("claude", meta(tok = 900)))
        assertEquals(900L, host.state("claude").meta?.tok)
    }

    @Test fun unavailableSnapshotIsKept() {
        attached()
        host.onFrame(snap(1, avail = false, why = Why.NO_SESSION))
        assertFalse(host.state("claude").avail)
        assertEquals(Why.NO_SESSION, host.state("claude").why)
    }

    @Test fun entriesAreCappedAtTheNewestMax() {
        attached()
        val max = ThreadState.MAX_ENTRIES
        host.onFrame(snap(0, *Array(200) { user("$it:0") }))
        for (i in 200 until max + 50) host.onFrame(ThreadFrame.Add("claude", (i - 199).toLong(), user("$i:0")))
        val e = host.state("claude").entries
        assertEquals(max, e.size)
        assertEquals("50:0", e.first().id)
        assertEquals("${max + 49}:0", e.last().id)
    }

    @Test fun gapTriggersExactlyOneReattachAndSnapshotResets() {
        attached()
        host.onFrame(snap(5, user("1:0")))
        calls.clear()
        host.onFrame(ThreadFrame.Add("claude", 9, user("2:0")))
        host.onFrame(ThreadFrame.Add("claude", 10, user("3:0")))
        assertEquals(listOf("attach claude"), calls)
        assertEquals(1, host.state("claude").entries.size)
        host.onFrame(snap(10, user("1:0"), user("2:0"), user("3:0")))
        assertEquals(3, host.state("claude").entries.size)
        host.onFrame(ThreadFrame.Add("claude", 11, user("4:0")))
        assertEquals(4, host.state("claude").entries.size)
        assertEquals(listOf("attach claude"), calls)
    }

    @Test fun addBeforeFirstSnapshotDoesNotReattach() {
        attached()
        calls.clear()
        host.onFrame(ThreadFrame.Add("claude", 1, user("1:0")))
        assertTrue(calls.isEmpty())
        assertTrue(host.state("claude").entries.isEmpty())
    }

    @Test fun detailRequestIsOneInFlightQueuedAndMatchedById() {
        attached()
        host.onFrame(snap(1, tool("1:0"), tool("2:0")))
        calls.clear()
        host.requestDetail("claude", "1:0")
        host.requestDetail("claude", "2:0")
        host.requestDetail("claude", "1:0")
        assertEquals(listOf("get claude 1:0"), calls)
        assertEquals(DetailState.Loading, host.state("claude").details["1:0"])
        host.onFrame(detail("2:0"))
        assertEquals(DetailState.Loading, host.state("claude").details["2:0"])
        host.onFrame(detail("1:0", x = "one"))
        assertEquals(DetailState.Ready("in", 0, "one", 0), host.state("claude").details["1:0"])
        assertEquals(listOf("get claude 1:0", "get claude 2:0"), calls)
        host.onFrame(detail("2:0", x = null, input = null))
        assertEquals(DetailState.Unavailable, host.state("claude").details["2:0"])
    }

    @Test fun cachedDetailIsNotRequestedAgainAndUnsolicitedReplyIsIgnored() {
        attached()
        host.onFrame(snap(1, tool("1:0")))
        host.onFrame(detail("1:0"))
        assertNull(host.state("claude").details["1:0"])
        host.requestDetail("claude", "1:0")
        host.onFrame(detail("1:0"))
        calls.clear()
        host.requestDetail("claude", "1:0")
        host.onFrame(detail("1:0", x = "changed"))
        assertTrue(calls.isEmpty())
        assertEquals("out", (host.state("claude").details["1:0"] as DetailState.Ready).text)
    }

    @Test fun failedSendLeavesNoPendingDetail() {
        attached()
        host.onFrame(snap(1, tool("1:0")))
        sendOk = false
        host.requestDetail("claude", "1:0")
        assertNull(host.state("claude").details["1:0"])
    }

    @Test fun toggleExpandedFlipsOnlyKnownIds() {
        attached()
        host.onFrame(snap(1, tool("1:0")))
        host.toggleExpanded("claude", "1:0")
        host.toggleExpanded("claude", "9:9")
        assertEquals(setOf("1:0"), host.state("claude").expanded)
        host.toggleExpanded("claude", "1:0")
        assertTrue(host.state("claude").expanded.isEmpty())
    }

    @Test fun attachOnSelectDetachOnLeaveAndSwitchClearsThePreviousSlot() {
        host.onSessions(caps, sessions)
        host.select("claude")
        host.onFrame(snap(1, user("1:0")))
        host.select("terminal2")
        assertEquals(listOf("attach claude", "detach claude", "attach terminal2"), calls)
        assertTrue(host.state("claude").entries.isEmpty())
        host.select(null)
        assertEquals("detach terminal2", calls.last())
    }

    @Test fun selectingTheAttachedSlotAgainDoesNothing() {
        attached()
        calls.clear()
        host.select("claude")
        assertTrue(calls.isEmpty())
    }

    @Test fun codexAndUnknownSlotsNeverAttach() {
        host.onSessions(caps, sessions)
        host.select("codex")
        host.select("nope")
        assertTrue(calls.isEmpty())
    }

    @Test fun missingThreadCapNeverAttaches() {
        host.onSessions(emptySet(), sessions)
        host.select("claude")
        assertTrue(calls.isEmpty())
    }

    @Test fun slotMissingFromSessionsNeverAttaches() {
        host.onSessions(caps, sessions.filter { it.s != "terminal2" })
        host.select("terminal2")
        assertTrue(calls.isEmpty())
    }

    @Test fun framesForAnotherSlotAreIgnored() {
        attached()
        host.onFrame(snap(1, user("1:0"), s = "terminal2"))
        assertTrue(host.state("terminal2").entries.isEmpty())
    }

    @Test fun selectBeforeSessionsAttachesOnSessions() {
        host.select("claude")
        assertTrue(calls.isEmpty())
        host.onSessions(caps, sessions)
        assertEquals(listOf("attach claude"), calls)
    }

    @Test fun disconnectClearsEverythingAndIgnoresLateFrames() {
        attached()
        host.onFrame(snap(1, tool("1:0")))
        host.requestDetail("claude", "1:0")
        host.onFrame(detail("1:0", x = "secret"))
        host.toggleExpanded("claude", "1:0")
        host.onDisconnected()
        assertEquals(ThreadState(), host.state("claude"))
        host.onFrame(snap(2, user("1:0", "late")))
        host.onFrame(detail("1:0", x = "late"))
        assertEquals(ThreadState(), host.state("claude"))
    }

    @Test fun reconnectReattachesTheWantedSlotWithNoStaleState() {
        attached()
        host.onFrame(snap(1, user("1:0")))
        host.onDisconnected()
        calls.clear()
        host.onSessions(caps, sessions)
        assertEquals(listOf("attach claude"), calls)
        assertTrue(host.state("claude").entries.isEmpty())
        host.onFrame(snap(1, user("2:0")))
        assertEquals(listOf("2:0"), host.state("claude").entries.map { it.id })
    }

    @Test fun leavingBeforeDisconnectMeansNoReattachOnReconnect() {
        attached()
        host.select(null)
        host.onDisconnected()
        calls.clear()
        host.onSessions(caps, sessions)
        assertTrue(calls.isEmpty())
    }

    @Test fun throwingCallbacksNeverEscape() {
        val h = ThreadHost({ error("x") }, { error("x") }, { _, _ -> error("x") }, { error("x") })
        h.onSessions(caps, sessions)
        h.select("claude")
        h.onFrame(snap(1))
    }
}
