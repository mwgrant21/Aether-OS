package com.matt.aethermobile.thread

import com.matt.aethermobile.protocol.ControlProtocol.PromptInfo
import com.matt.aethermobile.protocol.ControlProtocol.ThreadEvent
import com.matt.aethermobile.protocol.ControlProtocol.ThreadFrame

/** Which body the shell shows for the Claude slot. Held by the Activity (memory only). */
enum class ViewMode { THREAD, RAW }

/** A pending permission prompt with the phone-local deadline (receive time + ttlMs). */
data class PromptUi(val info: PromptInfo, val deadlineMs: Long)

/**
 * Immutable view of the thread for the UI.
 *
 * [attached] is what titan last said; do NOT show "no session" from `attached == false` alone. Use [noSession],
 * which stays false until the unattached state has lasted [ThreadHost.NO_SESSION_GRACE_MS]. [graceEndsAtMs]
 * is when [noSession] may flip, so the UI can re-read the snapshot then (null when no grace is running).
 */
data class ThreadUi(
    val events: List<ThreadEvent>,
    val attached: Boolean,
    val working: Boolean,
    val workingSince: Long?,
    val prompts: List<PromptUi>,
    val noSession: Boolean = false,
    val graceEndsAtMs: Long? = null,
) {
    companion object { val EMPTY = ThreadUi(emptyList(), false, false, null, emptyList()) }
}

/**
 * Per-connection model of the Claude thread, fed by the control client. Pure JVM, no android.* imports.
 * Synchronized like TerminalHost: [onFrame] runs on the transport thread, the rest on the UI thread.
 * Frame bodies are never logged. [onFrame] never throws.
 *
 * Attach is idempotent per host: [activate] and [onConnected] send `thread.attach` once, however often
 * they are called. A fresh connection builds a fresh host, which attaches once on its own socket.
 */
class ThreadHost(
    private val sendAttach: () -> Boolean,
    private val sendDetach: () -> Boolean,
    private val now: () -> Long = { System.currentTimeMillis() },
    private val onChanged: () -> Unit = {},
    private val onFirstContent: () -> Unit = {},
) {
    companion object {
        const val MAX_EVENTS = 500
        /** How long an empty, unattached snap may stand before the UI is told there is no session. */
        const val NO_SESSION_GRACE_MS = 2_000L
    }

    private var wanted = false
    private var live = false
    /** True from the moment we sent `thread.attach` until we detach or the connection ends. */
    private var attachedSent = false
    /** After a gap we re-attach once; further frames are ignored until the new snap arrives. */
    private var resyncing = false
    private var lastQ: Long? = null

    private var events: List<ThreadEvent> = emptyList()
    private var attached = false
    private var working = false
    private var workingSince: Long? = null
    private val prompts = LinkedHashMap<String, PromptUi>()
    private var unattachedSince: Long? = null
    private var firstContentSeen = false

    /** The connection is welcomed. Idempotent. */
    @Synchronized
    fun onConnected() {
        live = true
        sync()
    }

    /** The thread should be live (Claude slot, Thread view). Idempotent. */
    @Synchronized
    fun activate(on: Boolean) {
        wanted = on
        sync()
    }

    /** The connection ended: forget everything and ignore late frames. No detach is sent on a dead socket. */
    @Synchronized
    fun onDisconnected() {
        live = false
        attachedSent = false
        resyncing = false
        reset()
        safe { onChanged() }
    }

    @Synchronized
    fun snapshot(): ThreadUi {
        val t = now()
        val since = unattachedSince
        val graceEnds = if (since != null && attachedSent) since + NO_SESSION_GRACE_MS else null
        return ThreadUi(
            events, attached, working, workingSince, prompts.values.toList(),
            noSession = graceEnds != null && t >= graceEnds,
            graceEndsAtMs = graceEnds,
        )
    }

    @Synchronized
    fun onFrame(f: ThreadFrame) {
        if (!attachedSent) return // inactive, detached or disconnected: late frames are dropped
        try {
            when (f) {
                is ThreadFrame.Snap -> {
                    // A snap REPLACES the previous one (re-attach, or the cold feed's second snap at q+1).
                    // The cold feed first sends an empty snap with attached=false and follows with another;
                    // attached=false alone is therefore not "no session" (see ThreadUi.noSession).
                    events = f.events.takeLast(MAX_EVENTS)
                    attached = f.attached
                    working = f.working
                    workingSince = f.workingSinceMs
                    lastQ = f.q
                    resyncing = false
                    unattachedSince = if (f.attached) null else (unattachedSince ?: now())
                    if (!firstContentSeen && f.events.isNotEmpty()) {
                        firstContentSeen = true
                        safe { onFirstContent() }
                    }
                }
                is ThreadFrame.Events -> if (inOrder(f.q)) {
                    events = (events + f.events).takeLast(MAX_EVENTS)
                    lastQ = f.q
                }
                is ThreadFrame.State -> if (inOrder(f.q)) {
                    working = f.working
                    workingSince = f.workingSinceMs
                    lastQ = f.q
                }
                is ThreadFrame.Opened -> if (f.prompt.id !in prompts) {
                    prompts[f.prompt.id] = PromptUi(f.prompt, now() + f.prompt.ttlMs)
                }
                is ThreadFrame.Closed -> prompts.remove(f.id)
            }
        } catch (e: RuntimeException) {
            return
        }
        safe { onChanged() }
    }

    /** True when [q] is exactly the next frame. A duplicate is ignored; a gap re-attaches once. */
    private fun inOrder(q: Long): Boolean {
        val last = lastQ
        if (resyncing || last == null) return false
        if (q <= last) return false
        if (q == last + 1) return true
        resyncing = true
        prompts.clear() // the re-attach replays every pending prompt
        safe { sendAttach() }
        return false
    }

    private fun sync() {
        val want = wanted && live
        if (want && !attachedSent) {
            reset()
            attachedSent = true
            if (!safeSend(sendAttach)) attachedSent = false
        } else if (!want && attachedSent) {
            attachedSent = false
            resyncing = false
            if (live) safeSend(sendDetach)
            reset()
            safe { onChanged() }
        }
    }

    private fun reset() {
        events = emptyList(); attached = false; working = false; workingSince = null
        prompts.clear(); lastQ = null; unattachedSince = null
    }

    private fun safeSend(f: () -> Boolean): Boolean = try { f() } catch (e: RuntimeException) { false }
    private fun safe(f: () -> Unit) { try { f() } catch (e: RuntimeException) { } }
}
