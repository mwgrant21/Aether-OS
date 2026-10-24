package com.matt.aethermobile.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RelockPolicyTest {
    private var now = 1_000L
    private fun policy() = RelockPolicy(60_000L) { now }

    @Test fun startsLockedAndNeverUnlocksByItself() {
        val p = policy()
        assertEquals(RelockPolicy.State.Locked, p.state)
        p.onBackgrounded()
        now += 5_000
        assertFalse(p.onForegrounded())
        assertEquals(RelockPolicy.State.Locked, p.state)
    }

    @Test fun foregroundJustInsideTheWindowKeepsTheToken() {
        val p = policy()
        p.onUnlocked()
        p.onBackgrounded()
        now += 59_900
        assertFalse(p.onForegrounded())
        assertEquals(RelockPolicy.State.Unlocked, p.state)
    }

    @Test fun foregroundExactlyAtSixtySecondsRelocks() {
        val p = policy()
        p.onUnlocked()
        p.onBackgrounded()
        now += 60_000
        assertTrue(p.onForegrounded())
        assertEquals(RelockPolicy.State.Locked, p.state)
    }

    @Test fun lockNowLocksAndForegroundThenNeedsNothing() {
        val p = policy()
        p.onUnlocked()
        p.lockNow()
        assertEquals(RelockPolicy.State.Locked, p.state)
        p.onBackgrounded()
        now += 120_000
        assertFalse(p.onForegrounded())
    }

    @Test fun repeatedCyclesEachGetTheirOwnWindow() {
        val p = policy()
        p.onUnlocked()
        repeat(3) {
            p.onBackgrounded()
            now += 40_000
            assertFalse(p.onForegrounded())
        }
        assertEquals(RelockPolicy.State.Unlocked, p.state)
        p.onBackgrounded()
        now += 61_000
        assertTrue(p.onForegrounded())
    }

    @Test fun repeatedBackgroundCallsDoNotExtendTheWindow() {
        val p = policy()
        p.onUnlocked()
        p.onBackgrounded()
        now += 40_000
        p.onBackgrounded()
        now += 20_000
        assertTrue(p.onForegrounded())
    }

    @Test fun foregroundWithoutBackgroundIsANoOp() {
        val p = policy()
        p.onUnlocked()
        now += 500_000
        assertFalse(p.onForegrounded())
        assertEquals(RelockPolicy.State.Unlocked, p.state)
    }

    @Test fun clockGoingBackwardsFailsClosed() {
        val p = policy()
        p.onUnlocked()
        p.onBackgrounded()
        now -= 1
        assertTrue(p.onForegrounded())
    }
}
