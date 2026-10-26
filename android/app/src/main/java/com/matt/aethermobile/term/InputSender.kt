package com.matt.aethermobile.term

/**
 * Turns typed text into cseq-numbered `in` frames. Pure JVM, no android.* imports.
 * Ordered, at-most-once: a frame is sent once and never resent (design 2.3). Unacked frames are
 * only counted, so the UI can report them as not sent after the link drops. Not thread-safe:
 * [TerminalHost] calls it under its own monitor. Text is never logged.
 */
class InputSender(
    private val send: (String, Long, String) -> Boolean,
    private val nowMs: () -> Long,
    private val onNotSent: (Int) -> Unit = {},
    /** Why [send] refused a whole input (before any frame); called right after [onNotSent] for the same input. */
    private val onRefused: (Refusal) -> Unit = {},
    /** A cumulative ack retired at least one pending frame. */
    private val onAcked: () -> Unit = {},
) {
    enum class Refusal { TOO_LARGE, LONE_SURROGATE }

    /** [sentChars] reached `send`; [notSentChars] did not (refused input, or the link refused a frame). */
    data class SendResult(val frames: Int, val sentChars: Int, val notSentChars: Int)

    private class Pending(val c: Long, val chars: Int, val atMs: Long)

    private val nextC = HashMap<String, Long>()
    private val pending = HashMap<String, ArrayList<Pending>>()
    private var unsent = 0

    /** Chars reported not sent since construction (refused, link refused, or unacked at a drop). */
    fun unsentChars(): Int = unsent

    fun send(s: String, text: String): SendResult {
        if (text.isEmpty()) return SendResult(0, 0, 0)
        val refusal = when {
            text.toByteArray(Charsets.UTF_8).size > MAX_INPUT_BYTES -> Refusal.TOO_LARGE
            hasLoneSurrogate(text) -> Refusal.LONE_SURROGATE
            else -> null
        }
        if (refusal != null) {
            val r = fail(SendResult(0, 0, text.length))
            onRefused(refusal)
            return r
        }
        var i = 0
        var frames = 0
        while (i < text.length) {
            val end = chunkEnd(text, i)
            val c = nextC[s] ?: 1L
            if (!send(s, c, text.substring(i, end))) break
            nextC[s] = c + 1
            pending.getOrPut(s) { ArrayList() }.add(Pending(c, end - i, nowMs()))
            frames++
            i = end
        }
        return fail(SendResult(frames, i, text.length - i))
    }

    /** Input that never reached [send] (the host's gate was closed): counted and reported as not sent. */
    fun reject(chars: Int) {
        if (chars > 0) fail(SendResult(0, 0, chars))
    }

    /** Cumulative ack: every pending frame with cseq <= [c] for [s] was processed. */
    fun onAck(s: String, c: Long) {
        if (pending[s]?.removeAll { it.c <= c } == true) onAcked()
    }

    /** The link dropped: whatever is still unacked is reported not sent. Nothing is resent. */
    fun onDisconnected() {
        val n = pending.values.sumOf { l -> l.sumOf { it.chars } }
        pending.clear()
        if (n > 0) {
            unsent += n
            onNotSent(n)
        }
    }

    private fun fail(r: SendResult): SendResult {
        if (r.notSentChars > 0) {
            unsent += r.notSentChars
            onNotSent(r.notSentChars)
        }
        return r
    }

    /** End index (exclusive) of the chunk starting at [start]: <= [CHUNK_BYTES] bytes, whole code points. */
    private fun chunkEnd(t: String, start: Int): Int {
        var i = start
        var bytes = 0
        while (i < t.length) {
            val cp = t.codePointAt(i)
            val n = when {
                cp < 0x80 -> 1
                cp < 0x800 -> 2
                cp < 0x10000 -> 3
                else -> 4
            }
            if (bytes + n > CHUNK_BYTES) break
            bytes += n
            i += Character.charCount(cp)
        }
        return i
    }

    private fun hasLoneSurrogate(t: String): Boolean {
        var i = 0
        while (i < t.length) {
            val ch = t[i]
            if (Character.isHighSurrogate(ch)) {
                if (i + 1 >= t.length || !Character.isLowSurrogate(t[i + 1])) return true
                i += 2
            } else if (Character.isLowSurrogate(ch)) return true else i++
        }
        return false
    }

    companion object {
        const val CHUNK_BYTES = 4096
        /**
         * Largest paste accepted: 64 KiB = 16 frames of [CHUNK_BYTES]. The desktop allows 262144 B and
         * 100 frames per second, so one max paste uses 25% / 16% of that window and three still fit.
         */
        const val MAX_INPUT_BYTES = 65536
    }
}
