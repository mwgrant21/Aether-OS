package com.matt.aethermobile

/**
 * The V1 unlock flow as a pure state machine (no android.*, JVM-tested). Events
 * never carry the token or the pairing code: the activity holds those, and the
 * machine only says WHEN they must be kept ([AppFlow.holdsToken]) or dropped
 * ([Effect.DropToken], [Effect.DiscardSaveToken]).
 * Events that do not apply to the current state are ignored (same state, no effects).
 */

/** Why the user is looking at a message on Pair or Locked. Mapped to strings by the activity. */
enum class Notice {
    BadCode, Declined, Burned, Unreachable, ServerError, ScanFailed, WrongQr,
    SaveCancelled, SaveFailed, Revoked, KeyInvalidated,
    TryAgain, Cancelled, Lockout, BiometricUnavailable,
}

/** Terminal connection outcomes shown on the Error screen. */
enum class ErrorKind {
    Unreachable, ConnectionRefused, NotListening, Busy, ProofMismatch, Protocol,
    Superseded, Disabled, Closed,
}

enum class PairKind { Paired, BadCode, Declined, Burned, Unreachable, Other }

enum class UnlockKind { Ready, Empty, Invalidated, Unavailable }

enum class AuthFail { Cancelled, Lockout, Unavailable, Other }

sealed class FlowState {
    /** No BuildConfig.TITAN_IP: shows one line and offers no action. */
    object NotConfigured : FlowState()
    data class NeedsPair(val notice: Notice? = null) : FlowState()
    /** Waiting for the PC-side confirm. */
    object Pairing : FlowState()
    /** Paired; the fingerprint to save the token is up. */
    object SavePrompt : FlowState()
    data class Locked(val notice: Notice? = null) : FlowState()
    object Connecting : FlowState()
    data class Connected(val daysLeft: Int) : FlowState() {
        val warn: Boolean get() = daysLeft <= WARN_DAYS
    }
    data class Error(val kind: ErrorKind) : FlowState()

    companion object {
        const val WARN_DAYS = 7
    }
}

sealed class FlowEvent {
    data class Start(val configured: Boolean, val hasToken: Boolean) : FlowEvent()
    object PairSubmitted : FlowEvent()
    /** A scan or typed code was refused before any network call. */
    data class InputRejected(val notice: Notice) : FlowEvent()
    data class PairResult(val kind: PairKind) : FlowEvent()
    object SaveDone : FlowEvent()
    object SaveCancelled : FlowEvent()
    /** beginSave null, completeSave false, or the prompt could not be shown. */
    object SaveFailed : FlowEvent()
    object UnlockRequested : FlowEvent()
    data class UnlockStartResult(val kind: UnlockKind) : FlowEvent()
    data class UnlockAuthFailed(val reason: AuthFail) : FlowEvent()
    object UnlockDone : FlowEvent()
    /** completeUnlock returned null; [vaultWiped] = !vault.hasToken() afterwards. */
    data class UnlockDecryptFailed(val vaultWiped: Boolean) : FlowEvent()
    data class ClientConnected(val expiresAtMs: Long, val serverTimeMs: Long) : FlowEvent()
    object ClientRevoked : FlowEvent()
    data class ClientFailed(val kind: ErrorKind) : FlowEvent()
    object RelockDue : FlowEvent()
    object LockNow : FlowEvent()
    data class Retry(val hasToken: Boolean) : FlowEvent()
}

/** Work the activity must do, executed in list order. */
enum class Effect {
    BeginSave, BeginUnlock, Connect, CloseSocket,

    /** Null the in-memory token (the relock-window copy). */
    DropToken,

    /** Null the token and cipher held for a save attempt. */
    DiscardSaveToken,
    ClearVault,
}

data class Transition(val state: FlowState, val effects: List<Effect> = emptyList())

object AppFlow {
    private const val DAY_MS = 86_400_000L

    /** True only in states where the activity legitimately holds a token String. */
    fun holdsToken(state: FlowState): Boolean =
        state == FlowState.SavePrompt || state == FlowState.Connecting || state is FlowState.Connected

    fun daysLeft(expiresAtMs: Long, nowMs: Long): Int {
        val left = expiresAtMs - nowMs
        if (left <= 0) return 0
        return ((left + DAY_MS - 1) / DAY_MS).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
    }

    fun reduce(s: FlowState, e: FlowEvent): Transition {
        if (s == FlowState.NotConfigured) {
            return if (e is FlowEvent.Start) start(e) else Transition(s)
        }
        return when (e) {
            is FlowEvent.Start -> start(e)
            FlowEvent.PairSubmitted ->
                if (s is FlowState.NeedsPair) Transition(FlowState.Pairing) else Transition(s)
            is FlowEvent.InputRejected ->
                if (s is FlowState.NeedsPair) Transition(FlowState.NeedsPair(e.notice)) else Transition(s)
            is FlowEvent.PairResult -> pairResult(s, e.kind)
            FlowEvent.SaveDone ->
                if (s == FlowState.SavePrompt) Transition(FlowState.Connecting, listOf(Effect.Connect)) else Transition(s)
            FlowEvent.SaveCancelled -> saveEnded(s, Notice.SaveCancelled)
            FlowEvent.SaveFailed -> saveEnded(s, Notice.SaveFailed)
            FlowEvent.UnlockRequested ->
                if (s is FlowState.Locked) Transition(FlowState.Locked(), listOf(Effect.BeginUnlock)) else Transition(s)
            is FlowEvent.UnlockStartResult -> unlockStart(s, e.kind)
            is FlowEvent.UnlockAuthFailed ->
                if (s is FlowState.Locked) Transition(FlowState.Locked(authNotice(e.reason))) else Transition(s)
            FlowEvent.UnlockDone ->
                if (s is FlowState.Locked) Transition(FlowState.Connecting, listOf(Effect.Connect)) else Transition(s)
            is FlowEvent.UnlockDecryptFailed ->
                if (s !is FlowState.Locked) Transition(s)
                else if (e.vaultWiped) Transition(FlowState.NeedsPair(Notice.KeyInvalidated), listOf(Effect.ClearVault))
                else Transition(FlowState.Locked(Notice.TryAgain))
            is FlowEvent.ClientConnected ->
                if (s == FlowState.Connecting) {
                    Transition(FlowState.Connected(daysLeft(e.expiresAtMs, e.serverTimeMs)))
                } else Transition(s)
            FlowEvent.ClientRevoked ->
                if (live(s)) {
                    Transition(
                        FlowState.NeedsPair(Notice.Revoked),
                        listOf(Effect.CloseSocket, Effect.DropToken, Effect.ClearVault),
                    )
                } else Transition(s)
            is FlowEvent.ClientFailed ->
                if (live(s)) Transition(FlowState.Error(e.kind), listOf(Effect.CloseSocket, Effect.DropToken))
                else Transition(s)
            FlowEvent.RelockDue ->
                if (live(s)) {
                    Transition(FlowState.Locked(), listOf(Effect.CloseSocket, Effect.DropToken, Effect.BeginUnlock))
                } else Transition(s)
            FlowEvent.LockNow ->
                if (live(s)) Transition(FlowState.Locked(), listOf(Effect.CloseSocket, Effect.DropToken))
                else Transition(s)
            is FlowEvent.Retry ->
                if (s !is FlowState.Error) Transition(s)
                else if (e.hasToken) Transition(FlowState.Locked(), listOf(Effect.BeginUnlock))
                else Transition(FlowState.NeedsPair())
        }
    }

    private fun live(s: FlowState) = s == FlowState.Connecting || s is FlowState.Connected

    private fun start(e: FlowEvent.Start): Transition = when {
        !e.configured -> Transition(FlowState.NotConfigured)
        e.hasToken -> Transition(FlowState.Locked(), listOf(Effect.BeginUnlock))
        else -> Transition(FlowState.NeedsPair())
    }

    private fun pairResult(s: FlowState, kind: PairKind): Transition {
        if (s != FlowState.Pairing) return Transition(s)
        val notice = when (kind) {
            PairKind.Paired -> return Transition(FlowState.SavePrompt, listOf(Effect.BeginSave))
            PairKind.BadCode -> Notice.BadCode
            PairKind.Declined -> Notice.Declined
            PairKind.Burned -> Notice.Burned
            PairKind.Unreachable -> Notice.Unreachable
            PairKind.Other -> Notice.ServerError
        }
        return Transition(FlowState.NeedsPair(notice))
    }

    /** A save that did not complete never keeps the token: it is discarded and the user re-pairs. */
    private fun saveEnded(s: FlowState, notice: Notice): Transition =
        if (s == FlowState.SavePrompt) Transition(FlowState.NeedsPair(notice), listOf(Effect.DiscardSaveToken))
        else Transition(s)

    private fun unlockStart(s: FlowState, kind: UnlockKind): Transition {
        if (s !is FlowState.Locked) return Transition(s)
        return when (kind) {
            UnlockKind.Ready -> Transition(FlowState.Locked())
            UnlockKind.Empty -> Transition(FlowState.NeedsPair())
            UnlockKind.Invalidated ->
                Transition(FlowState.NeedsPair(Notice.KeyInvalidated), listOf(Effect.ClearVault))
            UnlockKind.Unavailable -> Transition(FlowState.Locked(Notice.TryAgain))
        }
    }

    private fun authNotice(r: AuthFail) = when (r) {
        AuthFail.Cancelled -> Notice.Cancelled
        AuthFail.Lockout -> Notice.Lockout
        AuthFail.Unavailable -> Notice.BiometricUnavailable
        AuthFail.Other -> Notice.TryAgain
    }
}
