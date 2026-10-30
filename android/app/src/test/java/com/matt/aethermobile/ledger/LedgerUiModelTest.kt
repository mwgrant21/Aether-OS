package com.matt.aethermobile.ledger

import com.matt.aethermobile.protocol.ControlProtocol.LedgerRollups
import com.matt.aethermobile.protocol.ControlProtocol.LedgerTier
import com.matt.aethermobile.protocol.ControlProtocol.LedgerTotal
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LedgerUiModelTest {
    @Test fun usdTwoDecimalsNoGrouping() {
        assertEquals("$912.34", usd(912.34))
        assertEquals("$1234567.50", usd(1234567.5))
    }

    @Test fun usdIgnoresDefaultLocale() {
        val old = Locale.getDefault()
        try {
            Locale.setDefault(Locale.GERMANY)
            assertEquals("$912.34", usd(912.34))
            assertEquals("52.6M", tokensCompact(52_560_000))
            assertEquals("89.6%", hitPercent(0.896))
        } finally {
            Locale.setDefault(old)
        }
    }

    @Test fun usdPreciseShowsSubCent() {
        assertEquals("<$0.01", usdPrecise(0.001))
        assertEquals("$0.00", usdPrecise(0.0))
        assertEquals("$0.01", usdPrecise(0.005))
    }

    @Test fun tokensCompactBoundaries() {
        assertEquals("999", tokensCompact(999))
        assertEquals("1.0K", tokensCompact(1_000))
        assertEquals("999.5K", tokensCompact(999_499))
        assertEquals("1.0M", tokensCompact(999_999))
        assertEquals("1.0M", tokensCompact(1_000_000))
        assertEquals("52.6M", tokensCompact(52_560_000))
        assertEquals("2.0B", tokensCompact(2_000_000_000))
    }

    @Test fun hitPercentAndFractionClamp() {
        assertEquals("89.6%", hitPercent(0.896))
        assertEquals(1f, hitFraction(1.5), 0f)
        assertEquals(0f, hitFraction(-0.2), 0f)
        assertEquals(0.5f, hitFraction(0.5), 0f)
    }

    @Test fun sharesInCardOrderWithFractions() {
        val p = shares(LedgerTotal(10.0, 1.0, 2.0, 3.0, 4.0))
        assertEquals(listOf(PartKind.INPUT, PartKind.OUTPUT, PartKind.CACHE_WRITE, PartKind.CACHE_READ), p.map { it.kind })
        assertEquals(listOf(0.1, 0.2, 0.3, 0.4), p.map { it.fraction })
        assertEquals(3.0, p[2].usd, 0.0)
    }

    @Test fun sharesZeroSumGivesZeroNotNaN() {
        val p = shares(LedgerTotal(0.0, 0.0, 0.0, 0.0, 0.0))
        assertTrue(p.all { it.fraction == 0.0 })
    }

    @Test fun rollupNullStaysNull() {
        val b = rollupOf(LedgerRollups(null, 1.5, 0.0))
        assertEquals(listOf(BucketKind.TODAY, BucketKind.WEEK, BucketKind.MONTH), b.map { it.kind })
        assertNull(b[0].usd)
        assertEquals(1.5, b[1].usd!!, 0.0)
        assertEquals(0.0, b[2].usd!!, 0.0)
    }

    @Test fun ageLabelBuckets() {
        val t = 1_000_000_000_000L
        assertEquals(AgeLabel.JustNow, ageLabel(t, t + 59_000))
        assertEquals(AgeLabel.Minutes(1), ageLabel(t, t + 60_000))
        assertEquals(AgeLabel.Minutes(59), ageLabel(t, t + 3_599_000))
        assertEquals(AgeLabel.Hours(1), ageLabel(t, t + 3_600_000))
        assertEquals(AgeLabel.Hours(47), ageLabel(t, t + 47 * 3_600_000L + 1))
        assertEquals(AgeLabel.Days(2), ageLabel(t, t + 48 * 3_600_000L))
    }

    @Test fun futureTimestampIsJustNow() {
        assertEquals(AgeLabel.JustNow, ageLabel(2_000_000L, 1_000L))
    }

    @Test fun staleAfterFiveMinutes() {
        assertFalse(isStale(0, 300_000))
        assertTrue(isStale(0, 300_001))
    }

    @Test fun tierLineJoinsOrNullWhenEmpty() {
        assertEquals("opus, sonnet", tierLine(listOf(LedgerTier.OPUS, LedgerTier.SONNET)))
        assertNull(tierLine(emptyList()))
    }
}
