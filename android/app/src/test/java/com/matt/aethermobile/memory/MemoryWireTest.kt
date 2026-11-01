package com.matt.aethermobile.memory

import com.matt.aethermobile.protocol.ControlProtocol
import com.matt.aethermobile.views.ViewHost
import com.matt.aethermobile.views.ViewUi
import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MemoryWireTest {
    private val golden: String = JSONObject(File("../../protocol/mobile-protocol.json").readText(Charsets.UTF_8))
        .getJSONObject("frames").getString("viewSnapMemory")

    private fun goldenD() = JSONObject(golden).getJSONObject("d")
    private fun snap() = MemoryWire.decode(goldenD())!!

    private fun liveRow(i: Int) = goldenD().getJSONArray("live").getJSONObject(i)
    private fun row(scope: String, owner: String?, id: Long = 1, kind: String = "decision") = MemoryRow(
        id, MemoryScope.values().first { it.wire == scope }, owner, MemoryKind.values().first { it.wire == kind },
        null, 0.5, null, "c", 1L, 1L,
    )
    private fun snapOf(live: List<MemoryRow>, tombs: List<MemoryTombstone> = emptyList()) = MemorySnapshot(1L, live.size.toLong(), tombs.size.toLong(), live, tombs)

    // ---- wire ----

    @Test fun decodesTheRealGolden() {
        val s = snap()
        assertEquals(1790000000000L, s.computedAtMs)
        assertEquals(3L, s.liveCount)
        assertEquals(listOf(41L, 52L, 57L), s.live.map { it.id })
        assertNull(s.live[0].status)
        assertNull(s.live[0].owner)
        assertEquals(MemoryKind.OVERRULE, s.live[0].kind)
        assertEquals("builder", s.live[1].owner)
        assertEquals(MemoryStatus.SETTLED, s.live[1].status)
        assertNull(s.live[1].subject)
        assertEquals(41L, s.tombstones[0].supersededBy)
        assertEquals(TombstoneCause.SUPERSEDED, s.tombstones[0].cause)
    }

    @Test fun goldenFrameParsesThroughViewFrameAndHost() {
        val f = ControlProtocol.parseViewFrame(golden)!!
        val host = ViewHost("memory", MemoryWire::decode, { true }, { true }, { true }, { 5L })
        host.onConnected(); host.activate(true)
        host.onFrame(f)
        assertTrue(host.snapshot() is ViewUi.Ready)
    }

    @Test fun extractionFieldIsIgnored() {
        assertNotNull(MemoryWire.decode(goldenD().apply { put("extraction", JSONObject().put("usd", "junk")) }))
        assertNotNull(MemoryWire.decode(goldenD().apply { remove("extraction") }))
    }

    @Test fun nullSupersededByAndAbsentOwnerAreFine() {
        val d = goldenD().apply { getJSONArray("tombstones").getJSONObject(0).put("supersededBy", JSONObject.NULL) }
        assertNull(MemoryWire.decode(d)!!.tombstones[0].supersededBy)
        val d2 = goldenD().apply { getJSONArray("live").getJSONObject(0).remove("owner") }
        assertNull(MemoryWire.decode(d2)!!.live[0].owner)
    }

    @Test fun garbageIsNullNeverAThrow() {
        assertNull(MemoryWire.decode(JSONObject()))
        assertNull(MemoryWire.decode(goldenD().apply { put("computedAtMs", "1") }))
        assertNull(MemoryWire.decode(goldenD().apply { put("counts", "x") }))
        assertNull(MemoryWire.decode(goldenD().apply { getJSONObject("counts").put("live", -1) }))
        assertNull(MemoryWire.decode(goldenD().apply { put("live", JSONObject()) }))
        assertNull(MemoryWire.decode(goldenD().apply { getJSONArray("live").put(0, 7) }))
        assertNull(MemoryWire.decode(goldenD().apply { getJSONArray("live").getJSONObject(0).put("id", "41") }))
        assertNull(MemoryWire.decode(goldenD().apply { getJSONArray("live").getJSONObject(0).put("kind", "idea") }))
        assertNull(MemoryWire.decode(goldenD().apply { getJSONArray("live").getJSONObject(0).put("scope", "team") }))
        assertNull(MemoryWire.decode(goldenD().apply { getJSONArray("live").getJSONObject(0).put("status", "done") }))
        assertNull(MemoryWire.decode(goldenD().apply { getJSONArray("live").getJSONObject(0).put("salience", "0.9") }))
        assertNull(MemoryWire.decode(goldenD().apply { getJSONArray("live").getJSONObject(0).put("salience", -0.1) }))
        assertNull(MemoryWire.decode(goldenD().apply { getJSONArray("live").getJSONObject(0).put("owner", 3) }))
        assertNull(MemoryWire.decode(goldenD().apply { getJSONArray("live").getJSONObject(0).put("content", 3) }))
        assertNull(MemoryWire.decode(goldenD().apply { getJSONArray("live").getJSONObject(0).put("updatedAtMs", 1.5) }))
        assertNull(MemoryWire.decode(goldenD().apply { getJSONArray("tombstones").getJSONObject(0).put("cause", "gone") }))
        assertNull(MemoryWire.decode(goldenD().apply { getJSONArray("tombstones").getJSONObject(0).put("supersededBy", "41") }))
        assertNull(MemoryWire.decode(goldenD().apply { getJSONArray("tombstones").getJSONObject(0).remove("deletedAtMs") }))
    }

    @Test fun unreadableWhenHostGetsGarbage() {
        val host = ViewHost("memory", MemoryWire::decode, { true }, { true }, { true })
        host.onConnected(); host.activate(true)
        host.onFrame(ControlProtocol.ViewFrame("memory", JSONObject().put("live", "x")))
        assertEquals(ViewUi.Unreadable, host.snapshot())
        host.onFrame(ControlProtocol.ViewFrame("memory", null))
        assertEquals(ViewUi.NoSnapshot, host.snapshot())
    }

    @Test fun oversizeIsRejected() {
        fun withLive(n: Int): JSONObject {
            val d = goldenD()
            val a = JSONArray()
            repeat(n) { a.put(JSONObject(liveRow(0).toString())) }
            return d.put("live", a)
        }
        assertNotNull(MemoryWire.decode(withLive(MemoryWire.MAX_LIVE)))
        assertNull(MemoryWire.decode(withLive(MemoryWire.MAX_LIVE + 1)))
        fun withTombs(n: Int): JSONObject {
            val d = goldenD()
            val a = JSONArray()
            repeat(n) { a.put(JSONObject(goldenD().getJSONArray("tombstones").getJSONObject(0).toString())) }
            return d.put("tombstones", a)
        }
        assertNotNull(MemoryWire.decode(withTombs(MemoryWire.MAX_TOMBSTONES)))
        assertNull(MemoryWire.decode(withTombs(MemoryWire.MAX_TOMBSTONES + 1)))
        assertNotNull(MemoryWire.decode(goldenD().apply { getJSONArray("live").getJSONObject(0).put("content", "x".repeat(600)) }))
        assertNull(MemoryWire.decode(goldenD().apply { getJSONArray("live").getJSONObject(0).put("content", "x".repeat(601)) }))
        assertNull(MemoryWire.decode(goldenD().apply { getJSONArray("live").getJSONObject(0).put("subject", "x".repeat(81)) }))
        assertNull(MemoryWire.decode(goldenD().apply { getJSONArray("live").getJSONObject(1).put("owner", "x".repeat(61)) }))
    }

    // ---- ui model ----

    @Test fun chipsAreAllSharedAgentsLiveTombstones() {
        assertEquals(
            listOf(MemoryFilter.All, MemoryFilter.Shared, MemoryFilter.Agent("builder"), MemoryFilter.Live, MemoryFilter.Tombstones),
            memoryUi(snap()).chips,
        )
    }

    @Test fun ownerlessPrivateRowsAreDroppedNotShownUnderShared() {
        val s = snapOf(listOf(row("shared", null, 1), row("private", null, 2), row("private", "", 3), row("private", "qa", 4)))
        val g = groupMemoriesByScope(s.live)
        assertEquals(listOf(1L), g.shared.map { it.id })
        assertEquals(listOf("qa"), g.byAgent.keys.toList())
        val ui = memoryUi(s)
        assertEquals(listOf(1L, 4L), ui.groups.flatMap { it.rows }.map { it.id })
        assertEquals(listOf(MemoryFilter.All, MemoryFilter.Shared, MemoryFilter.Agent("qa"), MemoryFilter.Live, MemoryFilter.Tombstones), ui.chips)
    }

    @Test fun groupsFollowTheFilter() {
        val s = snap()
        fun shape(f: MemoryFilter) = memoryUi(s, f).groups.map { it.kind to it.rows.map { r -> r.id } }
        assertEquals(listOf(GroupKind.SHARED to listOf(41L, 57L), GroupKind.AGENT to listOf(52L)), shape(MemoryFilter.All))
        assertEquals(shape(MemoryFilter.All), shape(MemoryFilter.Live))
        assertEquals(listOf(GroupKind.SHARED to listOf(41L, 57L)), shape(MemoryFilter.Shared))
        assertEquals(listOf(GroupKind.AGENT to listOf(52L)), shape(MemoryFilter.Agent("builder")))
        assertEquals(emptyList<Any>(), shape(MemoryFilter.Agent("ghost")))
        assertEquals(emptyList<Any>(), shape(MemoryFilter.Tombstones))
        assertEquals(emptyList<TombstoneUi>(), memoryUi(s, MemoryFilter.Shared).tombstones)
    }

    @Test fun kindColoursMatchDesktopTiers() {
        assertEquals(0xFFF5C66BL, kindColor(MemoryKind.OVERRULE))
        assertEquals(0xFF3BE0A0L, kindColor(MemoryKind.DECISION))
        assertEquals(0xFF3BE0A0L, kindColor(MemoryKind.PREFERENCE))
        assertEquals(0xFF8FD6FFL, kindColor(MemoryKind.REVISION))
        assertEquals(0xFF9FC4D1L, kindColor(MemoryKind.HABIT))
        assertEquals(0xFFF5C66BL, memoryUi(snap()).groups[0].rows[0].color)
    }

    @Test fun salienceFractionClamps() {
        assertEquals(0.9, salienceFraction(0.9), 0.0)
        assertEquals(1.0, salienceFraction(7.5), 0.0)
        assertEquals(0.0, salienceFraction(0.0), 0.0)
        assertEquals(0.0, salienceFraction(Double.NaN), 0.0)
    }

    @Test fun updatedLineOnlyWhenChangedAfterCreate() {
        val rows = memoryUi(snap()).groups[0].rows
        assertEquals(1789500000000L, rows[0].updatedAtMs)
        assertEquals(1789700000000L, rows[1].updatedAtMs)
        val agentRow = memoryUi(snap()).groups[1].rows[0]
        assertNull(agentRow.updatedAtMs)
    }

    @Test fun tombstoneShowsCauseAndSupersededBy() {
        val t = memoryUi(snap(), MemoryFilter.Tombstones).tombstones.single()
        assertEquals(TombstoneCause.SUPERSEDED, t.cause)
        assertEquals("superseded by #41", t.supersededBy)
        assertNull(supersededLine(null))
    }
}
