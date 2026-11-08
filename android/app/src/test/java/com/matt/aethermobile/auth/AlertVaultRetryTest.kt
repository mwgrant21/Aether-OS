package com.matt.aethermobile.auth

import java.security.UnrecoverableKeyException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.fail
import org.junit.Test

class AlertVaultRetryTest {
    @Test
    fun successFirstTimeNeverWipes() {
        var wipes = 0
        val r = attemptWithWipeRetry(op = { "ok" }, wipe = { wipes++ })
        assertEquals("ok", r)
        assertEquals(0, wipes)
    }

    @Test
    fun wipeClassFailureWipesOnceAndRetries() {
        var wipes = 0
        var calls = 0
        val r = attemptWithWipeRetry(
            op = {
                calls++
                if (calls == 1) throw UnrecoverableKeyException("gone")
                "ok"
            },
            wipe = { wipes++ },
        )
        assertEquals("ok", r)
        assertEquals(1, wipes)
        assertEquals(2, calls)
    }

    @Test
    fun secondWipeClassFailurePropagatesAfterOneWipe() {
        var wipes = 0
        var calls = 0
        val second = UnrecoverableKeyException("again")
        try {
            attemptWithWipeRetry<String>(
                op = {
                    calls++
                    throw if (calls == 1) UnrecoverableKeyException("first") else second
                },
                wipe = { wipes++ },
            )
            fail("expected exception")
        } catch (e: UnrecoverableKeyException) {
            assertSame(second, e)
        }
        assertEquals(1, wipes)
        assertEquals(2, calls)
    }

    @Test
    fun unavailableFailurePropagatesWithoutWipeOrRetry() {
        var wipes = 0
        var calls = 0
        try {
            attemptWithWipeRetry<String>(
                op = {
                    calls++
                    throw IllegalStateException("busy")
                },
                wipe = { wipes++ },
            )
            fail("expected exception")
        } catch (e: IllegalStateException) {
            assertEquals("busy", e.message)
        }
        assertEquals(0, wipes)
        assertEquals(1, calls)
    }
}
