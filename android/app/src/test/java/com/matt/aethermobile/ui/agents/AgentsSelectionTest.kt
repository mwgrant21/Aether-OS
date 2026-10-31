package com.matt.aethermobile.ui.agents

import com.matt.aethermobile.agents.AgentsSnapshot
import com.matt.aethermobile.agents.DONE_EXPANDED_DEFAULT
import com.matt.aethermobile.agents.EMPTY_ROSTER
import com.matt.aethermobile.agents.FLEET_EMPTY
import com.matt.aethermobile.agents.FLEET_UNAVAILABLE
import com.matt.aethermobile.agents.FleetRow
import com.matt.aethermobile.agents.FleetStatus
import com.matt.aethermobile.agents.FleetUi
import com.matt.aethermobile.agents.TimelineUi
import com.matt.aethermobile.agents.TimelineItem
import com.matt.aethermobile.agents.TimelineKind
import com.matt.aethermobile.agents.fleetUi
import com.matt.aethermobile.agents.timelineUi
import com.matt.aethermobile.agents.PROMPT_EMPTY
import com.matt.aethermobile.agents.RunningAgent
import com.matt.aethermobile.agents.TIMELINE_EMPTY
import com.matt.aethermobile.agents.TIMELINE_UNAVAILABLE
import com.matt.aethermobile.agents.agentsUi
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class AgentsSelectionTest {
    private fun run(id: String, needs: Boolean = false) = RunningAgent(
        id, "worker", "desc $id", 1_000L, null, "head $id", null, needs, null, "prompt $id",
    ).let { if (needs) it.copy(anomaly = com.matt.aethermobile.agents.AgentAnomaly(com.matt.aethermobile.agents.AnomalyKind.STALLED_PERMISSION, "x")) else it }

    private fun ui(vararg r: RunningAgent) = agentsUi(AgentsSnapshot(5_000L, r.toList(), emptyList(), null, null))

    @Test fun openAgentFollowsItsIdWhenRowsReorder() {
        val before = ui(run("a"), run("b"))
        assertEquals("b", findRunning(before, "b")?.id)
        // A refresh that puts b first (and a needs-input group above working) still resolves b, not index 1.
        val after = ui(run("a"), run("b", needs = true))
        assertEquals("b", findRunning(after, "b")?.id)
        assertEquals("a", findRunning(after, "a")?.id)
    }

    @Test fun vanishedOrNullIdClosesTheSheet() {
        assertNull(findRunning(ui(run("a")), "gone"))
        assertNull(findRunning(ui(run("a")), null))
    }

    @Test fun tappingTheOpenRowAgainClosesIt() {
        assertEquals("a", nextOpenId(null, "a"))
        assertEquals("b", nextOpenId("a", "b"))
        assertNull(nextOpenId("a", "a"))
    }

    @Test fun doneStartsCollapsed() {
        assertFalse(DONE_EXPANDED_DEFAULT)
    }

    @Test fun needsInputRowOpensTheSameDetailRowAsAnyOther() {
        val u = ui(run("a", needs = true))
        val row = findRunning(u, "a")
        assertNotNull(row)
        assertEquals("!1", u.badge)
        assertEquals("prompt a", row!!.prompt)
    }

    /** Every desktop sentence the model exposes must reach the screen verbatim through strings_agents.xml. */
    @Test fun stringsCarryTheDesktopSentencesVerbatim() {
        val xml = File("src/main/res/values/strings_agents.xml").readText(Charsets.UTF_8)
        fun res(name: String): String {
            val m = Regex("<string name=\"$name\">(.*?)</string>").find(xml)!!
            return m.groupValues[1].replace("\\'", "'")
        }
        assertEquals(EMPTY_ROSTER, res("agents_empty_roster"))
        assertEquals(FLEET_UNAVAILABLE, res("agents_fleet_unavailable"))
        assertEquals(FLEET_EMPTY, res("agents_fleet_empty"))
        assertEquals(TIMELINE_UNAVAILABLE, res("agents_timeline_unavailable"))
        assertEquals(TIMELINE_EMPTY, res("agents_timeline_empty"))
        assertEquals(PROMPT_EMPTY, res("agents_prompt_empty"))
    }

    @Test fun zeroNeedsInputHasNoBadge() {
        assertNull(ui(run("a")).badge)
    }

    private fun fr(key: String, start: Long) = FleetRow(key, "title $key", "n", start, FleetStatus.BUSY, "cli", null)

    @Test fun fleetExpansionFollowsKeyAcrossReorderAndClearsWhenKeyVanishes() {
        val before = (fleetUi(listOf(fr("keyAAAAA", 1L), fr("keyBBBBB", 2L))) as FleetUi.Rows).rows
        assertEquals("keyBBBBB", resolveExpandedFleet(before, "keyBBBBB")?.key)
        // A refresh puts a new, older session first: B moves from index 1 to 2 but stays the expanded one.
        val after = (fleetUi(listOf(fr("keyAAAAA", 5L), fr("keyBBBBB", 2L), fr("keyCCCCC", 0L))) as FleetUi.Rows).rows
        assertEquals(listOf("keyCCCCC", "keyBBBBB", "keyAAAAA"), after.map { it.key })
        assertEquals("keyBBBBB", resolveExpandedFleet(after, "keyBBBBB")?.key)
        assertNull(resolveExpandedFleet(after, "gone"))
        assertNull(resolveExpandedFleet(after, null))
        assertNull(nextOpenId("keyBBBBB", "keyBBBBB"))
    }

    @Test fun nullIsUnavailableAndEmptyListIsEmpty() {
        assertEquals(FleetUi.Unavailable(), fleetUi(null))
        assertEquals(FleetUi.Empty(), fleetUi(emptyList()))
        assertEquals(TimelineUi.Unavailable(), timelineUi(null))
        assertEquals(TimelineUi.Empty(), timelineUi(emptyList()))
    }

    @Test fun fleetRowCarriesTitleKindAndPid() {
        val r = (fleetUi(listOf(FleetRow("keyAAAAA", "proj", "sess", 1L, FleetStatus.IDLE, "bg", 7L))) as FleetUi.Rows).rows[0]
        assertEquals("proj", r.title); assertEquals("sess", r.name); assertEquals("bg", r.kind); assertEquals(7L, r.pid)
        assertFalse(r.busy)
    }

    @Test fun fleetAndTimelineStringsExistWithNoOldFallback() {
        val xml = File("src/main/res/values/strings_agents.xml").readText(Charsets.UTF_8)
        for (n in listOf("agents_fleet_status_busy", "agents_fleet_status_idle", "agents_fleet_detail", "agents_fleet_detail_pid", "agents_timeline_usage")) {
            assertEquals(n, true, xml.contains("name=\"$n\""))
        }
        assertFalse(xml.contains("agents_fleet_rows_unsupported") || xml.contains("agents_timeline_items_unsupported"))
        assertEquals(true, xml.contains("kind: %1\$s · pid: %2\$d"))
    }
}
