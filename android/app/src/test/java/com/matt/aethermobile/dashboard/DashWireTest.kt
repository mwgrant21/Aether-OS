package com.matt.aethermobile.dashboard

import com.matt.aethermobile.protocol.ControlProtocol
import com.matt.aethermobile.views.ViewHost
import com.matt.aethermobile.views.ViewUi
import java.io.File
import java.time.ZoneId
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DashWireTest {
    private val golden: String = JSONObject(File("../../protocol/mobile-protocol.json").readText(Charsets.UTF_8))
        .getJSONObject("frames").getString("viewSnapDash")

    private val utc = ZoneId.of("UTC")
    private val now = 1790000000000L // the golden's computedAtMs, 2026-09-21 14:13:20Z

    private fun goldenD() = JSONObject(golden).getJSONObject("d")
    private fun snap() = DashWire.decode(goldenD())!!
    private fun kpisOf(d: JSONObject) = d.getJSONObject("kpis")
    private fun etaOf(d: JSONObject) = kpisOf(d).getJSONObject("eta")

    /** The idle, never-scanned shape the desktop sends before the first transcript scan. */
    private fun unscanned() = goldenD().apply {
        put("live", false); put("alarm", "ok"); put("ratePerMin", JSONObject.NULL)
        kpisOf(this).put("monthTokens", JSONObject.NULL).put("budgetLeftPct", JSONObject.NULL).put("todayUsd", JSONObject.NULL)
        etaOf(this).put("kind", "none").put("secs", JSONObject.NULL).put("source", "scan").put("resetsInMs", JSONObject.NULL)
    }

    // ---- wire ----

    @Test fun decodesTheRealGolden() {
        val s = snap()
        assertEquals(1790000000000L, s.computedAtMs)
        assertTrue(s.live)
        assertEquals(DashAlarm.WARN, s.alarm)
        assertEquals(48210.0, s.ratePerMin!!, 0.0)
        assertEquals(182_400_000L, s.kpis.monthTokens)
        assertEquals(EtaKind.SECS, s.kpis.eta.kind)
        assertEquals(5400L, s.kpis.eta.secs)
        assertEquals(EtaSource.LIVE, s.kpis.eta.source)
        assertEquals(listOf(ReadinessKey.DESKTOP, ReadinessKey.TERMINAL, ReadinessKey.STATUSLINE, ReadinessKey.COLLECTOR), s.readiness.map { it.key })
        assertEquals(DashStrip(2, 3, 17), s.strip)
        assertEquals(DashRecap(4, 2, 1, 1_234_567), s.recap)
    }

    @Test fun goldenFrameParsesThroughViewFrameAndHost() {
        val f = ControlProtocol.parseViewFrame(golden)!!
        val host = ViewHost("dash", DashWire::decode, { true }, { true }, { true }, { 5L })
        host.onConnected(); host.activate(true)
        host.onFrame(f)
        assertTrue(host.snapshot() is ViewUi.Ready)
    }

    @Test fun nullsAndAbsentRecapDecode() {
        val s = DashWire.decode(unscanned().apply { put("recap", JSONObject.NULL) })!!
        assertNull(s.ratePerMin); assertNull(s.kpis.monthTokens); assertNull(s.kpis.todayUsd); assertNull(s.kpis.budgetLeftPct)
        assertNull(s.recap)
        assertNull(DashWire.decode(goldenD().apply { remove("recap") })!!.recap)
    }

    @Test fun strayKeysAreIgnored() {
        val d = goldenD().apply { put("cfg", JSONObject().put("x", 1)); put("note", "hi"); kpisOf(this).put("extra", true) }
        assertNotNull(DashWire.decode(d))
    }

    @Test fun wrongTypesAnywhereAreNullNeverAThrow() {
        assertNull(DashWire.decode(JSONObject()))
        assertNull(DashWire.decode(goldenD().apply { put("computedAtMs", "1") }))
        assertNull(DashWire.decode(goldenD().apply { put("live", "true") }))
        assertNull(DashWire.decode(goldenD().apply { put("alarm", "loud") }))
        assertNull(DashWire.decode(goldenD().apply { put("ratePerMin", "48210") }))
        assertNull(DashWire.decode(goldenD().apply { put("ratePerMin", -1) }))
        assertNull(DashWire.decode(goldenD().apply { kpisOf(this).put("monthTokens", 1.5) }))
        assertNull(DashWire.decode(goldenD().apply { kpisOf(this).put("budgetLeftPct", 101) }))
        assertNull(DashWire.decode(goldenD().apply { kpisOf(this).put("capM", 0) }))
        assertNull(DashWire.decode(goldenD().apply { remove("kpis") }))
        assertNull(DashWire.decode(goldenD().apply { remove("strip") }))
        assertNull(DashWire.decode(goldenD().apply { getJSONObject("strip").put("memory", -1) }))
        assertNull(DashWire.decode(goldenD().apply { getJSONObject("recap").put("tokensBurned", "x") }))
    }

    @Test fun inconsistentEtaIsNull() {
        assertNull(DashWire.decode(goldenD().apply { etaOf(this).put("kind", "none") }))
        assertNull(DashWire.decode(goldenD().apply { etaOf(this).put("secs", JSONObject.NULL) }))
        assertNull(DashWire.decode(goldenD().apply { etaOf(this).put("source", "guess") }))
    }

    @Test fun badReadinessRowsAreNull() {
        assertNull(DashWire.decode(goldenD().apply { getJSONArray("readiness").getJSONObject(0).put("key", "gpu") }))
        assertNull(DashWire.decode(goldenD().apply { getJSONArray("readiness").getJSONObject(1).put("key", "desktop") }))
        assertNull(DashWire.decode(goldenD().apply { getJSONArray("readiness").getJSONObject(0).put("met", 1) }))
        assertNull(DashWire.decode(goldenD().apply { getJSONArray("readiness").getJSONObject(1).put("atMs", "now") }))
        assertNull(DashWire.decode(goldenD().apply { getJSONArray("readiness").put(JSONObject().put("key", "desktop")) }))
    }

    // ---- UI model ----

    @Test fun statusFollowsAlarmThenLive() {
        assertEquals(DashStatus.ELEVATED, dashStatus(snap()))
        assertEquals("BURN ALARM", dashStatus(snap().copy(alarm = DashAlarm.CRIT, live = false)).label)
        assertEquals(DashStatus.NOMINAL, dashStatus(snap().copy(alarm = DashAlarm.OK, live = true)))
        assertEquals(DashStatus.STANDBY, dashStatus(snap().copy(alarm = DashAlarm.OK, live = false)))
        assertTrue(statusGlows(snap()))
        assertFalse(statusGlows(snap().copy(alarm = DashAlarm.OK, live = false)))
    }

    @Test fun rateLineLiveVersusStandby() {
        assertEquals("48,210 tok/min", rateLine(snap()))
        assertEquals("— tok/min · standby", rateLine(DashWire.decode(unscanned())!!))
    }

    @Test fun goldenTilesAndEta() {
        val t = kpiTiles(snap())
        assertEquals(listOf("182.40M", "1h 30m · resets 2h 30m", "$12.50", "63.5%"), t.map { it.value })
        assertEquals("of 500.0M cap", t[3].caption)
        assertEquals(EtaChip.LIVE, t[1].eta!!.chip)
    }

    @Test fun nullMonthTokensMakesBudgetAndEtaDashesNotZeroOrNow() {
        val tiles = kpiTiles(DashWire.decode(unscanned())!!)
        assertEquals(listOf(NO_DATA, NO_DATA, NO_DATA, NO_DATA), tiles.map { it.value })
        assertNull(tiles[1].eta!!.chip)
        // Even a (malformed-by-desktop) non-null pct or a "now" scan eta must not surface without a month reading.
        val s = DashWire.decode(unscanned().apply { kpisOf(this).put("budgetLeftPct", 0); etaOf(this).put("kind", "now") })!!
        assertEquals(NO_DATA, kpiTiles(s)[3].value)
        assertEquals(NO_DATA, kpiTiles(s)[1].value)
    }

    @Test fun etaMarksEstimatesAndStale() {
        fun eta(kind: String, secs: Any, source: String) = etaUi(
            DashWire.decode(goldenD().apply { etaOf(this).put("kind", kind).put("secs", secs).put("source", source) })!!.kpis,
        )
        assertEquals("~2h 5m", eta("secs", 7500, "scan").value)
        assertEquals(EtaChip.EST, eta("secs", 7500, "scan").chip)
        assertNull(eta("secs", 7500, "scan").resetsText)
        assertEquals("~45m", eta("secs", 2700, "stale").value)
        assertEquals(EtaChip.STALE, eta("secs", 2700, "stale").chip)
        assertEquals("now", eta("now", JSONObject.NULL, "scan").value)
        assertEquals("now", eta("now", JSONObject.NULL, "stale").value)
        assertEquals(NO_DATA, eta("none", JSONObject.NULL, "live").value)
    }

    @Test fun statuslineEtaSurvivesAMissingScan() {
        val s = DashWire.decode(unscanned().apply { etaOf(this).put("kind", "secs").put("secs", 600).put("source", "live").put("resetsInMs", 3_600_000) })!!
        assertEquals("10m · resets 1h 0m", kpiTiles(s)[1].value)
    }

    @Test fun readinessRowsUseDesktopWordingAndPhoneZone() {
        val rows = readinessRows(snap(), now, utc)
        assertEquals(
            listOf("Desktop app: running.", "Terminal: open since 11:26.", "Statusline: live, 14:13.", "Collector: not running."),
            rows.map { it.text },
        )
        assertEquals(listOf(false, true, true, false), rows.map { it.glows })
        assertEquals(ReadinessCopy.TERMINAL_OPEN_SINCE, rows[1].copy)
        assertEquals("11:26", rows[1].time)
        // Same instant in another zone reads differently.
        assertEquals("Terminal: open since 13:26.", readinessRows(snap(), now, ZoneId.of("Europe/Paris"))[1].text)
    }

    @Test fun readinessWordingForOtherStates() {
        val s = snap().copy(
            readiness = listOf(
                ReadinessWire(ReadinessKey.TERMINAL, true, true, null),
                ReadinessWire(ReadinessKey.STATUSLINE, false, false, now - 3L * 86_400_000),
                ReadinessWire(ReadinessKey.COLLECTOR, true, false, null),
            ),
        )
        assertEquals(listOf("Terminal: open.", "Statusline: last reading Sep 18 14:13.", "Collector: running, no events in the last 24h."), readinessRows(s, now, utc).map { it.text })
        val none = snap().copy(readiness = listOf(ReadinessWire(ReadinessKey.STATUSLINE, false, false, null), ReadinessWire(ReadinessKey.TERMINAL, false, false, null)))
        assertEquals(listOf("Statusline: no reading yet.", "Terminal: no session yet."), readinessRows(none, now, utc).map { it.text })
    }

    @Test fun stripTextAndMemoryUnit() {
        val items = stripItems(snap())
        assertEquals(listOf(StripKey.AGENTS, StripKey.ALERTS, StripKey.MEMORY), items.map { it.key })
        assertEquals(listOf(2L, 3L, 17L), items.map { it.count })
        assertEquals("engrams", items[2].unit)
        assertEquals("engram", stripItems(snap().copy(strip = DashStrip(0, 0, 1)))[2].unit)
    }

    @Test fun recapSentenceMatchesBanner() {
        assertEquals("Since you last looked: 4 dispatches completed, 2 anomalies detected, 1 anomaly cleared, 1,234,567 tokens burned.", recapSentence(snap()))
        assertEquals("Since you last looked: 1 dispatch completed, 0 tokens burned.", recapSentence(snap().copy(recap = DashRecap(1, 0, 0, 0))))
        assertNull(recapSentence(snap().copy(recap = null)))
    }

    @Test fun publishAgeComesFromComputedAtNotLiveState() {
        assertEquals(0L, publishAgeMs(snap(), now - 5_000))
        assertEquals(125_000L, publishAgeMs(snap(), now + 125_000))
        assertEquals("just now", publishAgeLabel(2_000))
        assertEquals("12s ago", publishAgeLabel(12_000))
        assertEquals("2m ago", publishAgeLabel(125_000))
        assertEquals("3h ago", publishAgeLabel(3 * 3_600_000L))
    }
}
