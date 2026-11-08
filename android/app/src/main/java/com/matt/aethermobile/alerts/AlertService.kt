package com.matt.aethermobile.alerts

import android.annotation.SuppressLint
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.ServiceCompat
import com.matt.aethermobile.BuildConfig
import com.matt.aethermobile.auth.AlertVault
import com.matt.aethermobile.net.ControlClient
import com.matt.aethermobile.net.ControlState
import com.matt.aethermobile.net.OkHttpTransport
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Foreground service that holds the alert-only socket. Never starts the main
 * connection and never reads the main token. The token and frame text are never
 * logged. State lives on the main thread; OkHttp-thread callbacks are marshalled.
 */
class AlertService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val policy = AlertReconnectPolicy()
    private var executor: ExecutorService? = null
    private var client: ControlClient? = null
    private var gen = 0
    private var loading = false
    private var reconnect: Runnable? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        executor = Executors.newSingleThreadExecutor()
        safely { AlertNotifier.ensureChannels(this) }
    }

    // The constant is inlined at compile time and matches the manifest foregroundServiceType.
    @SuppressLint("InlinedApi")
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // startForeground first, before any path that can return early: the service was
        // started with startForegroundService and must satisfy it within seconds.
        try {
            val n = AlertNotifier.watchingNotification(this, connected)
            ServiceCompat.startForeground(
                this, AlertNotifier.WATCH_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } catch (e: VirtualMachineError) {
            throw e
        } catch (_: RuntimeException) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_RECONNECT) {
            policy.reset()
            startConnect()
        } else if (client != null || loading || reconnect != null) {
            safely { AlertNotifier.updateWatching(this, connected) }
        } else {
            startConnect()
        }
        return START_STICKY
    }

    /** Drops any current client and pending reconnect, then loads the token off the main thread and connects. */
    private fun startConnect() {
        val g = ++gen
        client?.close()
        client = null
        cancelReconnect()
        connected = false
        loading = true
        val ex = executor
        try {
            ex?.execute {
                val token = try {
                    AlertVault(applicationContext).load()
                } catch (e: VirtualMachineError) {
                    throw e
                } catch (_: RuntimeException) {
                    null
                }
                handler.post { if (g == gen) onTokenLoaded(g, token) }
            }
        } catch (e: VirtualMachineError) {
            throw e
        } catch (_: RuntimeException) {
            loading = false
        }
    }

    private fun onTokenLoaded(g: Int, token: String?) {
        loading = false
        if (token == null) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }
        val c = ControlClient(
            host = BuildConfig.TITAN_IP,
            appVersion = BuildConfig.VERSION_NAME,
            transport = OkHttpTransport(OkHttpTransport.defaultAlertClient()),
            onState = { s -> handler.post { if (g == gen) onClientState(g, token, s) } },
            onAlertFrame = { f -> if (g == gen) safely { AlertNotifier.post(this, f) } },
        )
        client = c
        c.connect(token)
    }

    private fun onClientState(g: Int, token: String, s: ControlState) {
        when (s) {
            is ControlState.Connected -> {
                connected = true
                policy.reset()
                safely { AlertNotifier.updateWatching(this, connected = true) }
            }
            ControlState.Revoked -> {
                connected = false
                try {
                    executor?.execute {
                        val current = try {
                            AlertVault(applicationContext).load()
                        } catch (e: VirtualMachineError) {
                            throw e
                        } catch (_: RuntimeException) {
                            null
                        }
                        // A re-pair may have stored a newer token; only clear the one this connection used.
                        if (current == token) safely { AlertVault(applicationContext).clear() }
                        handler.post { if (g == gen) stopSelf() }
                    }
                } catch (e: VirtualMachineError) {
                    throw e
                } catch (_: RuntimeException) {
                    stopSelf()
                }
            }
            ControlState.Superseded, ControlState.Disabled, is ControlState.Closed, is ControlState.Failed -> {
                connected = false
                safely { AlertNotifier.updateWatching(this, connected = false) }
                scheduleReconnect(g)
            }
            ControlState.Idle, ControlState.Connecting -> Unit
        }
    }

    private fun scheduleReconnect(g: Int) {
        cancelReconnect()
        val r = Runnable {
            reconnect = null
            if (g == gen) startConnect()
        }
        reconnect = r
        handler.postDelayed(r, policy.nextDelayMs())
    }

    private fun cancelReconnect() {
        reconnect?.let { handler.removeCallbacks(it) }
        reconnect = null
    }

    override fun onDestroy() {
        gen++
        client?.close()
        client = null
        connected = false
        handler.removeCallbacksAndMessages(null)
        reconnect = null
        executor?.shutdown()
        executor = null
        super.onDestroy()
    }

    private inline fun safely(block: () -> Unit) {
        try {
            block()
        } catch (e: VirtualMachineError) {
            throw e
        } catch (_: RuntimeException) {
            // Notification failures must not reach an OkHttp or Handler thread.
        }
    }

    companion object {
        const val ACTION_RECONNECT = "com.matt.aethermobile.alerts.RECONNECT"

        /** True only while the alert client is in Connected. */
        @Volatile
        var connected: Boolean = false
            private set

        internal fun intent(context: Context, action: String? = null): Intent =
            Intent(context, AlertService::class.java).also { it.action = action }
    }
}
