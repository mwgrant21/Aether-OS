package com.matt.aethermobile.auth

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.KeyStore
import java.security.ProviderException
import java.security.UnrecoverableKeyException
import javax.crypto.AEADBadTagException
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
    const val IV_LEN: Int = 12
    const val MAX_TOTAL_BYTES: Int = 4096

    fun encode(iv: ByteArray, ct: ByteArray): ByteArray {
        require(iv.size == IV_LEN) { "bad iv length" }
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
        if (ivLen != IV_LEN) return null
        if (2 + ivLen > bytes.size) return null
        val iv = bytes.copyOfRange(2, 2 + ivLen)
        val ct = bytes.copyOfRange(2 + ivLen, bytes.size)
        return iv to ct
    }
}

/** What to do with the stored vault after a failure. */
enum class Outcome {
    /** Destroy the key and the file: the stored secret can never be read again. */
    Wipe,

    /** Transient or unknown: keep everything, the caller may simply try again. */
    Unavailable,
}

/** The vault file exists but is structurally bad (oversize or fails [VaultFormat.decode]). */
class VaultCorruptException : Exception("vault file is corrupt")

/** The vault file exists but its Keystore key does not. */
class VaultKeyMissingException : Exception("vault key is missing")

/**
 * The single wipe/no-wipe decision. ALLOW-LIST: only the triggers below wipe; every
 * other Throwable (UserNotAuthenticatedException, generic InvalidKeyException,
 * KeyStoreException, ProviderException, IllegalStateException, IOException, ...) is
 * Unavailable. Pure, so the table test covers the real paths.
 */
fun classify(t: Throwable): Outcome = when (t) {
    is KeyPermanentlyInvalidatedException -> Outcome.Wipe // new enrollment
    is UnrecoverableKeyException -> Outcome.Wipe // key gone or unusable
    is VaultKeyMissingException -> Outcome.Wipe // alias missing while vault.bin exists
    is VaultCorruptException -> Outcome.Wipe // decode returned null, or oversize file
    is AEADBadTagException -> Outcome.Wipe // tampered or corrupt ciphertext
    else -> Outcome.Unavailable
}

/** Result of [TokenVault.beginUnlock]. */
sealed class UnlockStart {
    /** Authenticate with this cipher in a CryptoObject, then call completeUnlock. */
    class Ready(val cipher: Cipher) : UnlockStart()

    /** Nothing stored. */
    object Empty : UnlockStart()

    /** The vault was wiped (key invalidated, key missing, or file corrupt); show the Pair screen. */
    object Invalidated : UnlockStart()

    /** Could not start now for a non-fatal reason; nothing was wiped. Show "Couldn't unlock, try again". */
    object Unavailable : UnlockStart()
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

    /** Delete the key and the file. Safe to call at any time; only Errors propagate. */
    fun clear() {
        try {
            val ks = keyStore()
            if (ks.containsAlias(KEY_ALIAS)) ks.deleteEntry(KEY_ALIAS)
        } catch (t: Throwable) {
            rethrowIfError(t) // otherwise the file removal below is the part that matters
        }
        file.delete()
        File(file.parentFile, "$FILE_NAME.tmp").delete()
    }

    /**
     * Cipher for ENCRYPT, to be wrapped in a CryptoObject and authenticated, or null
     * if the key could not be prepared right now (nothing is wiped for that). A stale
     * key (classify == Wipe) is replaced once: saving always starts a fresh vault.
     */
    fun beginSave(): Cipher? {
        try {
            return initEncrypt(getOrCreateKey())
        } catch (t: Throwable) {
            if (decide(t) != Outcome.Wipe) return null
        }
        clear()
        return try {
            initEncrypt(getOrCreateKey())
        } catch (t: Throwable) {
            decide(t)
            null
        }
    }

    /**
     * Encrypt [token] with the authenticated [cipher] and write it atomically.
     * False if it could not be saved; an existing vault is never wiped for that.
     */
    fun completeSave(cipher: Cipher, token: String): Boolean {
        val plain = token.toByteArray(Charsets.UTF_8)
        return try {
            val ct = cipher.doFinal(plain)
            writeAtomically(VaultFormat.encode(cipher.iv, ct))
            true
        } catch (t: Throwable) {
            decide(t)
            false
        } finally {
            plain.fill(0)
        }
    }

    fun beginUnlock(): UnlockStart {
        if (!file.isFile) return UnlockStart.Empty
        try {
            val parts = readParts()
            val key = existingKey() ?: throw VaultKeyMissingException()
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, parts.first))
            return UnlockStart.Ready(cipher)
        } catch (t: Throwable) {
            return when (decide(t)) {
                Outcome.Wipe -> {
                    clear()
                    UnlockStart.Invalidated
                }
                Outcome.Unavailable -> UnlockStart.Unavailable
            }
        }
    }

    /**
     * Decrypt with the authenticated [cipher]. Null on any failure; the vault is wiped
     * only when [classify] says Wipe (corrupt file or tampered ciphertext), so the
     * caller can tell the two apart with [hasToken].
     */
    fun completeUnlock(cipher: Cipher): String? {
        try {
            val parts = readParts()
            val plain = cipher.doFinal(parts.second)
            try {
                return String(plain, Charsets.UTF_8)
            } finally {
                plain.fill(0)
            }
        } catch (t: Throwable) {
            if (decide(t) == Outcome.Wipe) clear()
            return null
        }
    }

    /** Size-capped read plus decode. Throws [VaultCorruptException] if structurally bad. */
    private fun readParts(): Pair<ByteArray, ByteArray> {
        if (file.length() > VaultFormat.MAX_TOTAL_BYTES) throw VaultCorruptException()
        return VaultFormat.decode(file.readBytes()) ?: throw VaultCorruptException()
    }

    /** Errors (OOM etc.) are never swallowed; everything else goes through [classify]. */
    private fun decide(t: Throwable): Outcome {
        rethrowIfError(t)
        return classify(t)
    }

    private fun rethrowIfError(t: Throwable) {
        if (t is Error) throw t
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
            .setRandomizedEncryptionRequired(true)
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
        FileOutputStream(tmp).use { out ->
            out.write(bytes)
            out.fd.sync()
        }
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
