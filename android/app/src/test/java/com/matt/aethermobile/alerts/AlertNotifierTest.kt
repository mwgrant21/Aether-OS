package com.matt.aethermobile.alerts

import com.matt.aethermobile.protocol.ControlProtocol
import com.matt.aethermobile.protocol.ControlProtocol.AlertFrame
import com.matt.aethermobile.protocol.ControlProtocol.AlertKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AlertNotifierTest {
    @Test
    fun mapsEachKindToFixedFields() {
        assertEquals(
            AlertNotificationFields("Task finished", "Terminal Alpha", "Terminal Alpha has finished"),
            alertNotification(AlertFrame("claude", AlertKind.FINISHED)),
        )
        assertEquals(
            AlertNotificationFields("A question needs your attention", "Terminal Alpha", "Terminal Alpha has a question"),
            alertNotification(AlertFrame("claude", AlertKind.QUESTION)),
        )
        assertEquals(
            AlertNotificationFields("Input needed for clarification", "Terminal Alpha", "Terminal Alpha needs input"),
            alertNotification(AlertFrame("claude", AlertKind.INPUT)),
        )
    }

    @Test
    fun hostileExtraKeysNeverReachTheFields() {
        val hostile = ControlProtocol.parseAlertFrame("""{"t":"alert","s":"claude","kind":"finished","text":"C:\\secret","body":"x"}""")
        assertNotNull(hostile)
        val fields = alertNotification(hostile!!)
        assertEquals(alertNotification(AlertFrame("claude", AlertKind.FINISHED)), fields)
        assertTrue(fields.toString(), !fields.toString().contains("secret"))
    }

    @Test
    fun unknownSlotIsNeverEchoed() {
        val fields = alertNotification(AlertFrame("evil-slot", AlertKind.FINISHED))
        assertTrue(fields.toString(), !fields.toString().contains("evil"))
    }
}
