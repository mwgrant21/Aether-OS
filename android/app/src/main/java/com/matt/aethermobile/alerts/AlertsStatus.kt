package com.matt.aethermobile.alerts

enum class AlertsStatus { NOT_PAIRED, PERMISSION_OFF, WATCHING, NOT_CONNECTED }

fun alertsStatus(hasToken: Boolean, notificationsAllowed: Boolean, connected: Boolean): AlertsStatus = when {
    !hasToken -> AlertsStatus.NOT_PAIRED
    !notificationsAllowed -> AlertsStatus.PERMISSION_OFF
    connected -> AlertsStatus.WATCHING
    else -> AlertsStatus.NOT_CONNECTED
}
