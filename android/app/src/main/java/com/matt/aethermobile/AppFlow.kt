package com.matt.aethermobile

import com.matt.aethermobile.auth.RelockPolicy

/*
 * The V1 unlock flow, pure and JVM-tested (no android.*), in two layers:
 *  - AppFlow is the reducer. Events never carry the token or the pairing code (the activity
 *    holds those); it only says WHEN they must be kept (AppFlow.holdsToken) or dropped
 *    (Effect.DropToken, Effect.DiscardSaveToken). Events that do not apply to the current
 *    state are ignored (same state, no effects).
 *  - FlowController owns the lifecycle facts (started, resumed), relock bookkeeping and the
 *    two 60 s expiries, and decides when a prompt may be shown. The activity only forwards
 *    callbacks to it and runs the effects it returns.
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
    /** Paired while the app was not RESUMED (the PC confirm takes a while); the prompt waits for the next resume or the 60 s expiry. */
    object SaveDeferred : FlowState()
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
    /** Pairing succeeded but the activity is not RESUMED, so no prompt can be shown yet. */
    object PairedWhileHidden : FlowEvent()
    /** The activity resumed; [ageMs] is how long the save has been waiting. */
    data class DeferredResumed(val ageMs: Long) : FlowEvent()
    /** The deferred save sat for [AppFlow.DEFERRED_SAVE_MAX_MS] without a resume. */
    object DeferredExpired : FlowEvent()
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
    /** The socket died while stopped inside the relock window; reconnect with the held token, no prompt. */
    object Reconnect : FlowEvent()
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

    /** Cancel any biometric prompt that is up (the activity is stopping). */
    CancelPrompt,

    /** Arm / disarm the 60 s background relock timer; its expiry calls [FlowController.onRelockTimer]. */
    StartRelockTimer, CancelRelockTimer,

    /** Arm / disarm the 60 s SaveDeferred timer; its expiry calls [FlowController.onDeferredTimer]. */
    StartDeferredTimer, CancelDeferredTimer,
}

data class Transition(val state: FlowState, val effects: List<Effect> = emptyList())

object AppFlow {
    private const val DAY_MS = 86_400_000L

    /** A deferred save older than this is discarded (the relock window). */
    const val DEFERRED_SAVE_MAX_MS = 60_000L

    /** Backgrounded with a live session for this long: relock. */
    const val RELOCK_AFTER_MS = 60_000L

    /** True only in states where the activity legitimately holds a token String. */
    fun holdsToken(state: FlowState): Boolean =
        state == FlowState.SavePrompt || state == FlowState.SaveDeferred || state == FlowState.Connecting || state is FlowState.Connected

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
            FlowEvent.PairedWhileHidden ->
                if (s == FlowState.Pairing) Transition(FlowState.SaveDeferred) else Transition(s)
            is FlowEvent.DeferredResumed ->
                if (s != FlowState.SaveDeferred) Transition(s)
                else if (e.ageMs in 0 until DEFERRED_SAVE_MAX_MS) Transition(FlowState.SavePrompt, listOf(Effect.BeginSave))
                else saveEnded(FlowState.SavePrompt, Notice.SaveCancelled)
            FlowEvent.DeferredExpired ->
                if (s == FlowState.SaveDeferred) Transition(FlowState.NeedsPair(Notice.SaveCancelled), listOf(Effect.DiscardSaveToken))
                else Transition(s)
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
            FlowEvent.Reconnect ->
                if (live(s)) Transition(FlowState.Connecting, listOf(Effect.Connect)) else Transition(s)
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

/**
 * Lifecycle-aware wrapper around [AppFlow]. Rules:
 *  - Lifecycle facts arrive synchronously and only from the real callbacks: [onStart], [onStop],
 *    [onResume], [onPause]. [RelockPolicy] is fed only there (plus Connect/DropToken
 *    bookkeeping), never from a posted runnable.
 *  - A prompt effect never leaves here unless the activity is RESUMED; otherwise the request is
 *    parked in [promptWanted] and replayed by the next [onResume].
 *  - A socket close ([ErrorKind.Closed]) while stopped inside the armed relock window is deferred:
 *    token and timer stay, and the next [onStart] reconnects without a prompt unless
 *    [RelockPolicy] says the 60 s window has passed.
 *  - SaveDeferred and a backgrounded live session each carry their own 60 s timer (the
 *    Start/Cancel...Timer effects); [RelockPolicy]'s elapsed check backstops the relock timer
 *    because Handler delays do not count device sleep.
 */
class FlowController(private val clockMs: () -> Long) {
    private val relock = RelockPolicy(clockMs = clockMs)

    var state: FlowState = FlowState.NotConfigured
        private set
    var promptWanted = false
        private set
    /** A socket close arrived while stopped inside the relock window; [onStart] reconnects (or relocks). */
    var reconnectPending = false
        private set

    private var started = false
    private var resumed = false
    private var firstStartSeen = false
    private var relockArmed = false

    private var deferredArmed = false
    private var deferredAt = 0L

    fun dispatch(event: FlowEvent): List<Effect> {
        // Closed while stopped inside the armed relock window: keep token and timer, decide in onStart.
        if (event is FlowEvent.ClientFailed && event.kind == ErrorKind.Closed && !started && relockArmed) {
            reconnectPending = true
            return emptyList()
        }
        // A paired token cannot be saved without a visible prompt: park it instead.
        val e = if (event is FlowEvent.PairResult && event.kind == PairKind.Paired && !resumed) {
            FlowEvent.PairedWhileHidden
        } else event
        val t = AppFlow.reduce(state, e)
        state = t.state
        val out = ArrayList<Effect>()
        for (fx in t.effects) {
            when (fx) {
                Effect.BeginUnlock -> if (resumed) out.add(fx) else promptWanted = true
                Effect.Connect -> { relock.onUnlocked(); out.add(fx) }
                Effect.DropToken -> { relock.lockNow(); out.add(fx) }
                else -> out.add(fx)
            }
        }
        settle(out)
        return out
    }

    fun onStart(configured: Boolean, hasToken: () -> Boolean): List<Effect> {
        started = true
        val out = ArrayList<Effect>()
        if (relockArmed) {
            relockArmed = false
            out.add(Effect.CancelRelockTimer)
        }
        if (!firstStartSeen) {
            firstStartSeen = true
            out.addAll(dispatch(FlowEvent.Start(configured, hasToken())))
        } else if (relock.onForegrounded()) {
            out.addAll(dispatch(FlowEvent.RelockDue))
        } else if (reconnectPending) {
            reconnectPending = false
            out.addAll(dispatch(FlowEvent.Reconnect))
        }
        return out
    }

    fun onResume(): List<Effect> {
        resumed = true
        if (state == FlowState.SaveDeferred) return dispatch(FlowEvent.DeferredResumed(clockMs() - deferredAt))
        if (promptWanted && state is FlowState.Locked) {
            promptWanted = false
            return dispatch(FlowEvent.UnlockRequested)
        }
        return emptyList()
    }

    fun onPause() {
        resumed = false
    }

    fun onStop(): List<Effect> {
        resumed = false
        started = false
        relock.onBackgrounded()
        val out = ArrayList<Effect>()
        out.add(Effect.CancelPrompt)
        val s = state
        // A Locked screen with no notice had a prompt up (or wanted); it was just cancelled.
        if (s is FlowState.Locked && s.notice == null) promptWanted = true
        if (s == FlowState.SavePrompt) out.addAll(dispatch(FlowEvent.SaveCancelled)) else settle(out)
        return out
    }

    fun onRelockTimer(): List<Effect> {
        if (!relockArmed || started) return emptyList()
        relockArmed = false
        return dispatch(FlowEvent.RelockDue)
    }

    fun onDeferredTimer(): List<Effect> {
        if (!deferredArmed) return emptyList()
        deferredArmed = false
        return dispatch(FlowEvent.DeferredExpired)
    }

    private fun settle(out: MutableList<Effect>) {
        val s = state
        if (s !is FlowState.Locked) promptWanted = false
        val live = s == FlowState.Connecting || s is FlowState.Connected
        if (!live) reconnectPending = false
        if (live && !started && !relockArmed) {
            relock.onBackgrounded() // a Connect that lands while stopped must not erase the background start
            relockArmed = true
            out.add(Effect.StartRelockTimer)
        } else if (!live && relockArmed) {
            relockArmed = false
            out.add(Effect.CancelRelockTimer)
        }
        val deferred = s == FlowState.SaveDeferred
        if (deferred && !deferredArmed) {
            deferredArmed = true
            deferredAt = clockMs()
            out.add(Effect.StartDeferredTimer)
        } else if (!deferred && deferredArmed) {
            deferredArmed = false
            out.add(Effect.CancelDeferredTimer)
        }
    }
}
