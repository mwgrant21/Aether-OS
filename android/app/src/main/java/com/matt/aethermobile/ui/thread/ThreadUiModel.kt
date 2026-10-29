package com.matt.aethermobile.ui.thread

import com.matt.aethermobile.protocol.ControlProtocol.ThreadEvent
import com.matt.aethermobile.thread.ThreadUi

/** One line of the Thread screen. [key] is unique within a list (LazyColumn requires it). */
sealed interface ThreadRow {
    val key: String

    data class User(override val key: String, val text: String, val truncated: Boolean) : ThreadRow
    data class Claude(override val key: String, val text: String, val truncated: Boolean) : ThreadRow
    data class Tool(override val key: String, val text: String) : ThreadRow
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
                is ThreadEvent.Tool -> ThreadRow.Tool(uniqueKey(e.id), toolText(e))
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
 * The follow flag after a scroll settles. Only a user scroll can change it (follow iff it ended at the bottom);
 * our own scroll to a row taller than the viewport can end short of the bottom and must leave it alone.
 */
fun shouldFollowAfterSettle(userScrolled: Boolean, atBottom: Boolean, wasFollowing: Boolean): Boolean =
    if (userScrolled) atBottom else wasFollowing
