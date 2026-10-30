package com.matt.aethermobile.ledger

import com.matt.aethermobile.protocol.ControlProtocol

/** What the Ledger body shows. Ledger figures live only in [LedgerHost] memory (never persisted or logged). */
sealed interface LedgerUi {
    /** Not active (view not selected, or not connected). */
    data object Off : LedgerUi

    /** Attach sent, no frame yet. */
    data object Loading : LedgerUi

    /** Titan answered `ledger:null` (its first scan is not done). */
    data object NoSnapshot : LedgerUi

    data class Ready(val snapshot: ControlProtocol.LedgerSnapshot, val receivedAtMs: Long) : LedgerUi
}

/**
 * Per-connection holder of the Ledger snapshot, fed by the control client. Pure JVM, no android.* imports.
 * Synchronized: [onFrame] runs on the transport thread, the rest on the UI thread. Frame bodies are never
 * logged. [onFrame] never throws.
 *
 * Attach is idempotent: [activate] and [onConnected] send `ledger.attach` once per active period. Data is
 * dropped on detach ([activate] false, which is also what leaving the view on lock does) and on
 * [onDisconnected]; a late frame is ignored while not attached.
 */
class LedgerHost(
    private val sendAttach: () -> Boolean,
    private val sendDetach: () -> Boolean,
    private val now: () -> Long = { System.currentTimeMillis() },
    private val onChanged: () -> Unit = {},
) {
    private var wanted = false
    private var live = false
    private var attachedSent = false
    private var ui: LedgerUi = LedgerUi.Off

    /** The connection is welcomed. Idempotent. */
    @Synchronized
    fun onConnected() {
        live = true
        sync()
    }

    /** The Ledger view is selected (true) or left (false). Idempotent. */
    @Synchronized
    fun activate(on: Boolean) {
        wanted = on
        sync()
    }

    /** The connection ended: forget everything, ignore late frames, send no detach on a dead socket. */
    @Synchronized
    fun onDisconnected() {
        live = false
        attachedSent = false
        reset()
        safe { onChanged() }
    }

    @Synchronized
    fun snapshot(): LedgerUi = ui

    @Synchronized
    fun onFrame(f: ControlProtocol.LedgerFrame) {
        if (!attachedSent) return
        try {
            when (f) {
                is ControlProtocol.LedgerFrame.Snap -> {
                    val s = f.ledger
                    ui = if (s == null) LedgerUi.NoSnapshot else LedgerUi.Ready(s, now())
                }
            }
        } catch (e: RuntimeException) {
            return
        }
        safe { onChanged() }
    }

    private fun sync() {
        val want = wanted && live
        if (want && !attachedSent) {
            reset()
            attachedSent = true
            if (safeSend(sendAttach)) ui = LedgerUi.Loading else attachedSent = false
        } else if (!want && attachedSent) {
            attachedSent = false
            if (live) safeSend(sendDetach)
            reset()
            safe { onChanged() }
        }
    }

    private fun reset() {
        ui = LedgerUi.Off
    }

    private fun safeSend(f: () -> Boolean): Boolean = try { f() } catch (e: RuntimeException) { false }
    private fun safe(f: () -> Unit) { try { f() } catch (e: RuntimeException) { } }
}
