package com.matt.aethermobile.ui.thread

import com.matt.aethermobile.protocol.ControlProtocol.ThreadEntry
import com.matt.aethermobile.protocol.ControlProtocol.ThreadMeta
import com.matt.aethermobile.protocol.ControlProtocol.ToolState
import com.matt.aethermobile.protocol.ControlProtocol.Wait
import com.matt.aethermobile.protocol.ControlProtocol.Work
import com.matt.aethermobile.ui.thread.MarkdownLite.Block
import com.matt.aethermobile.ui.thread.MarkdownLite.Span
import com.matt.aethermobile.ui.thread.MarkdownLite.Style
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadUiModelTest {
    private fun meta(
        ctxTok: Long? = null, ctxPct: Double? = null, work: Work = Work.IDLE, since: Long? = null,
        tok: Long? = null, last: Long? = null, wait: Wait? = null,
    ) = ThreadMeta(ctxTok, ctxPct, work, since, tok, last, wait)

    private fun tool(
        id: String = "1:0", n: String = "Bash", st: ToolState = ToolState.OK, sz: Long? = 18_400, d: Boolean = true,
        df: List<Pair<String, String>>? = null, dn: Int? = null,
    ) = ThreadEntry.Tool(id, 0, n, "ls", st, sz, d, df, dn)

    @Test fun userAndAssistantRows() {
        val rows = ThreadUiModel.rowsFor(
            listOf(ThreadEntry.User("1:0", 1, "hi", true), ThreadEntry.Assistant("2:0", 2, "a **b**", false)),
        )
        assertEquals(ThreadRow.UserBubble("1:0", "hi", true), rows[0])
        val a = rows[1] as ThreadRow.AssistantText
        assertEquals(listOf<Block>(Block.Paragraph(listOf(Span("a ", Style.PLAIN), Span("b", Style.BOLD)))), a.blocks)
    }

    @Test fun toolRowFieldsAndExpansion() {
        val closed = ThreadUiModel.rowsFor(listOf(tool())).single() as ThreadRow.ToolRow
        assertEquals("BASH", closed.tag)
        assertEquals("18.4k c", closed.sizeText)
        assertTrue(closed.expandable)
        assertEquals(false, closed.expanded)
        assertNull(closed.detail)

        val loading = ThreadUiModel.rowsFor(listOf(tool()), setOf("1:0")).single() as ThreadRow.ToolRow
        assertEquals(ThreadDetail.Loading, loading.detail)

        val ready = ThreadDetail.Ready("ls", 0, "out", 2)
        val open = ThreadUiModel.rowsFor(listOf(tool()), setOf("1:0"), mapOf("1:0" to ready)).single() as ThreadRow.ToolRow
        assertEquals(ready, open.detail)

        val noDetail = ThreadUiModel.rowsFor(listOf(tool(d = false)), setOf("1:0")).single() as ThreadRow.ToolRow
        assertEquals(false, noDetail.expanded)
        assertNull(noDetail.detail)
    }

    @Test fun runningToolHasNoSize() {
        val r = ThreadUiModel.rowsFor(listOf(tool(st = ToolState.RUN, sz = null))).single() as ThreadRow.ToolRow
        assertEquals("", r.sizeText)
        assertEquals(ToolState.RUN, r.state)
    }

    @Test fun diffBlockFollowsToolRow() {
        val rows = ThreadUiModel.rowsFor(listOf(tool(n = "Edit", df = listOf("-" to "old", "+" to "new"), dn = 3)))
        assertEquals(2, rows.size)
        assertEquals("EDIT", (rows[0] as ThreadRow.ToolRow).tag)
        val d = rows[1] as ThreadRow.DiffBlock
        assertEquals(listOf(DiffLine(false, "old"), DiffLine(true, "new")), d.lines)
        assertEquals(3, d.moreLines)
        assertEquals(1, ThreadUiModel.rowsFor(listOf(tool(df = emptyList()))).size)
    }

    @Test fun thinkingRow() {
        val e = ThreadEntry.Thinking("3:0", 0, 14_000, true)
        val closed = ThreadUiModel.rowsFor(listOf(e)).single() as ThreadRow.ThinkingRow
        assertEquals("14 s", closed.durationText)
        assertTrue(closed.expandable)
        assertNull(closed.detail)
        val open = ThreadUiModel.rowsFor(listOf(e), setOf("3:0")).single() as ThreadRow.ThinkingRow
        assertEquals(ThreadDetail.Loading, open.detail)
        val empty = ThreadUiModel.rowsFor(listOf(ThreadEntry.Thinking("4:0", 0, null, false)), setOf("4:0")).single() as ThreadRow.ThinkingRow
        assertNull(empty.durationText)
        assertEquals(false, empty.expanded)
    }

    @Test fun tagMapping() {
        assertEquals("READ", ThreadUiModel.tagFor("Read"))
        assertEquals("GREP", ThreadUiModel.tagFor("Grep"))
        assertEquals("WRITE", ThreadUiModel.tagFor("Write"))
        assertEquals("AGENT", ThreadUiModel.tagFor("Task"))
        assertEquals("EDIT", ThreadUiModel.tagFor("MultiEdit"))
        assertEquals("GLOB", ThreadUiModel.tagFor("Glob"))
        assertEquals("MCP__SERVER_", ThreadUiModel.tagFor("mcp__server__tool"))
    }

    @Test fun sizeTextBoundaries() {
        assertEquals("", ThreadUiModel.sizeText(null))
        assertEquals("0 c", ThreadUiModel.sizeText(0))
        assertEquals("812 c", ThreadUiModel.sizeText(812))
        assertEquals("999 c", ThreadUiModel.sizeText(999))
        assertEquals("1.0k c", ThreadUiModel.sizeText(1000))
        assertEquals("18.4k c", ThreadUiModel.sizeText(18_400))
        assertEquals("1.0M c", ThreadUiModel.sizeText(999_950))
        assertEquals("1.2M c", ThreadUiModel.sizeText(1_234_567))
    }

    @Test fun ctxTextNeverRendersUnknownAsZero() {
        assertEquals("CTX 36.9%", ThreadUiModel.ctxText(meta(ctxPct = 36.9, ctxTok = 73_400)))
        assertEquals("CTX 73.4k tok", ThreadUiModel.ctxText(meta(ctxTok = 73_400)))
        assertEquals("CTX 73.4k tok", ThreadUiModel.ctxText(meta(ctxTok = 73_400, ctxPct = 0.0)))
        assertNull(ThreadUiModel.ctxText(meta()))
        assertNull(ThreadUiModel.ctxText(meta(ctxTok = 0, ctxPct = 0.0)))
        assertNull(ThreadUiModel.ctxText(meta(ctxPct = Double.NaN)))
        assertEquals("CTX 100.0%", ThreadUiModel.ctxText(meta(ctxPct = 140.0)))
    }

    @Test fun workingTextFormatsAndDropsUnknown() {
        val since = 1_000_000L
        fun w(elapsedSec: Long, tok: Long? = 38_200) =
            ThreadUiModel.workingText(meta(work = Work.WORKING, since = since, tok = tok), since + elapsedSec * 1000, 0)
        assertEquals("Working · 2m 14s · 38.2k tok", w(134))
        assertEquals("Working · 59s · 38.2k tok", w(59))
        assertEquals("Working · 1m 0s · 38.2k tok", w(60))
        assertEquals("Working · 1h 0m · 38.2k tok", w(3600))
        assertEquals("Working · 1h 1m · 38.2k tok", w(3661))
        assertEquals("Working · 2m 14s", w(134, null))
        assertEquals("Working · 38.2k tok", ThreadUiModel.workingText(meta(work = Work.WORKING, tok = 38_200), 5, 0))
        assertEquals("Working", ThreadUiModel.workingText(meta(work = Work.WORKING), 5, 0))
        assertNull(ThreadUiModel.workingText(meta(work = Work.IDLE, since = since), since + 5000, 0))
        assertNull(ThreadUiModel.workingText(meta(work = Work.UNKNOWN), 5, 0))
    }

    @Test fun workingTextAppliesServerOffsetAndClampsNegative() {
        val m = meta(work = Work.WORKING, since = 10_000)
        assertEquals("Working · 5s", ThreadUiModel.workingText(m, 5_000, 10_000))
        assertEquals("Working · 0s", ThreadUiModel.workingText(m, 1_000, 0))
    }

    @Test fun lastActivityText() {
        val now = 1_000_000_000L
        fun t(ago: Long, work: Work = Work.IDLE) = ThreadUiModel.lastActivityText(meta(work = work, last = now - ago * 1000), now, 0)
        assertEquals("Last activity just now", t(59))
        assertEquals("Last activity 1 min ago", t(60))
        assertEquals("Last activity 4 min ago", t(240))
        assertEquals("Last activity 2 h ago", t(7200))
        assertEquals("Last activity 3 d ago", t(3 * 86_400))
        assertNull(t(240, Work.WORKING))
        assertNull(ThreadUiModel.lastActivityText(meta(), now, 0))
    }

    @Test fun bannerChoice() {
        assertEquals(ThreadBanner(Wait.PERM, "thread_banner_perm"), ThreadUiModel.bannerFor(meta(wait = Wait.PERM), ThreadViewMode.THREAD))
        assertEquals(ThreadBanner(Wait.QUIET, "thread_banner_quiet"), ThreadUiModel.bannerFor(meta(wait = Wait.QUIET), ThreadViewMode.THREAD))
        assertNull(ThreadUiModel.bannerFor(meta(), ThreadViewMode.THREAD))
        assertNull(ThreadUiModel.bannerFor(meta(wait = Wait.PERM), ThreadViewMode.TERM))
        assertTrue(ThreadUiModel.termDot(meta(wait = Wait.QUIET)))
        assertEquals(false, ThreadUiModel.termDot(meta()))
    }

    // ---- MarkdownLite ----

    private fun p(vararg s: Span): Block = Block.Paragraph(s.toList())

    @Test fun markdownFenceAndParagraphs() {
        val b = MarkdownLite.parse("before\n```kotlin\nval a = 1\n\nval b = 2\n```\nafter\n\nnext")
        assertEquals(
            listOf(p(Span("before", Style.PLAIN)), Block.CodeFence("val a = 1\n\nval b = 2"), p(Span("after", Style.PLAIN)), p(Span("next", Style.PLAIN))),
            b,
        )
    }

    @Test fun markdownUnterminatedFenceClosesAtEnd() {
        assertEquals(listOf<Block>(Block.CodeFence("a\nb")), MarkdownLite.parse("```\na\nb"))
    }

    @Test fun markdownInlineCodeAndBold() {
        assertEquals(
            listOf(p(Span("run ", Style.PLAIN), Span("ls -a", Style.CODE), Span(" and ", Style.PLAIN), Span("stop", Style.BOLD), Span("!", Style.PLAIN))),
            MarkdownLite.parse("run `ls -a` and **stop**!"),
        )
        // bold markers inside code stay literal
        assertEquals(listOf(p(Span("**x**", Style.CODE))), MarkdownLite.parse("`**x**`"))
    }

    @Test fun markdownUnbalancedAndEmptyDelimitersStayLiteral() {
        assertEquals(listOf(p(Span("a **b", Style.PLAIN))), MarkdownLite.parse("a **b"))
        assertEquals(listOf(p(Span("a `b", Style.PLAIN))), MarkdownLite.parse("a `b"))
        assertEquals(listOf(p(Span("a **** b `` c", Style.PLAIN))), MarkdownLite.parse("a **** b `` c"))
    }

    @Test fun markdownLinksAndHtmlStayPlain() {
        val s = "[x](http://e.com) <b>hi</b> ![i](u)"
        assertEquals(listOf(p(Span(s, Style.PLAIN))), MarkdownLite.parse(s))
    }

    @Test fun markdownLongInputIsBounded() {
        for (unit in listOf("`", "**", "`a**", "```\n")) {
            val input = unit.repeat(20_000 / unit.length)
            val t0 = System.nanoTime()
            MarkdownLite.parse(input)
            val ms = (System.nanoTime() - t0) / 1_000_000
            assertTrue("unit took $ms ms", ms < 1000)
        }
    }
}
