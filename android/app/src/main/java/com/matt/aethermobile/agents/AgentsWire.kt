package com.matt.aethermobile.agents

import org.json.JSONArray
import org.json.JSONObject

enum class AnomalyKind(val wire: String) {
    RE_READ_LOOP("reReadLoop"),
    WRITE_DELETE_REWRITE("writeDeleteRewrite"),
    ZERO_EDIT_BURN("zeroEditBurn"),
    STALLED_PERMISSION("stalledPermission"),
}

data class AgentAnomaly(val kind: AnomalyKind, val detail: String)

/** [model] and [narration] are null when titan does not know them (JSON null). */
data class RunningAgent(
    val id: String,
    val type: String,
    val description: String,
    val startedAtMs: Long,
    val model: String?,
    val headline: String,
    val narration: String?,
    val needsInput: Boolean,
    val anomaly: AgentAnomaly?,
    val prompt: String,
)

/** [tokens], [toolUses] and [durationMs] are null when not measured (JSON null), which is not the same as 0. */
data class DoneAgent(
    val id: String,
    val type: String,
    val description: String,
    val startedAtMs: Long,
    val tokens: Long?,
    val toolUses: Long?,
    val durationMs: Long?,
    val headline: String,
)

enum class FleetStatus(val wire: String) { BUSY("busy"), IDLE("idle") }

/**
 * [key] is an opaque id, unique and stable within one titan run (expansion state follows it, never a list index);
 * [title] is the project folder name (the row title) and [name] the session name. [pid] is null when the session has none.
 */
data class FleetRow(val key: String, val title: String, val name: String, val startedAtMs: Long, val status: FleetStatus, val kind: String, val pid: Long?)

enum class TimelineKind(val wire: String) { TOOL("tool"), DISPATCH("dispatch"), ANOMALY("anomaly") }
data class TimelineItem(val kind: TimelineKind, val atMs: Long, val label: String, val tokens: Long?, val toolUses: Long?, val durationMs: Long?)

/** [fleet] and [timeline] null means titan has no collector data (not "no activity"); a present empty list means none. */
data class AgentsSnapshot(
    val computedAtMs: Long,
    val running: List<RunningAgent>,
    val done: List<DoneAgent>,
    val fleet: List<FleetRow>?,
    val timeline: List<TimelineItem>?,
)

/**
 * Decoder for the `d` object of an `agents` view.snap (see `viewSnapAgents` in protocol/mobile-protocol.json and
 * `encodeAgentsView` in electron/control/viewWire.ts). Strict for the roster: a wrong type, a missing field, a bad id,
 * a list over its wire cap, an unknown anomaly kind or needsInput that disagrees with anomaly anywhere returns null,
 * which ViewHost shows as Unreadable. Unknown extra keys are ignored. Values are never logged.
 *
 * `fleet` and `timeline` are LENIENT: a titan without the collector sends null, otherwise rows as built by
 * `encodeFleetRows` / `encodeTimelineRows` (golden `viewSnapAgentsDiag`). Absent, null and a malformed value (wrong
 * type, bad row, unknown enum, bad or duplicate fleet key, over cap) all decode to null, which the UI shows as
 * "unavailable", and never fail the roster.
 */
object AgentsWire {
    const val MAX_RUNNING = 30
    const val MAX_DONE = 20
    const val MAX_FLEET = 50
    const val MAX_TIMELINE = 60
    const val MAX_TYPE = 40
    const val MAX_MODEL = 40
    const val MAX_DESC = 120
    const val MAX_HEADLINE = 120
    const val MAX_NARRATION = 160
    const val MAX_DETAIL = 120
    const val MAX_PROMPT = 1200
    const val MAX_NAME = 60
    const val MAX_LABEL = 80
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
    private val KEY_RE = Regex("^[A-Za-z0-9_-]{8,64}$")
    private val ID_RE = Regex("^[A-Za-z0-9_-]{1,64}$")

    fun decode(d: JSONObject): AgentsSnapshot? {
        val computedAtMs = whole(d.opt("computedAtMs")) ?: return null
        val running = running(d.optJSONArray("running")) ?: return null
        val done = done(d.optJSONArray("done")) ?: return null
        return AgentsSnapshot(computedAtMs, running, done, fleet(d.opt("fleet")), timeline(d.opt("timeline")))
    }

    private fun running(a: JSONArray?): List<RunningAgent>? {
        if (a == null || a.length() > MAX_RUNNING) return null
        val out = ArrayList<RunningAgent>(a.length())
        for (i in 0 until a.length()) {
            val r = a.optJSONObject(i) ?: return null
            val needsInput = r.opt("needsInput") as? Boolean ?: return null
            if (!r.has("anomaly")) return null
            val anomaly: AgentAnomaly? = if (r.isNull("anomaly")) null else (anomaly(r.optJSONObject("anomaly")) ?: return null)
            if (needsInput != (anomaly != null)) return null
            out += RunningAgent(
                id(r.opt("id")) ?: return null,
                text(r.opt("type"), MAX_TYPE) ?: return null,
                text(r.opt("description"), MAX_DESC) ?: return null,
                whole(r.opt("startedAtMs")) ?: return null,
                (nullableText(r, "model", MAX_MODEL) ?: return null).value,
                text(r.opt("headline"), MAX_HEADLINE) ?: return null,
                (nullableText(r, "narration", MAX_NARRATION) ?: return null).value,
                needsInput,
                anomaly,
                text(r.opt("prompt"), MAX_PROMPT) ?: return null,
            )
        }
        return out
    }

    private fun anomaly(o: JSONObject?): AgentAnomaly? {
        if (o == null) return null
        val kind = AnomalyKind.values().firstOrNull { it.wire == o.opt("kind") } ?: return null
        return AgentAnomaly(kind, text(o.opt("detail"), MAX_DETAIL) ?: return null)
    }

    private fun done(a: JSONArray?): List<DoneAgent>? {
        if (a == null || a.length() > MAX_DONE) return null
        val out = ArrayList<DoneAgent>(a.length())
        for (i in 0 until a.length()) {
            val r = a.optJSONObject(i) ?: return null
            out += DoneAgent(
                id(r.opt("id")) ?: return null,
                text(r.opt("type"), MAX_TYPE) ?: return null,
                text(r.opt("description"), MAX_DESC) ?: return null,
                whole(r.opt("startedAtMs")) ?: return null,
                (nullableWhole(r, "tokens", required = true) ?: return null).value,
                (nullableWhole(r, "toolUses", required = true) ?: return null).value,
                (nullableWhole(r, "durationMs", required = true) ?: return null).value,
                text(r.opt("headline"), MAX_HEADLINE) ?: return null,
            )
        }
        return out
    }

    private fun fleet(v: Any?): List<FleetRow>? {
        val a = v as? JSONArray ?: return null
        if (a.length() > MAX_FLEET) return null
        val seen = HashSet<String>()
        val out = ArrayList<FleetRow>(a.length())
        for (i in 0 until a.length()) {
            val r = a.optJSONObject(i) ?: return null
            val key = (r.opt("key") as? String)?.takeIf { KEY_RE.matches(it) } ?: return null
            if (!seen.add(key)) return null
            out += FleetRow(
                key,
                text(r.opt("title"), MAX_NAME) ?: return null,
                text(r.opt("name"), MAX_NAME) ?: return null,
                whole(r.opt("startedAtMs")) ?: return null,
                FleetStatus.values().firstOrNull { it.wire == r.opt("status") } ?: return null,
                text(r.opt("kind"), MAX_TYPE) ?: return null,
                (nullableWhole(r, "pid", required = false) ?: return null).value,
            )
        }
        return out
    }

    private fun timeline(v: Any?): List<TimelineItem>? {
        val a = v as? JSONArray ?: return null
        if (a.length() > MAX_TIMELINE) return null
        val out = ArrayList<TimelineItem>(a.length())
        for (i in 0 until a.length()) {
            val r = a.optJSONObject(i) ?: return null
            out += TimelineItem(
                TimelineKind.values().firstOrNull { it.wire == r.opt("k") } ?: return null,
                whole(r.opt("atMs")) ?: return null,
                text(r.opt("label"), MAX_LABEL) ?: return null,
                (nullableWhole(r, "tokens", required = false) ?: return null).value,
                (nullableWhole(r, "toolUses", required = false) ?: return null).value,
                (nullableWhole(r, "durationMs", required = false) ?: return null).value,
            )
        }
        return out
    }

    private fun id(v: Any?): String? = (v as? String)?.takeIf { ID_RE.matches(it) }

    /** A string within [max] UTF-16 units. Empty is allowed: masking can legitimately empty a field. */
    private fun text(v: Any?, max: Int): String? = (v as? String)?.takeIf { it.length <= max }

    /** Required-key nullable string; the [Opt] wrapper separates a legitimate JSON null from a failed decode (null). */
    private fun nullableText(o: JSONObject, key: String, max: Int): Opt<String>? {
        if (!o.has(key)) return null
        if (o.isNull(key)) return Opt(null)
        return Opt(text(o.opt(key), max) ?: return null)
    }

    /** Nullable whole number; with [required] false an absent key reads as null (see [nullableText] for the wrapper). */
    private fun nullableWhole(o: JSONObject, key: String, required: Boolean): Opt<Long>? {
        if (!o.has(key)) return if (required) null else Opt(null)
        if (o.isNull(key)) return Opt(null)
        return Opt(whole(o.opt(key)) ?: return null)
    }

    private fun whole(v: Any?): Long? {
        val n = v as? Number ?: return null
        val dv = n.toDouble()
        if (!dv.isFinite() || dv < 0.0 || dv != Math.floor(dv) || dv > MAX_SAFE_INTEGER) return null
        return n.toLong()
    }

    private class Opt<T>(val value: T?)
}
