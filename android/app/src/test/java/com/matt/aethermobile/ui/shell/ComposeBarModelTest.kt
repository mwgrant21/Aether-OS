package com.matt.aethermobile.ui.shell

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
}
