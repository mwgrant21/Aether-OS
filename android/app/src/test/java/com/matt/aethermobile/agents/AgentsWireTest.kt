package com.matt.aethermobile.agents

import com.matt.aethermobile.ledger.AgeLabel
import com.matt.aethermobile.protocol.ControlProtocol
import com.matt.aethermobile.views.ViewHost
import com.matt.aethermobile.views.ViewUi
import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentsWireTest {
    private val golden: String = JSONObject(File("../../protocol/mobile-protocol.json").readText(Charsets.UTF_8))
        .getJSONObject("frames").getString("viewSnapAgents")

    private fun goldenD() = JSONObject(golden).getJSONObject("d")
    private fun snap() = AgentsWire.decode(goldenD())!!
    private fun ui() = agentsUi(snap())
    private fun run0(d: JSONObject) = d.getJSONArray("running").getJSONObject(0)
    private fun done0(d: JSONObject) = d.getJSONArray("done").getJSONObject(0)

    private val fleetJson = """[{"name":"b","startedAtMs":2000,"status":"idle","kind":"cli","pid":42},
        {"name":"a","startedAtMs":1000,"status":"busy","kind":"desktop"}]"""
    private val timelineJson = """[{"k":"tool","atMs":10,"label":"Read x.ts","tokens":null,"toolUses":null,"durationMs":null},
        {"k":"anomaly","atMs":30,"label":"reReadLoop"},{"k":"dispatch","atMs":20,"label":"Agent","tokens":5,"toolUses":2,"durationMs":900}]"""

    @Test fun decodesTheRealGolden() {
        val s = snap()
        assertEquals(1790000000000L, s.computedAtMs)
        assertEquals(listOf("toolu_01Aa", "toolu_01Bb"), s.running.map { it.id })
        assertEquals("claude-sonnet-5-5", s.running[0].model)
        assertNull(s.running[1].model)
        assertNull(s.running[1].narration)
        assertEquals(AgentAnomaly(AnomalyKind.RE_READ_LOOP, "worker.ts read 6 times"), s.running[0].anomaly)
        assertEquals(482000L, s.done[0].tokens)
        assertNull(s.done[1].tokens); assertNull(s.done[1].toolUses); assertNull(s.done[1].durationMs)
        assertNull(s.fleet); assertNull(s.timeline)
    }

    @Test fun goldenFrameParsesThroughViewFrameAndHost() {
        val host = ViewHost("agents", AgentsWire::decode, { true }, { true }, { true }, { 5L })
        host.onConnected(); host.activate(true)
        host.onFrame(ControlProtocol.parseViewFrame(golden)!!)
        assertTrue(host.snapshot() is ViewUi.Ready)
    }

    @Test fun wrongTypeAnywhereIsNullNeverAThrow() {
        assertNull(AgentsWire.decode(JSONObject()))
        assertNull(AgentsWire.decode(goldenD().apply { put("computedAtMs", "1") }))
        assertNull(AgentsWire.decode(goldenD().apply { put("running", JSONObject()) }))
        assertNull(AgentsWire.decode(goldenD().apply { remove("done") }))
        assertNull(AgentsWire.decode(goldenD().apply { run0(this).put("startedAtMs", "1") }))
        assertNull(AgentsWire.decode(goldenD().apply { run0(this).put("headline", 5) }))
        assertNull(AgentsWire.decode(goldenD().apply { run0(this).put("narration", 5) }))
        assertNull(AgentsWire.decode(goldenD().apply { run0(this).remove("model") }))
        assertNull(AgentsWire.decode(goldenD().apply { run0(this).put("prompt", JSONObject.NULL) }))
        assertNull(AgentsWire.decode(goldenD().apply { done0(this).put("tokens", "482000") }))
        assertNull(AgentsWire.decode(goldenD().apply { done0(this).remove("toolUses") }))
        assertNull(AgentsWire.decode(goldenD().apply { done0(this).put("durationMs", -1) }))
        assertNull(AgentsWire.decode(goldenD().apply { run0(this).getJSONObject("anomaly").put("kind", "bogus") }))
    }

    @Test fun idMustBeOpaqueSafeString() {
        assertNull(AgentsWire.decode(goldenD().apply { run0(this).put("id", "a/b") }))
        assertNull(AgentsWire.decode(goldenD().apply { run0(this).put("id", "") }))
        assertNull(AgentsWire.decode(goldenD().apply { done0(this).put("id", "x".repeat(65)) }))
        assertEquals("x".repeat(64), AgentsWire.decode(goldenD().apply { done0(this).put("id", "x".repeat(64)) })!!.done[0].id)
    }

    @Test fun needsInputMustMatchAnomaly() {
        assertNull(AgentsWire.decode(goldenD().apply { run0(this).put("needsInput", false) }))
        assertNull(AgentsWire.decode(goldenD().apply { getJSONArray("running").getJSONObject(1).put("needsInput", true) }))
    }

    @Test fun listsOverTheirWireCapAreRejected() {
        fun many(n: Int, one: JSONObject) = JSONArray().apply { repeat(n) { put(JSONObject(one.toString())) } }
        val r = run0(goldenD()); val d = done0(goldenD())
        assertEquals(30, AgentsWire.decode(goldenD().apply { put("running", many(30, r)) })!!.running.size)
        assertNull(AgentsWire.decode(goldenD().apply { put("running", many(31, r)) }))
        assertEquals(20, AgentsWire.decode(goldenD().apply { put("done", many(20, d)) })!!.done.size)
        assertNull(AgentsWire.decode(goldenD().apply { put("done", many(21, d)) }))
    }

    @Test fun strayKeysAreIgnored() {
        val s = AgentsWire.decode(goldenD().apply { put("extra", 1); run0(this).put("path", "C:/x"); done0(this).put("zzz", true) })!!
        assertEquals(snap(), s)
    }

    @Test fun fleetAndTimelineDecodeWhenPresent() {
        val s = AgentsWire.decode(goldenD().apply { put("fleet", JSONArray(fleetJson)); put("timeline", JSONArray(timelineJson)) })!!
        assertEquals(listOf("b" to 42L, "a" to null), s.fleet!!.map { it.name to it.pid })
        assertEquals(FleetStatus.IDLE, s.fleet!![0].status)
        assertEquals(listOf(TimelineKind.TOOL, TimelineKind.ANOMALY, TimelineKind.DISPATCH), s.timeline!!.map { it.kind })
        assertEquals(5L, s.timeline!![2].tokens)
        assertNull(s.timeline!![0].tokens); assertNull(s.timeline!![1].toolUses)
    }

    @Test fun malformedFleetOrTimelineIsNullNotAFailedDecode() {
        val d = goldenD().apply {
            put("fleet", JSONArray("""[{"name":"a","startedAtMs":1,"status":"sleeping","kind":"cli"}]"""))
            put("timeline", "nope")
        }
        val s = AgentsWire.decode(d)!!
        assertNull(s.fleet); assertNull(s.timeline)
        assertEquals(2, s.running.size)
        assertNull(AgentsWire.decode(goldenD().apply { put("timeline", JSONArray("""[{"k":"tool","atMs":"x","label":"y"}]""")) })!!.timeline)
        assertNull(AgentsWire.decode(goldenD().apply { remove("fleet"); remove("timeline") })!!.fleet)
    }

    @Test fun nullFleetAndTimelineShowUnavailableNotNoActivity() {
        val u = ui()
        assertEquals(FleetUi.Unavailable("Fleet data is unavailable because the collector isn't running."), u.fleet)
        assertEquals(TimelineUi.Unavailable("Dispatch diagnostics are unavailable because the collector isn't running."), u.timeline)
        val empty = agentsUi(snap().copy(fleet = emptyList(), timeline = emptyList()))
        assertEquals(FleetUi.Empty("No other sessions detected."), empty.fleet)
        assertEquals(TimelineUi.Empty("No recent activity from tool calls, dispatches or anomalies."), empty.timeline)
    }

    @Test fun fleetOldestFirstAndTimelineNewestFirst() {
        val s = AgentsWire.decode(goldenD().apply { put("fleet", JSONArray(fleetJson)); put("timeline", JSONArray(timelineJson)) })!!
        val u = agentsUi(s)
        val rows = (u.fleet as FleetUi.Rows).rows
        assertEquals(listOf("a", "b"), rows.map { it.name })
        assertEquals(listOf(true, false), rows.map { it.busy })
        assertEquals(listOf("kind: desktop", "kind: cli \u00b7 pid: 42"), rows.map { it.detail })
        assertEquals(listOf(30L, 20L, 10L), (u.timeline as TimelineUi.Items).items.map { it.atMs })
    }

    @Test fun groupsAreNeedsInputWorkingDoneAndOmitEmptyOnes() {
        val u = ui()
        assertEquals(listOf(AgentGroup.NEEDS_INPUT, AgentGroup.WORKING, AgentGroup.DONE), u.groups.map { it.group })
        assertEquals(listOf("toolu_01Aa"), u.groups[0].running.map { it.id })
        assertEquals(listOf("toolu_01Bb"), u.groups[1].running.map { it.id })
        assertEquals(listOf("toolu_01Cc", "toolu_01Dd"), u.groups[2].done.map { it.id })
        val none = agentsUi(snap().copy(running = emptyList(), done = emptyList()))
        assertTrue(none.groups.isEmpty())
        assertEquals("No agents are running.", none.emptyRoster)
        assertNull(u.emptyRoster)
    }

    @Test fun doneGroupDefaultsCollapsed() {
        assertFalse(DONE_EXPANDED_DEFAULT)
    }

    @Test fun badgeCountsNeedsInputOnly() {
        assertEquals("!1", ui().badge)
        assertEquals(1, ui().needsInputCount)
        val calm = agentsUi(snap().copy(running = snap().running.drop(1)))
        assertNull(calm.badge)
        assertEquals(0, calm.needsInputCount)
        val two = snap().running[0]
        assertEquals("!2", agentsUi(snap().copy(running = listOf(two, two.copy(id = "z")))).badge)
    }

    @Test fun elapsedUsesTitanClockOffsetAndFormats() {
        assertEquals("10:00", agentElapsed(1_000_000L, 1_000_000L, 600_000L))
        assertEquals("00:00", agentElapsed(5_000L, 1_000L, 0L))
        assertEquals("59:59", agentElapsed(0L, 3_599_999L, 0L))
        assertEquals("1h 00m", agentElapsed(0L, 3_600_000L, 0L))
        assertEquals("2h 05m", agentElapsed(0L, 7_500_000L, 0L))
    }

    @Test fun publishAgeUsesTitanClock() {
        assertEquals(AgeLabel.JustNow, agentsAge(1_000_000L, 1_000_000L, 0L))
        assertEquals(AgeLabel.Minutes(5), agentsAge(0L, 0L, 300_000L))
        assertEquals(AgeLabel.Minutes(2), agentsAge(1_000_000L, 1_120_000L, 0L))
    }

    @Test fun nullNarrationAndModelAreHiddenAndBlankHeadlineFallsBackToDescription() {
        val r = ui().groups[1].running[0]
        assertNull(r.narration); assertNull(r.modelBadge)
        assertEquals("claude-sonnet-5-5", ui().groups[0].running[0].modelBadge)
        assertEquals("Reading the worker loop.", ui().groups[0].running[0].narration)
        val blank = snap().running[0].copy(headline = "", narration = "  ", model = "", prompt = "")
        val row = agentsUi(snap().copy(running = listOf(blank))).groups[0].running[0]
        assertEquals("Audit the retry path in the sync worker", row.headline)
        assertNull(row.narration); assertNull(row.modelBadge); assertNull(row.prompt)
    }

    @Test fun unmeasuredDoneUsageIsNeverZero() {
        val measured = ui().groups[2].done[0]
        assertEquals("482.0K", measured.tokens); assertEquals("37", measured.toolUses); assertEquals("10:12", measured.elapsed)
        val unmeasured = ui().groups[2].done[1]
        assertEquals(NOT_MEASURED, unmeasured.tokens); assertEquals(NOT_MEASURED, unmeasured.toolUses); assertEquals(NOT_MEASURED, unmeasured.elapsed)
        val zero = snap().done[0].copy(tokens = 0L, toolUses = 0L, durationMs = 0L)
        val z = agentsUi(snap().copy(done = listOf(zero))).groups[2].done[0]
        assertEquals("0", z.tokens); assertEquals("0", z.toolUses); assertEquals("00:00", z.elapsed)
    }
}
