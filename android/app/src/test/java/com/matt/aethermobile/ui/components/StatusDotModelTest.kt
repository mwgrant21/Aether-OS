package com.matt.aethermobile.ui.components

import com.matt.aethermobile.protocol.ControlProtocol.SlotState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StatusDotModelTest {
    @Test fun runningIsLiveGlow() = assertEquals(DotStyle.LiveGlow, dotStyleFor(SlotState.RUNNING))

    @Test fun notStartedIsHollowRing() = assertEquals(DotStyle.HollowRing, dotStyleFor(SlotState.NOT_STARTED))

    @Test fun exitedIsFlat() = assertEquals(DotStyle.Flat, dotStyleFor(SlotState.EXITED))

    @Test fun onlyLiveGlowGlows() {
        assertTrue(DotStyle.LiveGlow.glows)
        for (s in SlotState.values()) {
            if (s != SlotState.RUNNING) assertFalse("$s must not glow", dotStyleFor(s).glows)
        }
    }
}
