package com.matt.aethermobile.dashboard

import java.time.Instant
import java.time.ZoneId
import java.util.Locale

/** The em dash the desktop prints wherever a readout has no real source (NO_DATA). "No data" is never 0. */
const val NO_DATA = "—"

/** Desktop computeDashStatus: an alarm always wins; otherwise a quiet console reads STANDBY, not NOMINAL. [label] is the English fallback. */
enum class DashStatus(val label: String) { NOMINAL("NOMINAL"), STANDBY("STANDBY"), ELEVATED("ELEVATED"), BURN_ALARM("BURN ALARM") }

fun dashStatus(s: DashSnapshot): DashStatus = when {
    s.alarm == DashAlarm.CRIT -> DashStatus.BURN_ALARM
    s.alarm == DashAlarm.WARN -> DashStatus.ELEVATED
    s.live -> DashStatus.NOMINAL
    else -> DashStatus.STANDBY
}

/** Glow-Is-State (desktop statusDotGlows): lit while live or alarmed, flat at STANDBY. */
fun statusGlows(s: DashSnapshot): Boolean = s.live || s.alarm != DashAlarm.OK

/**
 * The line under the reactor. Live and scanned: "92,000 tok/min". Otherwise the idle line "— tok/min · standby"
 * (the desktop appends its pulse mode, which needs cfg the phone never receives, so a live reading with no rate is
 * just "— tok/min").
 */
fun rateLine(s: DashSnapshot): String {
    val rate = s.ratePerMin
    if (s.live && rate != null) return "${groupedInt(Math.round(rate))} tok/min"
    return if (s.live) "$NO_DATA tok/min" else "$NO_DATA tok/min · standby"
}

enum class EtaChip(val label: String) { LIVE("LIVE"), STALE("STALE"), EST("EST") }

/**
 * ETA tile. [value] is "—", "now", or the duration with a "~" prefix when it is an estimate (scan source) or stale.
 * [resetsText] is the server rate-limit reset countdown ("1h 30m", "now", "—"), present only for a statusline
 * source (live or stale) and measured at publish time. [chip] is null when there is no value to attribute.
 * Deviation from desktop: desktop prefixes a STALE "now" with "~" ("~now"); the phone shows plain "now" for every source.
 */
data class DashEtaUi(val value: String, val chip: EtaChip?, val resetsText: String?)

fun etaUi(k: DashKpis): DashEtaUi {
    val e = k.eta
    val statusline = e.source != EtaSource.SCAN
    // A scan-sourced ETA projects from the month's token count; with no scan there is nothing to project from.
    // A statusline ETA is the server's own and does not depend on the scan.
    val part = when {
        k.monthTokens == null && !statusline -> NO_DATA
        e.kind == EtaKind.NONE -> NO_DATA
        e.kind == EtaKind.NOW -> "now"
        else -> duration(e.secs ?: 0L)
    }
    val estimate = part != NO_DATA && part != "now"
    val prefix = if (estimate && e.source != EtaSource.LIVE) "~" else ""
    val chip = when {
        part == NO_DATA -> null
        e.source == EtaSource.LIVE -> EtaChip.LIVE
        e.source == EtaSource.STALE -> EtaChip.STALE
        else -> EtaChip.EST
    }
    return DashEtaUi("$prefix$part", chip, if (statusline) resetCountdown(e.resetsInMs) else null)
}

enum class KpiKey(val label: String) {
    MONTH_TOKENS("MONTH TOKENS"), DEPLETION_ETA("DEPLETION ETA"), TODAY("TODAY"), BUDGET_LEFT("BUDGET LEFT")
}

/** [caption] is the English fallback ("this month", "at current draw", "API rate, not paid", "of 500.0M cap"). */
data class KpiTile(val key: KpiKey, val value: String, val caption: String, val eta: DashEtaUi?)

/** Desktop computeDashKpis order and formats; null is "—" and a scan-less month never reads "0.0%" or "now". */
fun kpiTiles(s: DashSnapshot): List<KpiTile> {
    val k = s.kpis
    val eta = etaUi(k)
    val etaValue = if (eta.resetsText != null) "${eta.value} · resets ${eta.resetsText}" else eta.value
    return listOf(
        KpiTile(KpiKey.MONTH_TOKENS, k.monthTokens?.let { shortCount(it.toDouble()) } ?: NO_DATA, "this month", null),
        KpiTile(KpiKey.DEPLETION_ETA, etaValue, if (eta.resetsText != null) "server rate limit" else "at current draw", eta),
        KpiTile(KpiKey.TODAY, k.todayUsd?.let { usdPrecise(it) } ?: NO_DATA, "API rate, not paid", null),
        KpiTile(
            KpiKey.BUDGET_LEFT,
            if (k.monthTokens == null || k.budgetLeftPct == null) NO_DATA else String.format(Locale.US, "%.1f%%", k.budgetLeftPct),
            String.format(Locale.US, "of %.1fM cap", k.capM),
            null,
        ),
    )
}

/**
 * The English sentence variants of desktop computeReadiness, as keys the screen maps to strings.xml. A withTime
 * copy takes one argument, the time from [formatReadinessTime].
 */
enum class ReadinessCopy(val english: String, val withTime: Boolean) {
    DESKTOP_RUNNING("Desktop app: running.", false),
    DESKTOP_NOT_RUNNING("Desktop app: not running.", false),
    TERMINAL_NONE("Terminal: no session yet.", false),
    TERMINAL_OPEN("Terminal: open.", false),
    TERMINAL_OPEN_SINCE("Terminal: open since %s.", true),
    STATUSLINE_NONE("Statusline: no reading yet.", false),
    STATUSLINE_LIVE("Statusline: live, %s.", true),
    STATUSLINE_LAST("Statusline: last reading %s.", true),
    COLLECTOR_NOT_RUNNING("Collector: not running.", false),
    COLLECTOR_NO_EVENTS("Collector: running, no events in the last 24h.", false),
    COLLECTOR_LAST_EVENT("Collector: running, last event %s.", true),
}

/** [time] is the formatted instant for a withTime copy, else null. [text] is the finished English fallback. */
data class ReadinessRowUi(val key: ReadinessKey, val met: Boolean, val glows: Boolean, val copy: ReadinessCopy, val time: String?, val text: String)

/**
 * Desktop computeReadiness wording, picked from key + met + atMs. The phone only ever hears from a running desktop
 * app, so a missing desktop/collector is "not running". Unmet-row hints are not carried (they name desktop commands).
 * Glow is the wire's `glows`, never recomputed.
 */
fun readinessRows(s: DashSnapshot, nowMs: Long, zone: ZoneId): List<ReadinessRowUi> = s.readiness.map { r ->
    val copy = when (r.key) {
        ReadinessKey.DESKTOP -> if (r.met) ReadinessCopy.DESKTOP_RUNNING else ReadinessCopy.DESKTOP_NOT_RUNNING
        ReadinessKey.TERMINAL -> when {
            !r.met -> ReadinessCopy.TERMINAL_NONE
            r.atMs == null -> ReadinessCopy.TERMINAL_OPEN
            else -> ReadinessCopy.TERMINAL_OPEN_SINCE
        }
        ReadinessKey.STATUSLINE -> when {
            r.atMs == null -> ReadinessCopy.STATUSLINE_NONE
            r.met -> ReadinessCopy.STATUSLINE_LIVE
            else -> ReadinessCopy.STATUSLINE_LAST
        }
        ReadinessKey.COLLECTOR -> when {
            !r.met -> ReadinessCopy.COLLECTOR_NOT_RUNNING
            r.atMs == null -> ReadinessCopy.COLLECTOR_NO_EVENTS
            else -> ReadinessCopy.COLLECTOR_LAST_EVENT
        }
    }
    val time = if (copy.withTime) r.atMs?.let { formatReadinessTime(it, nowMs, zone) } else null
    ReadinessRowUi(r.key, r.met, r.glows, copy, time, if (time != null) copy.english.format(time) else copy.english)
}

private val MONTHS = arrayOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/** Desktop formatReadinessTime: "HH:MM", or "Mon D HH:MM" when [atMs] is not on [nowMs]'s calendar day, in [zone] (the phone's zone, not the desktop's). */
fun formatReadinessTime(atMs: Long, nowMs: Long, zone: ZoneId): String {
    val t = Instant.ofEpochMilli(atMs).atZone(zone)
    val now = Instant.ofEpochMilli(nowMs).atZone(zone)
    val hhmm = String.format(Locale.US, "%02d:%02d", t.hour, t.minute)
    return if (t.toLocalDate() == now.toLocalDate()) hhmm else "${MONTHS[t.monthValue - 1]} ${t.dayOfMonth} $hhmm"
}

enum class StripKey(val label: String) { AGENTS("Agents"), ALERTS("Alerts"), MEMORY("Memory") }

/** [unit] is "engram"/"engrams" for memory, else null. */
data class StripItemUi(val key: StripKey, val count: Long, val unit: String?)

/**
 * Desktop computeStripItems labels and memory unit. Unlike the desktop, which lists only digests with nothing to
 * show, the phone has no digest panels, so all three counts are listed. Projects are not in the payload.
 */
fun stripItems(s: DashSnapshot): List<StripItemUi> = listOf(
    StripItemUi(StripKey.AGENTS, s.strip.agents, null),
    StripItemUi(StripKey.ALERTS, s.strip.alerts, null),
    StripItemUi(StripKey.MEMORY, s.strip.memory, if (s.strip.memory == 1L) "engram" else "engrams"),
)

/** RecapBanner sentence: zero-count parts are omitted, tokens burned is always last. Null when there is no recap. */
fun recapSentence(s: DashSnapshot): String? {
    val r = s.recap ?: return null
    val parts = ArrayList<String>()
    if (r.dispatches > 0) parts += "${r.dispatches} ${if (r.dispatches == 1L) "dispatch" else "dispatches"} completed"
    if (r.anomaliesDetected > 0) parts += "${r.anomaliesDetected} ${if (r.anomaliesDetected == 1L) "anomaly" else "anomalies"} detected"
    if (r.anomaliesCleared > 0) parts += "${r.anomaliesCleared} ${if (r.anomaliesCleared == 1L) "anomaly" else "anomalies"} cleared"
    parts += "${groupedInt(r.tokensBurned)} tokens burned"
    return "Since you last looked: ${parts.joinToString(", ")}."
}

/** How old the reading is. The snapshot is judged at computedAtMs and is never re-derived live, so the screen must show this. Clamped at 0 for clock skew. */
fun publishAgeMs(s: DashSnapshot, nowMs: Long): Long = (nowMs - s.computedAtMs).coerceAtLeast(0L)

/** "just now" under 5s, then "12s ago", "3m ago", "2h ago", "3d ago" (English fallback). */
fun publishAgeLabel(ageMs: Long): String {
    val sec = ageMs / 1000
    return when {
        sec < 5 -> "just now"
        sec < 60 -> "${sec}s ago"
        sec < 3600 -> "${sec / 60}m ago"
        sec < 86_400 -> "${sec / 3600}h ago"
        else -> "${sec / 86_400}d ago"
    }
}

// ---- formatting helpers (desktop utils/format.ts and ledger/format.ts, en-US) ----

private fun groupedInt(n: Long): String = String.format(Locale.US, "%,d", n)

/** Desktop short(): two decimals above a million, one above a thousand. */
private fun shortCount(n: Double): String = when {
    n >= 1e6 -> String.format(Locale.US, "%.2fM", n / 1e6)
    n >= 1e3 -> String.format(Locale.US, "%.1fK", n / 1e3)
    else -> Math.round(n).toString()
}

/** Desktop usdPrecise(): "<$0.01" for a real sub-cent amount, else "$12.50". */
private fun usdPrecise(v: Double): String = if (v > 0 && v < 0.005) "<\$0.01" else String.format(Locale.US, "\$%.2f", v)

/** Desktop fmtEta, but 0 reads "0m" rather than "n/a". */
private fun duration(secs: Long): String {
    val h = secs / 3600
    val m = (secs % 3600) / 60
    return if (h > 0) "${h}h ${m}m" else "${m}m"
}

/** Desktop formatResetCountdown. */
private fun resetCountdown(ms: Long?): String {
    if (ms == null) return NO_DATA
    if (ms <= 0) return "now"
    val totalMinutes = ms / 60_000
    val h = totalMinutes / 60
    val m = totalMinutes % 60
    return if (h > 0) "${h}h ${m}m" else "${m}m"
}
