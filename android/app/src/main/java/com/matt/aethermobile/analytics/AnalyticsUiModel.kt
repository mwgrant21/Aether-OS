package com.matt.aethermobile.analytics

import com.matt.aethermobile.ledger.AgeLabel
import com.matt.aethermobile.ledger.ageLabel
import java.util.Locale

/** Desktop empty-state sentences, verbatim (AgentBreakdownCard, TokenBurnCard, TopCommandsCard). P10 puts them in res. */
const val EMPTY_LONGEST = "No agents are running."
const val EMPTY_BURN = "No completed dispatches with real usage data yet."
const val EMPTY_COMMANDS = "No commands run yet."

enum class LogKind { SUCCESS, INFO, DENIED, OTHER }

/** One log tile; [fraction] is count / total of the four counts (0.0 when the total is 0). */
data class LogTileUi(val kind: LogKind, val count: Long, val fraction: Double)

/** [shareBarVisible] is false when all four counts are 0; the four fractions are then all 0.0. */
data class LogsUi(val tiles: List<LogTileUi>, val total: Long, val shareBarVisible: Boolean)

/** Elapsed is not stored: it ticks, so the screen calls [longestElapsed] with [startedAtMs] each second. */
data class LongestRowUi(val type: String, val description: String, val startedAtMs: Long)

/** [tokPerCall] is null (row shows nothing) when toolUses is null or 0, or the ratio rounds to 0. */
data class BurnRowUi(
    val type: String,
    val description: String,
    val tokensText: String,
    val callsText: String?,
    val tokPerCall: String?,
    val durationMs: Long,
    val barFraction: Double,
)

data class CommandRowUi(val name: String, val count: Long, val barFraction: Double)

data class AnalyticsUi(
    val computedAtMs: Long,
    val logs: LogsUi,
    val longest: List<LongestRowUi>,
    val burn: List<BurnRowUi>,
    val commands: List<CommandRowUi>,
    val emptyLongest: String?,
    val emptyBurn: String?,
    val emptyCommands: String?,
)

/** Share of [max]: value / max clamped to 0..1; a zero or empty max gives 0.0, never NaN. */
fun shareOfMax(value: Double, max: Double): Double = if (max > 0.0) (value / max).coerceIn(0.0, 1.0) else 0.0

/** Compact token count like the desktop `short()`: 1.50M, 12.3K, or the rounded number. */
fun shortCount(n: Double): String = when {
    n >= 1e6 -> String.format(Locale.US, "%.2fM", n / 1e6)
    n >= 1e3 -> String.format(Locale.US, "%.1fK", n / 1e3)
    else -> Math.round(n).toString()
}

/**
 * Tokens per tool call. Null when toolUses is null or 0 (no division is attempted) and when the ratio would display
 * as "0" (tokens 0, or under half a token per call): a missing value is never shown as zero.
 */
fun tokPerCall(tokens: Double, toolUses: Long?): String? {
    if (toolUses == null || toolUses <= 0L) return null
    val ratio = tokens / toolUses.toDouble()
    if (!ratio.isFinite() || Math.round(ratio) <= 0L) return null
    return shortCount(ratio)
}

/** "mm:ss" under an hour, "Xh YYm" from an hour up. Negative (start after now, clock skew) clamps to 00:00. */
fun formatElapsed(ms: Long): String {
    val total = (if (ms < 0L) 0L else ms) / 1_000L
    val h = total / 3_600L
    val m = (total % 3_600L) / 60L
    return if (h > 0L) String.format(Locale.US, "%dh %02dm", h, m)
    else String.format(Locale.US, "%02d:%02d", m, total % 60L)
}

/** Elapsed of a longest-running dispatch on titan's clock: titan time = phone now + titanClockOffsetMs. */
fun longestElapsed(startedAtMs: Long, phoneNowMs: Long, titanClockOffsetMs: Long): String =
    formatElapsed(phoneNowMs + titanClockOffsetMs - startedAtMs)

fun analyticsUi(s: AnalyticsSnapshot): AnalyticsUi {
    val counts = listOf(s.logs.success, s.logs.info, s.logs.denied, s.logs.other)
    val total = counts.sum()
    val tiles = LogKind.values().mapIndexed { i, k ->
        LogTileUi(k, counts[i], if (total > 0L) counts[i].toDouble() / total.toDouble() else 0.0)
    }
    val maxTokens = s.burn.maxOfOrNull { it.tokens } ?: 0.0
    val burn = s.burn.map { r ->
        BurnRowUi(
            r.type, r.description, shortCount(r.tokens), r.toolUses?.toString(), tokPerCall(r.tokens, r.toolUses),
            Math.round(r.durationMs), shareOfMax(r.tokens, maxTokens),
        )
    }
    val maxCount = (s.commands.maxOfOrNull { it.count } ?: 0L).toDouble()
    val commands = s.commands.map { CommandRowUi(it.name, it.count, shareOfMax(it.count.toDouble(), maxCount)) }
    val longest = s.longest.map { LongestRowUi(it.type, it.description, it.startedAtMs) }
    return AnalyticsUi(
        s.computedAtMs, LogsUi(tiles, total, total > 0L), longest, burn, commands,
        EMPTY_LONGEST.takeIf { longest.isEmpty() }, EMPTY_BURN.takeIf { burn.isEmpty() }, EMPTY_COMMANDS.takeIf { commands.isEmpty() },
    )
}

/** Age of the snapshot on titan's clock, the same label the Projects pane uses. */
fun analyticsAge(computedAtMs: Long, phoneNowMs: Long, titanClockOffsetMs: Long): AgeLabel =
    ageLabel(computedAtMs, phoneNowMs + titanClockOffsetMs)
