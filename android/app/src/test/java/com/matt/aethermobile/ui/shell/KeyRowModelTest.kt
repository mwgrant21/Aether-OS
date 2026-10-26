package com.matt.aethermobile.ui.shell

import com.matt.aethermobile.FlowState
import com.matt.aethermobile.protocol.ControlProtocol.SlotState
import com.matt.aethermobile.term.InputSender
import com.matt.aethermobile.term.TerminalHost.Tab
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KeyRowModelTest {
    private fun tab(state: SlotState) = Tab("claude", "Claude", state)
    private val ok = FlowState.Connected(20)

    @Test fun byteTableIsExact() {
        assertEquals("\u001b", Key.ESC.bytes)
        assertEquals("\t", Key.TAB.bytes)
        assertEquals("\u001b[A", Key.UP.bytes)
        assertEquals("\u001b[B", Key.DOWN.bytes)
        assertEquals("\u001b[C", Key.RIGHT.bytes)
        assertEquals("\u001b[D", Key.LEFT.bytes)
        assertEquals(listOf("|", "/", "-", "y", "n"), listOf(Key.PIPE, Key.SLASH, Key.DASH, Key.Y, Key.N).map { it.bytes })
        assertEquals("", Key.CTRL.bytes)
    }

    @Test fun rowListsEveryKeyOnce() {
        assertEquals(Key.values().toSet(), KEY_ORDER.toSet())
        assertEquals(Key.values().size, KEY_ORDER.size)
    }

    @Test fun enabledOnlyForConnectedRunningSlot() {
        assertTrue(keysEnabled(tab(SlotState.RUNNING), ok, true))
        assertFalse(keysEnabled(tab(SlotState.NOT_STARTED), ok, true))
        assertFalse(keysEnabled(tab(SlotState.EXITED), ok, true))
        assertFalse(keysEnabled(tab(SlotState.RUNNING), null, true)) // disconnected
        assertFalse(keysEnabled(null, ok, true)) // no such tab
    }

    @Test fun enabledNeedsTheHostGateEvenForAConnectedRunningSlot() {
        assertFalse(keysEnabled(tab(SlotState.RUNNING), ok, false)) // attach failed / not yet attached
    }

    @Test fun laterNotSentCharsDoNotKeepAStaleRefusalReason() {
        val n = NotSentNotice.NONE.add(8193).refused(InputSender.Refusal.TOO_LARGE).add(4)
        assertEquals(8197, n.chars)
        assertEquals(null, n.refusal)
    }

    @Test fun refusalAfterAddKeepsItsReason() {
        // InputSender reports the count first, then the reason.
        assertEquals(InputSender.Refusal.TOO_LARGE, NotSentNotice.NONE.add(8193).refused(InputSender.Refusal.TOO_LARGE).refusal)
    }

    @Test fun noticeAccumulatesAndRemembersRefusal() {
        val n = NotSentNotice.NONE.add(3).add(2).refused(InputSender.Refusal.TOO_LARGE)
        assertEquals(5, n.chars)
        assertEquals(InputSender.Refusal.TOO_LARGE, n.refusal)
        assertTrue(n.visible)
        assertFalse(NotSentNotice.NONE.visible)
    }
}
