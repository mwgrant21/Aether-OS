package com.matt.aethermobile.ui.shell

import androidx.compose.foundation.gestures.ScrollableState
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerType
import androidx.compose.ui.input.pointer.isPrimaryPressed
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.composed
import androidx.compose.ui.unit.dp
import kotlin.math.abs

/** Pure drag-to-scroll maths for a mouse button drag. Touch scrolling is native and never reaches this. */
class MouseDragTracker(private val slopPx: Float, private val horizontal: Boolean) {
    private var startX = 0f
    private var startY = 0f
    private var lastX = 0f
    private var lastY = 0f

    var dragging: Boolean = false
        private set

    fun down(x: Float, y: Float) {
        startX = x; startY = y; lastX = x; lastY = y
        dragging = false
    }

    /** Null until travel on either axis passes the slop; the crossing move returns 0f; then the scroll delta in px. */
    fun move(x: Float, y: Float): Float? {
        if (!dragging) {
            if (abs(x - startX) <= slopPx && abs(y - startY) <= slopPx) return null
            dragging = true
            lastX = x; lastY = y
            return 0f
        }
        val d = if (horizontal) -(x - lastX) else -(y - lastY)
        lastX = x; lastY = y
        return d
    }

    fun up() {
        dragging = false
    }
}

/**
 * Primary-button mouse drag scrolls [state]. Runs in the Initial pass and consumes once past the slop, so a
 * descendant SelectionContainer does not start a selection. Before the slop nothing is consumed, so taps pass through.
 */
fun Modifier.mouseDragScroll(state: ScrollableState, horizontal: Boolean = false): Modifier = composed {
    val slopPx = with(LocalDensity.current) { 6.dp.toPx() }
    pointerInput(state, horizontal) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            if (down.type != PointerType.Mouse || !currentEvent.buttons.isPrimaryPressed) return@awaitEachGesture
            val tracker = MouseDragTracker(slopPx, horizontal)
            tracker.down(down.position.x, down.position.y)
            while (true) {
                val event = awaitPointerEvent(PointerEventPass.Initial)
                val change = event.changes.firstOrNull { it.id == down.id } ?: break
                if (!change.pressed || !event.buttons.isPrimaryPressed) break
                val delta = tracker.move(change.position.x, change.position.y)
                if (delta != null) {
                    state.dispatchRawDelta(delta)
                    change.consume()
                }
            }
            tracker.up()
        }
    }
}
