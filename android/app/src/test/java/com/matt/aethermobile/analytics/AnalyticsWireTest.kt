package com.matt.aethermobile.analytics

import com.matt.aethermobile.ledger.AgeLabel
import com.matt.aethermobile.protocol.ControlProtocol
import com.matt.aethermobile.views.ViewHost
import com.matt.aethermobile.views.ViewUi
import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AnalyticsWireTest {
    private val golden: String = JSONObject(File("../../protocol/mobile-protocol.json").readText(Charsets.UTF_8))
        .getJSONObject("frames").getString("viewSnapAnalytics")

    private fun goldenD() = JSONObject(golden).getJSONObject("d")
    private fun snap() = AnalyticsWire.decode(goldenD())!!
    private fun ui() = analyticsUi(snap())
    private fun snapOf(burn: BurnRow) = snap().copy(burn = listOf(burn))

    @Test fun decodesTheRealGolden() {
        val s = snap()
        assertEquals(1790000000000L, s.computedAtMs)
        assertEquals(AnalyticsLogs(41, 128, 3, 9), s.logs)
        assertEquals(listOf("general-purpose", "Explore"), s.longest.map { it.type })
        assertEquals(1789999400000L, s.longest[0].startedAtMs)
        assertEquals(37L, s.burn[0].toolUses)
        assertNull(s.burn[1].toolUses)
        assertEquals(482000.0, s.burn[0].tokens, 0.0)
        assertEquals(listOf("status" to 9L, "budget" to 4L), s.commands.map { it.name to it.count })
    }

    @Test fun goldenFrameParsesThroughViewFrameAndHost() {
        val host = ViewHost("analytics", AnalyticsWire::decode, { true }, { true }, { true }, { 5L })
        host.onConnected(); host.activate(true)
        host.onFrame(ControlProtocol.parseViewFrame(golden)!!)
        assertTrue(host.snapshot() is ViewUi.Ready)
    }

    @Test fun wrongTypeAnywhereIsNullNeverAThrow() {
        assertNull(AnalyticsWire.decode(JSONObject()))
        assertNull(AnalyticsWire.decode(goldenD().apply { put("computedAtMs", "1") }))
        assertNull(AnalyticsWire.decode(goldenD().apply { remove("computedAtMs") }))
        assertNull(AnalyticsWire.decode(goldenD().apply { getJSONObject("logs").put("info", "128") }))
        assertNull(AnalyticsWire.decode(goldenD().apply { getJSONObject("logs").put("info", -1) }))
        assertNull(AnalyticsWire.decode(goldenD().apply { getJSONObject("logs").remove("other") }))
        assertNull(AnalyticsWire.decode(goldenD().apply { put("longest", JSONObject()) }))
        assertNull(AnalyticsWire.decode(goldenD().apply { getJSONArray("longest").put(0, 7) }))
        assertNull(AnalyticsWire.decode(goldenD().apply { getJSONArray("longest").getJSONObject(0).put("startedAtMs", "1") }))
        assertNull(AnalyticsWire.decode(goldenD().apply { getJSONArray("burn").getJSONObject(0).put("tokens", "482000") }))
        assertNull(AnalyticsWire.decode(goldenD().apply { getJSONArray("burn").getJSONObject(0).put("tokens", -5) }))
        assertNull(AnalyticsWire.decode(goldenD().apply { getJSONArray("burn").getJSONObject(0).put("toolUses", "37") }))
        assertNull(AnalyticsWire.decode(goldenD().apply { getJSONArray("burn").getJSONObject(0).remove("toolUses") }))
        assertNull(AnalyticsWire.decode(goldenD().apply { getJSONArray("commands").getJSONObject(0).put("name", "two words") }))
        assertNull(AnalyticsWire.decode(goldenD().apply { getJSONArray("commands").getJSONObject(0).put("count", 1.5) }))
        assertNull(AnalyticsWire.decode(goldenD().apply { put("commands", JSONArray(List(6) { JSONObject().put("name", "a").put("count", 1) })) }))
    }

    @Test fun strayKeysAreIgnored() {
        val d = goldenD().apply {
            put("prompt", "secret")
            getJSONObject("logs").put("raw", "x")
            getJSONArray("burn").getJSONObject(0).put("cmd", "rm -rf /")
        }
        assertEquals(snap(), AnalyticsWire.decode(d))
    }

    @Test fun logTilesAndShareFractions() {
        val l = ui().logs
        assertEquals(181L, l.total)
        assertTrue(l.shareBarVisible)
        assertEquals(41.0 / 181.0, l.tiles[0].fraction, 1e-12)
        assertEquals(1.0, l.tiles.sumOf { it.fraction }, 1e-12)
    }

    @Test fun zeroLogTotalGivesAllZeroFractionsAndHidesShareBar() {
        val l = analyticsUi(snap().copy(logs = AnalyticsLogs(0, 0, 0, 0))).logs
        assertEquals(listOf(0.0, 0.0, 0.0, 0.0), l.tiles.map { it.fraction })
        assertTrue(!l.shareBarVisible)
    }

    @Test fun elapsedIsMmSsUnderAnHourAndHoursMinutesOver() {
        assertEquals("00:00", formatElapsed(0))
        assertEquals("09:59", formatElapsed(599_999))
        assertEquals("59:59", formatElapsed(3_599_000))
        assertEquals("1h 00m", formatElapsed(3_600_000))
        assertEquals("2h 05m", formatElapsed(2 * 3_600_000L + 5 * 60_000L + 59_000L))
        assertEquals("00:00", formatElapsed(-5_000))
    }

    @Test fun longestElapsedUsesTitanClockOffset() {
        val started = 1789999400000L
        // phone is 10 min behind titan: phone now = started, offset +600s -> titan now = started + 600s
        assertEquals("10:00", longestElapsed(started, started, 600_000L))
        assertEquals("00:00", longestElapsed(started, started, 0L))
    }

    @Test fun burnBarsAreShareOfTheMax() {
        val b = ui().burn
        assertEquals(1.0, b[0].barFraction, 0.0)
        assertEquals(96000.0 / 482000.0, b[1].barFraction, 1e-12)
        val zero = analyticsUi(snap().copy(burn = listOf(BurnRow("t", "d", 0.0, 1, 0.0)))).burn[0]
        assertEquals(0.0, zero.barFraction, 0.0)
    }

    @Test fun tokPerCallNeverDividesByZeroNorShowsZero() {
        val b = ui().burn
        assertEquals("13.0K", b[0].tokPerCall)
        assertNull(b[1].tokPerCall) // toolUses null in the golden
        assertNull(b[1].callsText)
        assertNull(analyticsUi(snapOf(BurnRow("t", "d", 5000.0, 0, 1.0))).burn[0].tokPerCall)
        assertNull(analyticsUi(snapOf(BurnRow("t", "d", 0.0, 4, 1.0))).burn[0].tokPerCall)
        assertNull(analyticsUi(snapOf(BurnRow("t", "d", 1.0, 4, 1.0))).burn[0].tokPerCall)
        assertEquals("1", analyticsUi(snapOf(BurnRow("t", "d", 4.0, 4, 1.0))).burn[0].tokPerCall)
        assertEquals("0", analyticsUi(snapOf(BurnRow("t", "d", 0.0, 0, 1.0))).burn[0].callsText)
    }

    @Test fun commandBarsAreShareOfTheMax() {
        val c = ui().commands
        assertEquals(1.0, c[0].barFraction, 0.0)
        assertEquals(4.0 / 9.0, c[1].barFraction, 1e-12)
    }

    @Test fun emptyListsCarryTheDesktopSentencesVerbatim() {
        val u = analyticsUi(snap().copy(longest = emptyList(), burn = emptyList(), commands = emptyList()))
        assertEquals("No agents are running.", u.emptyLongest)
        assertEquals("No completed dispatches with real usage data yet.", u.emptyBurn)
        assertEquals("No commands run yet.", u.emptyCommands)
        val full = ui()
        assertNull(full.emptyLongest); assertNull(full.emptyBurn); assertNull(full.emptyCommands)
    }

    @Test fun ageUsesTitanClockOffset() {
        val t = 1_000_000_000_000L
        assertEquals(AgeLabel.Minutes(10), analyticsAge(t, t, 600_000L))
        assertEquals(AgeLabel.JustNow, analyticsAge(t, t, 0L))
    }
}
