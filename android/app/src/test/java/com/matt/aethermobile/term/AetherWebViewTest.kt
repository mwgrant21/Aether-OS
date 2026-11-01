package com.matt.aethermobile.term

import android.view.inputmethod.EditorInfo
import org.junit.Assert.assertEquals
import org.junit.Test

class AetherWebViewTest {
    private fun action(v: Int) = v and EditorInfo.IME_MASK_ACTION

    @Test fun goNextAndSearchActionsAreReplacedWithNone() {
        for (a in listOf(EditorInfo.IME_ACTION_GO, EditorInfo.IME_ACTION_NEXT, EditorInfo.IME_ACTION_SEARCH)) {
            assertEquals(EditorInfo.IME_ACTION_NONE, action(imeOptionsFor(a)))
        }
    }

    @Test fun unrelatedFlagsSurvive() {
        val out = imeOptionsFor(EditorInfo.IME_FLAG_NO_ENTER_ACTION or EditorInfo.IME_ACTION_GO)
        assertEquals(EditorInfo.IME_FLAG_NO_ENTER_ACTION, out and EditorInfo.IME_FLAG_NO_ENTER_ACTION)
    }

    @Test fun zeroGetsNoFullscreenNoExtractUiAndActionNone() {
        val out = imeOptionsFor(0)
        assertEquals(EditorInfo.IME_FLAG_NO_FULLSCREEN, out and EditorInfo.IME_FLAG_NO_FULLSCREEN)
        assertEquals(EditorInfo.IME_FLAG_NO_EXTRACT_UI, out and EditorInfo.IME_FLAG_NO_EXTRACT_UI)
        assertEquals(EditorInfo.IME_ACTION_NONE, action(out))
    }

    @Test fun resultIsIdempotent() {
        val once = imeOptionsFor(EditorInfo.IME_ACTION_SEARCH or EditorInfo.IME_FLAG_NO_ENTER_ACTION)
        assertEquals(once, imeOptionsFor(once))
    }
}
