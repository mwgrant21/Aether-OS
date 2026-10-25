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
) {
    data class Tab(val s: String, val label: String, val state: SlotState)

    private val states = HashMap<String, SlotState>()
    private val labels = HashMap<String, String>()
    private val sizes = HashMap<String, Pair<Int, Int>>()
    private val consumedBySlot = HashMap<String, Long>()
    private val awaitingSnap = HashSet<String>()
    private var active = false
    private var attached: String? = null

    /** Total bytes the page reported consumed; a plain counter for the V4 backpressure work. */
    @get:Synchronized
    var consumedTotal = 0L
        private set

    /** Always one tab per known slot, in wire order; a slot missing from `sessions` is not-started. */
    @Synchronized
    fun tabs(): List<Tab> = ControlProtocol.SLOTS.map {
        Tab(it.s, labels[it.s] ?: it.label, states[it.s] ?: SlotState.NOT_STARTED)
    }

    @Synchronized
    fun consumed(s: String): Long = consumedBySlot[s] ?: 0L

    @Synchronized
    fun onSessions(list: List<ControlProtocol.SessionInfo>) {
        states.clear(); labels.clear(); sizes.clear(); awaitingSnap.clear()
        for (i in list) {
            if (ControlProtocol.SLOTS.none { it.s == i.s }) continue
            states[i.s] = i.state
            labels[i.s] = i.label
            if (i.cols > 0 && i.rows > 0) sizes[i.s] = i.cols to i.rows
        }
        attached = null
        active = true
        safe { onTabsChanged() }
    }

    /** The connection ended: ignore frames (a late one may still arrive) until the next [onSessions]. */
    @Synchronized
    fun onDisconnected() {
        active = false
        attached = null
        awaitingSnap.clear()
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
        }
        attached = slot
        val q = feed.lastQ(slot)
        val sent = safe { attach(slot, q) } ?: false
        // A null-q attach asks for a snapshot; out frames before it are covered by it.
        if (sent && q == null) awaitingSnap.add(slot) else awaitingSnap.remove(slot)
        safe { post(BridgeOut.show(slot)) }
    }

    @Synchronized
    fun zoom(px: Int) {
        if (px != 0 && px !in 8..24) return
        safe { post(BridgeOut.zoom(px)) }
    }

    @Synchronized
    fun onFrame(frame: TerminalFrame) {
        if (!active) return
        safe { handle(frame) }
    }

    private fun handle(frame: TerminalFrame) {
        if (frame is TerminalFrame.State) {
            states[frame.s] = frame.state
            onTabsChanged()
            return
        }
        if (frame is TerminalFrame.Size && frame.cols > 0 && frame.rows > 0) {
            sizes[frame.s] = frame.cols to frame.rows
        }
        if (frame.s != attached) return
        when (frame) {
            is TerminalFrame.Snap -> {
                // Titan sends snap{d:"",cols:0,rows:0} for a not-started slot and the page ignores a
                // 0x0 snap, so forward it at the last known size (80x24 if none) to make it reset.
                val known = sizes[frame.s]
                val (cols, rows) = if (frame.cols > 0 && frame.rows > 0) frame.cols to frame.rows else known ?: (80 to 24)
                if (frame.cols > 0 && frame.rows > 0) sizes[frame.s] = cols to rows
                feed.onSnap(frame.s, frame.q)
                awaitingSnap.remove(frame.s)
                post(BridgeOut.snap(frame.s, frame.q, cols, rows, frame.d))
            }
            is TerminalFrame.Out -> when (feed.onOut(frame.s, frame.q)) {
                TerminalFeed.Verdict.Accept -> post(BridgeOut.out(frame.s, frame.q, frame.d))
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
        }
    }

    @Synchronized
    fun onPage(msg: PageMessage) {
        when (msg) {
            is PageMessage.Consumed -> {
                consumedTotal += msg.bytes
                consumedBySlot[msg.session] = (consumedBySlot[msg.session] ?: 0L) + msg.bytes
            }
            // Input is dropped until V3 (no `in` verb); Resize until V4b (no `resize` verb).
            // Ready and Copy are handled by the Android glue, not here.
            is PageMessage.Input, is PageMessage.Resize, is PageMessage.Ready, is PageMessage.Copy -> Unit
        }
    }

    private inline fun <T> safe(block: () -> T): T? = try { block() } catch (_: Exception) { null }
}
