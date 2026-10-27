package com.matt.aethermobile.term

import com.matt.aethermobile.net.TerminalFeed
import com.matt.aethermobile.protocol.ControlProtocol
import com.matt.aethermobile.protocol.ControlProtocol.SlotState
import com.matt.aethermobile.protocol.ControlProtocol.TerminalFrame

/**
 * Turns titan frames and user actions into page messages and attach/detach calls.
 * Pure JVM, no android.* imports. Methods are synchronized: onFrame runs on the
 * transport thread, everything else on the UI thread. Frame bodies are never logged.
 *
 * Frames are honoured only between [onSessions] and [onDisconnected], and `Snap`/`Out`/`Size`
 * only for the one slot currently attached by [select]. [onFrame] never throws.
 */
class TerminalHost(
    private val attach: (String, Long?) -> Boolean,
    private val detach: (String) -> Boolean,
    private val post: (String) -> Unit,
    private val feed: TerminalFeed,
    private val onTabsChanged: () -> Unit = {},
    sendInput: (String, Long, String) -> Boolean = { _, _, _ -> false },
    onNotSent: (Int) -> Unit = {},
    /**
     * The sender for the current connection. cseq continuity belongs to the connection (one epoch on the
     * desktop), so a host rebuilt on the same connection must share it; a new connection makes a new one.
     */
    sharedSender: InputSender? = null,
) {
    private val inputSender = sharedSender ?: InputSender(sendInput, { System.currentTimeMillis() }, onNotSent)
    data class Tab(val s: String, val label: String, val state: SlotState, val awaitingOutput: Boolean = false)

    private val states = HashMap<String, SlotState>()
    private val labels = HashMap<String, String>()
    private val sizes = HashMap<String, Pair<Int, Int>>()
    private val consumedBySlot = HashMap<String, Long>()
    private val awaitingSnap = HashSet<String>()
    /** Running slots whose latest snapshot was empty and have shown no output since. */
    private val awaitingOutput = HashSet<String>()
    private var active = false
    private var attached: String? = null
    private var zoomPx = 0
    private var ctrlLatch = false
    private var stdinOn = false

    /** Total bytes the page reported consumed; a plain counter for the V4 backpressure work. */
    @get:Synchronized
    var consumedTotal = 0L
        private set

    /** Always one tab per known slot, in wire order; a slot missing from `sessions` is not-started. */
    @Synchronized
    fun tabs(): List<Tab> = ControlProtocol.SLOTS.map {
        Tab(it.s, labels[it.s] ?: it.label, states[it.s] ?: SlotState.NOT_STARTED, it.s in awaitingOutput)
    }

    @Synchronized
    fun consumed(s: String): Long = consumedBySlot[s] ?: 0L

    @Synchronized
    fun onSessions(list: List<ControlProtocol.SessionInfo>) {
        states.clear(); labels.clear(); sizes.clear(); awaitingSnap.clear(); awaitingOutput.clear()
        for (i in list) {
            if (ControlProtocol.SLOTS.none { it.s == i.s }) continue
            states[i.s] = i.state
            labels[i.s] = i.label
            if (i.cols > 0 && i.rows > 0) sizes[i.s] = i.cols to i.rows
        }
        attached = null
        active = true
        ctrlLatch = false
        syncStdin()
        safe { onTabsChanged() }
    }

    /** The connection ended: ignore frames (a late one may still arrive) until the next [onSessions]. */
    @Synchronized
    fun onDisconnected(connectionLost: Boolean = true) {
        active = false
        attached = null
        awaitingSnap.clear()
        awaitingOutput.clear()
        ctrlLatch = false
        syncStdin()
        // Unacked frames are reported not sent on a real disconnect; a host rebuild on the same connection
        // (render gone) keeps them pending. Nothing is ever resent.
        if (connectionLost) safe { inputSender.onDisconnected() }
    }

    /** Keys may leave the phone only for the attached slot while active and RUNNING. */
    private fun canType(slot: String?): Boolean =
        active && slot != null && slot == attached && states[slot] == SlotState.RUNNING

    /** True when keys would be accepted right now: the same gate [sendKeys] applies. The UI drives the key row from it. */
    @Synchronized
    fun typingAccepted(): Boolean = canType(attached)

    /** Tells the page whether stdin is on; posts only on a change. */
    private fun syncStdin() {
        val on = canType(attached)
        if (on == stdinOn) return
        stdinOn = on
        safe { post(BridgeOut.stdin(on)) }
    }

    @Synchronized
    fun setCtrlLatch(on: Boolean) {
        ctrlLatch = on
    }

    @Synchronized
    fun ctrlLatched(): Boolean = ctrlLatch

    /** Key-row bytes (Esc, arrows, ...): same gates and sender as page input. */
    @Synchronized
    fun sendKeys(bytes: String) {
        val slot = attached
        if (slot == null) { if (bytes.isNotEmpty()) safe { inputSender.reject(bytes.length) }; return }
        typeInto(slot, bytes)
    }

    private fun typeInto(slot: String, data: String) {
        if (data.isEmpty()) return
        if (!canType(slot)) { safe { inputSender.reject(data.length) }; return }
        var out = data
        if (ctrlLatch) {
            ctrlLatch = false
            val ch = data[0]
            if (data.length == 1 && (ch in 'a'..'z' || ch in 'A'..'Z' || ch in "@[\\]^_")) {
                out = (ch.code and 0x1f).toChar().toString()
            }
        }
        safe { inputSender.send(slot, out) }
    }

    enum class ComposeResult { SENT, NOT_ACCEPTED, TOO_LARGE }

    /**
     * Native compose text for the attached slot, handed to the page (which owns bracketed-paste state)
     * as one `compose` message. Same gate as [sendKeys]; every refusal is counted as not sent exactly once.
     * The Ctrl latch is neither read nor cleared.
     */
    @Synchronized
    fun sendCompose(text: String, enter: Boolean): ComposeResult {
        val slot = attached
        val n = maxOf(1, text.length + (if (enter) 1 else 0))
        if (slot == null || !canType(slot)) {
            safe { inputSender.reject(n) }
            return ComposeResult.NOT_ACCEPTED
        }
        if (text.toByteArray(Charsets.UTF_8).size + COMPOSE_OVERHEAD > InputSender.MAX_INPUT_BYTES) {
            safe { inputSender.refuse(n, InputSender.Refusal.TOO_LARGE) }
            return ComposeResult.TOO_LARGE
        }
        if (text.isEmpty() && !enter) return ComposeResult.SENT
        if (safe { post(BridgeOut.compose(slot, text, enter)) } == null) {
            safe { inputSender.reject(n) }
            return ComposeResult.NOT_ACCEPTED
        }
        return ComposeResult.SENT
    }

    @Synchronized
    fun select(slot: String) {
        if (ControlProtocol.SLOTS.none { it.s == slot }) return
        if (!active) return
        if (slot == attached) {
            safe { post(BridgeOut.show(slot)) }
            return
        }
        attached?.let { prev ->
            safe { detach(prev) }
            feed.forget(prev)
            awaitingSnap.remove(prev)
            awaitingOutput.remove(prev)
        }
        val q = feed.lastQ(slot)
        val sent = safe { attach(slot, q) } ?: false
        // A failed attach leaves nothing attached, so selecting the same slot again retries.
        attached = if (sent) slot else null
        // A null-q attach asks for a snapshot; out frames before it are covered by it.
        if (sent && q == null) awaitingSnap.add(slot) else awaitingSnap.remove(slot)
        safe { post(BridgeOut.show(slot)) }
        syncStdin()
        safe { onTabsChanged() } // attached may have changed: the key row follows it
    }

    @Synchronized
    fun zoom(px: Int) {
        if (px != 0 && px !in 8..24) return
        zoomPx = px
        safe { post(BridgeOut.zoom(px)) }
    }

    /**
     * The page dropped queued messages (backlog overflow before it was ready), so the host's view of
     * what the page holds is wrong: re-show, re-zoom and re-attach for a fresh snapshot.
     */
    @Synchronized
    fun resync() {
        val slot = attached ?: return
        if (!active) return
        feed.forget(slot)
        safe { post(BridgeOut.show(slot)) }
        // The page may have rebuilt and forgotten its stdin state: re-assert it before the attach can change it.
        if (stdinOn) safe { post(BridgeOut.stdin(true)) }
        if (zoomPx != 0) safe { post(BridgeOut.zoom(zoomPx)) }
        if (safe { attach(slot, null) } == true) awaitingSnap.add(slot) else {
            awaitingSnap.remove(slot)
            attached = null
        }
        syncStdin()
        safe { onTabsChanged() }
    }

    @Synchronized
    fun onFrame(frame: TerminalFrame) {
        if (!active) return
        safe { handle(frame) }
    }

    private fun handle(frame: TerminalFrame) {
        if (frame is TerminalFrame.State) {
            states[frame.s] = frame.state
            if (frame.state != SlotState.RUNNING) awaitingOutput.remove(frame.s)
            syncStdin()
            onTabsChanged()
            return
        }
        if (frame is TerminalFrame.Size && frame.cols > 0 && frame.rows > 0) {
            sizes[frame.s] = frame.cols to frame.rows
        }
        if (frame is TerminalFrame.Ack) {
            inputSender.onAck(frame.s, frame.c)
            return
        }
        if (frame is TerminalFrame.Nak) {
            inputSender.onNak(frame.s, frame.c, frame.reason)
            return
        }
        if (frame.s != attached) return
        when (frame) {
            is TerminalFrame.Snap -> {
                // Titan sends snap{d:"",cols:0,rows:0} for a not-started slot and the page ignores a
                // 0x0 snap, so forward it at the last known size (80x24 if none) to make it reset.
                val known = sizes[frame.s]
                val (cols, rows) = if (frame.cols > 0 && frame.rows > 0) frame.cols to frame.rows else known ?: (80 to 24)
                if (frame.cols > 0 && frame.rows > 0) sizes[frame.s] = cols to rows
                try {
                    post(BridgeOut.snap(frame.s, frame.q, cols, rows, frame.d))
                } catch (e: Exception) {
                    // The page did not reset: no baseline, and let the next gap re-attach once.
                    feed.forget(frame.s)
                    awaitingSnap.remove(frame.s)
                    throw e
                }
                feed.onSnap(frame.s, frame.q)
                awaitingSnap.remove(frame.s)
                val wait = frame.d.isEmpty() && states[frame.s] == SlotState.RUNNING
                if (if (wait) awaitingOutput.add(frame.s) else awaitingOutput.remove(frame.s)) onTabsChanged()
            }
            is TerminalFrame.Out -> when (feed.onOut(frame.s, frame.q)) {
                TerminalFeed.Verdict.Accept -> try {
                    post(BridgeOut.out(frame.s, frame.q, frame.d))
                    if (frame.d.isNotEmpty() && awaitingOutput.remove(frame.s)) onTabsChanged()
                } catch (e: Exception) {
                    // The page never got it: drop the baseline so the next frame re-attaches for a snapshot.
                    feed.forget(frame.s)
                    throw e
                }
                TerminalFeed.Verdict.Duplicate -> Unit
                TerminalFeed.Verdict.Gap -> {
                    // One re-attach per gap; while its snapshot is pending, further gaps are dropped.
                    if (awaitingSnap.add(frame.s)) {
                        if (safe { attach(frame.s, null) } != true) awaitingSnap.remove(frame.s)
                    }
                }
            }
            is TerminalFrame.Size -> post(BridgeOut.size(frame.s, frame.cols, frame.rows))
            is TerminalFrame.State -> Unit
            is TerminalFrame.Ack -> Unit // handled before the attached-slot filter, above
            is TerminalFrame.Nak -> Unit // handled before the attached-slot filter, above
        }
    }

    @Synchronized
    fun onPage(msg: PageMessage) {
        when (msg) {
            is PageMessage.Consumed -> {
                consumedTotal += msg.bytes
                consumedBySlot[msg.session] = (consumedBySlot[msg.session] ?: 0L) + msg.bytes
            }
            is PageMessage.Input -> typeInto(msg.session, msg.data)
            // Resize is dropped until V4b (no `resize` verb).
            // Ready and Copy are handled by the Android glue, not here.
            is PageMessage.Resize, is PageMessage.Ready, is PageMessage.Copy -> Unit
        }
    }

    private companion object {
        /** Two 6-byte bracket markers, the CR, and slack. */
        const val COMPOSE_OVERHEAD = 16
    }

    private inline fun <T> safe(block: () -> T): T? = try { block() } catch (_: Exception) { null }
}

/** Sends transport-thread frames to whichever host is current; a replaced host never sees them. */
class FrameRouter {
    @Volatile
    var host: TerminalHost? = null

    fun route(frame: TerminalFrame) {
        host?.onFrame(frame)
    }
}
