package com.matt.aethermobile.ui.auth

import com.matt.aethermobile.ErrorKind
import com.matt.aethermobile.FlowState
import com.matt.aethermobile.Notice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthModelTest {
    @Test fun lockedDefaultsToNoNotice() {
        assertEquals(AuthScreen.Locked(null), authScreenFor(FlowState.Locked()))
    }

    @Test fun everyNonConnectedStateMapsToItsScreen() {
        assertEquals(AuthScreen.NotConfigured, authScreenFor(FlowState.NotConfigured))
        assertEquals(AuthScreen.Pair(null), authScreenFor(FlowState.NeedsPair()))
        assertEquals(AuthScreen.Pair(Notice.BadCode), authScreenFor(FlowState.NeedsPair(Notice.BadCode)))
        assertEquals(AuthScreen.Pairing, authScreenFor(FlowState.Pairing))
        assertEquals(AuthScreen.Connecting, authScreenFor(FlowState.Connecting))
        assertEquals(AuthScreen.Locked(Notice.Lockout), authScreenFor(FlowState.Locked(Notice.Lockout)))
        assertEquals(AuthScreen.Error(ErrorKind.Busy), authScreenFor(FlowState.Error(ErrorKind.Busy)))
    }

    @Test fun connectedHasNoAuthScreen() = assertNull(authScreenFor(FlowState.Connected(30)))

    @Test fun savePromptAndDeferredAreTheSameScreen() {
        assertEquals(AuthScreen.Saving, authScreenFor(FlowState.SavePrompt))
        assertEquals(AuthScreen.Saving, authScreenFor(FlowState.SaveDeferred))
    }

    @Test fun filterUppercasesAndDashes() {
        assertEquals("ABCD-2345", CodeInput.filter("abcd2345"))
        assertEquals("ABCD", CodeInput.filter("ab cd"))
        assertEquals("ABCD-234", CodeInput.filter("ab cd-12 34")) // 1 is not in the alphabet
    }

    @Test fun filterDropsCharsOutsideAlphabet() {
        assertEquals("ABCD-EFGH", CodeInput.filter("ABCD-EFGH")) // E is in the alphabet; I and O are not
        assertEquals("ABCD-FGH", CodeInput.filter("ABCD-IFOGH"))
        assertEquals("", CodeInput.filter("0O1Il"))
    }

    @Test fun filterCapsAtEightCharacters() = assertEquals("ABCD-2345", CodeInput.filter("ABCD23456789XYZ"))

    @Test fun filterIsIdempotent() {
        for (x in listOf("abcd1234", "ab cd-12 34", "ABCD-EFGH", "0O1Il", "ABCD23456789XYZ", "")) {
            assertEquals(CodeInput.filter(x), CodeInput.filter(CodeInput.filter(x)))
        }
    }

    @Test fun submittableOnlyForEightValidChars() {
        assertTrue(CodeInput.isSubmittable("ABCD-2345"))
        assertFalse(CodeInput.isSubmittable("ABCD-234"))
        assertFalse(CodeInput.isSubmittable(""))
    }

    @Test fun countdownFormatsAndHoldsAtZero() {
        assertEquals("1:00", countdownText(60))
        assertEquals("0:05", countdownText(5))
        assertEquals("0:00", countdownText(-3))
    }
}
