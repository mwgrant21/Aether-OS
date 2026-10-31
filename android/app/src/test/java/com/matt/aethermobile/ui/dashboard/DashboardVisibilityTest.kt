package com.matt.aethermobile.ui.dashboard

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DashboardVisibilityTest {
    @Test fun fullyVisible() = assertTrue(coreOnScreen(100f, 400f, 0f, 1000f))
    @Test fun fullyAbove() = assertFalse(coreOnScreen(-400f, -100f, 0f, 1000f))
    @Test fun fullyBelow() = assertFalse(coreOnScreen(1100f, 1400f, 0f, 1000f))
    @Test fun partlyClippedTop() = assertTrue(coreOnScreen(-250f, 50f, 0f, 1000f))
    @Test fun partlyClippedBottom() = assertTrue(coreOnScreen(950f, 1250f, 0f, 1000f))
    @Test fun touchingEdgeIsNotVisible() = assertFalse(coreOnScreen(-300f, 0f, 0f, 1000f))
    @Test fun notLaidOutIsNotVisible() = assertFalse(coreOnScreen(0f, 0f, 0f, 0f))
}
