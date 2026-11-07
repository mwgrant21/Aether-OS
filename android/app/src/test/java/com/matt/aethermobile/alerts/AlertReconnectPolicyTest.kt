package com.matt.aethermobile.alerts

import org.junit.Assert.assertEquals
import org.junit.Test

class AlertReconnectPolicyTest {
    @Test
    fun backoffDoublesToTheCap() {
        val p = AlertReconnectPolicy()
        val seen = List(7) { p.nextDelayMs() }
        assertEquals(listOf(2000L, 4000L, 8000L, 16000L, 32000L, 60000L, 60000L), seen)
    }

    @Test
    fun resetReturnsToBase() {
        val p = AlertReconnectPolicy()
        repeat(4) { p.nextDelayMs() }
        p.reset()
        assertEquals(2000L, p.nextDelayMs())
    }

    @Test
    fun neverOverflowsAfterManyCalls() {
        val p = AlertReconnectPolicy()
        repeat(200) { p.nextDelayMs() }
        assertEquals(60000L, p.nextDelayMs())
    }
}
