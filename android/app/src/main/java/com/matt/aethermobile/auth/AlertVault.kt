package com.matt.aethermobile.auth

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.io.File
import java.security.KeyStore
import java.security.ProviderException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Run [op]; if it fails with a non-Error throwable that [classify] marks as Wipe, call
 * [wipe] once and run [op] one more time (its failure propagates). Anything else
 * propagates immediately with no wipe and no retry.
 */
internal fun <T> attemptWithWipeRetry(op: () -> T, wipe: () -> Unit): T {
    try {
        return op()
    } catch (t: Throwable) {
        if (t is Error || classify(t) != Outcome.Wipe) throw t
    }
    wipe()
    return op()
}

/**
 * Stores the alert-only token, encrypted under its own Android Keystore AES-GCM key.
 * Unlike [TokenVault] the key needs no user authentication, so alerts can be
 * delivered while the app is locked. The alert token can only ever receive the
 * three-value alert label, never terminal output.
 *
 * The token is never logged. Any failure is reported as false/null, never thrown
 * (Errors excepted). Keystore behaviour cannot run on the JVM; the file layout is
 * covered by VaultFormatTest.
 */
class AlertVault(context: Context) {
    private val file = File(context.applicationContext.noBackupFilesDir, FILE_NAME)

    fun hasToken(): Boolean = file.isFile

    /** Delete the key and the file. Safe to call at any time; only Errors propagate. */
    fun clear() {
        try {
            val ks = keyStore()
            if (ks.containsAlias(KEY_ALIAS)) ks.deleteEntry(KEY_ALIAS)
        } catch (t: Throwable) {
            if (t is Error) throw t
        }
        file.delete()
        File(file.parentFile, "$FILE_NAME.tmp").delete()
    }

    /** Encrypt and write [token]; false if it could not be saved. Replaces any previous token. */
    fun save(token: String): Boolean {
        val plain = token.toByteArray(Charsets.UTF_8)
        return try {
            attemptWithWipeRetry(
                op = {
                    val cipher = Cipher.getInstance(TRANSFORMATION)
                    cipher.init(Cipher.ENCRYPT_MODE, existingKey() ?: generateKey())
                    val ct = cipher.doFinal(plain)
                    VaultFormat.writeAtomically(file, VaultFormat.encode(cipher.iv, ct))
                },
                wipe = { clear() },
            )
            true
        } catch (t: Throwable) {
            if (t is Error) throw t
            false
        } finally {
            plain.fill(0)
        }
    }

    /** The stored token, or null if absent or unreadable. A corrupt or keyless vault is cleared. */
    fun load(): String? {
        if (!file.isFile) return null
        return try {
            val bytes = file.inputStream().use { VaultFormat.readBounded(it) }
            val parts = VaultFormat.decode(bytes)
            val key = existingKey()
            if (parts == null || key == null) {
                clear()
                return null
            }
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, parts.first))
            val plain = cipher.doFinal(parts.second)
            try {
                String(plain, Charsets.UTF_8)
            } finally {
                plain.fill(0)
            }
        } catch (t: Throwable) {
            if (t is Error) throw t
            if (t is VaultCorruptException || classify(t) == Outcome.Wipe) clear()
            null
        }
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun existingKey(): SecretKey? = keyStore().getKey(KEY_ALIAS, null) as? SecretKey

    private fun generateKey(): SecretKey {
        return try {
            generateKey(strongBox = true)
        } catch (_: StrongBoxUnavailableException) {
            generateKey(strongBox = false)
        } catch (e: ProviderException) {
            if (e.cause is StrongBoxUnavailableException) generateKey(strongBox = false) else throw e
        }
    }

    private fun generateKey(strongBox: Boolean): SecretKey {
        val spec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .setUserAuthenticationRequired(false)
            .setIsStrongBoxBacked(strongBox)
            .build()
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        gen.init(spec)
        return gen.generateKey()
    }

    companion object {
        const val KEY_ALIAS = "aether_alert_key"
        const val FILE_NAME = "alert_vault.bin"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val TAG_BITS = 128
    }
}
