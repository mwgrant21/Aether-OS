package com.matt.aethermobile.projects

import com.matt.aethermobile.protocol.ControlProtocol.LedgerCache
import com.matt.aethermobile.protocol.ControlProtocol.LedgerRollups
import com.matt.aethermobile.protocol.ControlProtocol.LedgerTier
import com.matt.aethermobile.protocol.ControlProtocol.LedgerTotal
import org.json.JSONArray
import org.json.JSONObject

/** The per-snapshot Ledger shape D3 repeats for `all`, `unscoped`, every root and every child. */
data class LedgerBlock(val total: LedgerTotal, val tiers: List<LedgerTier>, val rollups: LedgerRollups, val cache: LedgerCache)

data class ProjectChild(val key: String, val worktree: String?, val block: LedgerBlock)
data class ProjectRoot(val key: String, val name: String, val block: LedgerBlock, val children: List<ProjectChild>)
data class ProjectsSnapshot(val computedAtMs: Long, val all: LedgerBlock, val unscoped: LedgerBlock?, val roots: List<ProjectRoot>)

/**
 * Decoder for the `d` object of a `projects` view.snap (see `viewSnapProjects` in protocol/mobile-protocol.json).
 * Strict: a wrong type, a missing field, an unknown tier or a list over the wire caps anywhere returns null, which
 * ViewHost shows as Unreadable. Money is any finite JSON number >= 0, never a string; rollup buckets may be JSON
 * null (no activity observed); `unscoped` may be null. Unknown extra keys are ignored. Values are never logged.
 */
object ProjectsWire {
    const val MAX_ROOTS = 50
    const val MAX_CHILDREN = 20
    const val MAX_NAME = 60
    const val MAX_KEY = 64
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

    fun decode(d: JSONObject): ProjectsSnapshot? {
        val computedAtMs = whole(d.opt("computedAtMs")) ?: return null
        val all = block(d.optJSONObject("all")) ?: return null
        val unscoped: LedgerBlock? = if (!d.has("unscoped") || d.isNull("unscoped")) null else (block(d.optJSONObject("unscoped")) ?: return null)
        val arr = d.optJSONArray("roots") ?: return null
        if (arr.length() > MAX_ROOTS) return null
        val roots = ArrayList<ProjectRoot>(arr.length())
        for (i in 0 until arr.length()) {
            val r = arr.optJSONObject(i) ?: return null
            val key = text(r.opt("key"), MAX_KEY) ?: return null
            val name = text(r.opt("name"), MAX_NAME) ?: return null
            val b = block(r) ?: return null
            val kids = children(r.optJSONArray("children")) ?: return null
            roots += ProjectRoot(key, name, b, kids)
        }
        return ProjectsSnapshot(computedAtMs, all, unscoped, roots)
    }

    private fun children(a: JSONArray?): List<ProjectChild>? {
        if (a == null || a.length() > MAX_CHILDREN) return null
        val out = ArrayList<ProjectChild>(a.length())
        for (i in 0 until a.length()) {
            val c = a.optJSONObject(i) ?: return null
            val key = text(c.opt("key"), MAX_KEY) ?: return null
            val worktree: String? = if (!c.has("worktree") || c.isNull("worktree")) null else (text(c.opt("worktree"), MAX_NAME) ?: return null)
            out += ProjectChild(key, worktree, block(c) ?: return null)
        }
        return out
    }

    private fun block(o: JSONObject?): LedgerBlock? {
        if (o == null) return null
        val t = o.optJSONObject("total") ?: return null
        val total = LedgerTotal(
            money(t.opt("usd")) ?: return null,
            money(t.opt("input")) ?: return null,
            money(t.opt("output")) ?: return null,
            money(t.opt("cacheCreation")) ?: return null,
            money(t.opt("cacheRead")) ?: return null,
        )
        val ta = o.optJSONArray("tiers") ?: return null
        val tiers = ArrayList<LedgerTier>(ta.length())
        for (i in 0 until ta.length()) tiers += LedgerTier.values().firstOrNull { it.wire == ta.opt(i) } ?: return null
        val r = o.optJSONObject("rollups") ?: return null
        val rollups = LedgerRollups(
            (nullableMoney(r, "today") ?: return null).value,
            (nullableMoney(r, "week") ?: return null).value,
            (nullableMoney(r, "month") ?: return null).value,
        )
        val c = o.optJSONObject("cache") ?: return null
        val hit = (c.opt("hitRate") as? Number)?.toDouble()?.takeIf { it.isFinite() && it in 0.0..1.0 } ?: return null
        val cache = LedgerCache(
            whole(c.opt("readTokens")) ?: return null,
            money(c.opt("wouldHaveUsd")) ?: return null,
            money(c.opt("actualUsd")) ?: return null,
            money(c.opt("savedUsd")) ?: return null,
            hit,
        )
        return LedgerBlock(total, tiers, rollups, cache)
    }

    private fun money(v: Any?): Double? = (v as? Number)?.toDouble()?.takeIf { it.isFinite() && it >= 0.0 }

    /** Present and JSON null -> Result(null); a money number -> Result(n); absent or any other type -> null (malformed). */
    private fun nullableMoney(o: JSONObject, key: String): Result<Double?>? {
        if (!o.has(key)) return null
        if (o.isNull(key)) return Result(null)
        return money(o.opt(key))?.let { Result(it) }
    }

    /** Boxes a nullable so "present and null" differs from "malformed". */
    class Result<T>(val value: T?)

    private fun whole(v: Any?): Long? {
        val n = v as? Number ?: return null
        val dv = n.toDouble()
        if (!dv.isFinite() || dv < 0.0 || dv != Math.floor(dv) || dv > MAX_SAFE_INTEGER) return null
        return n.toLong()
    }

    private fun text(v: Any?, max: Int): String? = (v as? String)?.takeIf { it.isNotEmpty() && it.length <= max }
}
