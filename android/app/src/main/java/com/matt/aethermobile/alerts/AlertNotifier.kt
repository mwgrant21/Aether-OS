package com.matt.aethermobile.alerts

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.matt.aethermobile.MainActivity
import com.matt.aethermobile.R
import com.matt.aethermobile.protocol.ControlProtocol

/** The only fields a notification may carry. All come from fixed strings, never from frame text. */
data class AlertNotificationFields(val title: String, val text: String, val publicText: String)

private const val FALLBACK_LABEL = "Aether"

/** Pure mapping from a parsed alert frame to notification fields. */
fun alertNotification(frame: ControlProtocol.AlertFrame): AlertNotificationFields {
    val label = ControlProtocol.SLOTS.firstOrNull { it.s == frame.s }?.label ?: FALLBACK_LABEL
    return AlertNotificationFields(
        title = AlertText.title(frame.kind),
        text = label,
        publicText = AlertText.publicText(label, frame.kind),
    )
}

/** Android side of alerts: channels and notifications. Not unit-tested (needs a device). */
object AlertNotifier {
    const val CHANNEL_WATCH = "aether_watch"
    const val CHANNEL_ALERTS = "aether_alerts"
    const val WATCH_ID = 1

    /** Constant so a new alert replaces the previous one. */
    const val ALERT_ID = 2

    fun ensureChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_WATCH, "Aether watching", NotificationManager.IMPORTANCE_LOW),
        )
        val alerts = NotificationChannel(CHANNEL_ALERTS, "Aether alerts", NotificationManager.IMPORTANCE_HIGH)
        alerts.lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        nm.createNotificationChannel(alerts)
    }

    fun watchingNotification(context: Context, connected: Boolean): Notification =
        NotificationCompat.Builder(context, CHANNEL_WATCH)
            .setSmallIcon(R.drawable.ic_stat_alert)
            .setContentText(if (connected) AlertText.WATCHING else AlertText.NOT_CONNECTED)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openApp(context))
            .build()

    fun updateWatching(context: Context, connected: Boolean) {
        try {
            NotificationManagerCompat.from(context).notify(WATCH_ID, watchingNotification(context, connected))
        } catch (_: SecurityException) {
            // Notification permission revoked; nothing to show.
        }
    }

    fun post(context: Context, frame: ControlProtocol.AlertFrame) {
        val fields = alertNotification(frame)
        try {
            val publicVersion = NotificationCompat.Builder(context, CHANNEL_ALERTS)
                .setSmallIcon(R.drawable.ic_stat_alert)
                .setContentTitle(fields.publicText)
                .build()
            val n = NotificationCompat.Builder(context, CHANNEL_ALERTS)
                .setSmallIcon(R.drawable.ic_stat_alert)
                .setContentTitle(fields.title)
                .setContentText(fields.text)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setPublicVersion(publicVersion)
                .setAutoCancel(true)
                .setContentIntent(openApp(context))
                .build()
            NotificationManagerCompat.from(context).notify(ALERT_ID, n)
        } catch (_: SecurityException) {
            // Permission revoked mid-flight; drop silently, never throw into the socket thread.
        }
    }

    private fun openApp(context: Context): PendingIntent =
        PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
}
