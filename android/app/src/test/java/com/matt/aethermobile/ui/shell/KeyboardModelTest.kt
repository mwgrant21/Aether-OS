package com.matt.aethermobile.ui.shell

import android.content.res.Configuration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KeyboardModelTest {
    @Test fun hardKeyboardTable() {
        assertTrue(hardKeyboardPresent(Configuration.KEYBOARD_QWERTY, Configuration.HARDKEYBOARDHIDDEN_NO))
        assertFalse(hardKeyboardPresent(Configuration.KEYBOARD_QWERTY, Configuration.HARDKEYBOARDHIDDEN_YES))
        assertFalse(hardKeyboardPresent(Configuration.KEYBOARD_NOKEYS, Configuration.HARDKEYBOARDHIDDEN_NO))
        assertFalse(hardKeyboardPresent(Configuration.KEYBOARD_UNDEFINED, Configuration.HARDKEYBOARDHIDDEN_NO))
    }

    @Test fun mirrorsMatchConfiguration() {
        assertEquals(Configuration.KEYBOARD_UNDEFINED, KbdConst.KEYBOARD_UNDEFINED)
        assertEquals(Configuration.KEYBOARD_NOKEYS, KbdConst.KEYBOARD_NOKEYS)
        assertEquals(Configuration.HARDKEYBOARDHIDDEN_NO, KbdConst.HARDKEYBOARDHIDDEN_NO)
        assertEquals(Configuration.HARDKEYBOARDHIDDEN_YES, KbdConst.HARDKEYBOARDHIDDEN_YES)
    }

    @Test fun softImeAllowedCombos() {
        assertTrue(softImeAllowed(false, ImeMode.AUTO))
        assertFalse(softImeAllowed(true, ImeMode.AUTO))
        assertTrue(softImeAllowed(false, ImeMode.USER_SHOWN))
        assertTrue(softImeAllowed(true, ImeMode.USER_SHOWN))
        assertFalse(softImeAllowed(false, ImeMode.USER_HIDDEN))
        assertFalse(softImeAllowed(true, ImeMode.USER_HIDDEN))
    }

    @Test fun nextImeModeFlipsOnVisibility() {
        assertEquals(ImeMode.USER_HIDDEN, nextImeMode(true))
        assertEquals(ImeMode.USER_SHOWN, nextImeMode(false))
    }

    @Test fun refocusAfterSendCombos() {
        assertTrue(refocusAfterSend(false, false))
        assertTrue(refocusAfterSend(false, true))
        assertFalse(refocusAfterSend(true, false))
        assertTrue(refocusAfterSend(true, true))
    }

    @Test fun landscapeNoImeKeepsKeysDropsZoom() {
        assertEquals(ChromePlan(zoomRow = false, keyRow = true), chromePlan(891f, 387f))
    }

    @Test fun landscapeWithImeDropsBoth() {
        assertEquals(ChromePlan(zoomRow = false, keyRow = false), chromePlan(891f, 197f))
    }

    @Test fun portraitKeepsBothWithOrWithoutIme() {
        assertEquals(ChromePlan(true, true), chromePlan(411f, 840f))
        assertEquals(ChromePlan(true, true), chromePlan(411f, 540f))
    }

    @Test fun shortPortraitDropsZoomOnly() {
        assertEquals(ChromePlan(zoomRow = false, keyRow = true), chromePlan(280f, 300f))
    }

    @Test fun boundaries() {
        assertTrue(chromePlan(200f, 264f).keyRow)
        assertFalse(chromePlan(200f, 263.9f).keyRow)
        assertTrue(chromePlan(200f, 320f).zoomRow)
        assertFalse(chromePlan(200f, 319.9f).zoomRow)
    }

    @Test fun badMeasureReturnsFullPlan() {
        val full = ChromePlan(true, true)
        assertEquals(full, chromePlan(Float.NaN, 300f))
        assertEquals(full, chromePlan(411f, Float.POSITIVE_INFINITY))
        assertEquals(full, chromePlan(411f, 0f))
        assertEquals(full, chromePlan(-1f, 300f))
    }
}
