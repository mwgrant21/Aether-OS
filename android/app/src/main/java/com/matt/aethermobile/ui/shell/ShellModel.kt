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

/** The phone shows slot 1 as Alpha and slot 2 as Beta (title case); any other slot keeps its server label. */
fun phoneSlotName(s: String, serverLabel: String): String = when (s) {
    "claude" -> "Alpha"
    "terminal2" -> "Beta"
    else -> serverLabel
}

fun slotRows(tabs: List<TerminalHost.Tab>, selected: String): List<SlotRow> = tabs.map {
    SlotRow(
        s = it.s,
        label = phoneSlotName(it.s, it.label),
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

/** Which top-level view the shell shows: the terminal slots, the read-only Ledger, or a generic-channel pane. */
enum class AppView { TERMINAL, LEDGER, PROJECTS, MEMORY, DASHBOARD, ANALYTICS, AGENTS, COMMS }

/** True for the views served by the generic view channel (everything except the terminal and the Ledger). */
val AppView.isPane: Boolean get() = this != AppView.TERMINAL && this != AppView.LEDGER

enum class Body { THREAD, RAW, LEDGER, PANE }

/** A Ledger or pane view wins over every slot; otherwise the Thread/Raw rule applies. */
fun bodyFor(selected: String, view: ViewMode, app: AppView): Body = when {
    app == AppView.LEDGER -> Body.LEDGER
    app.isPane -> Body.PANE
    threadBodyActive(selected, view) -> Body.THREAD
    else -> Body.RAW
}

/** Where Back goes from [app]: every non-terminal view returns to the terminal; null means Back is not ours. */
fun backTarget(app: AppView): AppView? = if (app == AppView.TERMINAL) null else AppView.TERMINAL

/** The Thread/Raw segment belongs to the terminal view only. */
fun showSegment(selected: String, app: AppView): Boolean = hasThread(selected) && app == AppView.TERMINAL

/** [enabled] is false for a pane the connected titan does not list; the row then shows "Update Aether on titan". */
data class ViewRow(val view: AppView, val selected: Boolean, val enabled: Boolean = true)

/**
 * Burger VIEWS rows: Ledger, then one row per registered pane in registry order (the terminal slots live under
 * TERMINALS). With no [panes] this is exactly the Ledger row. [supported] says whether the titan lists a pane.
 */
fun viewRows(app: AppView, panes: List<AppView> = emptyList(), supported: (AppView) -> Boolean = { true }): List<ViewRow> =
    listOf(ViewRow(AppView.LEDGER, app == AppView.LEDGER)) + panes.map { ViewRow(it, app == it, supported(it)) }

/** Header title: ALPHA / BETA for the two terminal slots, the server label for any other slot. */
fun titleFor(tabs: List<TerminalHost.Tab>, selected: String): String =
    when (selected) {
        "claude", "terminal2" -> phoneSlotName(selected, "").uppercase()
        else -> tabs.firstOrNull { it.s == selected }?.label.orEmpty()
    }

fun titleFor(tabs: List<TerminalHost.Tab>, selected: String, app: AppView): String = when (app) {
    AppView.TERMINAL -> titleFor(tabs, selected)
    AppView.LEDGER -> "LEDGER"
    AppView.PROJECTS -> "PROJECTS"
    AppView.MEMORY -> "MEMORY"
    AppView.DASHBOARD -> "DASHBOARD"
    AppView.ANALYTICS -> "ANALYTICS"
    AppView.AGENTS -> "AGENTS"
    AppView.COMMS -> "COMMS"
}

/** The header core runs Nominal when any slot is live, Idle otherwise. */
fun anyRunning(tabs: List<TerminalHost.Tab>): Boolean = tabs.any { it.state == SlotState.RUNNING }

/** Burger dropdown state. Every way out of the menu closes it. */
data class MenuState(val open: Boolean = false) {
    fun onBurger() = copy(open = !open)
    fun onSelectSlot() = copy(open = false)
    fun onSelectView() = copy(open = false)
    fun onLock() = copy(open = false)
    fun onBack() = copy(open = false)
    fun onScrim() = copy(open = false)
}
