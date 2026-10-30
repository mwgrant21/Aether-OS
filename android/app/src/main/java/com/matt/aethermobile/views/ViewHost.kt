package com.matt.aethermobile.views

import com.matt.aethermobile.protocol.ControlProtocol
import org.json.JSONObject

/** What a generic pane body shows. View data lives only in [ViewHost] memory (never persisted or logged). */
sealed interface ViewUi<out T> {
    /** Not active (pane not selected, or not connected). */
    data object Off : ViewUi<Nothing>

    /** Attach sent, no frame yet. */
    data object Loading : ViewUi<Nothing>

    /** Titan answered `d:null`: no data yet, or its encoder rejected the payload (fail closed). */
    data object NoSnapshot : ViewUi<Nothing>

    /** A frame arrived but the pane's decoder rejected or threw on it. The socket is untouched. */
    data object Unreadable : ViewUi<Nothing>

    /** The connected titan did not list this view in `welcome.views` (including a pre-channel titan). Nothing was sent. */
    data object Unsupported : ViewUi<Nothing>

    data class Ready<T>(val data: T, val receivedAtMs: Long) : ViewUi<T>
}

/**
 * Per-connection holder of one generic view's data, the generic twin of LedgerHost. Pure JVM, no android.*
 * imports. Synchronized: [onFrame] runs on the transport thread, the rest on the UI thread. Frame bodies
 * are never logged. [onFrame] never throws.
 *
 * [supported] answers "did the welcome list this view": when it is false the host shows
 * [ViewUi.Unsupported] and sends neither attach nor detach, so an older titan is never sent a verb it
 * would answer by closing the socket. Attach is idempotent: [activate] and [onConnected] send it once per
 * active period. Data is dropped on detach ([activate] false, which is also what leaving the view on lock
 * does) and on [onDisconnected]; a late frame, or a frame for another view id, is ignored.
 */
class ViewHost<T>(
    private val viewId: String,
    private val decode: (JSONObject) -> T?,
    private val supported: () -> Boolean,
    private val sendAttach: () -> Boolean,
    private val sendDetach: () -> Boolean,
    private val now: () -> Long = { System.currentTimeMillis() },
    private val onChanged: () -> Unit = {},
) {
    private var wanted = false
    private var live = false
    private var attachedSent = false
    private var ui: ViewUi<T> = ViewUi.Off

    /** The connection is welcomed. Idempotent. */
    @Synchronized
    fun onConnected() {
        live = true
        sync()
    }

    /** The pane is selected (true) or left (false). Idempotent. */
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
        ui = ViewUi.Off
        safe { onChanged() }
    }

    @Synchronized
    fun snapshot(): ViewUi<T> = ui

    @Synchronized
    fun onFrame(f: ControlProtocol.ViewFrame) {
        if (!attachedSent || f.v != viewId) return
        val d = f.d
        ui = if (d == null) {
            ViewUi.NoSnapshot
        } else {
            val decoded = try { decode(d) } catch (e: RuntimeException) { null }
            if (decoded == null) ViewUi.Unreadable else ViewUi.Ready(decoded, now())
        }
        safe { onChanged() }
    }

    private fun sync() {
        val want = wanted && live
        if (want && !attachedSent) {
            if (!safeSupported()) {
                if (ui != ViewUi.Unsupported) {
                    ui = ViewUi.Unsupported
                    safe { onChanged() }
                }
                return
            }
            ui = ViewUi.Off
            attachedSent = true
            if (safeSend(sendAttach)) ui = ViewUi.Loading else attachedSent = false
        } else if (!want && attachedSent) {
            attachedSent = false
            if (live) safeSend(sendDetach)
            ui = ViewUi.Off
            safe { onChanged() }
        } else if (!want && ui == ViewUi.Unsupported) {
            ui = ViewUi.Off
            safe { onChanged() }
        }
    }

    private fun safeSupported(): Boolean = try { supported() } catch (e: RuntimeException) { false }
    private fun safeSend(f: () -> Boolean): Boolean = try { f() } catch (e: RuntimeException) { false }
    private fun safe(f: () -> Unit) { try { f() } catch (e: RuntimeException) { } }
}
