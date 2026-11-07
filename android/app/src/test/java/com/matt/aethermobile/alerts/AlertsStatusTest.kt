package com.matt.aethermobile.alerts

import org.junit.Assert.assertEquals
import org.junit.Test

class AlertsStatusTest {
    @Test
    fun truthTableOverAllEightRows() {
        // hasToken, notificationsAllowed, connected -> status
        val rows = listOf(
            Triple(false, false, false) to AlertsStatus.NOT_PAIRED,
            Triple(false, false, true) to AlertsStatus.NOT_PAIRED,
            Triple(false, true, false) to AlertsStatus.NOT_PAIRED,
            Triple(false, true, true) to AlertsStatus.NOT_PAIRED,
            Triple(true, false, false) to AlertsStatus.PERMISSION_OFF,
            Triple(true, false, true) to AlertsStatus.PERMISSION_OFF,
            Triple(true, true, false) to AlertsStatus.NOT_CONNECTED,
            Triple(true, true, true) to AlertsStatus.WATCHING,
        )
        for ((input, expected) in rows) {
            assertEquals(input.toString(), expected, alertsStatus(input.first, input.second, input.third))
        }
    }
}
