package com.matt.aethermobile.alerts

import com.matt.aethermobile.protocol.ControlProtocol
import com.matt.aethermobile.protocol.ControlProtocol.AlertKind
import org.junit.Assert.assertEquals
import org.junit.Test

class AlertTextTest {
    @Test
    fun titleIsExactForEveryKind() {
        assertEquals("Task finished", AlertText.title(AlertKind.FINISHED))
        assertEquals("A question needs your attention", AlertText.title(AlertKind.QUESTION))
        assertEquals("Input needed for clarification", AlertText.title(AlertKind.INPUT))
    }

    @Test
    fun publicTextIsExactForEveryKind() {
        val label = ControlProtocol.SLOTS[0].label
        assertEquals("Terminal Alpha has finished", AlertText.publicText(label, AlertKind.FINISHED))
        assertEquals("Terminal Alpha has a question", AlertText.publicText(label, AlertKind.QUESTION))
        assertEquals("Terminal Alpha needs input", AlertText.publicText(label, AlertKind.INPUT))
        assertEquals(3, AlertKind.values().size)
    }

    @Test
    fun constantsAreExact() {
        assertEquals("Aether watching", AlertText.WATCHING)
        assertEquals("Aether not connected", AlertText.NOT_CONNECTED)
        assertEquals(
            "Alerts are off: allow notifications for Aether in Android settings.",
            AlertText.PERMISSION_OFF,
        )
    }
}
