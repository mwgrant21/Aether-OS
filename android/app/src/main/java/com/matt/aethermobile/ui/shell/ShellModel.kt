package com.matt.aethermobile.ui.shell

import com.matt.aethermobile.FlowState
import com.matt.aethermobile.protocol.ControlProtocol
import com.matt.aethermobile.protocol.ControlProtocol.SlotState
import com.matt.aethermobile.thread.DetailState
import com.matt.aethermobile.thread.ThreadState
import com.matt.aethermobile.term.TerminalHost
import com.matt.aethermobile.ui.components.DotStyle
import com.matt.aethermobile.ui.components.dotStyleFor
import com.matt.aethermobile.ui.thread.ThreadDetail
import com.matt.aethermobile.ui.thread.ThreadRow
import com.matt.aethermobile.ui.thread.ThreadUiModel
import com.matt.aethermobile.ui.thread.ThreadViewMode

/** What the header subline says. [Days] is rendered with the days_left / days_left_warn resources. */
sealed interface StatusLine {
    data object None : StatusLine
    data object NotStarted : StatusLine
    data object Exited : StatusLine
    data object AwaitingOutput : StatusLine
    data class Days(val daysLeft: Int, val warn: Boolean) : StatusLine
}

/** Same precedence as the pre-V3 MainActivity.renderTabs(): slot state, then awaiting output, then days left. */
fun statusFor(cur: TerminalHost.Tab?, flow: FlowState.Connected?): StatusLine = when {
    cur?.state == SlotState.NOT_STARTED -> StatusLine.NotStarted
    cur?.state == SlotState.EXITED -> StatusLine.Exited
    cur?.awaitingOutput == true -> StatusLine.AwaitingOutput
    flow != null -> StatusLine.Days(flow.daysLeft, flow.warn)
    else -> StatusLine.None
}

/** Amber subline: expiry warning on a running slot (also tints the awaiting-output text, as before). */
fun amber(cur: TerminalHost.Tab?, flow: FlowState.Connected?): Boolean =
    flow != null && flow.warn && cur?.state == SlotState.RUNNING

enum class SlotText { Running, NotStarted, Exited }

data class SlotRow(
    val s: String,
    val label: String,
    val dot: DotStyle,
    val text: SlotText,
    val selected: Boolean,
)

fun slotRows(tabs: List<TerminalHost.Tab>, selected: String): List<SlotRow> = tabs.map {
    SlotRow(
        s = it.s,
        label = it.label,
        dot = dotStyleFor(it.state),
        text = when (it.state) {
            SlotState.RUNNING -> SlotText.Running
            SlotState.NOT_STARTED -> SlotText.NotStarted
            SlotState.EXITED -> SlotText.Exited
        },
        selected = it.s == selected,
    )
}

/** Header title: the selected slot's label. */
fun titleFor(tabs: List<TerminalHost.Tab>, selected: String): String =
    tabs.firstOrNull { it.s == selected }?.label.orEmpty()

/** The header core runs Nominal when any slot is live, Idle otherwise. */
fun anyRunning(tabs: List<TerminalHost.Tab>): Boolean = tabs.any { it.state == SlotState.RUNNING }

/** Burger dropdown state. Every way out of the menu closes it. */
data class MenuState(val open: Boolean = false) {
    fun onBurger() = copy(open = !open)
    fun onSelectSlot() = copy(open = false)
    fun onLock() = copy(open = false)
    fun onBack() = copy(open = false)
    fun onScrim() = copy(open = false)
}

/** Codex has no transcript: it never gets the THREAD/TERM switch. */
fun showSwitch(slot: String): Boolean = slot in ControlProtocol.THREAD_SLOTS

/** True when this slot's thread should be attached: a threadable slot, `thread` in [caps], and the user has not chosen TERM. */
fun threadWanted(slot: String, caps: Set<String>, choice: ThreadViewMode?): Boolean =
    showSwitch(slot) && ControlProtocol.CAP_THREAD in caps && choice != ThreadViewMode.TERM

/**
 * Which view the slot shows. THREAD only for a threadable slot whose titan advertises `thread`, whose
 * session is readable ([threadAvail]) and where the user has not chosen TERM ([choice] null = default THREAD).
 */
fun viewModeFor(slot: String, caps: Set<String>, threadAvail: Boolean, choice: ThreadViewMode?): ThreadViewMode =
    if (threadWanted(slot, caps, choice) && threadAvail) ThreadViewMode.THREAD else ThreadViewMode.TERM

/** Display rows for the thread screen: the slot's entries with its expansion and fetched details. */
fun threadRows(st: ThreadState): List<ThreadRow> = ThreadUiModel.rowsFor(
    st.entries,
    st.expanded,
    st.details.mapValues { (_, d) ->
        when (d) {
            DetailState.Loading -> ThreadDetail.Loading
            DetailState.Unavailable -> ThreadDetail.Unavailable
            is DetailState.Ready -> ThreadDetail.Ready(d.input, d.inMore, d.text, d.more)
        }
    },
)

/** Before the first snapshot the thread is assumed readable, so attaching does not flash the terminal. */
fun threadAvail(st: ThreadState): Boolean = st.meta == null || st.avail
