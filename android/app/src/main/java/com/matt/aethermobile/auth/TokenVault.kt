package com.matt.aethermobile.auth

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.ProviderException
import java.security.UnrecoverableKeyException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * On-disk layout of the encrypted token: [version=1][ivLen][iv][ct]. Pure and
 * JVM-testable; knows nothing about keys. Carries no secret beyond the
 * (already encrypted) ciphertext, and nothing here is ever logged.
 */
object VaultFormat {
    const val VERSION: Int = 1
    const val MAX_IV_LEN: Int = 32
    const val MAX_TOTAL_BYTES: Int = 4096

    fun encode(iv: ByteArray, ct: ByteArray): ByteArray {
        require(iv.isNotEmpty() && iv.size <= MAX_IV_LEN) { "bad iv length" }
        require(2 + iv.size + ct.size <= MAX_TOTAL_BYTES) { "vault too large" }
        val out = ByteArray(2 + iv.size + ct.size)
        out[0] = VERSION.toByte()
        out[1] = iv.size.toByte()
        iv.copyInto(out, 2)
        ct.copyInto(out, 2 + iv.size)
        return out
    }

    /** Null for any short, oversize, wrong-version or inconsistent input. */
    fun decode(bytes: ByteArray): Pair<ByteArray, ByteArray>? {
        if (bytes.size < 2 || bytes.size > MAX_TOTAL_BYTES) return null
        if (bytes[0].toInt() != VERSION) return null
        val ivLen = bytes[1].toInt() and 0xFF
        if (ivLen == 0 || ivLen > MAX_IV_LEN) return null
        if (2 + ivLen > bytes.size) return null
        val iv = bytes.copyOfRange(2, 2 + ivLen)
        val ct = bytes.copyOfRange(2 + ivLen, bytes.size)
        return iv to ct
    }
}

/** Result of [TokenVault.beginUnlock]. */
sealed class UnlockStart {
    /** Authenticate with this cipher in a CryptoObject, then call completeUnlock. */
    class Ready(val cipher: Cipher) : UnlockStart()

    /** Nothing stored. */
    object Empty : UnlockStart()

    /**
     * The key was invalidated (new biometric enrollment), is unrecoverable, or
     * the file is corrupt. The vault has already been wiped; show the Pair screen.
     */
    object Invalidated : UnlockStart()
}

/**
 * Stores the control token encrypted under an Android Keystore AES-GCM key that
 * requires a fresh BIOMETRIC_STRONG authentication for every use (encrypt and
 * decrypt) and is invalidated by new biometric enrollment.
 *
 * The token is never written in plaintext, never logged, and the file lives in
 * app-private storage, which manifest backup rules exclude. Keystore behaviour
 * cannot run on the JVM; it is verified on-device at T15.
 */
class TokenVault(context: Context) {
    private val file = File(context.applicationContext.filesDir, FILE_NAME)

    fun hasToken(): Boolean = file.isFile

    /** Delete the key and the file. Safe to call at any time. */
    fun clear() {
        try {
            val ks = keyStore()
            if (ks.containsAlias(KEY_ALIAS)) ks.deleteEntry(KEY_ALIAS)
        } catch (_: GeneralSecurityException) {
            // Nothing more to delete; the file removal below is the part that matters.
        } catch (_: IOException) {
        }
        file.delete()
        File(file.parentFile, "$FILE_NAME.tmp").delete()
    }

    /**
     * Cipher for ENCRYPT, to be wrapped in a CryptoObject and authenticated.
     * A stale (invalidated) key is replaced; saving always starts a fresh vault.
     */
    fun beginSave(): Cipher {
        try {
            return initEncrypt(getOrCreateKey())
        } catch (_: KeyPermanentlyInvalidatedException) {
            clear()
        } catch (_: UnrecoverableKeyException) {
            clear()
        }
        return initEncrypt(getOrCreateKey())
    }

    /** Encrypt [token] with the authenticated [cipher] and write it atomically. */
    fun completeSave(cipher: Cipher, token: String) {
        val plain = token.toByteArray(Charsets.UTF_8)
        try {
            val ct = cipher.doFinal(plain)
            writeAtomically(VaultFormat.encode(cipher.iv, ct))
        } finally {
            plain.fill(0)
        }
    }

    fun beginUnlock(): UnlockStart {
        if (!file.isFile) return UnlockStart.Empty
        val parts = try {
            VaultFormat.decode(file.readBytes())
        } catch (_: IOException) {
            null
        }
        if (parts == null) {
            clear()
            return UnlockStart.Invalidated
        }
        return try {
            val key = existingKey()
            if (key == null) {
                clear()
                UnlockStart.Invalidated
            } else {
                val cipher = Cipher.getInstance(TRANSFORMATION)
                cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, parts.first))
                UnlockStart.Ready(cipher)
            }
        } catch (_: KeyPermanentlyInvalidatedException) {
            clear()
            UnlockStart.Invalidated
        } catch (_: UnrecoverableKeyException) {
            clear()
            UnlockStart.Invalidated
        }
    }

    /** Decrypt with the authenticated [cipher]. Null (and a wipe) if the file is corrupt or tampered. */
    fun completeUnlock(cipher: Cipher): String? {
        val parts = try {
            VaultFormat.decode(file.readBytes())
        } catch (_: IOException) {
            null
        }
        if (parts == null) {
            clear()
            return null
        }
        return try {
            val plain = cipher.doFinal(parts.second)
            try {
                String(plain, Charsets.UTF_8)
            } finally {
                plain.fill(0)
            }
        } catch (_: GeneralSecurityException) {
            clear()
            null
        }
    }

    private fun initEncrypt(key: SecretKey): Cipher {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key)
        return cipher
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun existingKey(): SecretKey? = keyStore().getKey(KEY_ALIAS, null) as? SecretKey

    private fun getOrCreateKey(): SecretKey = existingKey() ?: generateKey()

    private fun generateKey(): SecretKey {
        return try {
            generateKey(strongBox = true)
        } catch (_: StrongBoxUnavailableException) {
            generateKey(strongBox = false)
        } catch (e: ProviderException) {
            // Some devices wrap the StrongBox failure; retry on the TEE only for that case.
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
            .setUserAuthenticationRequired(true)
            // Timeout 0 = authentication is required for every single cryptographic use.
            .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
            .setInvalidatedByBiometricEnrollment(true)
            .setIsStrongBoxBacked(strongBox)
            .build()
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        gen.init(spec)
        return gen.generateKey()
    }

    private fun writeAtomically(bytes: ByteArray) {
        val tmp = File(file.parentFile, "$FILE_NAME.tmp")
        tmp.writeBytes(bytes)
        Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    }

    companion object {
        const val KEY_ALIAS = "aether_token_key"
        const val FILE_NAME = "vault.bin"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val TAG_BITS = 128
    }
}
