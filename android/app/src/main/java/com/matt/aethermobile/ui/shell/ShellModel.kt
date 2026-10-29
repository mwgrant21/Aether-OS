package com.matt.aethermobile.ui.shell

import com.matt.aethermobile.FlowState
import com.matt.aethermobile.protocol.ControlProtocol.SlotState
import com.matt.aethermobile.term.TerminalHost
import com.matt.aethermobile.thread.ViewMode
import com.matt.aethermobile.ui.components.DotStyle
import com.matt.aethermobile.ui.components.dotStyleFor

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

/** Menu-row capability line: whether the slot offers Thread and Raw or Raw only, plus its slot state. */
enum class SlotCaps { ThreadRaw, ThreadRawNotStarted, ThreadRawExited, RawOnly, RawOnlyNotStarted, RawOnlyExited }

data class SlotRow(
    val s: String,
    val label: String,
    val dot: DotStyle,
    val text: SlotText,
    val selected: Boolean,
    val caps: SlotCaps,
)

/** Only the Claude slot has a Thread view. */
fun hasThread(s: String): Boolean = s == "claude"

/** The thread body shows only for the Claude slot in Thread view. */
fun threadBodyActive(selected: String, view: ViewMode): Boolean = hasThread(selected) && view == ViewMode.THREAD

private fun capsFor(s: String, state: SlotState): SlotCaps = if (hasThread(s)) {
    when (state) {
        SlotState.RUNNING -> SlotCaps.ThreadRaw
        SlotState.NOT_STARTED -> SlotCaps.ThreadRawNotStarted
        SlotState.EXITED -> SlotCaps.ThreadRawExited
    }
} else {
    when (state) {
        SlotState.RUNNING -> SlotCaps.RawOnly
        SlotState.NOT_STARTED -> SlotCaps.RawOnlyNotStarted
        SlotState.EXITED -> SlotCaps.RawOnlyExited
    }
}

fun slotRows(tabs: List<TerminalHost.Tab>, selected: String): List<SlotRow> = tabs.map {
    SlotRow(
        s = it.s,
        label = if (hasThread(it.s)) "Claude" else it.label,
        dot = dotStyleFor(it.state),
        text = when (it.state) {
            SlotState.RUNNING -> SlotText.Running
            SlotState.NOT_STARTED -> SlotText.NotStarted
            SlotState.EXITED -> SlotText.Exited
        },
        selected = it.s == selected,
        caps = capsFor(it.s, it.state),
    )
}

/** Header title: the selected slot's label, except Claude shows as CLAUDE on the phone. */
fun titleFor(tabs: List<TerminalHost.Tab>, selected: String): String =
    if (selected == "claude") "CLAUDE" else tabs.firstOrNull { it.s == selected }?.label.orEmpty()

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
