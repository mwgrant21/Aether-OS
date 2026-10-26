package com.matt.aethermobile.term

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.ViewGroup
import android.webkit.WebView
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * Android glue between the hardened WebView and [TerminalHost]. Not unit-tested (WebView).
 * Outbound is postWebMessage only; inbound goes through [BridgeValidator.parse]. No
 * evaluateJavascript, no addJavascriptInterface. Everything except [post] runs on the main thread.
 */
class TerminalScreen(
    context: Context,
    private val debuggable: Boolean,
    private val onPage: (PageMessage) -> Unit,
    private val onRenderGone: () -> Unit,
    private val onResync: () -> Unit = {},
) {
    private val appContext = context
    var webView: WebView = WebView(context)
        private set
    private val main = Handler(Looper.getMainLooper())
    private val limiter = RateLimiter(500, SystemClock::elapsedRealtime)
    private val outbox = PageOutbox(MAX_QUEUED) { onResync() }
    private var supported = false

    init {
        setUp(webView)
        load()
    }

    private fun setUp(webView: WebView) {
        val loader = WebViewAssetLoader.Builder()
            .setDomain(TerminalWebView.ASSET_HOST)
            .addPathHandler(TerminalWebView.ASSET_PREFIX) { path ->
                WebViewAssetLoader.AssetsPathHandler(appContext).handle("terminal/$path")
            }
            .build()
        TerminalWebView.harden(webView, loader, debuggable) { rebuild(); onRenderGone() }
        webView.setBackgroundColor(0xFF0A0E14.toInt())
        supported = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
        if (supported) {
            WebViewCompat.addWebMessageListener(
                webView, BRIDGE, setOf(TerminalWebView.ORIGIN),
            ) { _, message: WebMessageCompat, sourceOrigin, isMainFrame, replyProxy ->
                if (!isMainFrame || sourceOrigin.toString() != TerminalWebView.ORIGIN) return@addWebMessageListener
                if (!limiter.allow()) return@addWebMessageListener
                val m = BridgeValidator.parse(message.data) ?: return@addWebMessageListener
                if (m === PageMessage.Ready) {
                    outbox.ready { replyProxy.postMessage(it) }
                }
                onPage(m)
            }
        } else {
            Log.w(TAG, "WEB_MESSAGE_LISTENER unsupported; terminal page not loaded")
        }
    }

    /** Pre-warm: called at construction, before the biometric prompt. */
    private fun load() {
        if (!supported) return
        TerminalWebView.pageUrl("index.html", debuggable)?.let { webView.loadUrl(it) }
    }

    /** TerminalHost -> page. Safe from any thread and under the host's monitor: posts, never waits. */
    fun post(msg: String) {
        val gen = outbox.generation
        main.post { outbox.submit(gen, msg) }
    }

    /** Drop the page and everything it rendered (lock, disconnect) and reload it clean. */
    fun reset() {
        outbox.reset()
        load()
    }

    /**
     * The renderer died: that WebView cannot be reused. Replace it with a freshly hardened one in the
     * same parent and drop everything queued for the old page.
     */
    fun rebuild() {
        outbox.reset()
        val old = webView
        val parent = old.parent as? ViewGroup
        val lp = old.layoutParams
        val index = parent?.indexOfChild(old) ?: -1
        parent?.removeView(old)
        old.destroy()
        val fresh = WebView(appContext)
        webView = fresh
        setUp(fresh)
        if (parent != null) parent.addView(fresh, if (index >= 0) index else parent.childCount, lp)
        load()
    }

    fun destroy() {
        outbox.reset()
        webView.destroy()
    }

    private companion object {
        const val TAG = "AetherWV"
        const val BRIDGE = "aetherBridge"
        const val MAX_QUEUED = 256
    }
}
