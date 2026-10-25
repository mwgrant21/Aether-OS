package com.matt.aethermobile.net

import com.matt.aethermobile.net.TerminalFeed.Verdict
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TerminalFeedTest {
    private val feed = TerminalFeed()

    @Test fun acceptDuplicateGapTable() {
        feed.onSnap("claude", 10)
        assertEquals(Verdict.Accept, feed.onOut("claude", 11))
        assertEquals(Verdict.Duplicate, feed.onOut("claude", 11))
        assertEquals(Verdict.Duplicate, feed.onOut("claude", 3))
        assertEquals(Verdict.Gap, feed.onOut("claude", 13))
        assertEquals(Verdict.Accept, feed.onOut("claude", 12))
    }

    @Test fun gapDoesNotAdvanceTheBaseline() {
        feed.onSnap("claude", 5)
        assertEquals(Verdict.Gap, feed.onOut("claude", 9))
        assertEquals(5L, feed.lastQ("claude"))
    }

    @Test fun outWithoutABaselineIsAGap() {
        assertEquals(Verdict.Gap, feed.onOut("claude", 1))
        assertNull(feed.lastQ("claude"))
    }

    @Test fun snapResetsTheBaselineEvenBackwards() {
        feed.onSnap("claude", 50)
        feed.onOut("claude", 51)
        feed.onSnap("claude", 7)
        assertEquals(7L, feed.lastQ("claude"))
        assertEquals(Verdict.Accept, feed.onOut("claude", 8))
    }

    @Test fun slotsAreIndependent() {
        feed.onSnap("claude", 10)
        feed.onSnap("codex", 100)
        assertEquals(Verdict.Accept, feed.onOut("codex", 101))
        assertEquals(10L, feed.lastQ("claude"))
        assertEquals(Verdict.Gap, feed.onOut("terminal2", 1))
    }

    @Test fun forgetDropsTheBaselineOfOneSlotOnly() {
        feed.onSnap("claude", 10)
        feed.onSnap("codex", 20)
        feed.forget("claude")
        assertNull(feed.lastQ("claude"))
        assertEquals(Verdict.Gap, feed.onOut("claude", 11))
        assertEquals(20L, feed.lastQ("codex"))
    }
}
