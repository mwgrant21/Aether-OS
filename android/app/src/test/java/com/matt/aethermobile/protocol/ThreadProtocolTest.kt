package com.matt.aethermobile.protocol

import com.matt.aethermobile.protocol.ControlProtocol.ThreadEntry
import com.matt.aethermobile.protocol.ControlProtocol.ThreadFrame
import com.matt.aethermobile.protocol.ControlProtocol.ThreadMeta
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class ThreadProtocolTest {
    // Gradle runs unit tests with cwd = android/app.
    private val spec = JSONObject(File("../../protocol/mobile-protocol.json").readText(Charsets.UTF_8))
    private val frames = spec.getJSONObject("frames")
    private fun g(name: String) = frames.getString(name)
    private fun parse(name: String) = ControlProtocol.parseThreadFrame(g(name))

    private val meta = ThreadMeta(73_400, 36.9, ControlProtocol.Work.WORKING, 1_790_000_000_000, 38_200, 1_790_000_100_000, null)
    private val unknownMeta = ThreadMeta(null, null, ControlProtocol.Work.UNKNOWN, null, null, null, null)

    private fun mutate(name: String, edit: (JSONObject) -> Unit): String = JSONObject(g(name)).also(edit).toString()

    @Test fun constantsEqualTheSharedJson() {
        val t = spec.getJSONObject("threads")
        assertEquals((0 until t.getJSONArray("slots").length()).map { t.getJSONArray("slots").getString(it) }, ControlProtocol.THREAD_SLOTS)
        assertEquals(t.getInt("historyEntries"), ControlProtocol.THREAD_HISTORY_ENTRIES)
        assertEquals(t.getInt("snapshotBytes"), ControlProtocol.THREAD_SNAPSHOT_BYTES)
        assertEquals(t.getInt("textCap"), ControlProtocol.THREAD_TEXT_CAP)
        assertEquals(t.getInt("labelCap"), ControlProtocol.THREAD_LABEL_CAP)
        assertEquals(t.getInt("diffInlineLines"), ControlProtocol.THREAD_DIFF_INLINE_LINES)
        assertEquals(t.getInt("detailBytes"), ControlProtocol.THREAD_DETAIL_BYTES)
        assertEquals(t.getInt("detailLines"), ControlProtocol.THREAD_DETAIL_LINES)
        assertEquals(t.getInt("inputBytes"), ControlProtocol.THREAD_INPUT_BYTES)
        assertEquals(t.getInt("inputLines"), ControlProtocol.THREAD_INPUT_LINES)
        assertEquals(t.getInt("ratePerS"), ControlProtocol.THREAD_RATE_PER_S)
        assertEquals(t.getInt("rateBurst"), ControlProtocol.THREAD_RATE_BURST)
    }

    @Test fun tsnapGoldenParsesToEveryEntryKind() {
        val f = parse("tsnap") as ThreadFrame.Snap
        assertEquals("claude", f.s)
        assertEquals(57L, f.q)
        assertTrue(f.avail)
        assertNull(f.why)
        assertEquals(meta, f.m)
        assertEquals(
            listOf(
                ThreadEntry.User("100:0", 1_790_000_000_000, "fix the login bug", false),
                ThreadEntry.Assistant("200:0", 1_790_000_001_000, "Looking at auth.ts.", false),
                ThreadEntry.Thinking("300:0", 1_790_000_002_000, 14_000, false),
                ThreadEntry.Tool(
                    "400:0", 1_790_000_003_000, "Edit", "auth.ts", ControlProtocol.ToolState.OK, 18_400, true,
                    listOf("-" to "const a = 1;", "+" to "const a = 2;"), 3,
                ),
                ThreadEntry.Tool("500:0", 1_790_000_004_000, "Bash", "npm test", ControlProtocol.ToolState.RUN, null, false),
            ),
            f.entries,
        )
    }

    @Test fun tsnapUnavailableGoldenParses() {
        val f = parse("tsnapUnavailable") as ThreadFrame.Snap
        assertEquals("terminal2", f.s)
        assertFalse(f.avail)
        assertEquals(ControlProtocol.Why.NO_SESSION, f.why)
        assertTrue(f.entries.isEmpty())
        assertEquals(unknownMeta, f.m)
    }

    @Test fun taddTupdTmetaGoldensParse() {
        assertEquals(
            ThreadFrame.Add("claude", 58, ThreadEntry.Assistant("200:0", 1_790_000_001_000, "Looking at auth.ts.", false)),
            parse("tadd"),
        )
        assertEquals(
            ThreadFrame.Upd("claude", 59, ThreadEntry.Tool("500:0", 1_790_000_004_000, "Bash", "npm test", ControlProtocol.ToolState.OK, 512, true)),
            parse("tupd"),
        )
        assertEquals(ThreadFrame.Meta("claude", meta), parse("tmeta"))
    }

    @Test fun tdetGoldensParseIncludingNulls() {
        assertEquals(ThreadFrame.Detail("claude", "500:0", "npm test", 0, "PASS 12 tests", 0), parse("tdet"))
        assertEquals(ThreadFrame.Detail("claude", "999:0", null, 0, null, 0), parse("tdetNull"))
    }

    @Test fun welcomeCapsGoldenParsesAndPlainWelcomeHasNone() {
        assertEquals(setOf("thread"), ControlProtocol.parseWelcome(g("welcomeCaps"))!!.caps)
        assertEquals(emptySet<String>(), ControlProtocol.parseWelcome(g("welcome"))!!.caps)
        val odd = mutate("welcomeCaps") { it.put("caps", JSONArray().put("thread").put(7).put(JSONObject.NULL)) }
        assertEquals(setOf("thread"), ControlProtocol.parseWelcome(odd)!!.caps)
        assertEquals(emptySet<String>(), ControlProtocol.parseWelcome(mutate("welcomeCaps") { it.put("caps", "thread") })!!.caps)
    }

    @Test fun buildersEqualTheGoldens() {
        assertEquals(g("tattach"), ControlProtocol.buildTattach("claude"))
        assertEquals(g("tdetach"), ControlProtocol.buildTdetach("terminal2"))
        assertEquals(g("tget"), ControlProtocol.buildTget("claude", "123456:0"))
    }

    @Test fun buildersRejectBadSlotsAndIds() {
        for (call in listOf<() -> Unit>(
            { ControlProtocol.buildTattach("codex") },
            { ControlProtocol.buildTattach("bash") },
            { ControlProtocol.buildTdetach("") },
            { ControlProtocol.buildTget("codex", "1:0") },
            { ControlProtocol.buildTget("claude", "") },
            { ControlProtocol.buildTget("claude", "abc:0") },
            { ControlProtocol.buildTget("claude", "1:0\",\"x\":\"") },
            { ControlProtocol.buildTget("claude", "1234567890123:0") },
            { ControlProtocol.buildTget("claude", "12345") },
            { ControlProtocol.buildTget("claude", "1:0".repeat(20)) },
        )) {
            try { call(); fail("expected IllegalArgumentException") } catch (_: IllegalArgumentException) { }
        }
    }

    @Test fun unknownFrameTypeAndTerminalOnlySlotAreRejected() {
        assertNull(ControlProtocol.parseThreadFrame(mutate("tmeta") { it.put("t", "tnope") }))
        assertNull(ControlProtocol.parseThreadFrame(g("snap")))
        assertNull(ControlProtocol.parseThreadFrame(mutate("tmeta") { it.put("s", "codex") }))
        assertNull(ControlProtocol.parseThreadFrame(mutate("tadd") { it.put("s", "bash") }))
        assertNull(ControlProtocol.parseThreadFrame(mutate("tmeta") { it.remove("s") }))
        assertNull(ControlProtocol.parseThreadFrame("not json"))
    }

    @Test fun nonWholeNumbersAreRejected() {
        // A double where the TS side emits an integer.
        assertNull(ControlProtocol.parseThreadFrame(g("tadd").replace("\"q\":58", "\"q\":58.0")))
        assertNull(ControlProtocol.parseThreadFrame(g("tadd").replace("\"q\":58", "\"q\":\"58\"")))
        assertNull(ControlProtocol.parseThreadFrame(g("tadd").replace("\"q\":58", "\"q\":-1")))
        assertNull(ControlProtocol.parseThreadFrame(g("tmeta").replace("\"ctxTok\":73400", "\"ctxTok\":73400.5")))
        assertNull(ControlProtocol.parseThreadFrame(g("tdet").replace("\"more\":0", "\"more\":1.5")))
        assertNull(ControlProtocol.parseThreadFrame(g("tupd").replace("\"sz\":512", "\"sz\":512.0")))
        // ctxPct is the one fractional field; a string is not a number.
        assertNull(ControlProtocol.parseThreadFrame(g("tmeta").replace("\"ctxPct\":36.9", "\"ctxPct\":\"36.9\"")))
        assertNotNull(ControlProtocol.parseThreadFrame(g("tmeta").replace("\"ctxPct\":36.9", "\"ctxPct\":37")))
    }

    @Test fun missingRequiredKeysAreRejected() {
        assertNull(ControlProtocol.parseThreadFrame(mutate("tadd") { it.remove("e") }))
        assertNull(ControlProtocol.parseThreadFrame(mutate("tadd") { it.getJSONObject("e").remove("x") }))
        assertNull(ControlProtocol.parseThreadFrame(mutate("tadd") { it.getJSONObject("e").remove("tr") }))
        assertNull(ControlProtocol.parseThreadFrame(mutate("tupd") { it.getJSONObject("e").remove("sz") }))
        assertNull(ControlProtocol.parseThreadFrame(mutate("tmeta") { it.getJSONObject("m").remove("wait") }))
        assertNull(ControlProtocol.parseThreadFrame(mutate("tdet") { it.remove("input") }))
        assertNull(ControlProtocol.parseThreadFrame(mutate("tsnap") { it.remove("why") }))
        assertNull(ControlProtocol.parseThreadFrame(mutate("tmeta") { it.put("m", "x") }))
    }

    @Test fun badEnumsAndEntryKindsAreRejected() {
        assertNull(ControlProtocol.parseThreadFrame(mutate("tadd") { it.getJSONObject("e").put("k", "z") }))
        assertNull(ControlProtocol.parseThreadFrame(mutate("tupd") { it.getJSONObject("e").put("st", "done") }))
        assertNull(ControlProtocol.parseThreadFrame(mutate("tmeta") { it.getJSONObject("m").put("work", "busy") }))
        assertNull(ControlProtocol.parseThreadFrame(mutate("tmeta") { it.getJSONObject("m").put("wait", "hung") }))
        assertNull(ControlProtocol.parseThreadFrame(mutate("tsnapUnavailable") { it.put("why", "gone") }))
        assertNull(ControlProtocol.parseThreadFrame(mutate("tsnap") { it.getJSONArray("entries").getJSONObject(3).getJSONArray("df").put(0, JSONArray().put("*").put("x")) }))
    }

    @Test fun badEntryIdsAreRejected() {
        for (bad in listOf("", "abc", "1-2", "1:0 ", "1:0".repeat(14))) {
            assertNull(bad, ControlProtocol.parseThreadFrame(mutate("tadd") { it.getJSONObject("e").put("id", bad) }))
        }
        assertNull(ControlProtocol.parseThreadFrame(mutate("tdet") { it.put("id", "../x") }))
    }

    @Test fun oversizeTextIsRejected() {
        val ok = "a".repeat(ControlProtocol.THREAD_TEXT_CAP)
        assertNotNull(ControlProtocol.parseThreadFrame(mutate("tadd") { it.getJSONObject("e").put("x", ok) }))
        assertNull(ControlProtocol.parseThreadFrame(mutate("tadd") { it.getJSONObject("e").put("x", ok + "a") }))
        assertNull(ControlProtocol.parseThreadFrame(mutate("tupd") { it.getJSONObject("e").put("l", "l".repeat(ControlProtocol.THREAD_LABEL_CAP + 1)) }))
        assertNull(ControlProtocol.parseThreadFrame(mutate("tdet") { it.put("x", "a".repeat(ControlProtocol.THREAD_DETAIL_BYTES + 1)) }))
        assertNull(ControlProtocol.parseThreadFrame(mutate("tdet") { it.put("input", "a".repeat(ControlProtocol.THREAD_INPUT_BYTES + 1)) }))
        // 2-byte characters: under the cap in characters, over it in UTF-8 bytes.
        assertNull(ControlProtocol.parseThreadFrame(mutate("tdet") { it.put("x", "é".repeat(ControlProtocol.THREAD_DETAIL_BYTES / 2 + 1)) }))
        assertNotNull(ControlProtocol.parseThreadFrame(mutate("tdet") { it.put("x", "a".repeat(ControlProtocol.THREAD_DETAIL_BYTES)) }))
    }

    @Test fun oversizeSnapshotAndTooManyEntriesAreRejected() {
        val big = "a".repeat(ControlProtocol.THREAD_TEXT_CAP)
        val one = JSONObject(g("tadd")).getJSONObject("e").put("x", big)
        val fat = mutate("tsnap") { o ->
            val a = JSONArray()
            repeat(40) { a.put(JSONObject(one.toString())) } // 40 * 4000 chars > 131072 + envelope
            o.put("entries", a)
        }
        assertTrue(fat.length > ControlProtocol.THREAD_SNAPSHOT_BYTES + 1024)
        assertNull(ControlProtocol.parseThreadFrame(fat))
        val many = mutate("tsnap") { o ->
            val a = JSONArray()
            repeat(ControlProtocol.THREAD_HISTORY_ENTRIES + 1) { a.put(JSONObject(one.toString()).put("x", "s")) }
            o.put("entries", a)
        }
        assertNull(ControlProtocol.parseThreadFrame(many))
        val atLimit = mutate("tsnap") { o ->
            val a = JSONArray()
            repeat(ControlProtocol.THREAD_HISTORY_ENTRIES) { a.put(JSONObject(one.toString()).put("x", "s")) }
            o.put("entries", a)
        }
        assertEquals(ControlProtocol.THREAD_HISTORY_ENTRIES, (ControlProtocol.parseThreadFrame(atLimit) as ThreadFrame.Snap).entries.size)
    }

    @Test fun unavailableSnapshotMustCarryNoEntries() {
        val bad = mutate("tsnapUnavailable") { it.put("entries", JSONObject(g("tsnap")).getJSONArray("entries")) }
        assertNull(ControlProtocol.parseThreadFrame(bad))
    }

    @Test fun unknownKeysAreIgnoredAndOneBadEntryRejectsTheWholeSnapshot() {
        assertNotNull(ControlProtocol.parseThreadFrame(mutate("tmeta") { it.put("future", 1) }))
        assertNotNull(ControlProtocol.parseThreadFrame(mutate("tadd") { it.getJSONObject("e").put("future", true) }))
        assertNull(ControlProtocol.parseThreadFrame(mutate("tsnap") { it.getJSONArray("entries").getJSONObject(1).put("tr", "no") }))
    }

    @Test fun toolDiffIsBoundedAndOptional() {
        val tooMany = JSONArray().also { a -> repeat(ControlProtocol.THREAD_DIFF_INLINE_LINES + 1) { a.put(JSONArray().put("+").put("l")) } }
        assertNull(ControlProtocol.parseThreadFrame(mutate("tupd") { it.getJSONObject("e").put("df", tooMany) }))
        val t = (parse("tupd") as ThreadFrame.Upd).e as ThreadEntry.Tool
        assertNull(t.df)
        assertNull(t.dn)
    }
}
