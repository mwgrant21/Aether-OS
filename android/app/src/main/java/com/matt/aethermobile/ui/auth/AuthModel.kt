package com.matt.aethermobile.ui.auth

import com.matt.aethermobile.ErrorKind
import com.matt.aethermobile.FlowState
import com.matt.aethermobile.Notice
import com.matt.aethermobile.auth.Pairing
import com.matt.aethermobile.protocol.ControlProtocol

/** Which auth/connection screen a [FlowState] shows. Pure: no android.* or Compose. */
sealed interface AuthScreen {
    object NotConfigured : AuthScreen
    data class Pair(val notice: Notice?) : AuthScreen
    object Pairing : AuthScreen
    object Saving : AuthScreen
    object Connecting : AuthScreen
    data class Locked(val notice: Notice?) : AuthScreen
    data class Error(val kind: ErrorKind) : AuthScreen
}

/** Null for Connected: the shell owns that state. SavePrompt and SaveDeferred are one screen. */
fun authScreenFor(s: FlowState): AuthScreen? = when (s) {
    FlowState.NotConfigured -> AuthScreen.NotConfigured
    is FlowState.NeedsPair -> AuthScreen.Pair(s.notice)
    FlowState.Pairing -> AuthScreen.Pairing
    FlowState.SavePrompt, FlowState.SaveDeferred -> AuthScreen.Saving
    is FlowState.Locked -> AuthScreen.Locked(s.notice)
    FlowState.Connecting -> AuthScreen.Connecting
    is FlowState.Connected -> null
    is FlowState.Error -> AuthScreen.Error(s.kind)
}

object CodeInput {
    /** Typed text -> uppercase code characters only, at most CODE_LENGTH, shown as XXXX-XXXX. */
    fun filter(raw: String): String {
        val chars = raw.uppercase()
            .filter { ControlProtocol.CODE_ALPHABET.indexOf(it) >= 0 }
            .take(ControlProtocol.CODE_LENGTH)
        return if (chars.length > 4) chars.substring(0, 4) + "-" + chars.substring(4) else chars
    }

    /** Same validity rule as the QR path; not reimplemented here. */
    fun isSubmittable(text: String): Boolean = Pairing.parseManualCode(text) != null
}

/** Cosmetic pairing countdown label, m:ss. */
fun countdownText(remainingSec: Int): String {
    val s = remainingSec.coerceAtLeast(0)
    return "${s / 60}:${(s % 60).toString().padStart(2, '0')}"
}
