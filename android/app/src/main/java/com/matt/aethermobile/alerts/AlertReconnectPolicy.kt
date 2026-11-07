package com.matt.aethermobile.alerts

/** Reconnect backoff: doubles from [baseMs] and saturates at [capMs]. */
class AlertReconnectPolicy(private val baseMs: Long = 2_000L, private val capMs: Long = 60_000L) {
    init {
        require(baseMs in 1L..capMs) { "baseMs must be in 1..capMs" }
    }

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
