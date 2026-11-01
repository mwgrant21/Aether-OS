package com.matt.aethermobile.ui.shell

import com.matt.aethermobile.net.ControlClient
import com.matt.aethermobile.net.Transport
import com.matt.aethermobile.protocol.ControlProtocol
import com.matt.aethermobile.views.ViewUi
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private const val HOST = "100.84.175.105"
private const val TOKEN = "unit-test-token-not-a-real-credential-00000"
private const val NONCE = "0123456789abcdef0123456789abcdef"
private const val EPOCH = "0123456789abcdef"

private class FakeTransport : Transport {
    val sent = mutableListOf<String>()
    var listener: Transport.Listener? = null
    override fun open(url: String, headers: Map<String, String>, listener: Transport.Listener) { this.listener = listener }
    override fun send(text: String): Boolean { sent += text; return true }
    override fun close(code: Int, reason: String) {}
}

/** PaneHosts is MainActivity's real wiring for pane feeds; these tests drive it with a real ControlClient. */
class PaneHostsTest {
    private val transport = FakeTransport()
    private var client: ControlClient? = null
    private val specs = listOf(
        PaneSpec(AppView.PROJECTS, "projects") { if (it.has("n")) it.getInt("n") else null },
        PaneSpec(AppView.MEMORY, "memory") { if (it.has("n")) it.getInt("n") else null },
    )
    private val hosts = PaneHosts(specs, { client })
    private val golden = JSONObject(java.io.File("../../protocol/mobile-protocol.json").readText(Charsets.UTF_8)).getJSONObject("frames")

    private fun connect(views: List<String>?) {
        val c = ControlClient(HOST, "0.2.0-v1", transport, nonceSource = { NONCE }, epochSource = { EPOCH })
        client = c
        c.connect(TOKEN)
        transport.listener!!.onOpen()
        val w = JSONObject().put("t", "welcome").put("v", 1).put("serverTimeMs", 1000L).put("expiresAtMs", 2000L)
            .put("sessions", JSONArray()).put("applied", JSONObject()).put("prompts", JSONArray())
            .put("proof", ControlProtocol.serverProof(TOKEN, NONCE))
        if (views != null) w.put("views", JSONArray(views))
        transport.listener!!.onMessage(w.toString())
        transport.sent.clear()
    }

    @Test fun preChannelWelcomeThroughTheRealWiringSendsNoViewAttach() {
        connect(null)
        hosts.sync(live = true, open = AppView.PROJECTS)
        assertEquals(emptyList<String>(), transport.sent)
        assertEquals(ViewUi.Unsupported, hosts.snapshots().getValue(AppView.PROJECTS))
        hosts.sync(live = true, open = AppView.TERMINAL)
        hosts.drop()
        assertEquals(emptyList<String>(), transport.sent)
    }

    @Test fun listedPaneAttachesOnlyTheOpenOneAndDetachesOnLeave() {
        connect(listOf("projects", "memory"))
        hosts.sync(true, AppView.PROJECTS)
        assertEquals(listOf(golden.getString("viewAttach")), transport.sent)
        assertEquals(ViewUi.Loading, hosts.snapshots().getValue(AppView.PROJECTS))
        assertEquals(ViewUi.Off, hosts.snapshots().getValue(AppView.MEMORY))
        transport.sent.clear()
        hosts.sync(true, AppView.TERMINAL)
        assertEquals(listOf(golden.getString("viewDetach")), transport.sent)
    }

    @Test fun framesReachOnlyTheirPaneAndLockDropsTheData() {
        connect(listOf("projects", "memory"))
        hosts.sync(true, AppView.PROJECTS)
        hosts.onFrame(ControlProtocol.ViewFrame("memory", JSONObject().put("n", 9)))
        assertEquals(ViewUi.Loading, hosts.snapshots().getValue(AppView.PROJECTS))
        hosts.onFrame(ControlProtocol.ViewFrame("projects", JSONObject().put("n", 3)))
        assertTrue(hosts.snapshots().getValue(AppView.PROJECTS) is ViewUi.Ready)
        hosts.drop()
        assertEquals(ViewUi.Off, hosts.snapshots().getValue(AppView.PROJECTS))
    }
}
