package com.matt.aethermobile.alerts

/** Reconnect backoff: doubles from [baseMs] and saturates at [capMs]. */
class AlertReconnectPolicy(private val baseMs: Long = 2_000L, private val capMs: Long = 60_000L) {
    private var current = baseMs

    /** Returns the current delay, then advances it. */
    fun nextDelayMs(): Long {
        val out = current
        current = minOf(current * 2, capMs)
        return out
    }

    fun reset() {
        current = baseMs
    }
}
