package com.matt.aethermobile.ui.shell

import com.matt.aethermobile.FlowState
import com.matt.aethermobile.protocol.ControlProtocol.SlotState
import com.matt.aethermobile.term.TerminalHost.Tab
import com.matt.aethermobile.ui.components.DotStyle
import com.matt.aethermobile.ui.thread.ThreadViewMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ShellModelTest {
    private fun tab(state: SlotState, awaiting: Boolean = false, s: String = "a") = Tab(s, "L-$s", state, awaiting)
    private val ok = FlowState.Connected(20)
    private val warn = FlowState.Connected(FlowState.WARN_DAYS)

    @Test fun notStartedBeatsAwaitingOutput() {
        assertEquals(StatusLine.NotStarted, statusFor(tab(SlotState.NOT_STARTED, awaiting = true), ok))
    }

    @Test fun exitedBeatsAwaitingOutput() {
        assertEquals(StatusLine.Exited, statusFor(tab(SlotState.EXITED, awaiting = true), warn))
    }

    @Test fun runningAwaitingOutputWinsOverDaysEvenWhenWarn() {
        assertEquals(StatusLine.AwaitingOutput, statusFor(tab(SlotState.RUNNING, awaiting = true), warn))
    }

    @Test fun runningNotAwaitingShowsDays() {
        assertEquals(StatusLine.Days(20, false), statusFor(tab(SlotState.RUNNING), ok))
        assertEquals(StatusLine.Days(FlowState.WARN_DAYS, true), statusFor(tab(SlotState.RUNNING), warn))
    }

    @Test fun noSlotButConnectedShowsDays() {
        assertEquals(StatusLine.Days(20, false), statusFor(null, ok))
    }

    @Test fun notConnectedShowsNothingUnlessSlotSaysSo() {
        assertEquals(StatusLine.None, statusFor(null, null))
        assertEquals(StatusLine.None, statusFor(tab(SlotState.RUNNING), null))
        assertEquals(StatusLine.Exited, statusFor(tab(SlotState.EXITED), null))
    }

    @Test fun amberOnlyForWarnAndRunning() {
        assertTrue(amber(tab(SlotState.RUNNING), warn))
        assertTrue(amber(tab(SlotState.RUNNING, awaiting = true), warn))
        assertFalse(amber(tab(SlotState.EXITED), warn))
        assertFalse(amber(tab(SlotState.NOT_STARTED), warn))
        assertFalse(amber(tab(SlotState.RUNNING), ok))
        assertFalse(amber(null, warn))
        assertFalse(amber(tab(SlotState.RUNNING), null))
    }

    @Test fun slotRowsEmptyTabsGiveNoRows() {
        assertTrue(slotRows(emptyList(), "a").isEmpty())
    }

    @Test fun slotRowsUnknownSelectedMarksNothing() {
        val tabs = listOf(tab(SlotState.RUNNING, s = "a"), tab(SlotState.EXITED, s = "b"))
        val rows = slotRows(tabs, "zz")
        assertEquals(listOf("a", "b"), rows.map { it.s })
        assertEquals(listOf(false, false), rows.map { it.selected })
    }

    @Test fun slotRowsMarkSelectedAndDotPerState() {
        val rows = slotRows(
            listOf(tab(SlotState.RUNNING, s = "a"), tab(SlotState.NOT_STARTED, s = "b"), tab(SlotState.EXITED, s = "c")),
            "b",
        )
        assertEquals(listOf(false, true, false), rows.map { it.selected })
        assertEquals(listOf(DotStyle.LiveGlow, DotStyle.HollowRing, DotStyle.Flat), rows.map { it.dot })
        assertEquals(listOf(SlotText.Running, SlotText.NotStarted, SlotText.Exited), rows.map { it.text })
    }

    @Test fun titleAndCoreFollowTabs() {
        val tabs = listOf(tab(SlotState.NOT_STARTED, s = "a"), tab(SlotState.RUNNING, s = "b"))
        assertEquals("L-b", titleFor(tabs, "b"))
        assertEquals("", titleFor(tabs, "zz"))
        assertTrue(anyRunning(tabs))
        assertFalse(anyRunning(tabs.take(1)))
    }

    @Test fun menuTransitions() {
        val closed = MenuState()
        val open = closed.onBurger()
        assertTrue(open.open)
        assertFalse(open.onBurger().open)
        assertFalse(open.onSelectSlot().open)
        assertFalse(open.onLock().open)
        assertFalse(open.onBack().open)
        assertFalse(open.onScrim().open)
        assertFalse(closed.onBack().open)
    }

    private val withThread = setOf("thread")

    @Test fun codexAlwaysTermWithNoSwitch() {
        assertFalse(showSwitch("codex"))
        assertTrue(showSwitch("claude") && showSwitch("terminal2"))
        assertEquals(ThreadViewMode.TERM, viewModeFor("codex", withThread, true, ThreadViewMode.THREAD))
        assertFalse(threadWanted("codex", withThread, null))
    }

    @Test fun missingThreadCapMeansTerm() {
        assertEquals(ThreadViewMode.TERM, viewModeFor("claude", emptySet(), true, null))
        assertFalse(threadWanted("claude", emptySet(), null))
    }

    @Test fun unavailableThreadMeansTermButStaysWanted() {
        assertEquals(ThreadViewMode.TERM, viewModeFor("claude", withThread, false, null))
        assertTrue(threadWanted("claude", withThread, null))
    }

    @Test fun choiceIsPerSlotAndDefaultsToThread() {
        assertEquals(ThreadViewMode.THREAD, viewModeFor("claude", withThread, true, null))
        assertEquals(ThreadViewMode.TERM, viewModeFor("claude", withThread, true, ThreadViewMode.TERM))
        assertEquals(ThreadViewMode.THREAD, viewModeFor("terminal2", withThread, true, null))
        assertFalse(threadWanted("claude", withThread, ThreadViewMode.TERM))
        assertTrue(threadWanted("terminal2", withThread, null))
    }

    @Test fun terminal2UnavailableWithTermChoiceIsTermAndDetached() {
        assertEquals(ThreadViewMode.TERM, viewModeFor("terminal2", withThread, false, ThreadViewMode.TERM))
        assertFalse(threadWanted("terminal2", withThread, ThreadViewMode.TERM))
    }

    @Test fun threadAssumedReadableUntilFirstSnapshot() {
        assertTrue(threadAvail(com.matt.aethermobile.thread.ThreadState()))
    }
}
