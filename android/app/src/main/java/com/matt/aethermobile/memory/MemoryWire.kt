package com.matt.aethermobile.memory

import org.json.JSONArray
import org.json.JSONObject

enum class MemoryScope(val wire: String) { SHARED("shared"), PRIVATE("private") }
enum class MemoryKind(val wire: String) { DECISION("decision"), PREFERENCE("preference"), OVERRULE("overrule"), HABIT("habit"), REVISION("revision") }
enum class MemoryStatus(val wire: String) { OPEN("open"), MOVING("moving"), SETTLED("settled") }
enum class TombstoneCause(val wire: String) { SUPERSEDED("superseded"), OPERATOR("operator"), INVALIDATED("invalidated") }

data class MemoryRow(
    val id: Long,
    val scope: MemoryScope,
    val owner: String?,
    val kind: MemoryKind,
    val status: MemoryStatus?,
    val salience: Double,
    val subject: String?,
    val content: String,
    val createdAtMs: Long,
    val updatedAtMs: Long,
)

data class MemoryTombstone(
    val id: Long,
    val scope: MemoryScope,
    val owner: String?,
    val content: String,
    val deletedAtMs: Long,
    val cause: TombstoneCause,
    val supersededBy: Long?,
)

data class MemorySnapshot(
    val computedAtMs: Long,
    val liveCount: Long,
    val tombstoneCount: Long,
    val live: List<MemoryRow>,
    val tombstones: List<MemoryTombstone>,
)

/**
 * Decoder for the `d` object of a `memory` view.snap (see `viewSnapMemory` in protocol/mobile-protocol.json).
 * Strict: a wrong type, a missing field, an unknown enum value or a list over the wire caps anywhere returns null,
 * which ViewHost shows as Unreadable. `extraction` is reserved and ignored (always null on the wire), as are unknown
 * extra keys. Free text is the owner's own memory and is never logged.
 */
object MemoryWire {
    const val MAX_LIVE = 150
    const val MAX_TOMBSTONES = 60
    const val MAX_CONTENT = 600
    const val MAX_SUBJECT = 80
    const val MAX_OWNER = 60
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

    fun decode(d: JSONObject): MemorySnapshot? {
        val computedAtMs = whole(d.opt("computedAtMs")) ?: return null
        val counts = d.optJSONObject("counts") ?: return null
        val liveCount = whole(counts.opt("live")) ?: return null
        val tombCount = whole(counts.opt("tombstones")) ?: return null
        val live = liveRows(d.optJSONArray("live")) ?: return null
        val tombs = tombstones(d.optJSONArray("tombstones")) ?: return null
        return MemorySnapshot(computedAtMs, liveCount, tombCount, live, tombs)
    }

    private fun liveRows(a: JSONArray?): List<MemoryRow>? {
        if (a == null || a.length() > MAX_LIVE) return null
        val out = ArrayList<MemoryRow>(a.length())
        for (i in 0 until a.length()) {
            val o = a.optJSONObject(i) ?: return null
            val salience = (o.opt("salience") as? Number)?.toDouble()?.takeIf { it.isFinite() && it >= 0.0 } ?: return null
            val status: MemoryStatus? = if (!o.has("status") || o.isNull("status")) null
            else MemoryStatus.values().firstOrNull { it.wire == o.opt("status") } ?: return null
            val owner = nullableText(o, "owner", MAX_OWNER)
            val subject = nullableText(o, "subject", MAX_SUBJECT)
            if (owner.malformed || subject.malformed) return null
            out += MemoryRow(
                whole(o.opt("id")) ?: return null,
                MemoryScope.values().firstOrNull { it.wire == o.opt("scope") } ?: return null,
                owner.value,
                MemoryKind.values().firstOrNull { it.wire == o.opt("kind") } ?: return null,
                status,
                salience,
                subject.value,
                text(o.opt("content"), MAX_CONTENT) ?: return null,
                whole(o.opt("createdAtMs")) ?: return null,
                whole(o.opt("updatedAtMs")) ?: return null,
            )
        }
        return out
    }

    private fun tombstones(a: JSONArray?): List<MemoryTombstone>? {
        if (a == null || a.length() > MAX_TOMBSTONES) return null
        val out = ArrayList<MemoryTombstone>(a.length())
        for (i in 0 until a.length()) {
            val o = a.optJSONObject(i) ?: return null
            val by: Long? = if (!o.has("supersededBy") || o.isNull("supersededBy")) null else (whole(o.opt("supersededBy")) ?: return null)
            val owner = nullableText(o, "owner", MAX_OWNER)
            if (owner.malformed) return null
            out += MemoryTombstone(
                whole(o.opt("id")) ?: return null,
                MemoryScope.values().firstOrNull { it.wire == o.opt("scope") } ?: return null,
                owner.value,
                text(o.opt("content"), MAX_CONTENT) ?: return null,
                whole(o.opt("deletedAtMs")) ?: return null,
                TombstoneCause.values().firstOrNull { it.wire == o.opt("cause") } ?: return null,
                by,
            )
        }
        return out
    }

    private class Text(val value: String?, val malformed: Boolean)

    /** Absent or JSON null -> null value; a string within max -> itself; any other type or an over-long string -> malformed. */
    private fun nullableText(o: JSONObject, key: String, max: Int): Text {
        if (!o.has(key) || o.isNull(key)) return Text(null, false)
        val s = o.opt(key) as? String
        return if (s == null || s.length > max) Text(null, true) else Text(s, false)
    }

    private fun whole(v: Any?): Long? {
        val n = v as? Number ?: return null
        val dv = n.toDouble()
        if (!dv.isFinite() || dv < 0.0 || dv != Math.floor(dv) || dv > MAX_SAFE_INTEGER) return null
        return n.toLong()
    }

    /** Free text may be empty (a blank memory) but must be a string within the cap. */
    private fun text(v: Any?, max: Int): String? = (v as? String)?.takeIf { it.length <= max }
}
