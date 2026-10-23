package com.matt.aethermobile.auth

import android.content.Context
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import javax.crypto.Cipher

/** Why a biometric prompt ended without success. Pure mapping, JVM-tested. */
enum class BiometricFailure {
    UserCancelled,
    Lockout,
    LockoutPermanent,
    NoHardware,
    NoneEnrolled,
    Other;

    companion object {
        fun fromCode(code: Int): BiometricFailure = when (code) {
            BiometricPrompt.ERROR_USER_CANCELED,
            BiometricPrompt.ERROR_NEGATIVE_BUTTON,
            BiometricPrompt.ERROR_CANCELED -> UserCancelled
            BiometricPrompt.ERROR_LOCKOUT -> Lockout
            BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> LockoutPermanent
            BiometricPrompt.ERROR_HW_NOT_PRESENT -> NoHardware
            BiometricPrompt.ERROR_NO_BIOMETRICS -> NoneEnrolled
            else -> Other
        }
    }
}

/** Whether a BIOMETRIC_STRONG prompt can be shown right now. */
enum class Availability {
    Available,
    NoHardware,
    HardwareUnavailable,
    NoneEnrolled,
    Unsupported;

    companion object {
        fun fromCode(code: Int): Availability = when (code) {
            BiometricManager.BIOMETRIC_SUCCESS -> Available
            BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> NoHardware
            BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> HardwareUnavailable
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> NoneEnrolled
            else -> Unsupported
        }
    }
}

interface BiometricCallback {
    /** Authenticated; [cipher] is now usable for exactly one operation. */
    fun onSuccess(cipher: Cipher)

    /** Terminal failure (the prompt is gone). A single non-matching finger is NOT reported here. */
    fun onFailure(reason: BiometricFailure)
}

/**
 * BIOMETRIC_STRONG availability check. The prompt itself lives in MainActivity (one reusable
 * instance); device credential / PIN is deliberately not allowed, which is why its negative
 * button is mandatory. Behaviour on a real device is verified at T15, not on the JVM.
 */
object BiometricGate {
    fun canAuthenticate(context: Context): Availability =
        Availability.fromCode(
            BiometricManager.from(context).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG),
        )
}
