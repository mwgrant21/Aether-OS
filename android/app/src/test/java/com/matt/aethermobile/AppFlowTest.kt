package com.matt.aethermobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppFlowTest {
    private fun step(s: FlowState, e: FlowEvent) = AppFlow.reduce(s, e)

    private fun run(start: FlowState, vararg events: FlowEvent): Transition {
        var t = Transition(start)
        for (e in events) t = AppFlow.reduce(t.state, e)
        return t
    }

    private val connected = FlowState.Connected(30)

    // ---- start / NotConfigured -----------------------------------------------------------

    @Test fun startWithoutAddressIsNotConfigured() {
        val t = step(FlowState.NeedsPair(), FlowEvent.Start(configured = false, hasToken = true))
        assertEquals(FlowState.NotConfigured, t.state)
        assertTrue(t.effects.isEmpty())
    }

    @Test fun startWithTokenIsLockedAndPrompts() {
        val t = step(FlowState.NotConfigured, FlowEvent.Start(configured = true, hasToken = true))
        assertEquals(FlowState.Locked(), t.state)
        assertEquals(listOf(Effect.BeginUnlock), t.effects)
    }

    @Test fun startWithoutTokenNeedsPair() {
        val t = step(FlowState.NotConfigured, FlowEvent.Start(configured = true, hasToken = false))
        assertEquals(FlowState.NeedsPair(), t.state)
        assertTrue(t.effects.isEmpty())
    }

    @Test fun notConfiguredHasNoActions() {
        val events = listOf(
            FlowEvent.PairSubmitted, FlowEvent.InputRejected(Notice.BadCode),
            FlowEvent.PairResult(PairKind.Paired), FlowEvent.PairedWhileHidden, FlowEvent.DeferredResumed(0), FlowEvent.DeferredExpired, FlowEvent.SaveDone, FlowEvent.SaveCancelled,
            FlowEvent.SaveFailed, FlowEvent.UnlockRequested,
            FlowEvent.UnlockStartResult(UnlockKind.Ready), FlowEvent.UnlockAuthFailed(AuthFail.Other),
            FlowEvent.UnlockDone, FlowEvent.UnlockDecryptFailed(true),
            FlowEvent.ClientConnected(1, 0), FlowEvent.ClientRevoked,
            FlowEvent.ClientFailed(ErrorKind.Closed), FlowEvent.RelockDue, FlowEvent.LockNow,
            FlowEvent.Retry(true),
        )
        for (e in events) {
            val t = step(FlowState.NotConfigured, e)
            assertEquals("$e", FlowState.NotConfigured, t.state)
            assertTrue("$e", t.effects.isEmpty())
        }
    }

    // ---- pairing and save ----------------------------------------------------------------

    @Test fun pairSubmittedMovesToPairing() {
        assertEquals(FlowState.Pairing, step(FlowState.NeedsPair(), FlowEvent.PairSubmitted).state)
    }

    @Test fun rejectedInputStaysOnPairWithNotice() {
        val t = step(FlowState.NeedsPair(), FlowEvent.InputRejected(Notice.ScanFailed))
        assertEquals(FlowState.NeedsPair(Notice.ScanFailed), t.state)
        assertTrue(t.effects.isEmpty())
    }

    @Test fun pairedStartsTheSavePrompt() {
        val t = step(FlowState.Pairing, FlowEvent.PairResult(PairKind.Paired))
        assertEquals(FlowState.SavePrompt, t.state)
        assertEquals(listOf(Effect.BeginSave), t.effects)
    }

    @Test fun pairFailuresReturnToPairWithTheirNotice() {
        val cases = mapOf(
            PairKind.BadCode to Notice.BadCode, PairKind.Declined to Notice.Declined,
            PairKind.Burned to Notice.Burned, PairKind.Unreachable to Notice.Unreachable,
            PairKind.Other to Notice.ServerError,
        )
        for ((kind, notice) in cases) {
            val t = step(FlowState.Pairing, FlowEvent.PairResult(kind))
            assertEquals(FlowState.NeedsPair(notice), t.state)
            assertTrue(t.effects.isEmpty())
        }
    }

    @Test fun saveDoneConnectsOnce() {
        val t = step(FlowState.SavePrompt, FlowEvent.SaveDone)
        assertEquals(FlowState.Connecting, t.state)
        assertEquals(listOf(Effect.Connect), t.effects)
    }

    @Test fun saveCancelledDiscardsTheTokenAndNeverConnects() {
        val t = step(FlowState.SavePrompt, FlowEvent.SaveCancelled)
        assertEquals(FlowState.NeedsPair(Notice.SaveCancelled), t.state)
        assertEquals(listOf(Effect.DiscardSaveToken), t.effects)
        assertFalse(Effect.Connect in t.effects)
        assertFalse(AppFlow.holdsToken(t.state))
    }

    @Test fun saveFailedDiscardsTheTokenAndNeverConnects() {
        val t = step(FlowState.SavePrompt, FlowEvent.SaveFailed)
        assertEquals(FlowState.NeedsPair(Notice.SaveFailed), t.state)
        assertEquals(listOf(Effect.DiscardSaveToken), t.effects)
        assertFalse(Effect.Connect in t.effects)
        assertFalse(AppFlow.holdsToken(t.state))
    }

    @Test fun pairedWhileHiddenDefersTheSaveWithoutPrompting() {
        val t = step(FlowState.Pairing, FlowEvent.PairedWhileHidden)
        assertEquals(FlowState.SaveDeferred, t.state)
        assertTrue(t.effects.isEmpty())
        assertTrue(AppFlow.holdsToken(t.state))
    }

    @Test fun deferredSaveResumedInTimePrompts() {
        val t = step(FlowState.SaveDeferred, FlowEvent.DeferredResumed(ageMs = 59_999))
        assertEquals(FlowState.SavePrompt, t.state)
        assertEquals(listOf(Effect.BeginSave), t.effects)
    }

    @Test fun deferredSaveExpiredDiscardsAndNeverConnects() {
        for (age in listOf(60_000L, 600_000L, -1L)) {
            val t = step(FlowState.SaveDeferred, FlowEvent.DeferredResumed(age))
            assertEquals(FlowState.NeedsPair(Notice.SaveCancelled), t.state)
            assertEquals(listOf(Effect.DiscardSaveToken), t.effects)
            assertFalse(Effect.Connect in t.effects)
            assertFalse(AppFlow.holdsToken(t.state))
        }
    }

    @Test fun deferredResumeOutsideDeferredIsIgnored() {
        val t = step(FlowState.Locked(), FlowEvent.DeferredResumed(0))
        assertEquals(FlowState.Locked(), t.state)
        assertTrue(t.effects.isEmpty())
    }

    @Test fun onlySavePromptConnectingAndConnectedHoldAToken() {
        val holding = listOf(FlowState.SavePrompt, FlowState.Connecting, connected)
        val notHolding = listOf(
            FlowState.NotConfigured, FlowState.NeedsPair(), FlowState.NeedsPair(Notice.SaveCancelled),
            FlowState.Pairing, FlowState.Locked(), FlowState.Error(ErrorKind.Closed),
        )
        holding.forEach { assertTrue("$it", AppFlow.holdsToken(it)) }
        notHolding.forEach { assertFalse("$it", AppFlow.holdsToken(it)) }
    }

    // ---- unlock --------------------------------------------------------------------------

    @Test fun unlockHappyPathReachesConnecting() {
        val t = run(
            FlowState.NeedsPair(),
            FlowEvent.Start(configured = true, hasToken = true),
            FlowEvent.UnlockStartResult(UnlockKind.Ready),
            FlowEvent.UnlockDone,
        )
        assertEquals(FlowState.Connecting, t.state)
        assertEquals(listOf(Effect.Connect), t.effects)
    }

    @Test fun unlockRequestedFromLockedPrompts() {
        val t = step(FlowState.Locked(Notice.Cancelled), FlowEvent.UnlockRequested)
        assertEquals(FlowState.Locked(), t.state)
        assertEquals(listOf(Effect.BeginUnlock), t.effects)
    }

    @Test fun invalidatedKeyGoesToPairAndClearsTheVault() {
        val t = step(FlowState.Locked(), FlowEvent.UnlockStartResult(UnlockKind.Invalidated))
        assertEquals(FlowState.NeedsPair(Notice.KeyInvalidated), t.state)
        assertEquals(listOf(Effect.ClearVault), t.effects)
    }

    @Test fun emptyVaultGoesToPair() {
        val t = step(FlowState.Locked(), FlowEvent.UnlockStartResult(UnlockKind.Empty))
        assertEquals(FlowState.NeedsPair(), t.state)
    }

    @Test fun unavailableStartStaysLockedWithRetryMessageAndNoWipe() {
        val t = step(FlowState.Locked(), FlowEvent.UnlockStartResult(UnlockKind.Unavailable))
        assertEquals(FlowState.Locked(Notice.TryAgain), t.state)
        assertFalse(Effect.ClearVault in t.effects)
    }

    @Test fun cancelledUnlockStaysLocked() {
        val t = step(FlowState.Locked(), FlowEvent.UnlockAuthFailed(AuthFail.Cancelled))
        assertEquals(FlowState.Locked(Notice.Cancelled), t.state)
        assertTrue(t.effects.isEmpty())
    }

    @Test fun otherAuthFailuresStayLockedWithTheirNotice() {
        assertEquals(
            FlowState.Locked(Notice.Lockout),
            step(FlowState.Locked(), FlowEvent.UnlockAuthFailed(AuthFail.Lockout)).state,
        )
        assertEquals(
            FlowState.Locked(Notice.BiometricUnavailable),
            step(FlowState.Locked(), FlowEvent.UnlockAuthFailed(AuthFail.Unavailable)).state,
        )
        assertEquals(
            FlowState.Locked(Notice.TryAgain),
            step(FlowState.Locked(), FlowEvent.UnlockAuthFailed(AuthFail.Other)).state,
        )
    }

    @Test fun transientDecryptFailureStaysLockedWithoutWipe() {
        val t = step(FlowState.Locked(), FlowEvent.UnlockDecryptFailed(vaultWiped = false))
        assertEquals(FlowState.Locked(Notice.TryAgain), t.state)
        assertFalse(Effect.ClearVault in t.effects)
    }

    @Test fun wipedDecryptFailureGoesToPair() {
        val t = step(FlowState.Locked(), FlowEvent.UnlockDecryptFailed(vaultWiped = true))
        assertEquals(FlowState.NeedsPair(Notice.KeyInvalidated), t.state)
    }

    // ---- client states -------------------------------------------------------------------

    @Test fun connectedShowsDaysLeftAndWarnsAtSevenOrFewer() {
        val day = 86_400_000L
        val ok = step(FlowState.Connecting, FlowEvent.ClientConnected(expiresAtMs = 30 * day, serverTimeMs = 0))
        assertEquals(FlowState.Connected(30), ok.state)
        assertFalse((ok.state as FlowState.Connected).warn)
        val soon = step(FlowState.Connecting, FlowEvent.ClientConnected(expiresAtMs = 7 * day, serverTimeMs = 0))
        assertTrue((soon.state as FlowState.Connected).warn)
        assertFalse(FlowState.Connected(8).warn)
    }

    @Test fun daysLeftRoundsUpAndNeverGoesNegative() {
        assertEquals(1, AppFlow.daysLeft(expiresAtMs = 1, nowMs = 0))
        assertEquals(2, AppFlow.daysLeft(expiresAtMs = 86_400_001L, nowMs = 0))
        assertEquals(0, AppFlow.daysLeft(expiresAtMs = 0, nowMs = 5))
    }

    @Test fun revokedClearsVaultDropsTokenAndGoesToPair() {
        for (s in listOf(FlowState.Connecting, connected)) {
            val t = step(s, FlowEvent.ClientRevoked)
            assertEquals(FlowState.NeedsPair(Notice.Revoked), t.state)
            assertEquals(listOf(Effect.CloseSocket, Effect.DropToken, Effect.ClearVault), t.effects)
        }
    }

    @Test fun byeRevokedWhileLockedIsANoOp() {
        val t = step(FlowState.Locked(), FlowEvent.ClientRevoked)
        assertEquals(FlowState.Locked(), t.state)
        assertTrue(t.effects.isEmpty())
    }

    @Test fun lateClientEventsAreIgnoredOutsideAConnection() {
        for (s in listOf(FlowState.Locked(), FlowState.NeedsPair(), FlowState.Error(ErrorKind.Busy))) {
            val failed = step(s, FlowEvent.ClientFailed(ErrorKind.Closed))
            assertEquals(s, failed.state)
            assertTrue(failed.effects.isEmpty())
            val up = step(s, FlowEvent.ClientConnected(1, 0))
            assertEquals(s, up.state)
        }
    }

    @Test fun connectionFailureShowsErrorDropsTokenAndKeepsTheVault() {
        for (kind in ErrorKind.values()) {
            val t = step(FlowState.Connecting, FlowEvent.ClientFailed(kind))
            assertEquals(FlowState.Error(kind), t.state)
            assertEquals(listOf(Effect.CloseSocket, Effect.DropToken), t.effects)
        }
        val fromConnected = step(connected, FlowEvent.ClientFailed(ErrorKind.Superseded))
        assertEquals(FlowState.Error(ErrorKind.Superseded), fromConnected.state)
    }

    @Test fun retryFromErrorPromptsAgainOrGoesToPair() {
        val withToken = step(FlowState.Error(ErrorKind.Unreachable), FlowEvent.Retry(hasToken = true))
        assertEquals(FlowState.Locked(), withToken.state)
        assertEquals(listOf(Effect.BeginUnlock), withToken.effects)
        val without = step(FlowState.Error(ErrorKind.Unreachable), FlowEvent.Retry(hasToken = false))
        assertEquals(FlowState.NeedsPair(), without.state)
    }

    // ---- relock --------------------------------------------------------------------------

    @Test fun relockFromConnectedClosesDropsTokenAndPrompts() {
        val t = step(connected, FlowEvent.RelockDue)
        assertEquals(FlowState.Locked(), t.state)
        assertEquals(listOf(Effect.CloseSocket, Effect.DropToken, Effect.BeginUnlock), t.effects)
        assertFalse(AppFlow.holdsToken(t.state))
    }

    @Test fun relockWhileConnectingAlsoLocks() {
        assertEquals(FlowState.Locked(), step(FlowState.Connecting, FlowEvent.RelockDue).state)
    }

    @Test fun relockWhenAlreadyLockedOrUnpairedIsANoOp() {
        for (s in listOf(FlowState.Locked(), FlowState.NeedsPair(), FlowState.Pairing)) {
            val t = step(s, FlowEvent.RelockDue)
            assertEquals(s, t.state)
            assertTrue(t.effects.isEmpty())
        }
    }

    @Test fun reconnectOnlyFromLiveStates() {
        for (s in listOf(connected, FlowState.Connecting)) {
            val x = step(s, FlowEvent.Reconnect)
            assertEquals(FlowState.Connecting, x.state)
            assertEquals(listOf(Effect.Connect), x.effects)
        }
        for (s in listOf(FlowState.Locked(), FlowState.NeedsPair(), FlowState.Error(ErrorKind.Closed), FlowState.Pairing)) {
            val x = step(s, FlowEvent.Reconnect)
            assertEquals(s, x.state)
            assertTrue(x.effects.isEmpty())
        }
    }

    @Test fun lockNowClosesAndDropsButDoesNotPromptByItself() {
        val t = step(connected, FlowEvent.LockNow)
        assertEquals(FlowState.Locked(), t.state)
        assertEquals(listOf(Effect.CloseSocket, Effect.DropToken), t.effects)
    }

    @Test fun lockNowIsANoOpWhenNothingIsLive() {
        val t = step(FlowState.NeedsPair(), FlowEvent.LockNow)
        assertEquals(FlowState.NeedsPair(), t.state)
        assertTrue(t.effects.isEmpty())
    }

    // ---- end to end ----------------------------------------------------------------------

    @Test fun fullPairSaveConnectRelockUnlockCycle() {
        val t = run(
            FlowState.NeedsPair(),
            FlowEvent.PairSubmitted, FlowEvent.PairResult(PairKind.Paired), FlowEvent.SaveDone,
            FlowEvent.ClientConnected(expiresAtMs = 86_400_000L * 30, serverTimeMs = 0),
            FlowEvent.RelockDue, FlowEvent.UnlockStartResult(UnlockKind.Ready), FlowEvent.UnlockDone,
            FlowEvent.ClientConnected(expiresAtMs = 86_400_000L * 30, serverTimeMs = 0),
        )
        assertEquals(FlowState.Connected(30), t.state)
    }

    // ---- lifecycle sequences (FlowController) --------------------------------------------

    private class Rig {
        var now = 0L
        val c = FlowController { now }
        val state get() = c.state

        fun start(hasToken: Boolean = true) = c.onStart(configured = true) { hasToken }

        /** Resumed on Connected, token in memory. */
        fun connected(): Rig {
            start()
            c.onResume()
            c.dispatch(FlowEvent.UnlockStartResult(UnlockKind.Ready))
            c.dispatch(FlowEvent.UnlockDone)
            c.dispatch(FlowEvent.ClientConnected(expiresAtMs = 86_400_000L * 30, serverTimeMs = 0))
            return this
        }

        /** Resumed on the Pairing screen. */
        fun pairing(): Rig {
            start(hasToken = false)
            c.onResume()
            c.dispatch(FlowEvent.PairSubmitted)
            return this
        }
    }

    private val minute = 60_000L

    @Test fun coldOpenPromptsOnlyOnceResumed() {
        val r = Rig()
        val atStart = r.start()
        assertEquals(FlowState.Locked(), r.state)
        assertFalse(Effect.BeginUnlock in atStart)
        assertTrue(r.c.promptWanted)
        assertEquals(listOf(Effect.BeginUnlock), r.c.onResume())
        assertFalse(r.c.promptWanted)
    }

    @Test fun backgroundOverAMinuteRelocksOnStartAndPromptsOnlyOnResume() {
        val r = Rig().connected()
        assertEquals(listOf(Effect.CancelPrompt, Effect.StartRelockTimer), r.c.onStop())
        r.now += minute + 1
        val atStart = r.start()
        assertEquals(listOf(Effect.CancelRelockTimer, Effect.CloseSocket, Effect.DropToken), atStart)
        assertEquals(FlowState.Locked(), r.state)
        assertTrue(r.c.promptWanted)
        assertEquals(listOf(Effect.BeginUnlock), r.c.onResume())
    }

    @Test fun backgroundUnderAMinuteDoesNotRelock() {
        val r = Rig().connected()
        r.c.onStop()
        r.now += minute - 1
        assertEquals(listOf(Effect.CancelRelockTimer), r.start())
        assertEquals(FlowState.Connected(30), r.state)
        assertTrue(r.c.onResume().isEmpty())
        assertTrue("a late timer must be ignored once foregrounded", r.c.onRelockTimer().isEmpty())
        assertEquals(FlowState.Connected(30), r.state)
    }

    @Test fun relockTimerFiresWhileStoppedAndPromptIsParkedNotShown() {
        val r = Rig().connected()
        r.c.onStop()
        r.now += minute
        assertEquals(listOf(Effect.CloseSocket, Effect.DropToken), r.c.onRelockTimer())
        assertEquals(FlowState.Locked(), r.state)
        assertFalse(AppFlow.holdsToken(r.state))
        assertTrue(r.c.promptWanted)
        // Coming back later: the policy is already locked, nothing is relocked twice.
        assertTrue(r.start().isEmpty())
        assertEquals(listOf(Effect.BeginUnlock), r.c.onResume())
    }

    @Test fun startStopBounceBeforeResumeStillRelocksOnTime() {
        val r = Rig().connected()
        r.c.onStop()
        r.now += 10_000
        r.start()
        // Stopped again before the activity ever resumed: the session must still relock.
        assertEquals(listOf(Effect.CancelPrompt, Effect.StartRelockTimer), r.c.onStop())
        r.now += minute
        assertEquals(listOf(Effect.CloseSocket, Effect.DropToken), r.c.onRelockTimer())
        assertEquals(FlowState.Locked(), r.state)
    }

    @Test fun startStopBounceThenHoursLaterRelocksOnTheNextStart() {
        val r = Rig().connected()
        r.c.onStop()
        r.start()
        r.c.onStop()
        r.now += 180 * minute
        assertTrue(Effect.DropToken in r.start())
        assertEquals(FlowState.Locked(), r.state)
    }

    @Test fun pairedWhileStoppedIsDeferredNotPrompted() {
        val r = Rig().pairing()
        r.c.onPause()
        r.c.onStop()
        val fx = r.c.dispatch(FlowEvent.PairResult(PairKind.Paired))
        assertEquals(FlowState.SaveDeferred, r.state)
        assertEquals(listOf(Effect.StartDeferredTimer), fx)
        assertTrue(AppFlow.holdsToken(r.state))
    }

    @Test fun pairedWhileStartedButNotResumedIsDeferred() {
        val r = Rig().pairing()
        r.c.onPause()
        assertEquals(listOf(Effect.StartDeferredTimer), r.c.dispatch(FlowEvent.PairResult(PairKind.Paired)))
        assertEquals(FlowState.SaveDeferred, r.state)
    }

    @Test fun deferredSaveExpiryDiscardsTheTokenWithoutALifecycleEvent() {
        val r = Rig().pairing()
        r.c.onStop()
        r.c.dispatch(FlowEvent.PairResult(PairKind.Paired))
        r.now += minute
        assertEquals(listOf(Effect.DiscardSaveToken), r.c.onDeferredTimer())
        assertEquals(FlowState.NeedsPair(Notice.SaveCancelled), r.state)
        assertFalse(AppFlow.holdsToken(r.state))
        assertTrue(r.c.onDeferredTimer().isEmpty())
    }

    @Test fun deferredSaveSurvivesAStartStopBounceThatNeverResumes() {
        val r = Rig().pairing()
        r.c.onStop()
        r.c.dispatch(FlowEvent.PairResult(PairKind.Paired))
        r.now += 10_000
        assertTrue(r.start().isEmpty())
        r.c.onStop()
        assertEquals(FlowState.SaveDeferred, r.state)
        r.now += 10_000
        r.start()
        assertEquals(listOf(Effect.BeginSave, Effect.CancelDeferredTimer), r.c.onResume())
        assertEquals(FlowState.SavePrompt, r.state)
    }

    @Test fun deferredSaveOlderThanAMinuteIsDiscardedOnResumeEvenIfTheTimerNeverRan() {
        val r = Rig().pairing()
        r.c.onStop()
        r.c.dispatch(FlowEvent.PairResult(PairKind.Paired))
        r.now += minute + 1 // device slept: Handler delays do not count sleep
        r.start()
        val fx = r.c.onResume()
        assertFalse(Effect.BeginSave in fx)
        assertTrue(Effect.DiscardSaveToken in fx)
        assertEquals(FlowState.NeedsPair(Notice.SaveCancelled), r.state)
    }

    @Test fun stopWhileSavePromptIsUpCancelsItAndDiscardsTheToken() {
        val r = Rig().pairing()
        assertEquals(listOf(Effect.BeginSave), r.c.dispatch(FlowEvent.PairResult(PairKind.Paired)))
        assertEquals(listOf(Effect.CancelPrompt, Effect.DiscardSaveToken), r.c.onStop())
        assertEquals(FlowState.NeedsPair(Notice.SaveCancelled), r.state)
    }

    @Test fun stopWhileUnlockPromptIsUpReprompsOnTheNextResume() {
        val r = Rig()
        r.start()
        r.c.onResume()
        r.c.dispatch(FlowEvent.UnlockStartResult(UnlockKind.Ready)) // prompt is up
        assertEquals(listOf(Effect.CancelPrompt), r.c.onStop())
        assertTrue(r.c.promptWanted)
        r.start()
        assertEquals(listOf(Effect.BeginUnlock), r.c.onResume())
    }

    @Test fun userCancelledUnlockIsNotRepromptedByResume() {
        val r = Rig()
        r.start()
        r.c.onResume()
        r.c.dispatch(FlowEvent.UnlockStartResult(UnlockKind.Ready))
        r.c.dispatch(FlowEvent.UnlockAuthFailed(AuthFail.Cancelled))
        r.c.onPause()
        r.c.onStop()
        assertFalse(r.c.promptWanted)
        r.start()
        assertTrue(r.c.onResume().isEmpty())
    }

    @Test fun unlockRequestedWhileNotResumedIsParkedNotRun() {
        val r = Rig()
        r.start()
        r.c.onResume()
        r.c.dispatch(FlowEvent.UnlockAuthFailed(AuthFail.Cancelled))
        r.c.onPause()
        assertTrue(r.c.dispatch(FlowEvent.UnlockRequested).isEmpty())
        assertTrue(r.c.promptWanted)
    }

    @Test fun connectLandingWhileStoppedStillArmsTheRelock() {
        val r = Rig()
        r.start()
        r.c.onResume()
        r.c.dispatch(FlowEvent.UnlockStartResult(UnlockKind.Ready))
        r.c.onPause()
        r.c.onStop()
        assertEquals(listOf(Effect.Connect, Effect.StartRelockTimer), r.c.dispatch(FlowEvent.UnlockDone))
        r.now += minute
        assertEquals(listOf(Effect.CloseSocket, Effect.DropToken), r.c.onRelockTimer())
    }

    @Test fun lockNowDisarmsTheRelockTimer() {
        val r = Rig().connected()
        r.c.onStop()
        r.start()
        r.c.onStop()
        assertEquals(
            listOf(Effect.CloseSocket, Effect.DropToken, Effect.CancelRelockTimer),
            r.c.dispatch(FlowEvent.LockNow),
        )
    }

    // ---- silent reconnect on resume ------------------------------------------------------

    private val longLived = FlowEvent.ClientConnected(expiresAtMs = 86_400_000L * 30, serverTimeMs = 0)

    @Test fun closedWhileStoppedInsideWindowKeepsTokenAndTimer() {
        val r = Rig().connected()
        val t0 = r.now
        assertEquals(listOf(Effect.CancelPrompt, Effect.StartRelockTimer), r.c.onStop())
        r.now += 5_000
        val fx = r.c.dispatch(FlowEvent.ClientFailed(ErrorKind.Closed))
        assertTrue(fx.isEmpty())
        assertEquals(FlowState.Connected(30), r.state)
        assertTrue(AppFlow.holdsToken(r.state))
        assertTrue(r.c.reconnectPending)
        r.now = t0 + minute
        assertEquals(listOf(Effect.CloseSocket, Effect.DropToken), r.c.onRelockTimer())
        assertEquals(FlowState.Locked(), r.state)
    }

    @Test fun returnInsideWindowReconnectsWithoutPrompt() {
        val r = Rig().connected()
        val t0 = r.now
        r.c.onStop()
        r.now += 5_000
        r.c.dispatch(FlowEvent.ClientFailed(ErrorKind.Closed))
        r.now = t0 + 59_900
        assertEquals(listOf(Effect.CancelRelockTimer, Effect.Connect), r.start())
        assertEquals(FlowState.Connecting, r.state)
        assertFalse(r.c.promptWanted)
        assertTrue(r.c.onResume().isEmpty())
        assertFalse(r.c.reconnectPending)
        r.c.dispatch(longLived)
        assertEquals(FlowState.Connected(30), r.state)
        assertEquals(listOf(Effect.CancelPrompt, Effect.StartRelockTimer), r.c.onStop())
    }

    @Test fun returnAtSixtySecondsRelocksEvenWithAPendingReconnect() {
        val r = Rig().connected()
        val t0 = r.now
        r.c.onStop()
        r.now += 5_000
        r.c.dispatch(FlowEvent.ClientFailed(ErrorKind.Closed))
        r.now = t0 + minute
        assertEquals(listOf(Effect.CancelRelockTimer, Effect.CloseSocket, Effect.DropToken), r.start())
        assertEquals(FlowState.Locked(), r.state)
        assertTrue(r.c.promptWanted)
        assertFalse(r.c.reconnectPending)
        assertEquals(listOf(Effect.BeginUnlock), r.c.onResume())
    }

    @Test fun closedWhileForegroundedStillErrors() {
        val r = Rig().connected()
        assertEquals(listOf(Effect.CloseSocket, Effect.DropToken), r.c.dispatch(FlowEvent.ClientFailed(ErrorKind.Closed)))
        assertEquals(FlowState.Error(ErrorKind.Closed), r.state)
        assertFalse(r.c.reconnectPending)
    }

    @Test fun otherFailuresWhileStoppedStillError() {
        val r = Rig().connected()
        r.c.onStop()
        assertEquals(
            listOf(Effect.CloseSocket, Effect.DropToken, Effect.CancelRelockTimer),
            r.c.dispatch(FlowEvent.ClientFailed(ErrorKind.Unreachable)),
        )
        assertEquals(FlowState.Error(ErrorKind.Unreachable), r.state)
        assertFalse(r.c.reconnectPending)
    }

    @Test fun relockTimerWhileReconnectPendingLocksAndNeverReconnects() {
        val r = Rig().connected()
        val t0 = r.now
        r.c.onStop()
        r.c.dispatch(FlowEvent.ClientFailed(ErrorKind.Closed))
        r.now = t0 + minute
        assertEquals(listOf(Effect.CloseSocket, Effect.DropToken), r.c.onRelockTimer())
        assertFalse(r.c.reconnectPending)
        assertTrue(r.start().isEmpty())
        assertEquals(listOf(Effect.BeginUnlock), r.c.onResume())
    }

    @Test fun foregroundReconnectFailureShowsError() {
        val r = Rig().connected()
        val t0 = r.now
        r.c.onStop()
        r.c.dispatch(FlowEvent.ClientFailed(ErrorKind.Closed))
        r.now = t0 + 10_000
        r.start()
        assertEquals(FlowState.Connecting, r.state)
        assertEquals(
            listOf(Effect.CloseSocket, Effect.DropToken),
            r.c.dispatch(FlowEvent.ClientFailed(ErrorKind.Unreachable)),
        )
        assertEquals(FlowState.Error(ErrorKind.Unreachable), r.state)
    }
}
