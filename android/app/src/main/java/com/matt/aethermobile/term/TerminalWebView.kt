package com.matt.aethermobile.term

import android.annotation.SuppressLint
import android.net.Uri
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.net.toUri
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream

/**
 * Locked-down WebView for the bundled xterm page (design spec 4.4). Local assets
 * only: every navigation is blocked, every request the asset loader does not
 * serve gets a 403, and the page can ask for nothing (windows, dialogs,
 * permissions, files, downloads).
 */
object TerminalWebView {
    const val ASSET_HOST = "appassets.androidplatform.net"
    const val ORIGIN = "https://$ASSET_HOST"
    const val ASSET_PREFIX = "/terminal/"
    private const val TAG = "AetherWV"

    /** Pages MainActivity may load; navtest.html (debug source set only) is never listed in release. */
    fun allowedPages(debuggable: Boolean): Set<String> =
        if (debuggable) setOf("index.html", "navtest.html") else setOf("index.html")

    /** Header form of the CSP; index.html carries the same policy as a meta fallback. */
    const val CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; " +
        "form-action 'none'; frame-ancestors 'none'"

    fun pageUrl(page: String, debuggable: Boolean): String? =
        if (page in allowedPages(debuggable)) "$ORIGIN$ASSET_PREFIX$page" else null

    /** True only for https://appassets.androidplatform.net/terminal/<no traversal>. */
    fun isServable(uri: Uri): Boolean = isServable(uri.scheme, uri.host, uri.port, uri.path)

    /** Pure form of [isServable], unit-tested on the JVM (android.net.Uri is a stub there). */
    fun isServable(scheme: String?, host: String?, port: Int, path: String?): Boolean {
        if (path == null) return false
        return scheme == "https" && host == ASSET_HOST && port == -1 &&
            path.startsWith(ASSET_PREFIX) && !path.contains("..") && !path.contains("//") && !path.contains('\\')
    }

    @SuppressLint("SetJavaScriptEnabled")
    fun harden(webView: WebView, loader: WebViewAssetLoader, debuggable: Boolean, onRenderGone: () -> Unit) {
        WebView.setWebContentsDebuggingEnabled(debuggable)
        webView.settings.apply {
            javaScriptEnabled = true // required for xterm
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            domStorageEnabled = false
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setGeolocationEnabled(false)
            mediaPlaybackRequiresUserGesture = true
            textZoom = 100
            setSupportZoom(false)
            builtInZoomControls = false
            cacheMode = WebSettings.LOAD_NO_CACHE
        }
        webView.isLongClickable = false
        webView.setDownloadListener { url, _, _, _, _ -> Log.w(TAG, "download blocked: ${hostOf(url)}") }
        webView.webViewClient = LockedClient(loader, onRenderGone)
        webView.webChromeClient = LockedChrome(debuggable)
    }

    private fun hostOf(url: String?): String = url?.toUri()?.host ?: "?"

    private class LockedClient(
        private val loader: WebViewAssetLoader,
        private val onRenderGone: () -> Unit,
    ) : WebViewClient() {
        // Every in-page navigation (link tap, location change, form post) is refused.
        // The initial loadUrl does not pass through here.
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            Log.w(TAG, "navigation blocked: ${request.url.scheme}://${request.url.host}")
            return true
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
            val served = if (request.method == "GET" && isServable(request.url)) {
                loader.shouldInterceptRequest(request.url)
            } else null
            if (served == null) {
                Log.w(TAG, "request blocked: ${request.url.scheme}://${request.url.host}")
                return WebResourceResponse(
                    "text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)),
                )
            }
            served.responseHeaders = (served.responseHeaders ?: emptyMap()) + mapOf(
                "Content-Security-Policy" to CSP,
                "X-Content-Type-Options" to "nosniff",
                "Cache-Control" to "no-store",
            )
            return served
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.e(TAG, "render process gone (crashed=${detail.didCrash()})")
            onRenderGone()
            return true
        }
    }

    private class LockedChrome(private val debuggable: Boolean) : WebChromeClient() {
        override fun onConsoleMessage(m: ConsoleMessage): Boolean {
            // CSP violations and page errors surface here; logged in debuggable builds only.
            if (debuggable) Log.i(TAG, "console[${m.messageLevel()}] ${m.message().take(300)}")
            return true
        }

        override fun onCreateWindow(
            view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message?,
        ): Boolean {
            Log.w(TAG, "window.open blocked")
            return false
        }

        override fun onPermissionRequest(request: PermissionRequest) = request.deny()

        override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) =
            callback.invoke(origin, false, false)

        override fun onShowFileChooser(
            view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams,
        ): Boolean {
            cb.onReceiveValue(null)
            return true
        }

        override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
            result.cancel(); return true
        }

        override fun onJsConfirm(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
            result.cancel(); return true
        }

        override fun onJsPrompt(
            view: WebView, url: String?, message: String?, defaultValue: String?, result: JsPromptResult,
        ): Boolean {
            result.cancel(); return true
        }
    }
}
