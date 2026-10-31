package com.matt.aethermobile.ui.agents

import com.matt.aethermobile.agents.AgentsUi
import com.matt.aethermobile.agents.FleetUi
import com.matt.aethermobile.agents.TimelineUi
import com.matt.aethermobile.agents.RunningRowUi

enum class AgentsTab { ROSTER, FLEET, TIMELINE }

/**
 * The running row whose detail sheet is open. Keyed by the dispatch id, never a list index, so a refreshed snapshot
 * that reorders rows keeps the same agent open; an id that vanished returns null and the sheet closes.
 */
fun findRunning(ui: AgentsUi, id: String?): RunningRowUi? {
    if (id == null) return null
    return ui.groups.asSequence().flatMap { it.running.asSequence() }.firstOrNull { it.id == id }
}

/** Tapping a row sets the open id to that row's id, or closes the sheet when the same row is tapped again. */
fun nextOpenId(current: String?, tapped: String): String? = if (current == tapped) null else tapped

/** What a Fleet or Timeline tab shows. [count] is the list size when the model has rows, never their contents. */
enum class NoticeKey { FLEET_UNAVAILABLE, FLEET_EMPTY, FLEET_ROWS_UNSUPPORTED, TIMELINE_UNAVAILABLE, TIMELINE_EMPTY, TIMELINE_ITEMS_UNSUPPORTED }

data class TabNotice(val key: NoticeKey, val count: Int? = null)

/** Until P13 renders rows, a populated list is reported as a count plus an update hint, never as a blank tab. */
fun fleetNotice(f: FleetUi): TabNotice = when (f) {
    is FleetUi.Unavailable -> TabNotice(NoticeKey.FLEET_UNAVAILABLE)
    is FleetUi.Empty -> TabNotice(NoticeKey.FLEET_EMPTY)
    is FleetUi.Rows -> TabNotice(NoticeKey.FLEET_ROWS_UNSUPPORTED, f.rows.size)
}

fun timelineNotice(t: TimelineUi): TabNotice = when (t) {
    is TimelineUi.Unavailable -> TabNotice(NoticeKey.TIMELINE_UNAVAILABLE)
    is TimelineUi.Empty -> TabNotice(NoticeKey.TIMELINE_EMPTY)
    is TimelineUi.Items -> TabNotice(NoticeKey.TIMELINE_ITEMS_UNSUPPORTED, t.items.size)
}
