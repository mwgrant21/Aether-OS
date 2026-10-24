package com.matt.aethermobile.auth

/**
 * 60-second relock state machine. Pure JVM; [clockMs] must be monotonic
 * (SystemClock.elapsedRealtime in production, never wall time).
 * The policy only ever moves toward Locked on its own: Unlocked is reached
 * solely through [onUnlocked].
 */
class RelockPolicy(
    private val relockAfterMs: Long = 60_000L,
    private val clockMs: () -> Long,
) {
    enum class State { Locked, Unlocked }

    private var current = State.Locked
    private var backgroundedAt: Long? = null

    @get:Synchronized
    val state: State get() = current

    @Synchronized
    fun onUnlocked() {
        current = State.Unlocked
        backgroundedAt = null
    }

    /** The first call of a background spell fixes its start; repeats do not extend the window. */
    @Synchronized
    fun onBackgrounded() {
        if (current == State.Unlocked && backgroundedAt == null) backgroundedAt = clockMs()
    }

    /** True = the caller must lock (close socket, drop token) and re-prompt. */
    @Synchronized
    fun onForegrounded(): Boolean {
        val since = backgroundedAt ?: return false
        backgroundedAt = null
        if (current != State.Unlocked) return false
        val elapsed = clockMs() - since
        if (elapsed < 0 || elapsed >= relockAfterMs) {
            current = State.Locked
            return true
        }
        return false
    }

    @Synchronized
    fun lockNow() {
        current = State.Locked
        backgroundedAt = null
    }
}
