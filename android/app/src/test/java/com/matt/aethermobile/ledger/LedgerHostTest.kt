package com.matt.aethermobile.ledger

import com.matt.aethermobile.protocol.ControlProtocol.LedgerCache
import com.matt.aethermobile.protocol.ControlProtocol.LedgerFrame
import com.matt.aethermobile.protocol.ControlProtocol.LedgerRollups
import com.matt.aethermobile.protocol.ControlProtocol.LedgerSnapshot
import com.matt.aethermobile.protocol.ControlProtocol.LedgerTier
import com.matt.aethermobile.protocol.ControlProtocol.LedgerTotal
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LedgerHostTest {
    private val calls = ArrayList<String>()
    private var clock = 5_000L
    private var changes = 0
    private var attachResult = true
    private var throwOnChanged = false
    private val host = LedgerHost(
        sendAttach = { calls.add("attach"); attachResult },
        sendDetach = { calls.add("detach"); true },
        now = { clock },
        onChanged = { changes++; if (throwOnChanged) throw IllegalStateException("boom") },
    )

    private fun snap(usd: Double) = LedgerSnapshot(
        1L, LedgerTotal(usd, 1.0, 2.0, 3.0, 4.0), listOf(LedgerTier.OPUS),
        LedgerRollups(null, 1.0, 2.0), LedgerCache(10L, 1.0, 1.0, 0.0, 0.5),
    )

    private fun live() { host.onConnected(); host.activate(true); calls.clear() }

    @Test fun attachSentOnceHoweverOftenCalled() {
        host.onConnected(); host.onConnected()
        host.activate(true); host.activate(true); host.onConnected()
        assertEquals(listOf("attach"), calls)
        assertEquals(LedgerUi.Loading, host.snapshot())
    }

    @Test fun activateBeforeConnectedWaitsThenAttaches() {
        host.activate(true)
        assertEquals(emptyList<String>(), calls)
        assertEquals(LedgerUi.Off, host.snapshot())
        host.onConnected()
        assertEquals(listOf("attach"), calls)
    }

    @Test fun deactivateSendsDetachOnceAndReturnsOffDroppingData() {
        live()
        host.onFrame(LedgerFrame.Snap(snap(9.0)))
        host.activate(false); host.activate(false)
        assertEquals(listOf("detach"), calls)
        assertEquals(LedgerUi.Off, host.snapshot())
    }

    @Test fun framesBeforeAttachAndAfterDetachAreDropped() {
        host.onConnected()
        host.onFrame(LedgerFrame.Snap(snap(1.0)))
        assertEquals(LedgerUi.Off, host.snapshot())
        host.activate(true)
        host.activate(false)
        host.onFrame(LedgerFrame.Snap(snap(2.0)))
        assertEquals(LedgerUi.Off, host.snapshot())
    }

    @Test fun nullSnapIsNoSnapshotThenReadyThenReplaced() {
        live()
        host.onFrame(LedgerFrame.Snap(null))
        assertEquals(LedgerUi.NoSnapshot, host.snapshot())
        host.onFrame(LedgerFrame.Snap(snap(1.0)))
        assertEquals(LedgerUi.Ready(snap(1.0), 5_000L), host.snapshot())
        clock = 9_000L
        host.onFrame(LedgerFrame.Snap(snap(2.0)))
        assertEquals(LedgerUi.Ready(snap(2.0), 9_000L), host.snapshot())
    }

    @Test fun disconnectDropsDataSendsNoDetachAndIgnoresLateFrame() {
        live()
        host.onFrame(LedgerFrame.Snap(snap(1.0)))
        host.onDisconnected()
        assertEquals(LedgerUi.Off, host.snapshot())
        host.onFrame(LedgerFrame.Snap(snap(2.0)))
        assertEquals(LedgerUi.Off, host.snapshot())
        assertEquals(emptyList<String>(), calls)
    }

    @Test fun failedAttachIsRetriedOnNextActivate() {
        attachResult = false
        host.onConnected(); host.activate(true)
        assertEquals(LedgerUi.Off, host.snapshot())
        attachResult = true
        host.activate(true)
        assertEquals(listOf("attach", "attach"), calls)
        assertEquals(LedgerUi.Loading, host.snapshot())
    }

    @Test fun throwingOnChangedDoesNotBreakHost() {
        live()
        throwOnChanged = true
        host.onFrame(LedgerFrame.Snap(snap(1.0)))
        assertTrue(host.snapshot() is LedgerUi.Ready)
        host.activate(false)
        assertEquals(LedgerUi.Off, host.snapshot())
    }
}
