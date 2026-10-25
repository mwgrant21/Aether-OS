package com.matt.aethermobile.net

/**
 * Per-slot sequence tracking for the phone side of the terminal stream. Pure
 * JVM: no android.* imports. All methods are synchronized so the transport
 * thread (onOut) and the UI thread (lastQ on a tab switch) may share one feed.
 */
class TerminalFeed {
    enum class Verdict {
        /** q is exactly last+1: write it and move on. */
        Accept,

        /** q <= last: already seen, drop it. */
        Duplicate,

        /** q > last+1, or the slot has no baseline yet: re-attach without q. */
        Gap,
    }

    private val last = HashMap<String, Long>()

    /** A snapshot replaces the slot's content: its q becomes the new baseline. */
    @Synchronized
    fun onSnap(s: String, q: Long) {
        last[s] = q
    }

    /** Advances the baseline only on [Verdict.Accept]. */
    @Synchronized
    fun onOut(s: String, q: Long): Verdict {
        val prev = last[s] ?: return Verdict.Gap
        return when {
            q <= prev -> Verdict.Duplicate
            q == prev + 1 -> { last[s] = q; Verdict.Accept }
            else -> Verdict.Gap
        }
    }

    /** The q to resume from on re-attach, or null when the slot has no baseline. */
    @Synchronized
    fun lastQ(s: String): Long? = last[s]

    /** Drops the baseline so the next attach asks for a full snapshot. */
    @Synchronized
    fun forget(s: String) {
        last.remove(s)
    }
}
