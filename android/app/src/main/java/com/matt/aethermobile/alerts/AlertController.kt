package com.matt.aethermobile.alerts

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.matt.aethermobile.auth.AlertVault

object AlertController {
    /** A re-pair stored a new alert token: a running service must drop its client and reload it. */
    fun onPaired(context: Context) = start(context, AlertService.ACTION_RECONNECT)

    /** Starts the service when an alert token exists; no-op otherwise. Idempotent. */
    fun ensureRunning(context: Context) = start(context, null)

    fun status(context: Context): AlertsStatus = alertsStatus(
        hasToken = AlertVault(context).hasToken(),
        notificationsAllowed = Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED,
        connected = AlertService.connected,
    )

    private fun start(context: Context, action: String?) {
        try {
            if (!AlertVault(context).hasToken()) return
            val app = context.applicationContext
            // ForegroundServiceStartNotAllowedException (API 31+) is a RuntimeException.
            ContextCompat.startForegroundService(app, AlertService.intent(app, action))
        } catch (e: VirtualMachineError) {
            throw e
        } catch (_: RuntimeException) {
            // Start refused (background restrictions); never crash the caller.
        }
    }
}
