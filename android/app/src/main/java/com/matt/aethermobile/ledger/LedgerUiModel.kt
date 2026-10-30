package com.matt.aethermobile.ledger

import com.matt.aethermobile.protocol.ControlProtocol
import java.util.Locale

// Pure formatting and state helpers for the Ledger body. Locale.US everywhere: no `912,34` on a German phone. 
enum class PartKind { INPUT, OUTPUT, CACHE_WRITE, CACHE_READ }
data class Part(val kind: PartKind, val usd: Double, val fraction: Double)

enum class BucketKind { TODAY, WEEK, MONTH }
data class Bucket(val kind: BucketKind, val usd: Double?)

sealed interface AgeLabel {
    data object JustNow : AgeLabel
    data class Minutes(val n: Long) : AgeLabel
    data class Hours(val n: Long) : AgeLabel
    data class Days(val n: Long) : AgeLabel
}

const val STALE_AFTER_MS = 5 * 60_000L

fun usd(v: Double): String = String.format(Locale.US, "$%.2f", v)

fun usdPrecise(v: Double): String = if (v > 0 && v < 0.005) "<$0.01" else usd(v)

fun tokensCompact(n: Long): String = when {
    n < 1_000L -> n.toString()
    n < 1_000_000L -> String.format(Locale.US, "%.1fK", n / 1_000.0)
    n < 1_000_000_000L -> String.format(Locale.US, "%.1fM", n / 1_000_000.0)
    else -> String.format(Locale.US, "%.1fB", n / 1_000_000_000.0)
}

fun hitPercent(r: Double): String = String.format(Locale.US, "%.1f%%", r * 100)

fun hitFraction(r: Double): Float = if (r.isNaN()) 0f else r.coerceIn(0.0, 1.0).toFloat()

fun shares(t: ControlProtocol.LedgerTotal): List<Part> {
    val parts = listOf(
        PartKind.INPUT to t.input,
        PartKind.OUTPUT to t.output,
        PartKind.CACHE_WRITE to t.cacheCreation,
        PartKind.CACHE_READ to t.cacheRead,
    )
    val sum = parts.sumOf { it.second }
    return parts.map { (k, v) -> Part(k, v, if (sum > 0.0) v / sum else 0.0) }
}

fun rollupOf(r: ControlProtocol.LedgerRollups): List<Bucket> = listOf(
    Bucket(BucketKind.TODAY, r.today),
    Bucket(BucketKind.WEEK, r.week),
    Bucket(BucketKind.MONTH, r.month),
)

fun ageLabel(computedAtMs: Long, nowMs: Long): AgeLabel {
    val s = (nowMs - computedAtMs) / 1_000L
    return when {
        s < 60L -> AgeLabel.JustNow // includes a future timestamp (clock skew)
        s < 3_600L -> AgeLabel.Minutes(s / 60L)
        s < 48L * 3_600L -> AgeLabel.Hours(s / 3_600L)
        else -> AgeLabel.Days(s / 86_400L)
    }
}

fun isStale(computedAtMs: Long, nowMs: Long): Boolean = nowMs - computedAtMs > STALE_AFTER_MS

/** Tier wires joined with ", "; null when empty (screen prints "no priced activity observed"). */
fun tierLine(tiers: List<ControlProtocol.LedgerTier>): String? =
    if (tiers.isEmpty()) null else tiers.joinToString(", ") { it.wire }
