package com.matt.aethermobile.alerts

import com.matt.aethermobile.protocol.ControlProtocol.AlertKind

/** Fixed alert strings. No function takes free text from a frame, so nothing hostile can reach a notification. */
object AlertText {
    const val WATCHING = "Aether watching"
    const val NOT_CONNECTED = "Aether not connected"
    const val PERMISSION_OFF = "Alerts are off: allow notifications for Aether in Android settings."

    fun title(kind: AlertKind): String = when (kind) {
        AlertKind.FINISHED -> "Task finished"
        AlertKind.QUESTION -> "A question needs your attention"
        AlertKind.INPUT -> "Input needed for clarification"
    }

    fun publicText(slotLabel: String, kind: AlertKind): String = when (kind) {
        AlertKind.FINISHED -> "$slotLabel has finished"
        AlertKind.QUESTION -> "$slotLabel has a question"
        AlertKind.INPUT -> "$slotLabel needs input"
    }
}
