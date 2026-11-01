package com.matt.aethermobile.dashboard

import org.json.JSONArray
import org.json.JSONObject

enum class DashAlarm(val wire: String) { OK("ok"), WARN("warn"), CRIT("crit") }
enum class EtaKind(val wire: String) { NONE("none"), NOW("now"), SECS("secs") }
enum class EtaSource(val wire: String) { SCAN("scan"), LIVE("live"), STALE("stale") }
enum class ReadinessKey(val wire: String) { DESKTOP("desktop"), TERMINAL("terminal"), STATUSLINE("statusline"), COLLECTOR("collector") }

data class DashEta(val kind: EtaKind, val secs: Long?, val source: EtaSource, val resetsInMs: Long?)

data class DashKpis(
    val monthTokens: Long?,
    val todayUsd: Double?,
    val budgetLeftPct: Double?,
    val capM: Double,
    val eta: DashEta,
)

data class ReadinessWire(val key: ReadinessKey, val met: Boolean, val glows: Boolean, val atMs: Long?)
data class DashRecap(val dispatches: Long, val anomaliesDetected: Long, val anomaliesCleared: Long, val tokensBurned: Long)
data class DashStrip(val agents: Long, val alerts: Long, val memory: Long)

data class DashSnapshot(
    val computedAtMs: Long,
    val live: Boolean,
    val alarm: DashAlarm,
    val ratePerMin: Double?,
    val kpis: DashKpis,
    val readiness: List<ReadinessWire>,
    val recap: DashRecap?,
    val strip: DashStrip,
)

/**
 * Decoder for the `d` object of a `dash` view.snap (see `viewSnapDash` in protocol/mobile-protocol.json and
 * `encodeDashView` in electron/control/viewWire.ts). Strict: a wrong type, a missing required field (absent nullable fields read as null), an unknown enum value, a
 * duplicate readiness key or an eta whose kind disagrees with its secs anywhere returns null, which ViewHost shows as
 * Unreadable. Unknown extra keys are ignored. There is no free text in this payload.
 */
object DashWire {
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

    fun decode(d: JSONObject): DashSnapshot? {
        val computedAtMs = whole(d.opt("computedAtMs")) ?: return null
        val live = d.opt("live") as? Boolean ?: return null
        val alarm = DashAlarm.values().firstOrNull { it.wire == d.opt("alarm") } ?: return null
        val rate = nullableNum(d, "ratePerMin") ?: return null
        val kpis = kpis(d.optJSONObject("kpis")) ?: return null
        val readiness = readiness(d.optJSONArray("readiness")) ?: return null
        val recap = recap(d) ?: return null
        val strip = d.optJSONObject("strip") ?: return null
        return DashSnapshot(
            computedAtMs, live, alarm, rate.value, kpis, readiness, recap.value,
            DashStrip(
                whole(strip.opt("agents")) ?: return null,
                whole(strip.opt("alerts")) ?: return null,
                whole(strip.opt("memory")) ?: return null,
            ),
        )
    }

    private fun kpis(k: JSONObject?): DashKpis? {
        if (k == null) return null
        val month = nullableWhole(k, "monthTokens") ?: return null
        val usd = nullableNum(k, "todayUsd") ?: return null
        val pct = nullableNum(k, "budgetLeftPct") ?: return null
        if (pct.value != null && pct.value > 100.0) return null
        val capM = num(k.opt("capM"))?.takeIf { it > 0.0 } ?: return null
        val e = k.optJSONObject("eta") ?: return null
        val kind = EtaKind.values().firstOrNull { it.wire == e.opt("kind") } ?: return null
        val source = EtaSource.values().firstOrNull { it.wire == e.opt("source") } ?: return null
        val secs = nullableWhole(e, "secs") ?: return null
        val resets = nullableWhole(e, "resetsInMs") ?: return null
        if ((kind == EtaKind.SECS) != (secs.value != null)) return null
        return DashKpis(month.value, usd.value, pct.value, capM, DashEta(kind, secs.value, source, resets.value))
    }

    private fun readiness(a: JSONArray?): List<ReadinessWire>? {
        if (a == null || a.length() > ReadinessKey.values().size) return null
        val out = ArrayList<ReadinessWire>(a.length())
        for (i in 0 until a.length()) {
            val o = a.optJSONObject(i) ?: return null
            val key = ReadinessKey.values().firstOrNull { it.wire == o.opt("key") } ?: return null
            if (out.any { it.key == key }) return null
            val at = nullableWhole(o, "atMs") ?: return null
            out += ReadinessWire(key, o.opt("met") as? Boolean ?: return null, o.opt("glows") as? Boolean ?: return null, at.value)
        }
        return out
    }

    private fun recap(d: JSONObject): Opt<DashRecap>? {
        if (!d.has("recap") || d.isNull("recap")) return Opt(null)
        val r = d.optJSONObject("recap") ?: return null
        return Opt(
            DashRecap(
                whole(r.opt("dispatches")) ?: return null,
                whole(r.opt("anomaliesDetected")) ?: return null,
                whole(r.opt("anomaliesCleared")) ?: return null,
                whole(r.opt("tokensBurned")) ?: return null,
            ),
        )
    }

    /** A present value (possibly null); the enclosing function returns null for a malformed field. */
    private class Opt<T>(val value: T?)

    /** Absent or JSON null -> Opt(null); a finite non-negative number -> Opt(it); anything else -> null (malformed). */
    private fun nullableNum(o: JSONObject, key: String): Opt<Double>? {
        if (!o.has(key) || o.isNull(key)) return Opt(null)
        return Opt(num(o.opt(key)) ?: return null)
    }

    private fun nullableWhole(o: JSONObject, key: String): Opt<Long>? {
        if (!o.has(key) || o.isNull(key)) return Opt(null)
        return Opt(whole(o.opt(key)) ?: return null)
    }

    private fun num(v: Any?): Double? {
        val dv = (v as? Number)?.toDouble() ?: return null
        return dv.takeIf { it.isFinite() && it >= 0.0 }
    }

    private fun whole(v: Any?): Long? {
        val n = v as? Number ?: return null
        val dv = n.toDouble()
        if (!dv.isFinite() || dv < 0.0 || dv != Math.floor(dv) || dv > MAX_SAFE_INTEGER) return null
        return n.toLong()
    }
}
