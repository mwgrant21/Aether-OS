package com.matt.aethermobile.term

import com.matt.aethermobile.net.TerminalFeed
import com.matt.aethermobile.protocol.ControlProtocol.SessionInfo
import com.matt.aethermobile.protocol.ControlProtocol.SlotState
import com.matt.aethermobile.protocol.ControlProtocol.TerminalFrame
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalHostTest {
    private val calls = ArrayList<String>()
    private val posts = ArrayList<String>()
    private val feed = TerminalFeed()
    private var attachResult = true
    private var throwOnPost = false
    private var throwOnAttach = false

    private val host = TerminalHost(
        attach = { s, q -> if (throwOnAttach) error("boom"); calls.add("attach $s ${q ?: "-"}"); attachResult },
        detach = { s -> calls.add("detach $s"); true },
        post = { m -> if (throwOnPost) error("boom"); posts.add(m) },
        feed = feed,
    )

    private fun fields(o: JSONObject): Map<String, String> =
        o.keys().asSequence().associateWith { o.get(it).toString() }

    private fun assertJson(expected: String, actual: String) =
        assertEquals(fields(JSONObject(expected)), fields(JSONObject(actual)))

    private fun info(s: String, st: SlotState = SlotState.RUNNING, cols: Int = 100, rows: Int = 30) =
        SessionInfo(s, s, st, cols, rows, 0)

    private fun ready(vararg i: SessionInfo = arrayOf(info("claude"), info("terminal2"), info("codex"))) =
        host.onSessions(i.toList())

    @Test fun selectDetachesPreviousThenAttachesWithLastQAndShows() {
        ready()
        host.select("claude")
        host.onFrame(TerminalFrame.Snap("claude", 5, 100, 30, "a"))
        host.select("terminal2")
        assertEquals(listOf("attach claude -", "detach claude", "attach terminal2 -"), calls)
        assertJson("""{"t":"show","s":"terminal2"}""", posts.last())
    }

    @Test fun resumeUsesLastQAndForgetGivesSnapshot() {
        ready()
        feed.onSnap("codex", 9)
        host.select("codex")
        assertEquals("attach codex 9", calls.last())
        host.select("claude") // explicit switch forgets codex
        host.select("codex")
        assertEquals("attach codex -", calls.last())
    }

    @Test fun duplicateDroppedAcceptedPostedGapReattachesOnceNoLoop() {
        ready()
        host.select("claude")
        host.onFrame(TerminalFrame.Snap("claude", 1, 100, 30, ""))
        posts.clear(); calls.clear()
        host.onFrame(TerminalFrame.Out("claude", 2, "x"))
        host.onFrame(TerminalFrame.Out("claude", 2, "x"))
        assertEquals(1, posts.size)
        host.onFrame(TerminalFrame.Out("claude", 9, "y"))
        host.onFrame(TerminalFrame.Out("claude", 10, "z"))
        host.onFrame(TerminalFrame.Out("claude", 11, "z"))
        assertEquals(listOf("attach claude -"), calls) // exactly one, no loop
        assertEquals(1, posts.size)
        host.onFrame(TerminalFrame.Snap("claude", 11, 100, 30, "S"))
        host.onFrame(TerminalFrame.Out("claude", 12, "w"))
        host.onFrame(TerminalFrame.Out("claude", 40, "gap again"))
        assertEquals(listOf("attach claude -", "attach claude -"), calls) // a new gap after the snap may re-attach
    }

    @Test fun switchingTabsNeverLosesOrDuplicatesBytes() {
        ready()
        host.select("claude")
        host.onFrame(TerminalFrame.Snap("claude", 1, 100, 30, "A"))
        host.onFrame(TerminalFrame.Out("claude", 2, "B"))
        host.select("terminal2")
        // old slot output after select, and new slot output before its snapshot arrives
        host.onFrame(TerminalFrame.Out("claude", 3, "LATE-OLD"))
        host.onFrame(TerminalFrame.Out("terminal2", 7, "EARLY-NEW"))
        host.onFrame(TerminalFrame.Out("terminal2", 8, "EARLY-NEW2"))
        host.onFrame(TerminalFrame.Snap("terminal2", 8, 100, 30, "SNAP"))
        host.onFrame(TerminalFrame.Out("terminal2", 8, "dup"))
        host.onFrame(TerminalFrame.Out("terminal2", 9, "C"))
        val written = posts.map { JSONObject(it) }.filter { it.getString("t") != "show" }
            .map { it.getString("s") + ":" + it.getString("d") }
        assertEquals(listOf("claude:A", "claude:B", "terminal2:SNAP", "terminal2:C"), written)
        assertEquals(listOf("attach claude -", "detach claude", "attach terminal2 -"), calls) // no extra re-attach
    }

    @Test fun framesForHiddenSlotDroppedButStateTracked() {
        ready()
        host.select("claude")
        host.onFrame(TerminalFrame.Snap("claude", 1, 100, 30, ""))
        posts.clear()
        host.onFrame(TerminalFrame.Snap("codex", 1, 80, 24, "x"))
        host.onFrame(TerminalFrame.Out("codex", 2, "x"))
        host.onFrame(TerminalFrame.Size("codex", 90, 20))
        assertTrue(posts.isEmpty())
        host.onFrame(TerminalFrame.State("codex", SlotState.EXITED))
        assertEquals(SlotState.EXITED, host.tabs()[2].state)
        assertTrue(posts.isEmpty())
    }

    @Test fun sizeFrameForVisibleSlotPosted() {
        ready(); host.select("claude")
        host.onFrame(TerminalFrame.Size("claude", 120, 40))
        assertJson("""{"t":"size","s":"claude","cols":120,"rows":40}""", posts.last())
    }

    @Test fun missingSessionsMemberShowsNotStarted() {
        ready(info("claude"))
        val t = host.tabs()
        assertEquals(3, t.size)
        assertEquals(SlotState.RUNNING, t[0].state)
        assertEquals(SlotState.NOT_STARTED, t[1].state)
        assertEquals(SlotState.NOT_STARTED, t[2].state)
        assertEquals("Codex", t[2].label)
    }

    @Test fun framesIgnoredAfterDisconnectUntilNextSessions() {
        ready(); host.select("claude")
        host.onFrame(TerminalFrame.Snap("claude", 1, 100, 30, ""))
        host.onDisconnected()
        posts.clear(); calls.clear()
        host.onFrame(TerminalFrame.Out("claude", 2, "late"))
        host.onFrame(TerminalFrame.State("claude", SlotState.EXITED))
        host.select("terminal2")
        assertTrue(posts.isEmpty() && calls.isEmpty())
        assertEquals(SlotState.RUNNING, host.tabs()[0].state)
        ready(); host.select("claude")
        assertEquals(listOf("attach claude 1"), calls)
    }

    @Test fun throwingPostOrAttachDoesNotEscapeOnFrame() {
        ready(); host.select("claude")
        host.onFrame(TerminalFrame.Snap("claude", 1, 100, 30, ""))
        throwOnPost = true
        host.onFrame(TerminalFrame.Out("claude", 2, "x"))
        host.onFrame(TerminalFrame.Size("claude", 1, 1))
        throwOnAttach = true
        host.onFrame(TerminalFrame.Out("claude", 9, "gap"))
        host.select("terminal2")
    }

    @Test fun zeroSizedSnapIsForwardedAtLastKnownSize() {
        ready(info("claude", cols = 132, rows = 43)); host.select("claude")
        host.onFrame(TerminalFrame.Snap("claude", 0, 0, 0, ""))
        assertJson("""{"t":"snap","s":"claude","q":0,"cols":132,"rows":43,"d":""}""", posts.last())
        host.onFrame(TerminalFrame.Size("claude", 90, 20))
        host.onFrame(TerminalFrame.Snap("claude", 0, 0, 0, ""))
        val last = JSONObject(posts.last())
        assertEquals(90, last.getInt("cols")); assertEquals(20, last.getInt("rows"))
    }

    @Test fun zeroSizedSnapWithNoKnownSizeUses80x24() {
        ready(info("claude", SlotState.NOT_STARTED, 0, 0)); host.select("claude")
        host.onFrame(TerminalFrame.Snap("claude", 0, 0, 0, ""))
        val m = JSONObject(posts.last())
        assertEquals(80, m.getInt("cols")); assertEquals(24, m.getInt("rows"))
    }

    @Test fun inputAndResizeFromPageAreDroppedConsumedCounted() {
        ready(); host.select("claude")
        calls.clear(); posts.clear()
        host.onPage(PageMessage.Input("claude", "ls\r"))
        host.onPage(PageMessage.Resize("claude", 10, 10))
        host.onPage(PageMessage.Ready)
        assertTrue(calls.isEmpty() && posts.isEmpty())
        host.onPage(PageMessage.Consumed("claude", 10))
        host.onPage(PageMessage.Consumed("claude", 5))
        host.onPage(PageMessage.Consumed("codex", 1))
        assertEquals(15L, host.consumed("claude"))
        assertEquals(16L, host.consumedTotal)
    }

    @Test fun zoomPostsOnlyValidValues() {
        ready()
        host.zoom(0); host.zoom(12); host.zoom(7); host.zoom(25)
        assertEquals(2, posts.size)
        assertJson("""{"t":"zoom","px":0}""", posts[0])
        assertJson("""{"t":"zoom","px":12}""", posts[1])
    }

    @Test fun outboundBuildersExactJsonAndEscaping() {
        assertJson("""{"t":"snap","s":"codex","q":3,"cols":80,"rows":24,"d":"a"}""", BridgeOut.snap("codex", 3, 80, 24, "a"))
        assertJson("""{"t":"out","s":"claude","q":4,"d":"x"}""", BridgeOut.out("claude", 4, "x"))
        assertJson("""{"t":"size","s":"claude","cols":1,"rows":2}""", BridgeOut.size("claude", 1, 2))
        assertJson("""{"t":"show","s":"codex"}""", BridgeOut.show("codex"))
        assertJson("""{"t":"zoom","px":14}""", BridgeOut.zoom(14))
        val d = "q\"\\\u001b[0m\r\n"
        assertEquals(d, JSONObject(BridgeOut.out("claude", 1, d)).getString("d"))
    }

}
