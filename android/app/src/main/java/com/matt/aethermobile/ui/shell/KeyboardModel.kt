package com.matt.aethermobile.ui.shell

// Pure JVM, no android.* imports: keyboard/IME and chrome-collapse decisions.

/** Mirrors of android.content.res.Configuration ints; the test asserts each equals the real constant. */
object KbdConst {
    const val KEYBOARD_UNDEFINED = 0
    const val KEYBOARD_NOKEYS = 1
    const val HARDKEYBOARDHIDDEN_NO = 1
    const val HARDKEYBOARDHIDDEN_YES = 2
}

/** True when a physical keyboard is attached and exposed. UNDEFINED/NOKEYS or hidden -> false. */
fun hardKeyboardPresent(keyboard: Int, hardKeyboardHidden: Int): Boolean =
    keyboard != KbdConst.KEYBOARD_UNDEFINED &&
        keyboard != KbdConst.KEYBOARD_NOKEYS &&
        hardKeyboardHidden != KbdConst.HARDKEYBOARDHIDDEN_YES

enum class ImeMode { AUTO, USER_SHOWN, USER_HIDDEN }

/** Whether a tap in the WebView may start an input session (and so open the IME). */
fun softImeAllowed(hardKeyboard: Boolean, mode: ImeMode): Boolean = when (mode) {
    ImeMode.USER_SHOWN -> true
    ImeMode.USER_HIDDEN -> false
    ImeMode.AUTO -> !hardKeyboard
}

/** Header toggle: IME visible -> USER_HIDDEN, otherwise USER_SHOWN. */
fun nextImeMode(imeVisible: Boolean): ImeMode =
    if (imeVisible) ImeMode.USER_HIDDEN else ImeMode.USER_SHOWN

/** After Send: refocus the compose field (which re-opens the IME) only when it cannot surprise. */
fun refocusAfterSend(hardKeyboard: Boolean, imeVisible: Boolean): Boolean =
    !hardKeyboard || imeVisible

object ChromeDp {
    const val HEADER = 60f
    const val COMPOSER = 52f
    const val KEY_ROW = 56f
    const val ZOOM_ROW = 56f
    const val MIN_TERMINAL = 96f
}

data class ChromePlan(val zoomRow: Boolean, val keyRow: Boolean)

private const val KEY_ROW_MIN_HEIGHT =
    ChromeDp.HEADER + ChromeDp.COMPOSER + ChromeDp.KEY_ROW + ChromeDp.MIN_TERMINAL
private const val ZOOM_ROW_MIN_HEIGHT = KEY_ROW_MIN_HEIGHT + ChromeDp.ZOOM_ROW

/**
 * heightDp = the shell's own available height (already minus system bars and IME).
 * A bad measure (non-finite or <= 0) returns the full plan so controls never vanish.
 * The zoom row is portrait-only; in landscape zoom lives in the burger menu.
 */
fun chromePlan(widthDp: Float, heightDp: Float): ChromePlan {
    if (!widthDp.isFinite() || !heightDp.isFinite() || widthDp <= 0f || heightDp <= 0f) {
        return ChromePlan(zoomRow = true, keyRow = true)
    }
    val landscape = widthDp > heightDp
    return ChromePlan(
        zoomRow = !landscape && heightDp >= ZOOM_ROW_MIN_HEIGHT,
        keyRow = heightDp >= KEY_ROW_MIN_HEIGHT,
    )
}
