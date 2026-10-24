package com.matt.aethermobile.auth

import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.UserNotAuthenticatedException
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.IOException
import java.security.InvalidAlgorithmParameterException
import java.security.InvalidKeyException
import java.security.KeyStoreException
import java.security.ProviderException
import java.security.UnrecoverableKeyException
import javax.crypto.AEADBadTagException
import javax.crypto.NoSuchPaddingException

class VaultClassifyTest {
    @Test
    fun onlyTheAllowListWipes() {
        val wipe = listOf<Throwable>(
            KeyPermanentlyInvalidatedException(),
            UnrecoverableKeyException("x"),
            VaultKeyMissingException(),
            VaultCorruptException(),
            AEADBadTagException("x"),
        )
        for (t in wipe) assertEquals(t.javaClass.simpleName, Outcome.Wipe, classify(t))
    }

    @Test
    fun everythingElseIsUnavailable() {
        val keep = listOf<Throwable>(
            UserNotAuthenticatedException(),
            InvalidKeyException("x"),
            KeyStoreException("x"),
            ProviderException("x"),
            IllegalStateException("x"),
            IOException("x"),
            NoSuchPaddingException("x"),
            InvalidAlgorithmParameterException("x"),
            RuntimeException("x"),
            Exception("x"),
        )
        for (t in keep) assertEquals(t.javaClass.simpleName, Outcome.Unavailable, classify(t))
    }
}
