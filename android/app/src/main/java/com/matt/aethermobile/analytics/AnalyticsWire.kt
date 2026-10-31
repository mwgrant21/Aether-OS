package com.matt.aethermobile.analytics

import org.json.JSONArray
import org.json.JSONObject

data class AnalyticsLogs(val success: Long, val info: Long, val denied: Long, val other: Long)
data class LongestRun(val type: String, val description: String, val startedAtMs: Long)

/** [toolUses] is null when titan could not count calls for the dispatch (JSON null), which is not the same as 0. */
data class BurnRow(val type: String, val description: String, val tokens: Double, val toolUses: Long?, val durationMs: Double)
data class CommandRow(val name: String, val count: Long)
data class AnalyticsSnapshot(
    val computedAtMs: Long,
    val logs: AnalyticsLogs,
    val longest: List<LongestRun>,
    val burn: List<BurnRow>,
    val commands: List<CommandRow>,
)

/**
 * Decoder for the `d` object of an `analytics` view.snap (see `viewSnapAnalytics` in protocol/mobile-protocol.json and
 * `encodeAnalyticsView` in electron/control/viewWire.ts). Strict: a wrong type, a missing field, a list over its wire
 * cap or a command name with whitespace anywhere returns null, which ViewHost shows as Unreadable. `toolUses` may be
 * JSON null; every other field is required. Unknown extra keys are ignored. Values are never logged.
 */
object AnalyticsWire {
    const val MAX_LONGEST = 8
    const val MAX_BURN = 5
    const val MAX_COMMANDS = 5
    const val MAX_TYPE = 40
    const val MAX_DESC = 80
    const val MAX_COMMAND = 24
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

    fun decode(d: JSONObject): AnalyticsSnapshot? {
        val computedAtMs = whole(d.opt("computedAtMs")) ?: return null
        val l = d.optJSONObject("logs") ?: return null
        val logs = AnalyticsLogs(
            whole(l.opt("success")) ?: return null,
            whole(l.opt("info")) ?: return null,
            whole(l.opt("denied")) ?: return null,
            whole(l.opt("other")) ?: return null,
        )
        val longest = longest(d.optJSONArray("longest")) ?: return null
        val burn = burn(d.optJSONArray("burn")) ?: return null
        val commands = commands(d.optJSONArray("commands")) ?: return null
        return AnalyticsSnapshot(computedAtMs, logs, longest, burn, commands)
    }

    private fun longest(a: JSONArray?): List<LongestRun>? {
        if (a == null || a.length() > MAX_LONGEST) return null
        val out = ArrayList<LongestRun>(a.length())
        for (i in 0 until a.length()) {
            val r = a.optJSONObject(i) ?: return null
            out += LongestRun(
                text(r.opt("type"), MAX_TYPE) ?: return null,
                text(r.opt("description"), MAX_DESC) ?: return null,
                whole(r.opt("startedAtMs")) ?: return null,
            )
        }
        return out
    }

    private fun burn(a: JSONArray?): List<BurnRow>? {
        if (a == null || a.length() > MAX_BURN) return null
        val out = ArrayList<BurnRow>(a.length())
        for (i in 0 until a.length()) {
            val r = a.optJSONObject(i) ?: return null
            if (!r.has("toolUses")) return null
            val toolUses: Long? = if (r.isNull("toolUses")) null else (whole(r.opt("toolUses")) ?: return null)
            out += BurnRow(
                text(r.opt("type"), MAX_TYPE) ?: return null,
                text(r.opt("description"), MAX_DESC) ?: return null,
                nonNeg(r.opt("tokens")) ?: return null,
                toolUses,
                nonNeg(r.opt("durationMs")) ?: return null,
            )
        }
        return out
    }

    private fun commands(a: JSONArray?): List<CommandRow>? {
        if (a == null || a.length() > MAX_COMMANDS) return null
        val out = ArrayList<CommandRow>(a.length())
        for (i in 0 until a.length()) {
            val r = a.optJSONObject(i) ?: return null
            val name = text(r.opt("name"), MAX_COMMAND)?.takeIf { it.isNotEmpty() && it.none(Char::isWhitespace) } ?: return null
            out += CommandRow(name, whole(r.opt("count")) ?: return null)
        }
        return out
    }

    private fun nonNeg(v: Any?): Double? = (v as? Number)?.toDouble()?.takeIf { it.isFinite() && it >= 0.0 }

    private fun whole(v: Any?): Long? {
        val n = v as? Number ?: return null
        val dv = n.toDouble()
        if (!dv.isFinite() || dv < 0.0 || dv != Math.floor(dv) || dv > MAX_SAFE_INTEGER) return null
        return n.toLong()
    }

    /** A string within [max] UTF-16 units. Empty is allowed: a masked description can legitimately be empty. */
    private fun text(v: Any?, max: Int): String? = (v as? String)?.takeIf { it.length <= max }
}
