package com.matt.aethermobile.thread

import com.matt.aethermobile.net.TerminalFeed
import com.matt.aethermobile.protocol.ControlProtocol
import com.matt.aethermobile.protocol.ControlProtocol.ThreadFrame

/**
 * Turns thread frames and user actions into per-slot [ThreadState] and tattach/tdetach/tget calls.
 * Pure JVM, no android.* imports. Methods are synchronized: [onFrame] runs on the transport thread,
 * everything else on the UI thread. Thread text is never logged and never leaves this object except
 * through [state].
 *
 * Frames are honoured only between [onSessions] and [onDisconnected], and only for the one slot
 * currently attached by [select]. [onDisconnected] (connection loss, lock, relock) clears every
 * held entry, detail and expansion. The slot the view wants is remembered across it, so the next
 * [onSessions] attaches it again. [onFrame] never throws.
 */
class ThreadHost(
    private val attach: (String) -> Boolean,
    private val detach: (String) -> Boolean,
    private val get: (String, String) -> Boolean,
    private val onChanged: (String) -> Unit = {},
) {
    private val feed = TerminalFeed()
    private val states = HashMap<String, ThreadState>()
    private var active = false
    private var threadCap = false
    private var known: Set<String> = emptySet()
    private var wanted: String? = null
    private var attached: String? = null
    private val awaitingSnap = HashSet<String>()
    private var inFlight: Pair<String, String>? = null
    private val queued = ArrayDeque<Pair<String, String>>()

    /** The current thread for [slot]; empty when the slot is not attached. */
    @Synchronized
    fun state(slot: String): ThreadState = states[slot] ?: ThreadState()

    /** A connection is up. Needs `thread` in [caps]; [sessions] limits which slots may attach. Attaches the wanted slot, if any. */
    @Synchronized
    fun onSessions(caps: Set<String>, sessions: List<ControlProtocol.SessionInfo>) {
        clear()
        threadCap = ControlProtocol.CAP_THREAD in caps
        known = sessions.map { it.s }.filterTo(HashSet()) { it in ControlProtocol.THREAD_SLOTS }
        active = true
        wanted?.let { attachSlot(it) }
    }

    /** The connection ended or the app locked: drop all thread text, ignore late frames until the next [onSessions]. */
    @Synchronized
    fun onDisconnected() {
        active = false
        threadCap = false
        known = emptySet()
        clear()
    }

    /**
     * The slot whose thread the screen shows, or null when the THREAD view is not on screen (TERM view,
     * Codex slot, left the shell). Detaches the previous slot and clears its state; attaches [slot] if it is threadable.
     */
    @Synchronized
    fun select(slot: String?) {
        wanted = slot?.takeIf { it in ControlProtocol.THREAD_SLOTS }
        if (!active) return
        if (wanted != null && wanted == attached) return
        attached?.let { dropAttached(it) }
        wanted?.let { attachSlot(it) }
    }

    /** Asks titan for the tapped entry's input/output once; a cached or pending one is not asked again. Requests run one at a time. */
    @Synchronized
    fun requestDetail(slot: String, id: String) {
        if (!active || slot != attached) return
        val st = states[slot] ?: return
        if (st.entries.none { it.id == id } || id in st.details) return
        states[slot] = st.withDetail(id, DetailState.Loading)
        queued.addLast(slot to id)
        pump()
        changed(slot)
    }

    @Synchronized
    fun toggleExpanded(slot: String, id: String) {
        if (!active || slot != attached) return
        val st = states[slot] ?: return
        val next = st.toggled(id)
        if (next == st) return
        states[slot] = next
        changed(slot)
    }

    @Synchronized
    fun onFrame(frame: ThreadFrame) {
        if (!active) return
        safe { handle(frame) }
    }

    private fun handle(frame: ThreadFrame) {
        val slot = frame.s
        if (slot != attached) return
        val st = states[slot] ?: ThreadState()
        when (frame) {
            is ThreadFrame.Snap -> {
                feed.onSnap(slot, frame.q)
                awaitingSnap.remove(slot)
                if (inFlight?.first == slot) inFlight = null
                queued.removeAll { it.first == slot }
                states[slot] = st.applySnap(frame)
            }
            is ThreadFrame.Add -> when (feed.onOut(slot, frame.q)) {
                TerminalFeed.Verdict.Accept -> states[slot] = st.applyAdd(frame.e)
                TerminalFeed.Verdict.Duplicate -> return
                TerminalFeed.Verdict.Gap -> { regap(slot); return }
            }
            is ThreadFrame.Upd -> when (feed.onOut(slot, frame.q)) {
                TerminalFeed.Verdict.Accept -> states[slot] = st.applyUpd(frame.e)
                TerminalFeed.Verdict.Duplicate -> return
                TerminalFeed.Verdict.Gap -> { regap(slot); return }
            }
            is ThreadFrame.Meta -> states[slot] = st.applyMeta(frame.m)
            is ThreadFrame.Detail -> {
                // only the reply to the tget in flight counts; a queued or never-asked id is not settled by a stray frame
                if (inFlight != slot to frame.id) return
                inFlight = null
                states[slot] = st.applyDetail(frame)
                pump()
            }
        }
        changed(slot)
    }

    /** One re-attach per gap; while its snapshot is pending, further gaps are dropped. */
    private fun regap(slot: String) {
        if (awaitingSnap.add(slot) && safe { attach(slot) } != true) awaitingSnap.remove(slot)
    }

    private fun attachSlot(slot: String) {
        if (!threadCap || slot !in known) return
        // A failed attach leaves nothing attached, so selecting the same slot again retries.
        if (safe { attach(slot) } != true) return
        attached = slot
        states[slot] = ThreadState()
        awaitingSnap.add(slot)
        changed(slot)
    }

    private fun dropAttached(slot: String) {
        safe { detach(slot) }
        attached = null
        feed.forget(slot)
        awaitingSnap.remove(slot)
        queued.removeAll { it.first == slot }
        if (inFlight?.first == slot) inFlight = null
        states.remove(slot)
        changed(slot)
    }

    private fun pump() {
        if (inFlight != null) return
        while (queued.isNotEmpty()) {
            val (slot, id) = queued.removeFirst()
            if (safe { get(slot, id) } == true) {
                inFlight = slot to id
                return
            }
            // not sent: drop the pending marker so a later tap asks again
            states[slot]?.let { states[slot] = it.withoutDetail(id) }
        }
    }

    private fun clear() {
        states.clear()
        ControlProtocol.THREAD_SLOTS.forEach { feed.forget(it) }
        attached = null
        awaitingSnap.clear()
        queued.clear()
        inFlight = null
    }

    private fun changed(slot: String) {
        safe { onChanged(slot) }
    }

    private inline fun <T> safe(block: () -> T): T? = try { block() } catch (_: Exception) { null }
}
