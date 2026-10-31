package com.matt.aethermobile.agents

import com.matt.aethermobile.analytics.formatElapsed
import com.matt.aethermobile.analytics.shortCount
import com.matt.aethermobile.ledger.AgeLabel
import com.matt.aethermobile.ledger.ageLabel

/** Desktop sentences, verbatim (AgentRosterCard, FleetCard, DispatchTimeline, AgentDetailCard). P12/P13 put them in res. */
const val EMPTY_ROSTER = "No agents are running."
const val FLEET_UNAVAILABLE = "Fleet data is unavailable because the collector isn't running."
const val FLEET_EMPTY = "No other sessions detected."
const val TIMELINE_UNAVAILABLE = "Dispatch diagnostics are unavailable because the collector isn't running."
const val TIMELINE_EMPTY = "No recent activity from tool calls, dispatches or anomalies."
const val PROMPT_EMPTY = "no prompt text available"
const val DETAIL_EMPTY = "A running agent's prompt and elapsed time will appear here."

/** Shown for a usage number titan did not measure. Never "0". The desktop done row shows "--" for a missing duration. */
const val NOT_MEASURED = "—"

/** DONE is collapsible and starts collapsed (desktop `collapsible: true`; the screen owns the toggle state). */
const val DONE_EXPANDED_DEFAULT = false

enum class AgentGroup(val label: String) {
    NEEDS_INPUT("NEEDS INPUT"),
    WORKING("WORKING"),
    DONE("DONE"),
}

/**
 * Running row. Elapsed is not stored: it ticks, so the screen calls [agentElapsed] with [startedAtMs]. [narration] is
 * null (line hidden) when titan sent null or blank; [modelBadge] is null (no badge) likewise; [prompt] is null when
 * blank (screen shows [PROMPT_EMPTY]). [anomaly] is non-null exactly when [needsInput].
 */
data class RunningRowUi(
    val id: String,
    val type: String,
    val modelBadge: String?,
    val headline: String,
    val narration: String?,
    val startedAtMs: Long,
    val needsInput: Boolean,
    val anomaly: AgentAnomaly?,
    val prompt: String?,
)

/** Usage strings are [NOT_MEASURED] for null wire values; a real 0 stays "0". [elapsed] is the final duration. */
data class DoneRowUi(
    val id: String,
    val type: String,
    val headline: String,
    val tokens: String,
    val toolUses: String,
    val elapsed: String,
)

data class AgentGroupUi(val group: AgentGroup, val running: List<RunningRowUi>, val done: List<DoneRowUi>) {
    val count: Int get() = running.size + done.size
}

data class FleetRowUi(val name: String, val startedAtMs: Long, val busy: Boolean, val detail: String)

/** Unavailable (wire null) and Empty (wire present, no rows) are different states with different sentences. */
sealed interface FleetUi {
    data class Unavailable(val message: String = FLEET_UNAVAILABLE) : FleetUi
    data class Empty(val message: String = FLEET_EMPTY) : FleetUi
    data class Rows(val rows: List<FleetRowUi>) : FleetUi
}

sealed interface TimelineUi {
    data class Unavailable(val message: String = TIMELINE_UNAVAILABLE) : TimelineUi
    data class Empty(val message: String = TIMELINE_EMPTY) : TimelineUi
    data class Items(val items: List<TimelineItem>) : TimelineUi
}

/** [groups] omits empty groups (the desktop hides them); [badge] is "!N" for N needs-input dispatches, null when 0. */
data class AgentsUi(
    val computedAtMs: Long,
    val groups: List<AgentGroupUi>,
    val needsInputCount: Int,
    val badge: String?,
    val emptyRoster: String?,
    val fleet: FleetUi,
    val timeline: TimelineUi,
)

/** Desktop headline rule: the generated headline, else the description. */
internal fun headlineOf(headline: String, description: String): String = headline.ifBlank { description }

fun agentsUi(s: AgentsSnapshot): AgentsUi {
    val (needs, working) = s.running.partition { it.needsInput }
    fun row(a: RunningAgent) = RunningRowUi(
        a.id, a.type, a.model?.takeIf { it.isNotBlank() }, headlineOf(a.headline, a.description),
        a.narration?.takeIf { it.isNotBlank() }, a.startedAtMs, a.needsInput, a.anomaly, a.prompt.takeIf { it.isNotBlank() },
    )
    val done = s.done.map { d ->
        DoneRowUi(
            d.id, d.type, headlineOf(d.headline, d.description), d.tokens?.let { shortCount(it.toDouble()) } ?: NOT_MEASURED,
            d.toolUses?.toString() ?: NOT_MEASURED, d.durationMs?.let { formatElapsed(it) } ?: NOT_MEASURED,
        )
    }
    val groups = listOf(
        AgentGroupUi(AgentGroup.NEEDS_INPUT, needs.map(::row), emptyList()),
        AgentGroupUi(AgentGroup.WORKING, working.map(::row), emptyList()),
        AgentGroupUi(AgentGroup.DONE, emptyList(), done),
    ).filter { it.count > 0 }
    return AgentsUi(
        s.computedAtMs, groups, needs.size, if (needs.isEmpty()) null else "!${needs.size}",
        EMPTY_ROSTER.takeIf { s.running.isEmpty() }, fleetUi(s.fleet), timelineUi(s.timeline),
    )
}

/** Null (no collector data) is Unavailable, never an empty list that would read as "no activity". Oldest first. */
fun fleetUi(fleet: List<FleetRow>?): FleetUi {
    if (fleet == null) return FleetUi.Unavailable()
    if (fleet.isEmpty()) return FleetUi.Empty()
    return FleetUi.Rows(
        fleet.sortedBy { it.startedAtMs }.map {
            FleetRowUi(it.name, it.startedAtMs, it.status == FleetStatus.BUSY, "kind: ${it.kind}" + (it.pid?.let { p -> " · pid: $p" } ?: ""))
        },
    )
}

/** Null is Unavailable, an empty list is Empty. Newest first, as on the desktop. */
fun timelineUi(timeline: List<TimelineItem>?): TimelineUi {
    if (timeline == null) return TimelineUi.Unavailable()
    if (timeline.isEmpty()) return TimelineUi.Empty()
    return TimelineUi.Items(timeline.sortedByDescending { it.atMs })
}

/** Elapsed of a running dispatch or fleet session on titan's clock: titan time = phone now + titanClockOffsetMs. */
fun agentElapsed(startedAtMs: Long, phoneNowMs: Long, titanClockOffsetMs: Long): String =
    formatElapsed(phoneNowMs + titanClockOffsetMs - startedAtMs)

/** Age of the snapshot on titan's clock, the same label the Projects pane uses. */
fun agentsAge(computedAtMs: Long, phoneNowMs: Long, titanClockOffsetMs: Long): AgeLabel =
    ageLabel(computedAtMs, phoneNowMs + titanClockOffsetMs)
