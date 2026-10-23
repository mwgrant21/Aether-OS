package com.matt.aethermobile.net

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/**
 * OkHttp-backed [Transport]. No Origin header is added (OkHttp never adds one),
 * redirects are off, and no cookie jar is installed. Listener callbacks run on
 * OkHttp threads.
 */
class OkHttpTransport(
    private val client: OkHttpClient = defaultClient(),
) : Transport {
    @Volatile
    private var socket: WebSocket? = null

    override fun open(url: String, headers: Map<String, String>, listener: Transport.Listener) {
        val req = Request.Builder().url(url).also { b ->
            for ((k, v) in headers) b.header(k, v)
        }.build()
        socket = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = listener.onOpen()
            override fun onMessage(webSocket: WebSocket, text: String) = listener.onMessage(text)
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = listener.onClosed(code, reason)
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, null)
                listener.onClosed(code, reason)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
                listener.onFailure(response?.code, t)
        })
    }

    override fun send(text: String): Boolean = socket?.send(text) ?: false

    override fun close(code: Int, reason: String) {
        socket?.close(code, reason.ifEmpty { null })
    }

    companion object {
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(3, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(10, TimeUnit.SECONDS)
            .followRedirects(false)
            .followSslRedirects(false)
            .build()
    }
}
