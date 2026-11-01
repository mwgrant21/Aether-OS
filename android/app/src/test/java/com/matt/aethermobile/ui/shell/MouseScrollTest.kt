package com.matt.aethermobile.ui.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MouseScrollTest {
    @Test fun belowSlopIsNull() {
        val t = MouseDragTracker(6f, false)
        t.down(0f, 0f)
        assertNull(t.move(3f, 4f))
        assertFalse(t.dragging)
    }

    @Test fun crossingReturnsZeroThenVerticalDeltas() {
        val t = MouseDragTracker(6f, false)
        t.down(0f, 100f)
        assertEquals(0f, t.move(0f, 90f)!!, 0f)
        assertTrue(t.dragging)
        assertEquals(10f, t.move(0f, 80f)!!, 0f)   // content dragged up scrolls forward
        assertEquals(-5f, t.move(0f, 85f)!!, 0f)
    }

    @Test fun horizontalUsesXOnly() {
        val t = MouseDragTracker(6f, true)
        t.down(100f, 0f)
        assertEquals(0f, t.move(90f, 50f)!!, 0f)
        assertEquals(15f, t.move(75f, 200f)!!, 0f)
    }

    @Test fun upResetsAndSecondGestureStartsFresh() {
        val t = MouseDragTracker(6f, false)
        t.down(0f, 0f)
        t.move(0f, 20f)
        t.up()
        assertFalse(t.dragging)
        t.down(0f, 500f)
        assertNull(t.move(0f, 502f))
        assertEquals(0f, t.move(0f, 520f)!!, 0f)
    }
}
