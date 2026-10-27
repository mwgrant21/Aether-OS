package com.matt.aethermobile.ui.shell

/** Terminal font size in px. 0 sent to the page means "fit width"; it is a button, not the default. */
object Zoom {
    const val DEFAULT = 14
    const val MIN = 8
    const val MAX = 24
    const val STEP = 2

    /** [current] == 0 (fit) steps from [DEFAULT]. */
    fun stepped(current: Int, delta: Int): Int {
        val base = if (current == 0) DEFAULT else current
        return (base + delta).coerceIn(MIN, MAX)
    }
}
