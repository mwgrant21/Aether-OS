package com.matt.aethermobile.ui.agents

import com.matt.aethermobile.agents.AgentsUi
import com.matt.aethermobile.agents.FleetRowUi
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

/** The expanded fleet row's key, or null when that key is no longer in [rows]: expansion follows the stable key, not an index. */
fun resolveExpandedFleet(rows: List<FleetRowUi>, key: String?): FleetRowUi? =
    if (key == null) null else rows.firstOrNull { it.key == key }
