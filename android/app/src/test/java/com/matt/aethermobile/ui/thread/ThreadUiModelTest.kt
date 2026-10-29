package com.matt.aethermobile.ui.thread

import com.matt.aethermobile.protocol.ControlProtocol.PromptCloseReason
import com.matt.aethermobile.protocol.ControlProtocol.PromptInfo
import com.matt.aethermobile.protocol.ControlProtocol.PromptRisk
import com.matt.aethermobile.protocol.ControlProtocol.ThreadEvent
import com.matt.aethermobile.protocol.ControlProtocol.ThreadFrame
import com.matt.aethermobile.thread.PromptUi
import com.matt.aethermobile.thread.ThreadHost
import com.matt.aethermobile.thread.ThreadUi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadUiModelTest {
    private fun ui(
        vararg e: ThreadEvent, attached: Boolean = true, working: Boolean = false, since: Long? = null,
        noSession: Boolean = false, graceEnds: Long? = null,
    ) = ThreadUi(e.toList(), attached, working, since, emptyList(), noSession, graceEnds)

    private fun tool(name: String, target: String?, add: Long?, del: Long?) = ThreadEvent.Tool("t", 1L, name, target, add, del)

    @Test fun rowsMapEachEventKindInOrderWithKeys() {
        val rows = threadRows(
            ui(ThreadEvent.User("1:0", 1L, "hi", true), ThreadEvent.Claude("2:0", 2L, "yo", false), ThreadEvent.Tool("3:0", 3L, "Bash", null, null, null)),
            0L,
        )
        assertEquals(listOf("1:0", "2:0", "3:0"), rows.map { it.key })
        assertEquals(ThreadRow.User("1:0", "hi", true), rows[0])
        assertEquals(ThreadRow.Claude("2:0", "yo", false), rows[1])
        assertEquals(ThreadRow.Tool("3:0", "Bash"), rows[2])
    }

    @Test fun toolTextWithAndWithoutTargetAndCounts() {
        assertEquals("Edit KeyRow.kt · +18 −4", toolText(tool("Edit", "KeyRow.kt", 18, 4)))
        assertEquals("Write notes.md · +12", toolText(tool("Write", "notes.md", 12, null)))
        assertEquals("Edit a.kt · −3", toolText(tool("Edit", "a.kt", null, 3)))
        assertEquals("Read TerminalWebView.kt", toolText(tool("Read", "TerminalWebView.kt", null, null)))
        assertEquals("Bash", toolText(tool("Bash", null, null, null)))
        assertEquals("Bash", toolText(tool("Bash", "  ", null, null)))
        assertEquals("Bash · +1 −0", toolText(tool("Bash", null, 1, 0)))
    }

    @Test fun workingRowOnlyWhenWorkingAndSecondsFloor() {
        assertTrue(threadRows(ui(working = false, since = 0L), 5_000L).isEmpty())
        val ev = ThreadEvent.Claude("1:0", 1L, "x", false)
        assertEquals(ThreadRow.Working(1), threadRows(ui(ev, working = true, since = 0L), 1_999L).last())
        assertEquals(ThreadRow.Working(2), threadRows(ui(ev, working = true, since = 0L), 2_000L).last())
        assertEquals(ThreadRow.Working(0), threadRows(ui(ev, working = true, since = 9_000L), 2_000L).last())
        assertEquals(ThreadRow.Working(null), threadRows(ui(ev, working = true, since = null), 2_000L).last())
        assertEquals(2, threadRows(ui(ev, working = true, since = 0L), 0L).size)
    }

    @Test fun emptyStatesFollowNoSessionNotAttached() {
        assertNull(emptyStateFor(ui(ThreadEvent.Claude("1:0", 1L, "x", false), noSession = true)))
        assertEquals(ThreadEmpty.NoSession, emptyStateFor(ui(attached = false, noSession = true)))
        assertEquals(ThreadEmpty.Waiting, emptyStateFor(ui(attached = false, noSession = false)))
        assertEquals(ThreadEmpty.Waiting, emptyStateFor(ui(attached = true)))
    }

    @Test fun duplicateEventIdsGetUniqueKeys() {
        val e = { ThreadEvent.Claude("5:0", 1L, "x", false) }
        val keys = threadRows(ui(e(), e(), e()), 0L).map { it.key }
        assertEquals(listOf("5:0", "5:0#2", "5:0#3"), keys)
    }

    @Test fun graceDelayIsRemainingTimeOrNull() {
        assertNull(graceRerenderDelayMs(ui(), 3_500L))
        assertEquals(1_500L, graceRerenderDelayMs(ui(graceEnds = 5_000L), 3_500L))
        assertEquals(1L, graceRerenderDelayMs(ui(graceEnds = 5_000L), 5_000L))
        assertNull(graceRerenderDelayMs(ui(graceEnds = 5_000L, noSession = true), 5_000L))
    }

    @Test fun graceRerenderFiresExactlyWhenSnapshotFlips() {
        var clock = 0L
        val host = ThreadHost(sendAttach = { true }, sendDetach = { true }, now = { clock })
        host.onConnected(); host.activate(true)
        clock = 10_000L
        host.onFrame(ThreadFrame.Snap(1, false, false, null, emptyList()))
        var s = host.snapshot()
        assertEquals(false, s.noSession)
        assertEquals(2_000L, graceRerenderDelayMs(s, clock))
        clock = 11_999L
        s = host.snapshot()
        assertEquals(false, s.noSession)
        val delay = graceRerenderDelayMs(s, clock)
        assertEquals(1L, delay)
        clock += delay!! // the fake scheduler fires the re-render
        s = host.snapshot()
        assertEquals(12_000L, clock)
        assertEquals(true, s.noSession)
        assertNull(graceRerenderDelayMs(s, clock))
        host.onFrame(ThreadFrame.Snap(2, true, false, null, emptyList()))
        assertNull(graceRerenderDelayMs(host.snapshot(), clock))
    }

    @Test fun scrollsToEndOnlyWhenAtBottomAndAppended() {
        assertTrue(shouldScrollToEnd(wasAtBottomBeforeUpdate = true, appended = true))
        assertEquals(false, shouldScrollToEnd(wasAtBottomBeforeUpdate = true, appended = false))
        assertEquals(false, shouldScrollToEnd(wasAtBottomBeforeUpdate = false, appended = true))
        assertEquals(false, shouldScrollToEnd(wasAtBottomBeforeUpdate = false, appended = false))
    }

    @Test fun firstFillOfAnEmptyListScrollsToEnd() {
        // An empty list cannot scroll forward, so the caller passes wasAtBottomBeforeUpdate = true.
        assertTrue(shouldScrollToEnd(wasAtBottomBeforeUpdate = !false, appended = true))
    }

    private fun pu(id: String, tool: String = "Bash", risk: PromptRisk = PromptRisk.MED, summary: String = "ls", deadline: Long = 100_000L) =
        PromptUi(PromptInfo(id, tool, risk, summary, 0L), deadline)

    @Test fun countdownRoundsUpAndClamps() {
        assertEquals("0:00", formatCountdown(0))
        assertEquals("0:01", formatCountdown(1))
        assertEquals("0:59", formatCountdown(59_000))
        assertEquals("1:00", formatCountdown(59_001))
        assertEquals("1:00", formatCountdown(60_000))
        assertEquals("1:42", formatCountdown(102_000))
        assertEquals("2:00", formatCountdown(120_000))
        assertEquals("0:00", formatCountdown(-5_000))
    }

    @Test fun riskRoleMapsLowMedHigh() {
        assertEquals(RiskRole.SUCCESS, riskRole(PromptRisk.LOW))
        assertEquals(RiskRole.WARN, riskRole(PromptRisk.MED))
        assertEquals(RiskRole.DANGER, riskRole(PromptRisk.HIGH))
    }

    @Test fun approvalShowsOldestWithMoreCountAndUppercaseTool() {
        assertNull(approvalFor(emptyList(), 0L))
        val v = approvalFor(listOf(pu("a", deadline = 102_000L), pu("b"), pu("c")), 0L)!!
        assertEquals("a", v.id)
        assertEquals(2, v.moreCount)
        assertEquals("BASH", v.toolLabel)
        assertEquals("1:42", v.countdown)
        assertEquals(false, v.expired)
    }

    @Test fun expiredHoldsThreeSecondsThenHidesAndNextTakesOver() {
        val both = listOf(pu("a", deadline = 10_000L), pu("b", deadline = 60_000L))
        val atDeadline = approvalFor(both, 10_000L)!!
        assertEquals("a", atDeadline.id)
        assertTrue(atDeadline.expired)
        assertEquals("0:00", atDeadline.countdown)
        assertEquals("a", approvalFor(both, 12_999L)!!.id)
        val next = approvalFor(both, 13_000L)!!
        assertEquals("b", next.id)
        assertEquals(false, next.expired)
        assertEquals(0, next.moreCount)
        assertNull(approvalFor(listOf(pu("a", deadline = 10_000L)), 13_000L))
    }

    @Test fun approvalSummaryKeepsShortAndCapsLong() {
        assertEquals("x".repeat(1200), approvalSummary("x".repeat(1200)))
        val capped = approvalSummary("x".repeat(1201))
        assertEquals(1200, capped.length)
        assertTrue(capped.endsWith("\u2026"))
    }

    @Test fun clockRunsOnlyWhileSomethingVisible() {
        assertEquals(false, needsClock(ui(), 0L))
        assertTrue(needsClock(ui(working = true), 0L))
        assertTrue(needsClock(uiWith(listOf(pu("a", deadline = 10_000L))), 0L))
        assertEquals(false, needsClock(uiWith(listOf(pu("a", deadline = 10_000L))), 13_000L))
    }

    @Test fun hostPromptRemainingTtlFlowsToCard() {
        var clock = 0L
        val host = ThreadHost(sendAttach = { true }, sendDetach = { true }, now = { clock })
        host.onConnected(); host.activate(true)
        host.onFrame(ThreadFrame.Snap(1, true, false, null, emptyList()))
        clock = 1_000L
        host.onFrame(ThreadFrame.Opened(PromptInfo("p", "Bash", PromptRisk.MED, "ls", 5_000L)))
        assertEquals("0:05", approvalFor(host.snapshot().prompts, 1_000L)!!.countdown)
        clock = 3_500L
        assertEquals("0:03", approvalFor(host.snapshot().prompts, clock)!!.countdown)
        host.onFrame(ThreadFrame.Closed("p", PromptCloseReason.ANSWERED_DESKTOP))
        assertNull(approvalFor(host.snapshot().prompts, clock))
    }

    @Test fun approvalWithOneMsLeftIsNotExpired() {
        val v = approvalFor(listOf(pu("a", deadline = 1L)), 0L)!!
        assertEquals("0:01", v.countdown)
        assertEquals(false, v.expired)
    }

    private fun uiWith(p: List<PromptUi>) = ThreadUi(emptyList(), true, false, null, p)
}
