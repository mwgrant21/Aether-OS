package com.matt.aethermobile.ui.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PaneEnvTest {
    @Test
    fun gateBackPassesAPaneWantOnlyWhenBackIsEnabled() {
        assertTrue(PaneEnv(backEnabled = true).gateBack(true))
        assertFalse(PaneEnv(backEnabled = true).gateBack(false))
        assertFalse(PaneEnv(backEnabled = false).gateBack(true))
        assertFalse(PaneEnv(backEnabled = false).gateBack(false))
    }

    @Test
    fun menuOpenSilencesPaneBack() {
        assertFalse(paneEnvFor(menuOpen = true).backEnabled)
        assertTrue(paneEnvFor(menuOpen = false).backEnabled)
    }

    @Test
    fun defaultEnvLeavesPaneBackOn() {
        assertEquals(true, PaneEnv().gateBack(true))
    }
}
