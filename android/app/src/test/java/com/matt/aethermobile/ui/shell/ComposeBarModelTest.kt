package com.matt.aethermobile.ui.shell

import com.matt.aethermobile.ErrorKind
import com.matt.aethermobile.FlowState
import com.matt.aethermobile.protocol.ControlProtocol.SlotState
import com.matt.aethermobile.term.TerminalHost
import com.matt.aethermobile.term.TerminalHost.ComposeResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ComposeBarModelTest {
    private val flow = FlowState.Connected(30)
    private fun tab(state: SlotState) = TerminalHost.Tab("claude", "Claude", state)

    @Test fun enabledOnlyWhenRunningConnectedAndHostAccepts() {
        assertTrue(composeEnabled(tab(SlotState.RUNNING), flow, true))
        assertFalse(composeEnabled(tab(SlotState.NOT_STARTED), flow, true))
        assertFalse(composeEnabled(tab(SlotState.EXITED), flow, true))
        assertFalse(composeEnabled(tab(SlotState.RUNNING), null, true))
        assertFalse(composeEnabled(tab(SlotState.RUNNING), flow, false))
        assertFalse(composeEnabled(null, flow, true))
    }

    @Test fun enabledMirrorsKeyRowGate() {
        for (st in SlotState.values()) for (f in listOf(flow, null)) for (h in listOf(true, false)) {
            assertEquals(keysEnabled(tab(st), f, h), composeEnabled(tab(st), f, h))
        }
    }

    @Test fun clearsOnlyOnSent() {
        assertTrue(shouldClear(ComposeResult.SENT))
        assertFalse(shouldClear(ComposeResult.NOT_ACCEPTED))
        assertFalse(shouldClear(ComposeResult.TOO_LARGE))
    }

    @Test fun draftKeptThroughDropAndWipedOnlyOnLockedOrNeedsPair() {
        assertFalse(clearsDraft(flow))
        assertFalse(clearsDraft(FlowState.Connecting))
        assertFalse(clearsDraft(FlowState.Error(ErrorKind.Unreachable)))
        assertTrue(clearsDraft(FlowState.Locked()))
        assertTrue(clearsDraft(FlowState.NeedsPair()))
    }

    @Test fun secondSendWithin400msIsDropped() {
        val gate = SendGate()
        var calls = 0
        assertEquals(ComposeResult.SENT, gate.attempt(1000) { calls++; ComposeResult.SENT })
        assertEquals(null, gate.attempt(1100) { calls++; ComposeResult.SENT })
        assertEquals(1, calls)
    }

    @Test fun sendAtOrPast400msGoesThrough() {
        val gate = SendGate()
        gate.attempt(1000) { ComposeResult.SENT }
        assertEquals(ComposeResult.SENT, gate.attempt(1400) { ComposeResult.SENT })
        assertEquals(ComposeResult.SENT, gate.attempt(2000) { ComposeResult.SENT })
    }

    @Test fun emptyBarSendAfterWindowStillSendsOneEnter() {
        val gate = SendGate()
        gate.attempt(0) { ComposeResult.SENT }
        var enters = 0
        gate.attempt(500) { enters++; ComposeResult.SENT }
        assertEquals(1, enters)
    }

    @Test fun refusedSendDoesNotStartWindow() {
        val gate = SendGate()
        assertEquals(ComposeResult.NOT_ACCEPTED, gate.attempt(1000) { ComposeResult.NOT_ACCEPTED })
        assertEquals(ComposeResult.SENT, gate.attempt(1100) { ComposeResult.SENT })
    }
}
