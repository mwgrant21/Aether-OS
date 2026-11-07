package com.matt.aethermobile.alerts

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
