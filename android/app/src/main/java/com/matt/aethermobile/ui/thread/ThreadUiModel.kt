package com.matt.aethermobile.ui.thread

import com.matt.aethermobile.protocol.ControlProtocol.ThreadEntry
import com.matt.aethermobile.protocol.ControlProtocol.ThreadMeta
import com.matt.aethermobile.protocol.ControlProtocol.ToolState
import com.matt.aethermobile.protocol.ControlProtocol.Wait
import com.matt.aethermobile.protocol.ControlProtocol.Work
import kotlin.math.max
import kotlin.math.min

/**
 * Every decision the thread screen makes, as pure Kotlin (no Compose, no android.*).
 * Unknown is never rendered as zero: null/non-positive context, null sizes and a
 * missing elapsed time produce no text rather than "0".
 */
enum class ThreadViewMode { THREAD, TERM }

/** Fetched detail for an expanded row (the `tdet` reply), or its absence. */
sealed class ThreadDetail {
    object Loading : ThreadDetail()
    object Unavailable : ThreadDetail()
    data class Ready(val input: String?, val inMore: Int, val output: String?, val more: Int) : ThreadDetail()
}

data class DiffLine(val added: Boolean, val text: String)

sealed class ThreadRow {
    abstract val id: String

    data class UserBubble(override val id: String, val text: String, val truncated: Boolean) : ThreadRow()
    data class AssistantText(override val id: String, val blocks: List<MarkdownLite.Block>, val truncated: Boolean) : ThreadRow()
    data class ToolRow(
        override val id: String,
        val tag: String,
        val label: String,
        val sizeText: String,
        val state: ToolState,
        val expandable: Boolean,
        val expanded: Boolean,
        /** Null unless [expanded]. */
        val detail: ThreadDetail?,
    ) : ThreadRow()
    data class DiffBlock(override val id: String, val lines: List<DiffLine>, val moreLines: Int) : ThreadRow()
    data class ThinkingRow(
        override val id: String,
        /** "14 s" style duration, null when unknown. */
        val durationText: String?,
        val expandable: Boolean,
        val expanded: Boolean,
        val detail: ThreadDetail?,
    ) : ThreadRow()
}

/** [stringName] is the resource name in strings_thread.xml; the OPEN TERMINAL action is always offered. */
data class ThreadBanner(val kind: Wait, val stringName: String)

object ThreadUiModel {
    const val TAG_CAP = 12

    fun rowsFor(
        entries: List<ThreadEntry>,
        expanded: Set<String> = emptySet(),
        details: Map<String, ThreadDetail> = emptyMap(),
    ): List<ThreadRow> {
        val out = ArrayList<ThreadRow>(entries.size)
        for (e in entries) {
            val open = e.id in expanded
            when (e) {
                is ThreadEntry.User -> out.add(ThreadRow.UserBubble(e.id, e.x, e.tr))
                is ThreadEntry.Assistant -> out.add(ThreadRow.AssistantText(e.id, MarkdownLite.parse(e.x), e.tr))
                is ThreadEntry.Tool -> {
                    val isOpen = e.d && open
                    out.add(
                        ThreadRow.ToolRow(
                            id = e.id,
                            tag = tagFor(e.n),
                            label = e.l,
                            sizeText = sizeText(e.sz),
                            state = e.st,
                            expandable = e.d,
                            expanded = isOpen,
                            detail = if (isOpen) details[e.id] ?: ThreadDetail.Loading else null,
                        ),
                    )
                    val df = e.df
                    if (!df.isNullOrEmpty()) {
                        out.add(
                            ThreadRow.DiffBlock(
                                id = "${e.id}#diff",
                                lines = df.map { DiffLine(added = it.first == "+", text = it.second) },
                                moreLines = max(0, e.dn ?: 0),
                            ),
                        )
                    }
                }
                is ThreadEntry.Thinking -> {
                    val isOpen = e.d && open
                    out.add(
                        ThreadRow.ThinkingRow(
                            id = e.id,
                            durationText = e.ms?.takeIf { it > 0 }?.let { shortDuration(it / 1000) },
                            expandable = e.d,
                            expanded = isOpen,
                            detail = if (isOpen) details[e.id] ?: ThreadDetail.Loading else null,
                        ),
                    )
                }
            }
        }
        return out
    }

    fun tagFor(toolName: String): String = when (toolName.lowercase()) {
        "read" -> "READ"
        "grep" -> "GREP"
        "edit", "multiedit", "notebookedit" -> "EDIT"
        "bash" -> "BASH"
        "write" -> "WRITE"
        "agent", "task" -> "AGENT"
        else -> toolName.uppercase().take(TAG_CAP)
    }

    /** "812 c", "18.4k c", "1.2M c"; null (still running) is "". */
    fun sizeText(sz: Long?): String = if (sz == null || sz < 0) "" else "${count(sz)} c"

    /** "CTX 36.9%" of context, else "CTX 73.4k tok", else null. Never "0%". */
    fun ctxText(meta: ThreadMeta): String? {
        val pct = meta.ctxPct
        if (pct != null && !pct.isNaN() && pct > 0.0) {
            val tenths = Math.round(min(pct, 100.0) * 10.0)
            if (tenths > 0) return "CTX ${tenths / 10}.${tenths % 10}%"
        }
        val tok = meta.ctxTok
        return if (tok != null && tok > 0) "CTX ${count(tok)} tok" else null
    }

    /** "Working · 2m 14s · 38.2k tok"; null unless working. Elapsed/tokens are dropped when unknown. */
    fun workingText(meta: ThreadMeta, nowMs: Long, offsetMs: Long): String? {
        if (meta.work != Work.WORKING) return null
        val parts = ArrayList<String>(3)
        parts.add("Working")
        val since = meta.since
        if (since != null && since > 0) parts.add(elapsed(max(0L, nowMs + offsetMs - since) / 1000))
        val tok = meta.tok
        if (tok != null && tok > 0) parts.add("${count(tok)} tok")
        return parts.joinToString(" · ")
    }

    /** "Last activity 4 min ago"; null while working or when no activity time is known. */
    fun lastActivityText(meta: ThreadMeta, nowMs: Long, offsetMs: Long): String? {
        if (meta.work == Work.WORKING) return null
        val last = meta.last
        if (last == null || last <= 0) return null
        val s = max(0L, nowMs + offsetMs - last) / 1000
        val ago = when {
            s < 60 -> "just now"
            s < 3600 -> "${s / 60} min ago"
            s < 86_400 -> "${s / 3600} h ago"
            else -> "${s / 86_400} d ago"
        }
        return "Last activity $ago"
    }

    /** Banner shown above the stream in THREAD mode while titan thinks a terminal prompt is open. */
    fun bannerFor(meta: ThreadMeta, mode: ThreadViewMode): ThreadBanner? {
        if (mode != ThreadViewMode.THREAD) return null
        return when (meta.wait) {
            Wait.PERM -> ThreadBanner(Wait.PERM, "thread_banner_perm")
            Wait.QUIET -> ThreadBanner(Wait.QUIET, "thread_banner_quiet")
            null -> null
        }
    }

    /** Dot on the TERM chip while a prompt may be waiting, whichever view is showing. */
    fun termDot(meta: ThreadMeta): Boolean = meta.wait != null

    private fun elapsed(totalSec: Long): String = when {
        totalSec < 60 -> "${totalSec}s"
        totalSec < 3600 -> "${totalSec / 60}m ${totalSec % 60}s"
        else -> "${totalSec / 3600}h ${(totalSec % 3600) / 60}m"
    }

    private fun shortDuration(sec: Long): String = if (sec < 1) "<1 s" else if (sec < 60) "$sec s" else elapsed(sec)

    /** 812 -> "812", 18_400 -> "18.4k", 1_234_567 -> "1.2M"; rounds half up, never prints "1000.0k". */
    private fun count(n: Long): String {
        if (n < 1000) return n.toString()
        val tenthsK = (n + 50) / 100
        if (tenthsK < 10_000) return "${tenthsK / 10}.${tenthsK % 10}k"
        val tenthsM = (n + 50_000) / 100_000
        return "${tenthsM / 10}.${tenthsM % 10}M"
    }
}
