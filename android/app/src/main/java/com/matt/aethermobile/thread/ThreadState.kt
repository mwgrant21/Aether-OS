package com.matt.aethermobile.thread

import com.matt.aethermobile.protocol.ControlProtocol.ThreadEntry
import com.matt.aethermobile.protocol.ControlProtocol.ThreadFrame
import com.matt.aethermobile.protocol.ControlProtocol.ThreadMeta
import com.matt.aethermobile.protocol.ControlProtocol.Why

/** Tap-to-expand detail of one entry. */
sealed class DetailState {
    /** A tget for this entry is queued or in flight. */
    object Loading : DetailState()

    /** [input] and [text] are redacted by titan; null means that part has nothing to show. [inMore] and [more] count omitted lines. */
    data class Ready(val input: String?, val inMore: Int, val text: String?, val more: Int) : DetailState()

    /** Titan had nothing to show for this entry. */
    object Unavailable : DetailState()
}

/**
 * One slot's thread as the phone holds it. Immutable: every reducer step returns a new value, so a
 * reader on the UI thread never sees a half-applied frame. Pure JVM, no android.* imports.
 */
data class ThreadState(
    /** False until the first snapshot, and when titan says the slot has no readable session. */
    val avail: Boolean = false,
    val why: Why? = null,
    /** Oldest first, ids unique, at most [MAX_ENTRIES]. */
    val entries: List<ThreadEntry> = emptyList(),
    /** Null until the first snapshot; null fields inside are "unknown", never zero. */
    val meta: ThreadMeta? = null,
    val details: Map<String, DetailState> = emptyMap(),
    val expanded: Set<String> = emptySet(),
) {
    /** Replaces everything from a snapshot. Details are dropped (the tool output may have changed); expansion survives for ids still present. */
    fun applySnap(f: ThreadFrame.Snap): ThreadState {
        val trimmed = dedupe(f.entries).takeLast(MAX_ENTRIES)
        val ids = trimmed.mapTo(HashSet()) { it.id }
        return ThreadState(f.avail, f.why, trimmed, f.m, emptyMap(), expanded.filterTo(HashSet()) { it in ids })
    }

    /** Appends [e], or replaces the entry already carrying its id in place (dedupe); drops the oldest past [MAX_ENTRIES]. */
    fun applyAdd(e: ThreadEntry): ThreadState {
        val i = entries.indexOfFirst { it.id == e.id }
        if (i >= 0) return copy(entries = entries.toMutableList().also { it[i] = e }, details = dropUnavailable(e.id))
        val all = entries + e
        if (all.size <= MAX_ENTRIES) return copy(entries = all)
        val kept = all.takeLast(MAX_ENTRIES)
        val ids = kept.mapTo(HashSet()) { it.id }
        return copy(
            entries = kept,
            details = details.filterKeys { it in ids },
            expanded = expanded.filterTo(HashSet()) { it in ids },
        )
    }

    /** Replaces the entry with [e]'s id in place; an id not held (older than the window) is ignored. */
    fun applyUpd(e: ThreadEntry): ThreadState {
        val i = entries.indexOfFirst { it.id == e.id }
        if (i < 0) return this
        return copy(entries = entries.toMutableList().also { it[i] = e }, details = dropUnavailable(e.id))
    }

    fun applyMeta(m: ThreadMeta): ThreadState = copy(meta = m)

    /** Settles the detail for [f].id only while it is Loading; an unsolicited or repeated reply changes nothing. */
    fun applyDetail(f: ThreadFrame.Detail): ThreadState {
        if (details[f.id] !is DetailState.Loading) return this
        val d = if (f.input == null && f.x == null) DetailState.Unavailable else DetailState.Ready(f.input, f.inMore, f.x, f.more)
        return copy(details = details + (f.id to d))
    }

    fun withDetail(id: String, d: DetailState): ThreadState = copy(details = details + (id to d))

    fun withoutDetail(id: String): ThreadState = copy(details = details - id)

    fun toggled(id: String): ThreadState {
        if (entries.none { it.id == id }) return this
        return copy(expanded = if (id in expanded) expanded - id else expanded + id)
    }

    /** An Unavailable detail may become available once the tool finishes, so an update to the entry lets a re-expand ask again. */
    private fun dropUnavailable(id: String): Map<String, DetailState> =
        if (details[id] === DetailState.Unavailable) details - id else details

    /** Keeps one entry per id: the last one seen, at the position of the first. */
    private fun dedupe(list: List<ThreadEntry>): List<ThreadEntry> {
        val last = HashMap<String, ThreadEntry>()
        for (e in list) last[e.id] = e
        val seen = HashSet<String>()
        return list.mapNotNull { if (seen.add(it.id)) last[it.id] else null }
    }

    companion object {
        const val MAX_ENTRIES = 400
    }
}
