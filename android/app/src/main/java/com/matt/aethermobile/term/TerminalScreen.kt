package com.matt.aethermobile.term

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
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
) {
    val webView: WebView = WebView(context)
    private val main = Handler(Looper.getMainLooper())
    private val limiter = RateLimiter(500, SystemClock::elapsedRealtime)
    private var proxy: JavaScriptReplyProxy? = null
    private val queued = ArrayList<String>()
    private var overflowed = false
    private var supported = false

    init {
        val loader = WebViewAssetLoader.Builder()
            .setDomain(TerminalWebView.ASSET_HOST)
            .addPathHandler(TerminalWebView.ASSET_PREFIX) { path ->
                WebViewAssetLoader.AssetsPathHandler(context).handle("terminal/$path")
            }
            .build()
        TerminalWebView.harden(webView, loader, debuggable) { reset(); onRenderGone() }
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
                    proxy = replyProxy
                    flush()
                }
                onPage(m)
            }
        } else {
            Log.w(TAG, "WEB_MESSAGE_LISTENER unsupported; terminal page not loaded")
        }
        load()
    }

    /** Pre-warm: called at construction, before the biometric prompt. */
    private fun load() {
        if (!supported) return
        TerminalWebView.pageUrl("index.html", debuggable)?.let { webView.loadUrl(it) }
    }

    /** TerminalHost -> page. Safe from any thread and under the host's monitor: posts, never waits. */
    fun post(msg: String) {
        main.post { deliver(msg) }
    }

    private fun deliver(msg: String) {
        val p = proxy
        if (p != null) {
            p.postMessage(msg)
            return
        }
        // Page not ready yet (pre-warm still loading): hold a bounded backlog, flushed on 'ready'.
        if (overflowed) return
        if (queued.size >= MAX_QUEUED) {
            queued.clear()
            overflowed = true
            return
        }
        queued.add(msg)
    }

    private fun flush() {
        val p = proxy ?: return
        queued.forEach { p.postMessage(it) }
        queued.clear()
    }

    /** Drop the page and everything it rendered (lock, disconnect, renderer crash) and reload it clean. */
    fun reset() {
        proxy = null
        queued.clear()
        overflowed = false
        load()
    }

    fun destroy() {
        proxy = null
        queued.clear()
        webView.destroy()
    }

    private companion object {
        const val TAG = "AetherWV"
        const val BRIDGE = "aetherBridge"
        const val MAX_QUEUED = 256
    }
}
