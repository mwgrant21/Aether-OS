package com.matt.aethermobile.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreenShareModeTest {
    private fun on() = ScreenShareState().also { it.onAuthenticated() }

    @Test fun defaultsOffAndSecure() {
        val s = ScreenShareState()
        assertFalse(s.on)
        assertTrue(s.secureWanted)
    }

    @Test fun availableShowsPromptWithoutTurningOn() {
        val s = ScreenShareState()
        assertEquals(ShareStart.ShowPrompt, s.requestEnable(Availability.Available))
        assertFalse(s.on)
    }

    @Test fun unavailableMapsToRefusalAndStaysOff() {
        val expected = mapOf(
            Availability.NoHardware to ShareMessage.NoHardware,
            Availability.NoneEnrolled to ShareMessage.NoneEnrolled,
            Availability.HardwareUnavailable to ShareMessage.SensorUnavailable,
            Availability.Unsupported to ShareMessage.Failed,
        )
        for ((a, m) in expected) {
            val s = ScreenShareState()
            assertEquals(ShareStart.Refused(m), s.requestEnable(a))
            assertEquals(ShareUi(false, m), s.ui())
        }
    }

    @Test fun authenticatedTurnsOn() {
        val s = on()
        assertTrue(s.on)
        assertFalse(s.secureWanted)
    }

    @Test fun disableTurnsOffIdempotently() {
        val s = on()
        s.disable()
        s.disable()
        assertFalse(s.on)
        assertTrue(s.secureWanted)
        assertNull(s.ui().message)
    }

    @Test fun failureMapsToMessageAndStaysOff() {
        val expected = mapOf(
            BiometricFailure.UserCancelled to null,
            BiometricFailure.Lockout to ShareMessage.Lockout,
            BiometricFailure.LockoutPermanent to ShareMessage.Lockout,
            BiometricFailure.NoHardware to ShareMessage.NoHardware,
            BiometricFailure.NoneEnrolled to ShareMessage.NoneEnrolled,
            BiometricFailure.Other to ShareMessage.Failed,
        )
        for ((f, m) in expected) {
            val s = ScreenShareState()
            s.onAuthFailed(f)
            assertEquals(m, s.ui().message)
            assertFalse(s.on)
        }
    }

    @Test fun requestWhileOnIsAlreadyOn() {
        assertEquals(ShareStart.AlreadyOn, on().requestEnable(Availability.Available))
    }

    @Test fun promptNotShownIsFailed() {
        val s = ScreenShareState()
        s.onPromptNotShown()
        assertEquals(ShareMessage.Failed, s.ui().message)
        assertFalse(s.on)
    }

    @Test fun freshLaunchResetsOff() {
        val s = on()
        s.onActivityCreate(freshLaunch = true)
        assertFalse(s.on)
    }

    @Test fun recreationKeepsOn() {
        val s = on()
        s.onActivityCreate(freshLaunch = false)
        assertTrue(s.on)
    }

    @Test fun newRequestClearsPreviousMessage() {
        val s = ScreenShareState()
        s.requestEnable(Availability.NoHardware)
        s.requestEnable(Availability.Available)
        assertNull(s.ui().message)
    }

    @Test fun uiMirrorsState() {
        val s = on()
        assertEquals(ShareUi(true, null), s.ui())
    }
}
