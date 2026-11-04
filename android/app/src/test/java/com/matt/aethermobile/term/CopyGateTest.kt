package com.matt.aethermobile.term

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CopyGateTest {
    private var t = 1_000L
    private val gate = CopyGate(ttlMs = 3000) { t }

    @Test fun unarmedRejects() {
        assertNull(gate.accept("secret"))
    }

    @Test fun armedAcceptsOnce() {
        gate.arm()
        assertEquals("hi", gate.accept("hi"))
        assertNull(gate.accept("hi"))
    }

    @Test fun acceptsAtTtlBoundaryRejectsAfter() {
        gate.arm()
        t += 3000
        assertEquals("a", gate.accept("a"))
        gate.arm()
        t += 3001
        assertNull(gate.accept("a"))
    }

    @Test fun disarmRejects() {
        gate.arm()
        gate.disarm()
        assertNull(gate.accept("a"))
    }

    @Test fun emptyTextConsumesTheArm() {
        gate.arm()
        assertNull(gate.accept(""))
        assertNull(gate.accept("a"))
    }

    @Test fun rearmAfterExpiryWorks() {
        gate.arm()
        t += 5000
        assertNull(gate.accept("a"))
        gate.arm()
        assertEquals("b", gate.accept("b"))
    }

    @Test fun rearmRefreshesWindow() {
        gate.arm()
        t += 2000
        gate.arm()
        t += 2000
        assertEquals("a", gate.accept("a"))
    }

    @Test fun pageMessagesAloneNeverArm() {
        // The gate has no path from parse(): parsed Sel/Copy without a native arm() never yield text.
        BridgeValidator.parse("""{"t":"sel","s":"claude","on":true}""")
        val msg = BridgeValidator.parse("""{"t":"copy","text":"stolen"}""") as PageMessage.Copy
        assertNull(gate.accept(msg.text))
    }
}
