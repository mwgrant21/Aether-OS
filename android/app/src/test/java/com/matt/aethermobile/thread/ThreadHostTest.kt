package com.matt.aethermobile.thread

import com.matt.aethermobile.protocol.ControlProtocol.PromptCloseReason
import com.matt.aethermobile.protocol.ControlProtocol.PromptInfo
import com.matt.aethermobile.protocol.ControlProtocol.PromptRisk
import com.matt.aethermobile.protocol.ControlProtocol.ThreadEvent
import com.matt.aethermobile.protocol.ControlProtocol.ThreadFrame
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadHostTest {
    private val calls = ArrayList<String>()
    private var clock = 1_000L
    private var changes = 0
    private var firstContent = 0
    private val host = ThreadHost(
        sendAttach = { calls.add("attach"); true },
        sendDetach = { calls.add("detach"); true },
        now = { clock },
        onChanged = { changes++ },
        onFirstContent = { firstContent++ },
    )

    private fun ev(id: String) = ThreadEvent.Claude(id, 1L, "t$id", false)
    private fun snap(q: Long, vararg e: ThreadEvent, attached: Boolean = true, working: Boolean = false, since: Long? = null) =
        ThreadFrame.Snap(q, attached, working, since, e.toList())
    private fun prompt(id: String, ttl: Long = 100_000) =
        ThreadFrame.Opened(PromptInfo(id, "Bash", PromptRisk.MED, "ls", ttl))

    private fun live() { host.onConnected(); host.activate(true); calls.clear() }

    @Test fun activateSendsAttachOnceAndDetachOnOff() {
        host.onConnected()
        host.activate(true); host.activate(true)
        assertEquals(listOf("attach"), calls)
        host.activate(false); host.activate(false)
        assertEquals(listOf("attach", "detach"), calls)
    }

    @Test fun activateBeforeConnectionWaitsForIt() {
        host.activate(true)
        assertTrue(calls.isEmpty())
        host.onConnected(); host.onConnected()
        assertEquals(listOf("attach"), calls)
    }

    @Test fun snapReplacesNotAppends() {
        live()
        host.onFrame(snap(1, ev("a"), ev("b"), working = true, since = 50L))
        host.onFrame(snap(2, ev("c")))
        val ui = host.snapshot()
        assertEquals(listOf("c"), ui.events.map { it.id })
        assertFalse(ui.working)
        assertNull(ui.workingSince)
    }

    @Test fun eventsAppendInOrderAndDuplicateIsIgnored() {
        live()
        host.onFrame(snap(5, ev("a")))
        host.onFrame(ThreadFrame.Events(6, listOf(ev("b"))))
        host.onFrame(ThreadFrame.Events(6, listOf(ev("b"))))
        host.onFrame(ThreadFrame.Events(5, listOf(ev("old"))))
        assertEquals(listOf("a", "b"), host.snapshot().events.map { it.id })
        assertTrue(calls.isEmpty())
    }

    @Test fun gapTriggersExactlyOneReattachAndResnapRecovers() {
        live()
        host.onFrame(snap(5, ev("a")))
        host.onFrame(ThreadFrame.Events(8, listOf(ev("x"))))
        host.onFrame(ThreadFrame.Events(9, listOf(ev("y"))))
        host.onFrame(ThreadFrame.State(10, true, 7L))
        assertEquals(listOf("attach"), calls)
        assertEquals(listOf("a"), host.snapshot().events.map { it.id })
        host.onFrame(snap(11, ev("a"), ev("x"), ev("y")))
        host.onFrame(ThreadFrame.Events(12, listOf(ev("z"))))
        assertEquals(listOf("a", "x", "y", "z"), host.snapshot().events.map { it.id })
        host.onFrame(ThreadFrame.Events(20, listOf(ev("q"))))
        assertEquals(listOf("attach", "attach"), calls) // a later gap is a new gap
    }

    @Test fun stateFollowsTheSameQRule() {
        live()
        host.onFrame(snap(1))
        host.onFrame(ThreadFrame.State(2, true, 900L))
        assertTrue(host.snapshot().working)
        assertEquals(900L, host.snapshot().workingSince)
        host.onFrame(ThreadFrame.State(2, false, null))
        assertTrue(host.snapshot().working)
        host.onFrame(ThreadFrame.State(3, false, null))
        assertFalse(host.snapshot().working)
        assertNull(host.snapshot().workingSince)
    }

    @Test fun reattachOnSameSocketDoesNotDuplicateEvents() {
        live()
        host.onFrame(snap(3, ev("a"), ev("b")))
        host.onConnected(); host.activate(true) // Activity re-sync: no second attach
        assertTrue(calls.isEmpty())
        host.onFrame(snap(4, ev("a"), ev("b"))) // desktop answers a legal re-attach with a full snap
        assertEquals(listOf("a", "b"), host.snapshot().events.map { it.id })
    }

    @Test fun coldFeedEmptyUnattachedSnapDoesNotFlashNoSession() {
        live()
        host.onFrame(snap(1, attached = false))
        assertFalse(host.snapshot().attached)
        assertFalse(host.snapshot().noSession)
        host.onFrame(snap(2, ev("a"))) // second snap (q+1) replaces the first
        val ui = host.snapshot()
        assertTrue(ui.attached)
        assertFalse(ui.noSession)
        assertNull(ui.graceEndsAtMs)
        assertEquals(1, ui.events.size)
    }

    @Test fun unattachedStandingPastGraceBecomesNoSession() {
        live()
        host.onFrame(snap(1, attached = false))
        assertEquals(1_000L + ThreadHost.NO_SESSION_GRACE_MS, host.snapshot().graceEndsAtMs)
        clock += ThreadHost.NO_SESSION_GRACE_MS - 1
        assertFalse(host.snapshot().noSession)
        clock += 1
        assertTrue(host.snapshot().noSession)
    }

    @Test fun promptsOpenCloseDedupeAndDeadline() {
        live()
        host.onFrame(snap(1))
        host.onFrame(prompt("p1", 5_000))
        clock += 1_000
        host.onFrame(prompt("p2", 9_000))
        host.onFrame(prompt("p1", 99_000)) // dedupe: first wins, order kept
        var ps = host.snapshot().prompts
        assertEquals(listOf("p1", "p2"), ps.map { it.info.id })
        assertEquals(1_000L + 5_000L, ps[0].deadlineMs)
        assertEquals(2_000L + 9_000L, ps[1].deadlineMs)
        host.onFrame(snap(2)) // a snap clears nothing else
        assertEquals(2, host.snapshot().prompts.size)
        host.onFrame(ThreadFrame.Closed("p1", PromptCloseReason.TIMEOUT))
        host.onFrame(ThreadFrame.Closed("nope", PromptCloseReason.TIMEOUT))
        ps = host.snapshot().prompts
        assertEquals(listOf("p2"), ps.map { it.info.id })
    }

    @Test fun disconnectClearsEverythingAndIgnoresLateFrames() {
        live()
        host.onFrame(snap(1, ev("a")))
        host.onFrame(prompt("p1"))
        host.onDisconnected()
        assertEquals(ThreadUi.EMPTY, host.snapshot())
        host.onFrame(snap(2, ev("late")))
        assertTrue(host.snapshot().events.isEmpty())
        assertTrue(calls.isEmpty()) // no detach on a dead socket
    }

    @Test fun deactivateDetachesClearsAndIgnoresFrames() {
        live()
        host.onFrame(snap(1, ev("a")))
        host.onFrame(prompt("p1"))
        host.activate(false)
        assertEquals(listOf("detach"), calls)
        assertEquals(ThreadUi.EMPTY, host.snapshot())
        host.onFrame(ThreadFrame.Events(2, listOf(ev("b"))))
        host.onFrame(prompt("p2"))
        assertEquals(ThreadUi.EMPTY, host.snapshot())
    }

    @Test fun framesBeforeAnyActivationAreIgnored() {
        host.onConnected()
        host.onFrame(snap(1, ev("a")))
        assertTrue(host.snapshot().events.isEmpty())
    }

    @Test fun keepsOnlyTheLast500Events() {
        live()
        host.onFrame(snap(1, *(0 until 200).map { ev("s$it") }.toTypedArray()))
        for (i in 0 until 4) host.onFrame(ThreadFrame.Events(2L + i, (0 until 100).map { ev("e$i-$it") }))
        val ids = host.snapshot().events.map { it.id }
        assertEquals(500, ids.size)
        assertEquals("s100", ids.first())
        assertEquals("e3-99", ids.last())
    }

    @Test fun firstContentFiresOnceOnFirstNonEmptySnap() {
        live()
        host.onFrame(snap(1))
        assertEquals(0, firstContent)
        host.onFrame(snap(2, ev("a")))
        host.onFrame(snap(3, ev("a"), ev("b")))
        assertEquals(1, firstContent)
    }
}
