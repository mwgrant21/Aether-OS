package com.matt.aethermobile.term

/**
 * One-shot, time-limited permission for a single page `copy` to reach the clipboard. Only native code
 * calls [arm] (the COPY tap); the page can never arm or satisfy it on its own. Pure JVM, clock injected.
 */
class CopyGate(private val ttlMs: Long = 3000, private val now: () -> Long) {
    private var armedAt: Long? = null

    /** A second arm just refreshes the window. */
    fun arm() { armedAt = now() }

    fun disarm() { armedAt = null }

    /** Returns [text] exactly once, only while armed and within the TTL and non-empty; always disarms. */
    fun accept(text: String?): String? {
        val at = armedAt
        armedAt = null
        if (at == null || text == null || text.isEmpty()) return null
        return if (now() - at in 0..ttlMs) text else null
    }
}
