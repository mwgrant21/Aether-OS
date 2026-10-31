package com.matt.aethermobile.memory

/** Which slice of the snapshot a chip selects. All/Shared/Agent/Live filter live memories; Tombstones lists the tombstones. */
sealed interface MemoryFilter {
    data object All : MemoryFilter
    data object Shared : MemoryFilter
    data class Agent(val name: String) : MemoryFilter
    data object Live : MemoryFilter
    data object Tombstones : MemoryFilter
}

/** Kind tier colours as 0xAARRGGBB, mirroring desktop KIND_TIER_COLOR; habit is the README textDim token #9FC4D1. */
fun kindColor(kind: MemoryKind): Long = when (kind) {
    MemoryKind.OVERRULE -> 0xFFF5C66BL
    MemoryKind.DECISION, MemoryKind.PREFERENCE -> 0xFF3BE0A0L
    MemoryKind.REVISION -> 0xFF8FD6FFL
    MemoryKind.HABIT -> 0xFF9FC4D1L
}

/** Salience bar fraction clamped to 0..1; the wire allows any finite value >= 0, and NaN draws as empty. */
fun salienceFraction(s: Double): Double = if (s.isNaN()) 0.0 else s.coerceIn(0.0, 1.0)

/** "updated" line: the update time, shown only when the row changed after it was created (desktop parity); else null. */
fun updatedAtOrNull(createdAtMs: Long, updatedAtMs: Long): Long? = updatedAtMs.takeIf { it != createdAtMs }

/** "superseded by #N" when a tombstone names its successor; null otherwise. */
fun supersededLine(by: Long?): String? = by?.let { "superseded by #$it" }

/** Desktop groupMemoriesByScope: shared rows, and private rows by owner in first-seen order. Private rows with no owner are dropped. */
class MemoryGroups(val shared: List<MemoryRow>, val byAgent: Map<String, List<MemoryRow>>)

fun groupMemoriesByScope(rows: List<MemoryRow>): MemoryGroups {
    val shared = rows.filter { it.scope == MemoryScope.SHARED }
    val byAgent = LinkedHashMap<String, MutableList<MemoryRow>>()
    for (m in rows) {
        val owner = m.owner
        if (m.scope != MemoryScope.PRIVATE || owner.isNullOrEmpty()) continue
        byAgent.getOrPut(owner) { ArrayList() }.add(m)
    }
    return MemoryGroups(shared, byAgent)
}

/** Chip order: All, Shared, one per owner agent present in live memories, Live memories, Tombstones. */
fun memoryChips(s: MemorySnapshot): List<MemoryFilter> =
    listOf(MemoryFilter.All, MemoryFilter.Shared) +
        groupMemoriesByScope(s.live).byAgent.keys.map { MemoryFilter.Agent(it) } +
        listOf(MemoryFilter.Live, MemoryFilter.Tombstones)

data class MemoryRowUi(
    val id: Long,
    val kind: MemoryKind,
    val color: Long,
    val subject: String?,
    val content: String,
    val status: MemoryStatus?,
    val salience: Double,
    val salienceBar: Double,
    val createdAtMs: Long,
    val updatedAtMs: Long?,
)

enum class GroupKind { SHARED, AGENT }
data class MemoryGroupUi(val kind: GroupKind, val agent: String?, val rows: List<MemoryRowUi>)

data class TombstoneUi(
    val id: Long,
    val scope: MemoryScope,
    val owner: String?,
    val content: String,
    val cause: TombstoneCause,
    val deletedAtMs: Long,
    val supersededBy: String?,
)

data class MemoryUi(
    val computedAtMs: Long,
    val chips: List<MemoryFilter>,
    val groups: List<MemoryGroupUi>,
    val tombstones: List<TombstoneUi>,
)

private fun rowUi(m: MemoryRow) = MemoryRowUi(
    m.id, m.kind, kindColor(m.kind), m.subject, m.content, m.status, m.salience, salienceFraction(m.salience),
    m.createdAtMs, updatedAtOrNull(m.createdAtMs, m.updatedAtMs),
)

private fun tombUi(t: MemoryTombstone) =
    TombstoneUi(t.id, t.scope, t.owner, t.content, t.cause, t.deletedAtMs, supersededLine(t.supersededBy))

/**
 * The list for one chip. Tombstones shows every tombstone and no live groups; the other chips show live groups and no
 * tombstones. The SHARED group is present (possibly empty) for All, Shared and Live, as on desktop; agent groups follow
 * the filter. Rows keep the order received.
 */
fun memoryUi(s: MemorySnapshot, filter: MemoryFilter = MemoryFilter.All): MemoryUi {
    val chips = memoryChips(s)
    if (filter == MemoryFilter.Tombstones) return MemoryUi(s.computedAtMs, chips, emptyList(), s.tombstones.map(::tombUi))
    val g = groupMemoriesByScope(s.live)
    val groups = ArrayList<MemoryGroupUi>()
    if (filter !is MemoryFilter.Agent) groups += MemoryGroupUi(GroupKind.SHARED, null, g.shared.map(::rowUi))
    if (filter != MemoryFilter.Shared) {
        for ((agent, rows) in g.byAgent) {
            if (filter is MemoryFilter.Agent && filter.name != agent) continue
            groups += MemoryGroupUi(GroupKind.AGENT, agent, rows.map(::rowUi))
        }
    }
    return MemoryUi(s.computedAtMs, chips, groups, emptyList())
}
