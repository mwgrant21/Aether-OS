package com.matt.aethermobile.term

import android.content.Context
import android.text.InputType
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.webkit.WebView

/**
 * WebView whose soft-keyboard connection asks the IME for plain, uncomposed text: visible-password
 * variation plus no-suggestions stops Gboard composing, predicting or auto-correcting into the
 * terminal. Real behavior is only checkable on a device (WebView is not JVM-testable).
 */
class AetherWebView(context: Context) : WebView(context) {
    init {
        isFocusableInTouchMode = true
    }

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        val connection = super.onCreateInputConnection(outAttrs)
        outAttrs.inputType = InputType.TYPE_CLASS_TEXT or
            InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or
            InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        outAttrs.imeOptions = imeOptionsFor(outAttrs.imeOptions)
        return connection
    }
}

/** Clears the 0xff action field first: IME_ACTION_NONE is 1, so a plain OR cannot replace GO/NEXT/SEARCH. */
internal fun imeOptionsFor(current: Int): Int =
    (current and EditorInfo.IME_MASK_ACTION.inv()) or
        EditorInfo.IME_FLAG_NO_FULLSCREEN or
        EditorInfo.IME_FLAG_NO_EXTRACT_UI or
        EditorInfo.IME_ACTION_NONE
