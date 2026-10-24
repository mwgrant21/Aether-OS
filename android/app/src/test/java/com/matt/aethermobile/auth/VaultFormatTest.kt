package com.matt.aethermobile.auth

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import java.util.Random

class VaultFormatTest {
    private val iv = ByteArray(12) { (it + 1).toByte() }
    private val ct = ByteArray(40) { (it * 3).toByte() }

    @Test
    fun roundTrip() {
        val (i, c) = VaultFormat.decode(VaultFormat.encode(iv, ct))!!
        assertArrayEquals(iv, i)
        assertArrayEquals(ct, c)
    }

    @Test
    fun layoutIsVersionIvLenIvCt() {
        val b = VaultFormat.encode(iv, ct)
        assertEquals(1, b[0].toInt())
        assertEquals(12, b[1].toInt())
        assertEquals(2 + 12 + 40, b.size)
    }

    @Test
    fun emptyCiphertextRoundTrips() {
        val (i, c) = VaultFormat.decode(VaultFormat.encode(iv, ByteArray(0)))!!
        assertArrayEquals(iv, i)
        assertEquals(0, c.size)
    }

    @Test
    fun truncatedIsNull() {
        assertNull(VaultFormat.decode(ByteArray(0)))
        assertNull(VaultFormat.decode(byteArrayOf(1)))
        val b = VaultFormat.encode(iv, ct)
        assertNull(VaultFormat.decode(b.copyOf(2 + 11))) // cuts into the iv
    }

    @Test
    fun wrongVersionIsNull() {
        val b = VaultFormat.encode(iv, ct)
        b[0] = 2
        assertNull(VaultFormat.decode(b))
        b[0] = 0
        assertNull(VaultFormat.decode(b))
    }

    @Test
    fun ivLenLargerThanBufferIsNull() {
        val b = VaultFormat.encode(iv, ct)
        b[1] = 32 // still within the cap, but 2 + 32 <= size here, so shrink the buffer instead
        assertNull(VaultFormat.decode(b.copyOf(2 + 31)))
        assertNull(VaultFormat.decode(byteArrayOf(1, 12, 1, 2, 3)))
    }

    @Test
    fun zeroOrOversizeIvLenIsNull() {
        val b = VaultFormat.encode(iv, ct)
        b[1] = 0
        assertNull(VaultFormat.decode(b))
        b[1] = 33
        assertNull(VaultFormat.decode(b))
        b[1] = 0xFF.toByte()
        assertNull(VaultFormat.decode(b))
    }

    @Test
    fun nonTwelveByteIvIsNull() {
        for (n in intArrayOf(1, 5, 13, 32)) {
            val b = ByteArray(2 + n + 20)
            b[0] = 1
            b[1] = n.toByte()
            assertNull("ivLen $n", VaultFormat.decode(b))
        }
    }

    @Test
    fun sizeCapEnforcedOnBothSides() {
        val atCap = ByteArray(VaultFormat.MAX_TOTAL_BYTES - 2 - iv.size)
        assertNotNull(VaultFormat.decode(VaultFormat.encode(iv, atCap)))
        assertThrows(IllegalArgumentException::class.java) { VaultFormat.encode(iv, ByteArray(atCap.size + 1)) }
        val over = ByteArray(VaultFormat.MAX_TOTAL_BYTES + 1)
        over[0] = 1
        over[1] = 12
        assertNull(VaultFormat.decode(over))
    }

    @Test
    fun encodeRejectsBadIv() {
        assertThrows(IllegalArgumentException::class.java) { VaultFormat.encode(ByteArray(0), ct) }
        assertThrows(IllegalArgumentException::class.java) { VaultFormat.encode(ByteArray(33), ct) }
    }

    @Test
    fun garbageNeverThrows() {
        val rnd = Random(42)
        repeat(500) {
            val b = ByteArray(rnd.nextInt(80))
            rnd.nextBytes(b)
            VaultFormat.decode(b) // must return a value or null, never throw
        }
    }

    // BiometricFailure / Availability tables (no owned file of their own in T12).

    @Test
    fun biometricFailureTable() {
        val table = mapOf(
            BiometricPrompt.ERROR_USER_CANCELED to BiometricFailure.UserCancelled,
            BiometricPrompt.ERROR_NEGATIVE_BUTTON to BiometricFailure.UserCancelled,
            BiometricPrompt.ERROR_CANCELED to BiometricFailure.UserCancelled,
            BiometricPrompt.ERROR_LOCKOUT to BiometricFailure.Lockout,
            BiometricPrompt.ERROR_LOCKOUT_PERMANENT to BiometricFailure.LockoutPermanent,
            BiometricPrompt.ERROR_HW_NOT_PRESENT to BiometricFailure.NoHardware,
            BiometricPrompt.ERROR_NO_BIOMETRICS to BiometricFailure.NoneEnrolled,
            BiometricPrompt.ERROR_TIMEOUT to BiometricFailure.Other,
            BiometricPrompt.ERROR_HW_UNAVAILABLE to BiometricFailure.Other,
            BiometricPrompt.ERROR_NO_SPACE to BiometricFailure.Other,
            9999 to BiometricFailure.Other,
            -1 to BiometricFailure.Other,
        )
        for ((code, want) in table) assertEquals("code $code", want, BiometricFailure.fromCode(code))
    }

    @Test
    fun readBoundedDistinguishesEmptyOversizeAndUnreadable() {
        // exists-and-empty: bytes come back empty and decode rejects them (corrupt, may wipe)
        val empty = VaultFormat.readBounded(java.io.ByteArrayInputStream(ByteArray(0)))
        assertEquals(0, empty.size)
        assertNull(VaultFormat.decode(empty))
        // oversize is structurally bad
        assertThrows(VaultCorruptException::class.java) {
            VaultFormat.readBounded(java.io.ByteArrayInputStream(ByteArray(VaultFormat.MAX_TOTAL_BYTES + 1)))
        }
        // a read failure is an IOException, which classify leaves alone
        val failing = object : java.io.InputStream() {
            override fun read(): Int = throw java.io.IOException("stat/read failed")
        }
        val e = assertThrows(java.io.IOException::class.java) { VaultFormat.readBounded(failing) }
        assertEquals(Outcome.Unavailable, classify(e))
    }

    @Test
    fun failedWriteRemovesTheTmpFile() {
        val dir = java.nio.file.Files.createTempDirectory("vault").toFile()
        try {
            val target = java.io.File(dir, "vault.bin")
            target.mkdir() // a non-empty directory target makes the final move fail
            java.io.File(target, "x").writeText("x")
            assertThrows(Exception::class.java) { VaultFormat.writeAtomically(target, byteArrayOf(1, 2, 3)) }
            assertEquals(false, java.io.File(dir, "vault.bin.tmp").exists())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun availabilityTable() {
        assertEquals(Availability.Available, Availability.fromCode(BiometricManager.BIOMETRIC_SUCCESS))
        assertEquals(Availability.NoHardware, Availability.fromCode(BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE))
        assertEquals(Availability.HardwareUnavailable, Availability.fromCode(BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE))
        assertEquals(Availability.NoneEnrolled, Availability.fromCode(BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED))
        assertEquals(Availability.Unsupported, Availability.fromCode(BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED))
        assertEquals(Availability.Unsupported, Availability.fromCode(12345))
    }
}
