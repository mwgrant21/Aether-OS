package com.matt.aethermobile.ui.thread

import com.matt.aethermobile.protocol.ControlProtocol.PROMPT_SUMMARY_CAP
import com.matt.aethermobile.protocol.ControlProtocol.PromptRisk
import com.matt.aethermobile.protocol.ControlProtocol.ThreadEvent
import com.matt.aethermobile.thread.PromptUi
import com.matt.aethermobile.thread.ThreadUi
import java.util.Locale

/** One line of the Thread screen. [key] is unique within a list (LazyColumn requires it). */
sealed interface ThreadRow {
    val key: String

    data class User(override val key: String, val text: String, val truncated: Boolean) : ThreadRow
    data class Claude(override val key: String, val text: String, val truncated: Boolean) : ThreadRow
    /** [desc] is [toolText], the row's accessibility description; the pieces are what the row draws. */
    data class Tool(
        override val key: String, val tag: String, val target: String?, val add: Long?, val del: Long?, val desc: String,
    ) : ThreadRow
    /** [seconds] is null when titan did not send a start time. */
    data class Working(val seconds: Long?) : ThreadRow { override val key: String get() = "working" }
}

/** One row per event in order (newest last), then a [ThreadRow.Working] row iff the thread is working. Never throws. */
fun threadRows(ui: ThreadUi, nowMs: Long): List<ThreadRow> {
    val seen = HashMap<String, Int>()
    fun uniqueKey(id: String): String {
        val n = (seen[id] ?: 0) + 1
        seen[id] = n
        return if (n == 1) id else "$id#$n"
    }
    val rows = ArrayList<ThreadRow>(ui.events.size + 1)
    for (e in ui.events) {
        rows.add(
            when (e) {
                is ThreadEvent.User -> ThreadRow.User(uniqueKey(e.id), e.text, e.truncated)
                is ThreadEvent.Claude -> ThreadRow.Claude(uniqueKey(e.id), e.text, e.truncated)
                is ThreadEvent.Tool -> ThreadRow.Tool(uniqueKey(e.id), toolTag(e.name), e.target?.takeIf { it.isNotBlank() }, e.add, e.del, toolText(e))
            },
        )
    }
    if (ui.working) {
        val since = ui.workingSince
        rows.add(ThreadRow.Working(if (since == null) null else maxOf(0L, (nowMs - since) / 1000)))
    }
    return rows
}

/** Tool name as sent, then the target, then `+A -D` (U+2212 minus) when either count is present. */
fun toolText(e: ThreadEvent.Tool): String {
    val sb = StringBuilder(e.name)
    val target = e.target
    if (target != null && target.isNotBlank()) sb.append(' ').append(target)
    val counts = listOfNotNull(e.add?.let { "+$it" }, e.del?.let { "−$it" })
    if (counts.isNotEmpty()) sb.append(" · ").append(counts.joinToString(" "))
    return sb.toString()
}

/** Short upper-case tag for the tool row: the last `__` segment (MCP names are `mcp__server__tool`); blank -> `TOOL`. */
fun toolTag(name: String): String =
    name.substringAfterLast("__").trim().uppercase(Locale.ROOT).ifEmpty { "TOOL" }

/** `18s` under a minute, else `2m 14s` (seconds zero-padded); negative clamps to zero. */
fun formatElapsed(seconds: Long): String {
    val s = maxOf(0L, seconds)
    return if (s < 60) "${s}s" else "${s / 60}m ${(s % 60).toString().padStart(2, '0')}s"
}

enum class ThreadEmpty { NoSession, Waiting }

/** Null when there is something to show. "No session" only after the grace ([ThreadUi.noSession]), never from `!attached`. */
fun emptyStateFor(ui: ThreadUi): ThreadEmpty? = when {
    ui.events.isNotEmpty() -> null
    ui.noSession -> ThreadEmpty.NoSession
    else -> ThreadEmpty.Waiting
}

/**
 * Delay until the UI must re-read the snapshot so the grace expiry shows, or null when nothing is pending.
 * Uses `!noSession` rather than `nowMs < graceEndsAtMs`: across the boundary the answer is 1, so one more render lands.
 */
fun graceRerenderDelayMs(ui: ThreadUi, nowMs: Long): Long? {
    val ends = ui.graceEndsAtMs
    if (ends == null || ui.noSession) return null
    return maxOf(1L, ends - nowMs)
}

/**
 * Whether to scroll to the end of the list after its rows changed. [wasAtBottomBeforeUpdate] is read before the new
 * rows are laid out (an empty list counts as at the bottom); a user who scrolled up is never moved.
 */
fun shouldScrollToEnd(wasAtBottomBeforeUpdate: Boolean, appended: Boolean): Boolean =
    wasAtBottomBeforeUpdate && appended

/** How long an approval card stays on screen as "Expired" after its deadline, waiting for the desktop's close. */
const val APPROVAL_EXPIRED_HOLD_MS = 3_000L

/** Colour role of a risk tag; the Composable maps it to a token so this file stays colour-free. */
enum class RiskRole { SUCCESS, WARN, DANGER }

fun riskRole(r: PromptRisk): RiskRole = when (r) {
    PromptRisk.LOW -> RiskRole.SUCCESS
    PromptRisk.MED -> RiskRole.WARN
    PromptRisk.HIGH -> RiskRole.DANGER
}

/** `m:ss` from whole seconds rounded up and clamped at zero; minutes are unpadded and unbounded. */
fun formatCountdown(remainingMs: Long): String {
    val secs = maxOf(0L, (remainingMs + 999) / 1000)
    return "${secs / 60}:${(secs % 60).toString().padStart(2, '0')}"
}

/** Defensive phone-side cap; the desktop already caps at [PROMPT_SUMMARY_CAP]. The 12-line limit is visual only. */
fun approvalSummary(raw: String): String =
    if (raw.length <= PROMPT_SUMMARY_CAP) raw else raw.substring(0, PROMPT_SUMMARY_CAP - 1) + "\u2026"

data class ApprovalView(
    val id: String,
    val toolLabel: String,
    val risk: PromptRisk,
    val summary: String,
    val countdown: String,
    val expired: Boolean,
    val moreCount: Int,
)

/**
 * The oldest visible prompt as a card, or null. A prompt stays visible until [APPROVAL_EXPIRED_HOLD_MS] after its
 * deadline, so a lost close cannot pin the card. Pure: [nowMs] is passed in.
 */
fun approvalFor(prompts: List<PromptUi>, nowMs: Long): ApprovalView? {
    val visible = prompts.filter { nowMs < it.deadlineMs + APPROVAL_EXPIRED_HOLD_MS }
    val first = visible.firstOrNull() ?: return null
    val remaining = first.deadlineMs - nowMs
    return ApprovalView(
        id = first.info.id,
        toolLabel = first.info.tool.uppercase(Locale.ROOT),
        risk = first.info.risk,
        summary = approvalSummary(first.info.summary),
        countdown = formatCountdown(remaining),
        expired = remaining <= 0,
        moreCount = visible.size - 1,
    )
}

/** The 1 Hz clock only needs to run while the working line or a visible approval card depends on it. */
fun needsClock(ui: ThreadUi, nowMs: Long): Boolean = ui.working || approvalFor(ui.prompts, nowMs) != null
