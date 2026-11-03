package com.matt.aethermobile.ui.shell

import org.junit.Assert.assertEquals
import org.junit.Test

class SelectionBarTest {
    @Test fun visibleOnlyWhenRawSelectionAndConnected() {
        assertEquals(true, selectionBarVisible(rawBody = true, selection = true, connected = true))
    }

    @Test fun hiddenWhenNotConnected() {
        assertEquals(false, selectionBarVisible(rawBody = true, selection = true, connected = false))
    }

    @Test fun hiddenWithoutSelection() {
        assertEquals(false, selectionBarVisible(rawBody = true, selection = false, connected = true))
    }

    @Test fun hiddenOutsideRaw() {
        assertEquals(false, selectionBarVisible(rawBody = false, selection = true, connected = true))
    }
}
