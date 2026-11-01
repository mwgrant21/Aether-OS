package com.matt.aethermobile.projects

import com.matt.aethermobile.ledger.AgeLabel
import com.matt.aethermobile.ledger.BucketKind
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

class ProjectsWireTest {
    private val golden: String = JSONObject(File("../../protocol/mobile-protocol.json").readText(Charsets.UTF_8))
        .getJSONObject("frames").getString("viewSnapProjects")

    private fun goldenD() = JSONObject(golden).getJSONObject("d")
    private fun snap() = ProjectsWire.decode(goldenD())!!

    @Test fun decodesTheRealGolden() {
        val s = snap()
        assertEquals(1790000000000L, s.computedAtMs)
        assertEquals(912.34, s.all.total.usd, 0.0)
        assertEquals(listOf("aether-os", "tarot-app"), s.roots.map { it.name })
        assertNull(s.roots[0].children[0].worktree)
        assertEquals("phone-views-d3", s.roots[0].children[1].worktree)
        assertEquals(emptyList<ProjectChild>(), s.roots[1].children)
        assertNull(s.unscoped!!.rollups.today)
        assertEquals(9.0, s.roots[0].block.rollups.today!!, 0.0)
    }

    @Test fun goldenFrameParsesThroughViewFrameAndHost() {
        val f = ControlProtocol.parseViewFrame(golden)!!
        val host = ViewHost("projects", ProjectsWire::decode, { true }, { true }, { true }, { 5L })
        host.onConnected(); host.activate(true)
        host.onFrame(f)
        assertTrue(host.snapshot() is ViewUi.Ready)
    }

    @Test fun nullUnscopedIsFine() {
        val d = goldenD().apply { put("unscoped", JSONObject.NULL) }
        assertNull(ProjectsWire.decode(d)!!.unscoped)
        val d2 = goldenD().apply { remove("unscoped") }
        assertNull(ProjectsWire.decode(d2)!!.unscoped)
    }

    @Test fun garbageIsNullNeverAThrow() {
        assertNull(ProjectsWire.decode(JSONObject()))
        assertNull(ProjectsWire.decode(goldenD().apply { put("all", "x") }))
        assertNull(ProjectsWire.decode(goldenD().apply { put("computedAtMs", "1") }))
        assertNull(ProjectsWire.decode(goldenD().apply { put("roots", JSONObject()) }))
        assertNull(ProjectsWire.decode(goldenD().apply { getJSONArray("roots").put(0, 7) }))
        assertNull(ProjectsWire.decode(goldenD().apply { getJSONObject("all").getJSONObject("total").put("usd", "912.34") }))
        assertNull(ProjectsWire.decode(goldenD().apply { getJSONObject("all").getJSONObject("total").put("usd", -1) }))
        assertNull(ProjectsWire.decode(goldenD().apply { getJSONObject("all").put("tiers", JSONArray(listOf("gpt"))) }))
        assertNull(ProjectsWire.decode(goldenD().apply { getJSONObject("all").getJSONObject("rollups").remove("today") }))
        assertNull(ProjectsWire.decode(goldenD().apply { getJSONObject("all").getJSONObject("cache").put("hitRate", 1.5) }))
        assertNull(ProjectsWire.decode(goldenD().apply { getJSONArray("roots").getJSONObject(0).put("children", JSONObject.NULL) }))
        assertNull(ProjectsWire.decode(goldenD().apply { getJSONArray("roots").getJSONObject(0).getJSONArray("children").getJSONObject(1).put("worktree", 3) }))
    }

    @Test fun unreadableWhenHostGetsGarbage() {
        val host = ViewHost("projects", ProjectsWire::decode, { true }, { true }, { true })
        host.onConnected(); host.activate(true)
        host.onFrame(ControlProtocol.ViewFrame("projects", JSONObject().put("roots", "x")))
        assertEquals(ViewUi.Unreadable, host.snapshot())
        host.onFrame(ControlProtocol.ViewFrame("projects", null))
        assertEquals(ViewUi.NoSnapshot, host.snapshot())
    }

    @Test fun oversizeIsRejected() {
        fun withRoots(n: Int): JSONObject {
            val d = goldenD()
            val root = d.getJSONArray("roots").getJSONObject(1)
            val a = JSONArray()
            repeat(n) { a.put(JSONObject(root.toString())) }
            return d.put("roots", a)
        }
        assertNotNull(ProjectsWire.decode(withRoots(ProjectsWire.MAX_ROOTS)))
        assertNull(ProjectsWire.decode(withRoots(ProjectsWire.MAX_ROOTS + 1)))
        val kid = goldenD().getJSONArray("roots").getJSONObject(0).getJSONArray("children").getJSONObject(0)
        fun withKids(n: Int): JSONObject {
            val d = goldenD()
            val a = JSONArray()
            repeat(n) { a.put(JSONObject(kid.toString())) }
            d.getJSONArray("roots").getJSONObject(0).put("children", a)
            return d
        }
        assertNotNull(ProjectsWire.decode(withKids(ProjectsWire.MAX_CHILDREN)))
        assertNull(ProjectsWire.decode(withKids(ProjectsWire.MAX_CHILDREN + 1)))
        assertNull(ProjectsWire.decode(goldenD().apply { getJSONArray("roots").getJSONObject(0).put("name", "x".repeat(61)) }))
    }

    @Test fun uiModelRowsFromGolden() {
        val ui = projectsUi(snap())
        assertEquals(listOf("aether-os", "tarot-app"), ui.rows.map { it.label })
        assertEquals("$640.50", ui.rows[0].usdText)
        assertEquals(1.0, ui.rows[0].bar, 0.0)
        assertEquals(268.63 / 640.5, ui.rows[1].bar, 1e-9)
        assertTrue(ui.rows[0].expandable)
        assertTrue(!ui.rows[1].expandable)
        assertEquals(listOf("main", "phone-views-d3"), ui.rows[0].children.map { it.label })
        assertEquals("opus, sonnet", ui.rows[0].tiers)
        assertEquals("$912.34", ui.all.usdText)
    }

    @Test fun singleChildIsNotExpandable() {
        val d = goldenD()
        val kids = d.getJSONArray("roots").getJSONObject(0).getJSONArray("children")
        kids.remove(1)
        assertTrue(!projectsUi(ProjectsWire.decode(d)!!).rows[0].expandable)
    }

    @Test fun barFractionFloorAndZeroMax() {
        assertEquals(0.02, barFraction(0.0, 100.0), 0.0)
        assertEquals(0.02, barFraction(0.5, 100.0), 0.0)
        assertEquals(0.5, barFraction(50.0, 100.0), 0.0)
        assertEquals(0.02, barFraction(0.0, 0.0), 0.0)
        assertEquals(1.0, barFraction(200.0, 100.0), 0.0)
    }

    @Test fun nullRollupIsNoActivityNotZeroDollars() {
        val u = projectsUi(snap()).unscoped!!
        val today = u.buckets.first { it.kind == BucketKind.TODAY }
        assertNull(bucketText(today))
        assertEquals("$1.28", bucketText(u.buckets.first { it.kind == BucketKind.WEEK }))
        val zero = com.matt.aethermobile.ledger.Bucket(BucketKind.TODAY, 0.0)
        assertEquals("$0.00", bucketText(zero))
    }

    @Test fun ageUsesTitanClockOffset() {
        val t = 1_000_000_000_000L
        // phone is 10 min behind titan: phone now = t + 0, offset +600s -> titan now = t + 600s
        assertEquals(AgeLabel.Minutes(10), projectsAge(t, t, 600_000L))
        assertEquals(AgeLabel.JustNow, projectsAge(t, t, 0L))
    }
}
