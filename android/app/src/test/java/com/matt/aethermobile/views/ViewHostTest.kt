package com.matt.aethermobile.views

import com.matt.aethermobile.protocol.ControlProtocol.ViewFrame
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ViewHostTest {
    private val calls = ArrayList<String>()
    private var clock = 5_000L
    private var attachResult = true
    private var throwOnChanged = false
    private var supported = true
    private var decodeThrows = false
    private val host = ViewHost<Int>(
        viewId = "projects",
        decode = { if (decodeThrows) throw IllegalStateException("boom") else if (it.has("n")) it.getInt("n") else null },
        supported = { supported },
        sendAttach = { calls.add("attach"); attachResult },
        sendDetach = { calls.add("detach"); true },
        now = { clock },
        onChanged = { if (throwOnChanged) throw IllegalStateException("boom") },
    )

    private fun frame(n: Int, v: String = "projects") = ViewFrame(v, JSONObject().put("n", n))
    private fun live() { host.onConnected(); host.activate(true); calls.clear() }

    @Test fun attachSentOnceHoweverOftenCalled() {
        host.onConnected(); host.onConnected()
        host.activate(true); host.activate(true); host.onConnected()
        assertEquals(listOf("attach"), calls)
        assertEquals(ViewUi.Loading, host.snapshot())
    }

    @Test fun activateBeforeConnectedWaitsThenAttaches() {
        host.activate(true)
        assertEquals(emptyList<String>(), calls)
        assertEquals(ViewUi.Off, host.snapshot())
        host.onConnected()
        assertEquals(listOf("attach"), calls)
    }

    @Test fun deactivateSendsDetachOnceAndReturnsOffDroppingData() {
        live()
        host.onFrame(frame(9))
        host.activate(false); host.activate(false)
        assertEquals(listOf("detach"), calls)
        assertEquals(ViewUi.Off, host.snapshot())
    }

    @Test fun framesBeforeAttachAfterDetachAndForOtherViewsAreDropped() {
        host.onConnected()
        host.onFrame(frame(1))
        assertEquals(ViewUi.Off, host.snapshot())
        host.activate(true)
        host.onFrame(frame(2, v = "memory"))
        assertEquals(ViewUi.Loading, host.snapshot())
        host.activate(false)
        host.onFrame(frame(3))
        assertEquals(ViewUi.Off, host.snapshot())
    }

    @Test fun nullDataIsNoSnapshotThenReadyThenReplaced() {
        live()
        host.onFrame(ViewFrame("projects", null))
        assertEquals(ViewUi.NoSnapshot, host.snapshot())
        host.onFrame(frame(1))
        assertEquals(ViewUi.Ready(1, 5_000L), host.snapshot())
        clock = 9_000L
        host.onFrame(frame(2))
        assertEquals(ViewUi.Ready(2, 9_000L), host.snapshot())
    }

    @Test fun disconnectDropsDataSendsNoDetachAndIgnoresLateFrame() {
        live()
        host.onFrame(frame(1))
        host.onDisconnected()
        assertEquals(ViewUi.Off, host.snapshot())
        host.onFrame(frame(2))
        assertEquals(ViewUi.Off, host.snapshot())
        assertEquals(emptyList<String>(), calls)
    }

    @Test fun failedAttachIsRetriedOnNextActivate() {
        attachResult = false
        host.onConnected(); host.activate(true)
        assertEquals(ViewUi.Off, host.snapshot())
        attachResult = true
        host.activate(true)
        assertEquals(listOf("attach", "attach"), calls)
        assertEquals(ViewUi.Loading, host.snapshot())
    }

    @Test fun throwingOnChangedDoesNotBreakHost() {
        live()
        throwOnChanged = true
        host.onFrame(frame(1))
        assertTrue(host.snapshot() is ViewUi.Ready<*>)
        host.activate(false)
        assertEquals(ViewUi.Off, host.snapshot())
    }

    @Test fun unsupportedViewShowsUnsupportedAndSendsNothingEvenOnDeactivate() {
        supported = false
        host.onConnected(); host.activate(true)
        assertEquals(ViewUi.Unsupported, host.snapshot())
        host.onFrame(frame(1))
        assertEquals(ViewUi.Unsupported, host.snapshot())
        host.activate(false)
        assertEquals(ViewUi.Off, host.snapshot())
        assertEquals(emptyList<String>(), calls)
    }

    @Test fun decoderNullOrThrowIsUnreadableAndALaterGoodFrameRecovers() {
        live()
        host.onFrame(ViewFrame("projects", JSONObject().put("other", 1)))
        assertEquals(ViewUi.Unreadable, host.snapshot())
        decodeThrows = true
        host.onFrame(frame(1))
        assertEquals(ViewUi.Unreadable, host.snapshot())
        decodeThrows = false
        host.onFrame(frame(2))
        assertEquals(ViewUi.Ready(2, 5_000L), host.snapshot())
        assertEquals(emptyList<String>(), calls)
    }
}
