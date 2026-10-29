package com.matt.aethermobile.term

import com.matt.aethermobile.net.TerminalFeed
import com.matt.aethermobile.protocol.ControlProtocol.NakReason
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
    private val sent = ArrayList<Triple<String, Long, String>>()
    private val notSent = ArrayList<Int>()
    private var sendOk = true

    private val host = TerminalHost(
        attach = { s, q -> if (throwOnAttach) error("boom"); calls.add("attach $s ${q ?: "-"}"); attachResult },
        detach = { s -> calls.add("detach $s"); true },
        post = { m -> if (throwOnPost) error("boom"); posts.add(m) },
        feed = feed,
        sendInput = { s, c, d -> if (sendOk) sent.add(Triple(s, c, d)); sendOk },
        onNotSent = { notSent.add(it) },
    )

    // Both sides are re-parsed from strings, so Long vs Integer cannot false-fail.
    // Type-aware, order-free: class + value per key, recursive, extra/missing keys fail.
    private fun norm(v: Any?): Any? = when (v) {
        is JSONObject -> v.keys().asSequence().associateWith { norm(v.get(it)) }
        is org.json.JSONArray -> (0 until v.length()).map { norm(v.get(it)) }
        null -> null
        else -> v.javaClass to v
    }

    private fun assertJson(expected: String, actual: String) =
        assertEquals(norm(JSONObject(expected)), norm(JSONObject(actual)))

    private fun info(s: String, st: SlotState = SlotState.RUNNING, cols: Int = 100, rows: Int = 30) =
        SessionInfo(s, s, st, cols, rows, 0)

    private fun ready(vararg i: SessionInfo = arrayOf(info("claude"), info("terminal2"), info("codex"))) =
        host.onSessions(i.toList())

    private fun waiting(s: String) = host.tabs().first { it.s == s }.awaitingOutput

    @Test fun emptySnapshotForRunningSlotAwaitsOutput() {
        ready()
        host.select("claude")
        host.onFrame(TerminalFrame.Snap("claude", 1, 100, 30, ""))
        assertTrue(waiting("claude"))
        host.onFrame(TerminalFrame.Out("claude", 2, "hi"))
        assertTrue(!waiting("claude"))
        host.onFrame(TerminalFrame.Snap("claude", 3, 100, 30, ""))
        assertTrue(waiting("claude"))
        host.onFrame(TerminalFrame.Snap("claude", 4, 100, 30, "text"))
        assertTrue(!waiting("claude"))
    }

    @Test fun nonEmptySnapshotNeverAwaitsOutput() {
        ready()
        host.select("claude")
        host.onFrame(TerminalFrame.Snap("claude", 1, 100, 30, "text"))
        assertTrue(!waiting("claude"))
    }

    @Test fun deliveryQueuedBeforeResetNeverReachesTheNextPage() {
        val got = ArrayList<String>()
        val box = PageOutbox(4) {}
        val gen = box.generation
        box.reset() // lock / endTerminal while the main-looper delivery is still pending
        box.ready { got.add(it) }
        box.submit(gen, "stale")
        box.submit(box.generation, "fresh")
        assertEquals(listOf("fresh"), got)
    }

    @Test fun backlogOverflowResyncsHostOnceAfterPageReady() {
        var resyncs = 0
        val box = PageOutbox(2) { resyncs++ }
        for (i in 1..3) box.submit(box.generation, "m$i")
        assertEquals(0, resyncs)
        val got = ArrayList<String>()
        box.ready { got.add(it) }
        assertEquals(1, resyncs)
        assertTrue(got.isEmpty())
    }

    @Test fun resyncShowsZoomsAndReattachesForSnapshot() {
        ready()
        host.select("claude")
        host.onFrame(TerminalFrame.Snap("claude", 5, 100, 30, "a"))
        host.zoom(16)
        posts.clear(); calls.clear()
        host.resync()
        assertEquals(listOf("attach claude -"), calls)
        assertJson("""{"t":"show","s":"claude"}""", posts.first())
        assertJson("""{"t":"zoom","px":16}""", posts.last())
    }

    @Test fun frameRouterSendsToReplacedHostNotTheOldOne() {
        val router = FrameRouter()
        val old = host
        router.host = old
        val seen = ArrayList<String>()
        val fresh = TerminalHost({ s, _ -> seen.add("attach $s"); true }, { true }, { seen.add(it) }, TerminalFeed())
        fresh.onSessions(listOf(info("claude")))
        fresh.select("claude")
        old.onDisconnected()
        router.host = fresh
        seen.clear()
        router.route(TerminalFrame.Snap("claude", 1, 100, 30, "x"))
        assertTrue(seen.isNotEmpty())
    }

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
        val written = posts.map { JSONObject(it) }.filter { it.getString("t") !in setOf("show", "stdin") }
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

    @Test fun resizeFromPageIsDroppedConsumedCounted() {
        ready(); host.select("claude")
        calls.clear(); posts.clear()
        host.onPage(PageMessage.Resize("claude", 10, 10))
        host.onPage(PageMessage.Ready)
        assertTrue(calls.isEmpty() && posts.isEmpty())
        host.onPage(PageMessage.Consumed("claude", 10))
        host.onPage(PageMessage.Consumed("claude", 5))
        host.onPage(PageMessage.Consumed("codex", 1))
        assertEquals(15L, host.consumed("claude"))
        assertEquals(16L, host.consumedTotal)
    }

    private fun typed() = sent.map { it.third }
    private fun stdins() = posts.map { JSONObject(it) }.filter { it.getString("t") == "stdin" }.map { it.getBoolean("on") }

    @Test fun inputIsAcceptedOnlyForTheAttachedRunningSlot() {
        ready(info("claude"), info("terminal2", SlotState.NOT_STARTED), info("codex", SlotState.EXITED))
        host.onPage(PageMessage.Input("claude", "a")) // nothing attached yet
        host.select("claude")
        host.onPage(PageMessage.Input("codex", "b")) // other slot
        host.onPage(PageMessage.Input("terminal2", "c")) // other slot, not started
        assertTrue(sent.isEmpty())
        host.onPage(PageMessage.Input("claude", "d"))
        assertEquals(listOf("d"), typed())
        host.select("terminal2")
        host.onPage(PageMessage.Input("terminal2", "e")) // attached but not started
        host.select("codex")
        host.onPage(PageMessage.Input("codex", "f")) // attached but exited
        host.onDisconnected()
        host.onPage(PageMessage.Input("codex", "g")) // inactive
        assertEquals(listOf("d"), typed())
    }

    @Test fun inputToASlotThatExitsIsDroppedAfterTheStateFrame() {
        ready(); host.select("claude")
        host.onFrame(TerminalFrame.State("claude", SlotState.EXITED))
        host.onPage(PageMessage.Input("claude", "x"))
        assertTrue(sent.isEmpty())
    }

    @Test fun pageInputAndKeyRowShareOneOrderedCseqSequence() {
        ready(); host.select("claude")
        host.onPage(PageMessage.Input("claude", "a"))
        host.sendKeys("\u001b[A")
        host.onPage(PageMessage.Input("claude", "b"))
        assertEquals(listOf(1L, 2L, 3L), sent.map { it.second })
        assertEquals(listOf("a", "\u001b[A", "b"), typed())
    }

    @Test fun sendKeysIsGatedLikePageInput() {
        ready(info("claude", SlotState.EXITED)); host.sendKeys("x"); host.select("claude"); host.sendKeys("x")
        assertTrue(sent.isEmpty())
    }

    @Test fun failedAttachMeansTypingIsNotAcceptedAndKeysAreReportedNotSent() {
        attachResult = false
        ready(); host.select("claude")
        assertTrue(!host.typingAccepted())
        host.sendKeys("[A")
        assertTrue(sent.isEmpty())
        assertEquals(listOf(3), notSent)
    }

    @Test fun typingIsAcceptedOnlyForAnAttachedRunningSlot() {
        ready()
        assertTrue(!host.typingAccepted()) // between onSessions and select
        host.select("claude")
        assertTrue(host.typingAccepted())
        host.onFrame(TerminalFrame.State("claude", SlotState.EXITED))
        assertTrue(!host.typingAccepted())
    }

    @Test fun ctrlLatchTurnsOneLetterIntoAControlCharOnceThenClears() {
        ready(); host.select("claude")
        host.setCtrlLatch(true)
        assertTrue(host.ctrlLatched())
        host.onPage(PageMessage.Input("claude", "c"))
        host.onPage(PageMessage.Input("claude", "c"))
        assertEquals(listOf("\u0003", "c"), typed())
        assertTrue(!host.ctrlLatched())
    }

    @Test fun ctrlLatchMapsTheSpecialPunctuationAndIgnoresOtherKeys() {
        ready(); host.select("claude")
        for (k in listOf("[", "\\", "]", "^", "_", "@")) { host.setCtrlLatch(true); host.onPage(PageMessage.Input("claude", k)) }
        assertEquals(listOf(0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0), typed().map { it[0].code })
        sent.clear()
        host.setCtrlLatch(true); host.onPage(PageMessage.Input("claude", "1"))
        assertEquals(listOf("1"), typed())
    }

    @Test fun ctrlLatchIsIgnoredForMultiCharDataButStillClears() {
        ready(); host.select("claude")
        host.setCtrlLatch(true)
        host.onPage(PageMessage.Input("claude", "ls"))
        assertEquals(listOf("ls"), typed())
        assertTrue(!host.ctrlLatched())
    }

    @Test fun disconnectDropsTheLatchAndSendsNothingAfterward() {
        ready(); host.select("claude")
        host.setCtrlLatch(true)
        host.onDisconnected()
        assertTrue(!host.ctrlLatched())
        host.sendKeys("x"); host.onPage(PageMessage.Input("claude", "y"))
        assertTrue(sent.isEmpty())
    }

    @Test fun disconnectWithUnackedInputReportsNotSentAndNeverResendsOnReconnect() {
        ready(); host.select("claude")
        host.onPage(PageMessage.Input("claude", "abc")); host.onPage(PageMessage.Input("claude", "de"))
        host.onDisconnected()
        assertEquals(listOf(5), notSent)
        ready(); host.select("claude") // reconnect: onSessions again
        assertEquals(2, sent.size) // no replay
    }

    @Test fun ackFrameClearsPendingInput() {
        ready(); host.select("claude")
        host.onPage(PageMessage.Input("claude", "abc")); host.onPage(PageMessage.Input("claude", "de"))
        host.onFrame(TerminalFrame.Ack("claude", 2))
        host.onDisconnected()
        assertTrue(notSent.isEmpty())
    }

    @Test fun nakReachesTheSenderForAttachedAndDetachedSlotsAndCseqContinuesAfterIt() {
        val frames = ArrayList<Long>(); val ns = ArrayList<Int>(); val why = ArrayList<InputSender.Refusal>()
        val events = ArrayList<String>()
        val shared = InputSender({ _, c, _ -> frames.add(c); true }, { 0L }, { ns.add(it); events.add("notSent($it)") }, { why.add(it); events.add("refused($it)") })
        val h = TerminalHost(attach = { _, _ -> true }, detach = { true }, post = {}, feed = TerminalFeed(), sharedSender = shared)
        h.onSessions(listOf(info("claude"), info("codex"))); h.select("claude")
        h.onPage(PageMessage.Input("claude", "abc")); h.onPage(PageMessage.Input("claude", "de"))
        h.onFrame(TerminalFrame.Nak("claude", 1, NakReason.NOT_RUNNING))
        h.select("codex") // claude is no longer attached
        h.onFrame(TerminalFrame.Nak("claude", 2, NakReason.TYPING_OFF))
        assertEquals(listOf(3, 2), ns)
        assertEquals(listOf(InputSender.Refusal.NOT_RUNNING, InputSender.Refusal.TYPING_OFF), why)
        assertEquals(listOf("notSent(3)", "refused(NOT_RUNNING)", "notSent(2)", "refused(TYPING_OFF)"), events)
        h.select("claude"); h.onPage(PageMessage.Input("claude", "f"))
        assertEquals(listOf(1L, 2L, 3L), frames) // the nak'd numbers are never reused
    }

    @Test fun sendInputReturningFalseCountsAsNotSent() {
        ready(); host.select("claude")
        sendOk = false
        host.onPage(PageMessage.Input("claude", "abc"))
        assertEquals(listOf(3), notSent)
    }

    @Test fun stdinIsPostedOnWhenARunningSlotIsAttachedAndOffOnExitAndDisconnect() {
        ready(info("claude"), info("terminal2", SlotState.NOT_STARTED), info("codex"))
        assertTrue(stdins().isEmpty())
        host.select("claude")
        assertEquals(listOf(true), stdins())
        host.select("terminal2")
        assertEquals(listOf(true, false), stdins())
        host.select("codex")
        host.onFrame(TerminalFrame.State("codex", SlotState.EXITED))
        assertEquals(listOf(true, false, true, false), stdins())
        host.onDisconnected()
        assertEquals(listOf(true, false, true, false), stdins()) // already off: no repeat
        ready(); host.select("claude"); host.onDisconnected()
        assertEquals(listOf(true, false, true, false, true, false), stdins())
    }

    private fun hostOn(sender: InputSender) = TerminalHost(
        attach = { _, _ -> true }, detach = { true }, post = {}, feed = TerminalFeed(), sharedSender = sender,
    ).also { it.onSessions(listOf(info("claude"))); it.select("claude") }

    @Test fun twoHostsOnOneConnectionShareOneSenderSoCseqContinues() {
        val frames = ArrayList<Long>()
        val shared = InputSender({ _, c, _ -> frames.add(c); true }, { 0L })
        val h1 = hostOn(shared)
        for (k in 1..3) h1.onPage(PageMessage.Input("claude", "k"))
        h1.onFrame(TerminalFrame.Ack("claude", 3))
        h1.onDisconnected(connectionLost = false) // render gone
        val h2 = hostOn(shared)
        h2.onPage(PageMessage.Input("claude", "k"))
        assertEquals(listOf(1L, 2L, 3L, 4L), frames)
    }

    @Test fun aSecondOnSessionsOnOneConnectionDoesNotRestartCseq() {
        ready(); host.select("claude")
        host.onPage(PageMessage.Input("claude", "a")); host.onPage(PageMessage.Input("claude", "b"))
        ready(); host.select("claude")
        host.onPage(PageMessage.Input("claude", "c"))
        assertEquals(listOf(1L, 2L, 3L), sent.map { it.second })
    }

    @Test fun renderGoneRebuildReportsNothingNotSentButARealDisconnectDoes() {
        ready(); host.select("claude")
        host.onPage(PageMessage.Input("claude", "abc"))
        host.onDisconnected(connectionLost = false)
        assertTrue(notSent.isEmpty())
        ready(); host.select("claude")
        host.onDisconnected()
        assertEquals(listOf(3), notSent) // still pending: the shared sender kept it
    }

    @Test fun failedAttachLeavesNothingAttachedAndReselectRetries() {
        ready()
        attachResult = false
        host.select("claude")
        attachResult = true
        host.select("claude")
        assertEquals(listOf("attach claude -", "attach claude -"), calls)
        host.select("claude") // now attached: shortcut, no third attach
        assertEquals(2, calls.size)
    }

    @Test fun throwingAttachOnSelectAlsoRetries() {
        ready()
        throwOnAttach = true
        host.select("claude")
        throwOnAttach = false
        host.select("claude")
        assertEquals(listOf("attach claude -"), calls)
    }

    @Test fun failedPostOfAcceptedOutForgetsBaselineSoNextFrameReattaches() {
        ready(); host.select("claude")
        host.onFrame(TerminalFrame.Snap("claude", 1, 100, 30, ""))
        calls.clear()
        throwOnPost = true
        host.onFrame(TerminalFrame.Out("claude", 2, "lost"))
        throwOnPost = false
        host.onFrame(TerminalFrame.Out("claude", 3, "next"))
        assertEquals(listOf("attach claude -"), calls)
    }

    @Test fun failedPostOfSnapForgetsBaselineAndNextOutReattachesOnce() {
        ready(); host.select("claude")
        calls.clear()
        throwOnPost = true
        host.onFrame(TerminalFrame.Snap("claude", 3, 100, 30, "S"))
        throwOnPost = false
        host.onFrame(TerminalFrame.Out("claude", 4, "x"))
        host.onFrame(TerminalFrame.Out("claude", 5, "y"))
        assertEquals(listOf("attach claude -"), calls)
        host.onFrame(TerminalFrame.Snap("claude", 5, 100, 30, "S2"))
        host.onFrame(TerminalFrame.Out("claude", 5, "dup"))
        host.onFrame(TerminalFrame.Out("claude", 6, "z"))
        val written = posts.map { JSONObject(it) }.filter { it.getString("t") !in setOf("show", "stdin") }.map { it.getString("d") }
        assertEquals(listOf("S2", "z"), written)
    }

    @Test fun failedSnapPostWithExistingBaselineDoesNotAcceptStaleOut() {
        ready(); host.select("claude")
        host.onFrame(TerminalFrame.Snap("claude", 1, 100, 30, "S"))
        calls.clear()
        throwOnPost = true
        host.onFrame(TerminalFrame.Snap("claude", 2, 100, 30, "S2"))
        throwOnPost = false
        host.onFrame(TerminalFrame.Out("claude", 2, "x"))
        host.onFrame(TerminalFrame.Out("claude", 3, "y"))
        assertEquals(listOf("attach claude -"), calls)
        assertEquals(listOf("S"), posts.map { JSONObject(it) }.filter { it.getString("t") !in setOf("show", "stdin") }.map { it.getString("d") })
    }

    @Test fun typeRegressionInBuilderIsCaughtByAssertJson() {
        val bad = JSONObject().put("t", "size").put("s", "claude").put("cols", "80").put("rows", 24).toString()
        val threw = try { assertJson("""{"t":"size","s":"claude","cols":80,"rows":24}""", bad); false } catch (_: AssertionError) { true }
        assertTrue(threw)
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

    private fun composeHost(events: ArrayList<String>, posted: ArrayList<String>): TerminalHost {
        val sender = InputSender(
            { _, _, _ -> true }, { 0L },
            onNotSent = { events.add("notSent($it)") }, onRefused = { events.add("refused($it)") },
        )
        return TerminalHost({ _, _ -> true }, { true }, { posted.add(it) }, TerminalFeed(), sharedSender = sender).also {
            it.onSessions(listOf(info("claude")))
            it.select("claude")
            posted.clear()
        }
    }

    @Test fun composePostsOneMessageForARunningAttachedSlot() {
        ready(); host.select("claude"); posts.clear()
        assertEquals(TerminalHost.ComposeResult.SENT, host.sendCompose("line1\nline2", true))
        assertEquals(1, posts.size)
        assertJson("""{"t":"compose","s":"claude","d":"line1\nline2","enter":true}""", posts[0])
        assertTrue(sent.isEmpty() && notSent.isEmpty())
    }

    @Test fun composePostsCrlfUnchanged() {
        ready(); host.select("claude"); posts.clear()
        host.sendCompose("a\r\nb", false)
        assertEquals("a\r\nb", JSONObject(posts[0]).getString("d"))
    }

    @Test fun composeIsNotAcceptedWhenTypingIsClosed() {
        for (setup in listOf<() -> Unit>(
            { ready() },
            { ready(info("claude", SlotState.NOT_STARTED)); host.select("claude") },
            { ready(); host.select("claude"); host.onFrame(TerminalFrame.State("claude", SlotState.EXITED)) },
            { ready(); host.select("claude"); host.onDisconnected() },
        )) {
            notSent.clear(); setup(); posts.clear()
            assertEquals(TerminalHost.ComposeResult.NOT_ACCEPTED, host.sendCompose("abc", true))
            assertTrue(posts.isEmpty())
            assertEquals(listOf(4), notSent)
        }
    }

    @Test fun composeOverTheCapIsRefusedCountedThenReasonedAndNotPosted() {
        val events = ArrayList<String>(); val posted = ArrayList<String>()
        val h = composeHost(events, posted)
        assertEquals(TerminalHost.ComposeResult.TOO_LARGE, h.sendCompose("x".repeat(InputSender.MAX_INPUT_BYTES - 15), false))
        assertTrue(posted.isEmpty())
        assertEquals(listOf("notSent(${InputSender.MAX_INPUT_BYTES - 15})", "refused(TOO_LARGE)"), events)
    }

    @Test fun composeOverTheCapWithEnterCountsTheEnterLikeOtherRefusals() {
        val events = ArrayList<String>(); val posted = ArrayList<String>()
        val h = composeHost(events, posted)
        val len = InputSender.MAX_INPUT_BYTES - 15
        assertEquals(TerminalHost.ComposeResult.TOO_LARGE, h.sendCompose("x".repeat(len), true))
        assertTrue(posted.isEmpty())
        assertEquals(listOf("notSent(${len + 1})", "refused(TOO_LARGE)"), events)
    }

    @Test fun composeJustUnderTheCapIsSent() {
        val events = ArrayList<String>(); val posted = ArrayList<String>()
        val h = composeHost(events, posted)
        assertEquals(TerminalHost.ComposeResult.SENT, h.sendCompose("x".repeat(InputSender.MAX_INPUT_BYTES - 16), false))
        assertEquals(1, posted.size)
        assertTrue(events.isEmpty())
    }

    @Test fun composeEmptyWithEnterPostsOnceAndEmptyWithoutEnterPostsNothing() {
        ready(); host.select("claude"); posts.clear()
        assertEquals(TerminalHost.ComposeResult.SENT, host.sendCompose("", true))
        assertEquals(1, posts.size)
        assertJson("""{"t":"compose","s":"claude","d":"","enter":true}""", posts[0])
        posts.clear()
        assertEquals(TerminalHost.ComposeResult.SENT, host.sendCompose("", false))
        assertTrue(posts.isEmpty())
    }

    @Test fun composeLeavesTheCtrlLatchAlone() {
        ready(); host.select("claude")
        host.setCtrlLatch(true)
        host.sendCompose("a", false)
        assertTrue(host.ctrlLatched())
    }

    @Test fun composePostFailureIsCountedNotSentOnce() {
        ready(); host.select("claude")
        throwOnPost = true
        assertEquals(TerminalHost.ComposeResult.NOT_ACCEPTED, host.sendCompose("abc", true))
        assertEquals(listOf(4), notSent)
    }

    @Test fun pageCompositionBytesGoOutAsTwoInputFramesInOrder() {
        ready(); host.select("claude")
        host.onPage(PageMessage.Input("claude", "\u001b[200~line1\rline2\u001b[201~"))
        host.onPage(PageMessage.Input("claude", "\r"))
        assertEquals(
            listOf(Triple("claude", 1L, "\u001b[200~line1\rline2\u001b[201~"), Triple("claude", 2L, "\r")),
            sent,
        )
    }

    private fun exitedT2() { ready(info("claude"), info("terminal2", SlotState.EXITED), info("codex", SlotState.EXITED)); host.select("terminal2") }

    @Test fun restartAvailableOnlyForAttachedExitedTerminal2() {
        ready(info("claude"), info("terminal2", SlotState.EXITED), info("codex", SlotState.EXITED))
        assertTrue(!host.restartAvailable())
        host.select("terminal2")
        assertTrue(host.restartAvailable())
        host.onDisconnected()
        assertTrue(!host.restartAvailable())
    }

    @Test fun restartNotAvailableForRunningNotStartedClaudeOrCodex() {
        for ((slot, st) in listOf("terminal2" to SlotState.RUNNING, "terminal2" to SlotState.NOT_STARTED,
            "claude" to SlotState.EXITED, "codex" to SlotState.EXITED)) {
            fun st(n: String) = if (n == slot) st else SlotState.RUNNING
            ready(info("claude", st("claude")), info("terminal2", st("terminal2")), info("codex", st("codex")))
            host.select(slot)
            assertTrue("$slot $st", !host.restartAvailable())
            assertTrue("$slot $st", !host.restartTerminal2())
        }
        assertTrue(sent.isEmpty()); assertTrue(notSent.isEmpty())
    }

    @Test fun restartSendsExactlyOneCr() {
        exitedT2()
        assertTrue(host.restartTerminal2())
        assertEquals(listOf(Triple("terminal2", 1L, "\r")), sent)
        assertTrue(!host.typingAccepted())
        assertTrue(stdins().none { it })
    }

    @Test fun typingStaysBlockedOnExitedTerminal2() {
        exitedT2()
        host.sendKeys("x"); host.sendKeys("\r"); host.sendCompose("x", true)
        host.onPage(PageMessage.Input("terminal2", "x"))
        assertTrue(sent.isEmpty()); assertTrue(notSent.isNotEmpty()); assertTrue(!host.typingAccepted())
    }

    @Test fun restartControlFollowsServerStateFrames() {
        exitedT2()
        host.onFrame(TerminalFrame.State("terminal2", SlotState.RUNNING))
        assertTrue(!host.restartAvailable()); assertTrue(host.typingAccepted())
        host.onFrame(TerminalFrame.State("terminal2", SlotState.EXITED))
        assertTrue(host.restartAvailable()); assertTrue(!host.typingAccepted())
    }
}
