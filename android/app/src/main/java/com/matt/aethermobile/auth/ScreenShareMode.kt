package com.matt.aethermobile.auth

/** Why enabling screen share mode did not turn it on; mapped to a user message by the UI. */
enum class ShareMessage { NoHardware, NoneEnrolled, SensorUnavailable, Lockout, Failed }

/** What the UI shows: the switch position and an optional message under it. */
data class ShareUi(val on: Boolean = false, val message: ShareMessage? = null)

/** What the caller must do after asking to enable share mode. */
sealed interface ShareStart {
    data object ShowPrompt : ShareStart
    data object AlreadyOn : ShareStart
    data class Refused(val message: ShareMessage) : ShareStart
}

/**
 * Owns "is screen share mode on" and the biometric-gate decisions around turning it on.
 * Pure: no Android classes. Turning ON requires a successful biometric ([onAuthenticated]);
 * no failure or refusal path can set it on. Turning OFF never needs a prompt.
 */
class ScreenShareState {
    @Volatile private var isOn = false
    @Volatile private var message: ShareMessage? = null

    val on: Boolean get() = isOn

    /** True when the activity must hold FLAG_SECURE. */
    val secureWanted: Boolean get() = !isOn

    @Synchronized
    fun requestEnable(availability: Availability): ShareStart {
        if (isOn) return ShareStart.AlreadyOn
        message = null
        val refusal = when (availability) {
            Availability.Available -> null
            Availability.NoHardware -> ShareMessage.NoHardware
            Availability.NoneEnrolled -> ShareMessage.NoneEnrolled
            Availability.HardwareUnavailable -> ShareMessage.SensorUnavailable
            Availability.Unsupported -> ShareMessage.Failed
        }
        if (refusal == null) return ShareStart.ShowPrompt
        message = refusal
        return ShareStart.Refused(refusal)
    }

    @Synchronized
    fun onAuthenticated() {
        isOn = true
        message = null
    }

    @Synchronized
    fun onAuthFailed(reason: BiometricFailure) {
        message = when (reason) {
            BiometricFailure.UserCancelled -> null
            BiometricFailure.Lockout, BiometricFailure.LockoutPermanent -> ShareMessage.Lockout
            BiometricFailure.NoHardware -> ShareMessage.NoHardware
            BiometricFailure.NoneEnrolled -> ShareMessage.NoneEnrolled
            BiometricFailure.Other -> ShareMessage.Failed
        }
    }

    /** The prompt refused to start. */
    @Synchronized
    fun onPromptNotShown() {
        message = ShareMessage.Failed
    }

    @Synchronized
    fun disable() {
        isOn = false
        message = null
    }

    /** A fresh launch (no saved instance state) always starts OFF; a recreation keeps the state. */
    @Synchronized
    fun onActivityCreate(freshLaunch: Boolean) {
        if (freshLaunch) disable()
    }

    @Synchronized
    fun ui(): ShareUi = ShareUi(isOn, message)
}

/**
 * Process-scoped share mode state. Survives activity recreation, dies with the process, and is
 * never persisted (Decision D1): a cold start always comes up OFF and needs a new biometric.
 */
object ScreenShare {
    val state = ScreenShareState()
}
