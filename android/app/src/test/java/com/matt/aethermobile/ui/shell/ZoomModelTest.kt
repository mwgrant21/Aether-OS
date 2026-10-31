package com.matt.aethermobile.ui.shell

import org.junit.Assert.assertEquals
import org.junit.Test

class ZoomModelTest {
    @Test fun defaultIsReadable() = assertEquals(14, Zoom.DEFAULT)

    @Test fun fitStepsFromDefault() {
        assertEquals(16, Zoom.stepped(0, +2))
        assertEquals(12, Zoom.stepped(0, -2))
    }

    @Test fun clampsAtBounds() {
        assertEquals(24, Zoom.stepped(24, +2))
        assertEquals(8, Zoom.stepped(8, -2))
    }

    @Test fun nonFitStepsFromCurrent() = assertEquals(16, Zoom.stepped(14, +2))

    @Test fun rangeMatchesHostZoom() {
        assertEquals(8, Zoom.MIN)
        assertEquals(24, Zoom.MAX)
    }
}
