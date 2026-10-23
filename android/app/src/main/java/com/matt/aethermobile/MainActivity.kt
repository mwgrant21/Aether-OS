package com.matt.aethermobile

import android.content.pm.ApplicationInfo
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.WindowManager
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.matt.aethermobile.term.BridgeValidator
import com.matt.aethermobile.term.FakeTerminalSource
import com.matt.aethermobile.term.PageMessage
import com.matt.aethermobile.term.RateLimiter
import com.matt.aethermobile.term.TerminalWebView

/**
 * V0 walking skeleton: one hardened WebView showing the bundled xterm page, fed by a
 * local fake source. No network, no auth, no titan; those arrive with V1+.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private val source = FakeTerminalSource()
    private val limiter = RateLimiter(maxPerSecond = 200, nowMs = SystemClock::elapsedRealtime)

    private val debuggable: Boolean
        get() = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

    override fun onCreate(savedInstanceState: Bundle?) {
        // No screenshots, blank recents thumbnail (design spec 1.4). Must precede content.
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        val root = FrameLayout(this)
        webView = WebView(this).also { root.addView(it, FrameLayout.LayoutParams(-1, -1)) }
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            // Refuse to run rather than fall back to addJavascriptInterface.
            Log.e(TAG, "WEB_MESSAGE_LISTENER unsupported by this WebView; not loading")
            finish()
            return
        }

        val loader = WebViewAssetLoader.Builder()
            .setDomain(TerminalWebView.ASSET_HOST)
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        TerminalWebView.harden(webView, loader, debuggable) { runOnUiThread { recreate() } }

        WebViewCompat.addWebMessageListener(
            webView, BRIDGE_NAME, setOf(TerminalWebView.ORIGIN),
        ) { _, message, _, isMainFrame, reply ->
            if (isMainFrame && message.type == WebMessageCompat.TYPE_STRING) onPageMessage(message.data, reply)
        }

        // Debug builds can open the navigation-block test page: adb ... --es page navtest.html
        val page = if (debuggable) intent.getStringExtra("page") ?: "index.html" else "index.html"
        webView.loadUrl(TerminalWebView.pageUrl(page, debuggable) ?: TerminalWebView.pageUrl("index.html", debuggable)!!)
    }

    private fun onPageMessage(raw: String?, reply: JavaScriptReplyProxy) {
        if (!limiter.allow()) return
        when (val msg = BridgeValidator.parse(raw)) {
            PageMessage.Ready -> reply.postMessage(source.banner())
            is PageMessage.Input -> source.onInput(msg.data)?.let(reply::postMessage)
            // Accepted by the validator, no behaviour until their slices (resize V4b, flow control V2, copy V3).
            is PageMessage.Resize, is PageMessage.Consumed, is PageMessage.Copy -> Unit
            null -> if (debuggable) Log.w(TAG, "bridge message rejected")
        }
    }

    override fun onDestroy() {
        if (::webView.isInitialized) {
            (webView.parent as? FrameLayout)?.removeView(webView)
            webView.destroy()
        }
        super.onDestroy()
    }

    private companion object {
        const val TAG = "AetherMobile"
        const val BRIDGE_NAME = "aetherBridge"
    }
}
