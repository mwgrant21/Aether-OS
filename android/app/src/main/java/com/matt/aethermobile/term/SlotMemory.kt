package com.matt.aethermobile.term

import com.matt.aethermobile.protocol.ControlProtocol

/** Where the last user-chosen slot id lives. A slot id is not a secret. */
interface SlotStore {
    fun get(): String?
    fun put(slot: String)
}

/**
 * Remembers the slot the user last chose so a reconnect re-attaches it.
 * Only [remember] writes; [pick] never does, so an automatic fallback keeps the preference.
 */
class SlotMemory(private val store: SlotStore) {
    fun remember(slot: String) {
        if (ControlProtocol.SLOTS.none { it.s == slot }) return
        try { store.put(slot) } catch (_: Exception) { /* best effort */ }
    }

    fun pick(sessions: List<ControlProtocol.SessionInfo>): String {
        val stored = try { store.get() } catch (_: Exception) { null }
        if (stored != null && ControlProtocol.SLOTS.any { it.s == stored } &&
            sessions.any { it.s == stored && it.state == ControlProtocol.SlotState.RUNNING }
        ) return stored
        return sessions.firstOrNull { it.state == ControlProtocol.SlotState.RUNNING }?.s ?: "claude"
    }
}
