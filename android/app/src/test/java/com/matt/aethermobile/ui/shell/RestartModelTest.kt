package com.matt.aethermobile.ui.shell

import com.matt.aethermobile.FlowState
import com.matt.aethermobile.protocol.ControlProtocol.SlotState
import com.matt.aethermobile.term.TerminalHost
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class RestartModelTest {
    private val flow = FlowState.Connected(30)

    @Test fun visibleOnlyForExitedTerminal2() {
        for (s in listOf("claude", "terminal2", "codex")) for (st in SlotState.values()) {
            val want = s == "terminal2" && st == SlotState.EXITED
            assertEquals("$s $st", want, restartVisible(TerminalHost.Tab(s, s, st), flow, true))
        }
        val t2 = TerminalHost.Tab("terminal2", "T2", SlotState.EXITED)
        assertFalse(restartVisible(t2, null, true))
        assertFalse(restartVisible(null, flow, true))
        assertFalse(restartVisible(t2, flow, false))
    }

    @Test fun doubleTapWithinWindowRestartsOnce() {
        val gate = SendGate()
        var n = 0
        val go = { n++; true }
        assertEquals(true, attemptRestart(gate, 1000, go)); assertEquals(1, n)
        assertNull(attemptRestart(gate, 1399, go)); assertEquals(1, n)
        assertEquals(true, attemptRestart(gate, 1400, go)); assertEquals(2, n)
    }

    @Test fun refusedRestartDoesNotStartTheWindow() {
        val gate = SendGate()
        var n = 0
        val no = { n++; false }
        assertEquals(false, attemptRestart(gate, 1000, no))
        assertEquals(false, attemptRestart(gate, 1001, no))
        assertEquals(2, n)
    }
}
