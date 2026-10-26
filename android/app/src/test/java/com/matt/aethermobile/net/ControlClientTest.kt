package com.matt.aethermobile.net

import com.matt.aethermobile.protocol.ControlProtocol
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

private const val HOST = "100.84.175.105"
private const val TOKEN = "unit-test-token-not-a-real-credential-00000"
private const val NONCE = "00112233445566778899aabbccddeeff"
private const val EPOCH = "0123456789abcdef"

private class FakeTransport : Transport {
    var opens = 0
    var url: String? = null
    var headers: Map<String, String>? = null
    val sent = mutableListOf<String>()
    val closes = mutableListOf<Int>()
    var listener: Transport.Listener? = null

    var openThrows: Throwable? = null

    override fun open(url: String, headers: Map<String, String>, listener: Transport.Listener) {
        opens++
        openThrows?.let { throw it }
        this.url = url
        this.headers = headers
        this.listener = listener
    }

    override fun send(text: String): Boolean { sent += text; return true }
    override fun close(code: Int, reason: String) { closes += code }
}

private class FakeScheduler {
    var delayMs: Long? = null
    var task: (() -> Unit)? = null
    var cancelled = false
    val schedule: (Long, () -> Unit) -> (() -> Unit) = { d, t ->
        delayMs = d
        task = t
        cancelled = false
        ({ cancelled = true })
    }
}

class ControlClientTest {
    private val transport = FakeTransport()
    private val states = mutableListOf<ControlState>()
    private val scheduler = FakeScheduler()

    private val frames = mutableListOf<ControlProtocol.TerminalFrame>()

    private fun client(host: String = HOST) = ControlClient(
        host = host,
        appVersion = "0.2.0-v1",
        transport = transport,
        onState = { states += it },
        onFrame = { frames += it },
        nonceSource = { NONCE },
        epochSource = { EPOCH },
        scheduler = scheduler.schedule,
    )

    private fun welcome(proof: String?): String {
        val o = JSONObject().put("t", "welcome").put("v", 1)
            .put("serverTimeMs", 1000L).put("expiresAtMs", 2000L)
            .put("sessions", org.json.JSONArray()).put("applied", JSONObject()).put("prompts", org.json.JSONArray())
        if (proof != null) o.put("proof", proof)
        return o.toString()
    }

    private fun bye(reason: String) = """{"t":"bye","reason":"$reason"}"""

    private fun opened(): ControlClient {
        val c = client()
        c.connect(TOKEN)
        transport.listener!!.onOpen()
        return c
    }

    @Test fun helloIsTheFirstAndOnlyFrameAndHeaderCarriesTheToken() {
        val c = opened()
        assertEquals(1, transport.sent.size)
        assertEquals(ControlProtocol.buildHello("0.2.0-v1", EPOCH, NONCE), transport.sent[0])
        assertEquals("ws://$HOST:47821/ctl", transport.url)
        assertEquals(mapOf("Authorization" to "Bearer $TOKEN"), transport.headers)
        assertFalse(transport.url!!.contains(TOKEN))
        transport.listener!!.onMessage(welcome(ControlProtocol.serverProof(TOKEN, NONCE)))
        assertEquals(1, transport.sent.size)
        assertTrue(c.state is ControlState.Connected)
    }

    @Test fun correctProofConnects() {
        val c = opened()
        transport.listener!!.onMessage(welcome(ControlProtocol.serverProof(TOKEN, NONCE)))
        assertEquals(ControlState.Connected(2000L, 1000L), c.state)
        assertTrue(transport.closes.isEmpty())
    }

    @Test fun randomWellFormedProofIsRejectedAndClosed1008() {
        val c = opened()
        transport.listener!!.onMessage(welcome("ab".repeat(32)))
        assertEquals(ControlState.Failed(Failure.ProofMismatch), c.state)
        assertEquals(listOf(1008), transport.closes)
        assertFalse(states.any { it is ControlState.Connected })
    }

    @Test fun oneFlippedHexDigitIsRejected() {
        val good = ControlProtocol.serverProof(TOKEN, NONCE)
        for (i in listOf(0, good.length / 2, good.length - 1)) {
            val flipped = good.substring(0, i) + (if (good[i] == '0') '1' else '0') + good.substring(i + 1)
            val t = FakeTransport()
            val c = ControlClient(HOST, "0.2.0-v1", t, nonceSource = { NONCE }, epochSource = { EPOCH })
            c.connect(TOKEN)
            t.listener!!.onOpen()
            t.listener!!.onMessage(welcome(flipped))
            assertEquals("index $i", ControlState.Failed(Failure.ProofMismatch), c.state)
            assertEquals(listOf(1008), t.closes)
        }
    }

    @Test fun missingOrEmptyProofIsRejected() {
        for (frame in listOf(welcome(null), welcome(""))) {
            val t = FakeTransport()
            val c = ControlClient(HOST, "0.2.0-v1", t, nonceSource = { NONCE }, epochSource = { EPOCH })
            c.connect(TOKEN)
            t.listener!!.onOpen()
            t.listener!!.onMessage(frame)
            assertEquals(ControlState.Failed(Failure.ProofMismatch), c.state)
            assertEquals(listOf(1008), t.closes)
        }
    }

    @Test fun proofForADifferentNonceIsRejected() {
        val c = opened()
        transport.listener!!.onMessage(welcome(ControlProtocol.serverProof(TOKEN, "f".repeat(32))))
        assertEquals(ControlState.Failed(Failure.ProofMismatch), c.state)
    }

    @Test fun welcomeBeforeHelloIsSentIsAProtocolError() {
        val c = client()
        c.connect(TOKEN)
        transport.listener!!.onMessage(welcome(ControlProtocol.serverProof(TOKEN, NONCE)))
        assertEquals(ControlState.Failed(Failure.Protocol), c.state)
        assertEquals(listOf(1008), transport.closes)
        assertTrue(transport.sent.isEmpty())
    }

    @Test fun unknownOrMalformedFramesCloseWith1008() {
        for (frame in listOf("""{"t":"input","data":"x"}""", "not json", "{}")) {
            val t = FakeTransport()
            val c = ControlClient(HOST, "0.2.0-v1", t, nonceSource = { NONCE }, epochSource = { EPOCH })
            c.connect(TOKEN)
            t.listener!!.onOpen()
            t.listener!!.onMessage(frame)
            assertEquals(ControlState.Failed(Failure.Protocol), c.state)
            assertEquals(listOf(1008), t.closes)
        }
    }

    @Test fun secondWelcomeAfterConnectedIsAProtocolError() {
        val c = opened()
        val w = welcome(ControlProtocol.serverProof(TOKEN, NONCE))
        transport.listener!!.onMessage(w)
        transport.listener!!.onMessage(w)
        assertEquals(ControlState.Failed(Failure.Protocol), c.state)
        assertEquals(listOf(1008), transport.closes)
    }

    @Test fun byeReasonsMapToStates() {
        val table = mapOf(
            "revoked" to ControlState.Revoked,
            "expired" to ControlState.Revoked,
            "superseded" to ControlState.Superseded,
            "disabled" to ControlState.Disabled,
            "policy" to ControlState.Closed("policy"),
            "slow-consumer" to ControlState.Closed("slow-consumer"),
            "rate-limit" to ControlState.Closed("rate-limit"),
        )
        for ((reason, expected) in table) {
            val t = FakeTransport()
            val c = ControlClient(HOST, "0.2.0-v1", t, nonceSource = { NONCE }, epochSource = { EPOCH })
            c.connect(TOKEN)
            t.listener!!.onOpen()
            t.listener!!.onMessage(welcome(ControlProtocol.serverProof(TOKEN, NONCE)))
            t.listener!!.onMessage(bye(reason))
            assertEquals(reason, expected, c.state)
        }
    }

    @Test fun byeBeforeWelcomeIsHonoured() {
        val c = opened()
        transport.listener!!.onMessage(bye("superseded"))
        assertEquals(ControlState.Superseded, c.state)
    }

    @Test fun byeWinsOverALaterTransportCloseOrFailure() {
        val c = opened()
        transport.listener!!.onMessage(bye("revoked"))
        transport.listener!!.onClosed(1006, "gone")
        transport.listener!!.onFailure(null, java.io.IOException("reset"))
        assertEquals(ControlState.Revoked, c.state)
        assertEquals(1, states.count { it == ControlState.Revoked })
        assertEquals(ControlState.Revoked, states.last())
    }

    @Test fun httpStatusOnUpgradeIsMapped() {
        val table = mapOf(
            401 to ControlState.Revoked,
            404 to ControlState.Failed(Failure.NotListening),
            503 to ControlState.Failed(Failure.Busy),
            500 to ControlState.Failed(Failure.Protocol),
        )
        for ((status, expected) in table) {
            val t = FakeTransport()
            val c = ControlClient(HOST, "0.2.0-v1", t, nonceSource = { NONCE }, epochSource = { EPOCH })
            c.connect(TOKEN)
            t.listener!!.onFailure(status, null)
            assertEquals("status $status", expected, c.state)
        }
    }

    @Test fun transportErrorsWithoutAStatusAreMapped() {
        val refused = client().also { it.connect(TOKEN) }
        transport.listener!!.onFailure(null, ConnectException("refused"))
        assertEquals(ControlState.Failed(Failure.ConnectionRefused), refused.state)

        val t = FakeTransport()
        val timeout = ControlClient(HOST, "0.2.0-v1", t, nonceSource = { NONCE }, epochSource = { EPOCH })
        timeout.connect(TOKEN)
        t.listener!!.onFailure(null, SocketTimeoutException("timed out"))
        assertEquals(ControlState.Failed(Failure.Unreachable), timeout.state)
    }

    @Test fun plainTransportCloseAfterConnectedIsClosed() {
        val c = opened()
        transport.listener!!.onMessage(welcome(ControlProtocol.serverProof(TOKEN, NONCE)))
        transport.listener!!.onClosed(1006, "")
        assertEquals(ControlState.Closed("transport"), c.state)
    }

    @Test fun nonTailnetHostIsRefusedWithZeroTransportCalls() {
        for (host in listOf("8.8.8.8", "192.168.1.1", "100.63.255.255", "100.128.0.0", "example.com", "", "100.84.175.105.evil.com")) {
            val t = FakeTransport()
            val c = ControlClient(host, "0.2.0-v1", t, nonceSource = { NONCE }, epochSource = { EPOCH })
            c.connect(TOKEN)
            assertEquals(host, ControlState.Failed(Failure.HostRefused), c.state)
            assertEquals(0, t.opens)
            assertTrue(t.sent.isEmpty())
            assertTrue(t.closes.isEmpty())
        }
    }

    @Test fun connectWhileConnectingDoesNotOpenASecondSocket() {
        val c = client()
        c.connect(TOKEN)
        c.connect(TOKEN)
        assertEquals(1, transport.opens)
    }

    @Test fun localCloseEndsQuietly() {
        val c = opened()
        c.close()
        assertEquals(ControlState.Closed("local"), c.state)
        assertEquals(listOf(1000), transport.closes)
    }

    @Test fun realUpgradeCarriesAuthorizationAndNoOrigin() {
        val server = MockWebServer()
        val firstFrame = LinkedBlockingQueue<String>()
        val opened = CountDownLatch(1)
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { opened.countDown() }
            override fun onMessage(webSocket: WebSocket, text: String) { firstFrame.add(text) }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
        }))
        server.start()
        try {
            val events = LinkedBlockingQueue<String>()
            val transport = OkHttpTransport()
            transport.open(
                "ws://${server.hostName}:${server.port}/ctl",
                mapOf("Authorization" to "Bearer $TOKEN"),
                object : Transport.Listener {
                    override fun onOpen() { events.add("open") }
                    override fun onMessage(text: String) { events.add("msg") }
                    override fun onClosed(code: Int, reason: String) { events.add("closed") }
                    override fun onFailure(httpStatus: Int?, error: Throwable?) { events.add("fail") }
                },
            )
            assertEquals("open", events.poll(5, TimeUnit.SECONDS))
            assertTrue(transport.send("""{"t":"hello"}"""))
            assertEquals("""{"t":"hello"}""", firstFrame.poll(5, TimeUnit.SECONDS))
            val req = server.takeRequest(5, TimeUnit.SECONDS)
            assertNotNull(req)
            assertEquals("Bearer $TOKEN", req!!.getHeader("Authorization"))
            assertNull(req.getHeader("Origin"))
            assertFalse(req.path!!.contains(TOKEN))
            transport.close(1000, "")
        } finally {
            server.shutdown()
        }
    }

    @Test fun realUpgradeRejectedWith401ReportsTheStatus() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(401))
        server.start()
        try {
            val status = LinkedBlockingQueue<Int>()
            OkHttpTransport().open(
                "ws://${server.hostName}:${server.port}/ctl",
                mapOf("Authorization" to "Bearer $TOKEN"),
                object : Transport.Listener {
                    override fun onOpen() {}
                    override fun onMessage(text: String) {}
                    override fun onClosed(code: Int, reason: String) {}
                    override fun onFailure(httpStatus: Int?, error: Throwable?) { status.add(httpStatus ?: -1) }
                },
            )
            assertEquals(401, status.poll(5, TimeUnit.SECONDS))
        } finally {
            server.shutdown()
        }
    }

    @Test fun openThrowingFailsUnreachableWithoutStickingInConnecting() {
        transport.openThrows = IllegalStateException("secret-in-message $TOKEN")
        val c = client()
        c.connect(TOKEN)
        assertEquals(ControlState.Failed(Failure.Unreachable), c.state)
        assertFalse(states.toString().contains("secret-in-message"))
        transport.openThrows = null
        c.connect(TOKEN)
        assertEquals(2, transport.opens)
    }

    @Test fun welcomeBeforeTheDeadlineCancelsTheWatchdog() {
        val c = opened()
        assertEquals(8_000L, scheduler.delayMs)
        transport.listener!!.onMessage(welcome(ControlProtocol.serverProof(TOKEN, NONCE)))
        assertTrue(scheduler.cancelled)
        assertTrue(c.state is ControlState.Connected)
        assertTrue(transport.closes.isEmpty())
    }

    @Test fun noWelcomeFiresTheWatchdogAsProtocolFailure() {
        val c = opened()
        assertFalse(scheduler.cancelled)
        scheduler.task!!.invoke()
        assertEquals(ControlState.Failed(Failure.Protocol), c.state)
        assertEquals(listOf(1008), transport.closes)
    }

    @Test fun endingTheConnectionCancelsTheWatchdog() {
        val c = opened()
        c.close()
        assertTrue(scheduler.cancelled)
    }

    @Test fun watchdogTaskAlreadyRunningCannotFailAWelcomedSession() {
        val c = opened()
        transport.listener!!.onMessage(welcome(ControlProtocol.serverProof(TOKEN, NONCE)))
        scheduler.task!!.invoke()
        assertTrue(c.state is ControlState.Connected)
        assertTrue(transport.closes.isEmpty())
    }

    private val golden = JSONObject(java.io.File("../../protocol/mobile-protocol.json").readText(Charsets.UTF_8)).getJSONObject("frames")

    private fun connected(): ControlClient {
        val c = opened()
        transport.listener!!.onMessage(welcome(ControlProtocol.serverProof(TOKEN, NONCE)))
        assertTrue(c.state is ControlState.Connected)
        return c
    }

    @Test fun framesReachOnFrameInOrderAfterConnected() {
        connected()
        val l = transport.listener!!
        l.onMessage(golden.getString("snap"))
        l.onMessage(golden.getString("out"))
        l.onMessage(golden.getString("size"))
        l.onMessage(golden.getString("state"))
        assertEquals(
            listOf(
                ControlProtocol.TerminalFrame.Snap("claude", 124, 100, 30, "\u001b[1mhi\u001b[0m\r\n"),
                ControlProtocol.TerminalFrame.Out("claude", 125, "\u001b[32mok\u001b[0m\r\n"),
                ControlProtocol.TerminalFrame.Size("claude", 120, 40),
                ControlProtocol.TerminalFrame.State("claude", ControlProtocol.SlotState.RUNNING),
            ),
            frames,
        )
        assertTrue(transport.closes.isEmpty())
    }

    @Test fun welcomeSessionsRideOnConnected() {
        val c = opened()
        val w = JSONObject(golden.getString("welcomeSessions")).put("proof", ControlProtocol.serverProof(TOKEN, NONCE))
        transport.listener!!.onMessage(w.toString())
        assertEquals(3, (c.state as ControlState.Connected).sessions.size)
        assertEquals("terminal2", (c.state as ControlState.Connected).sessions[1].s)
    }

    @Test fun terminalFrameBeforeTheProofVerifiesIsAProtocolFailure() {
        for (f in listOf("snap", "out", "size", "state")) {
            val t = FakeTransport()
            val seen = mutableListOf<ControlProtocol.TerminalFrame>()
            val c = ControlClient(HOST, "0.2.0-v1", t, onFrame = { seen += it }, nonceSource = { NONCE }, epochSource = { EPOCH })
            c.connect(TOKEN)
            t.listener!!.onOpen()
            t.listener!!.onMessage(golden.getString(f))
            assertEquals(f, ControlState.Failed(Failure.Protocol), c.state)
            assertEquals(f, listOf(1008), t.closes)
            assertTrue(f, seen.isEmpty())
        }
    }

    @Test fun malformedTerminalFrameClosesWith1008AndIsNotDelivered() {
        val c = connected()
        transport.listener!!.onMessage("""{"t":"out","s":"claude","q":"125","d":"x"}""")
        assertEquals(ControlState.Failed(Failure.Protocol), c.state)
        assertEquals(listOf(1008), transport.closes)
        assertTrue(frames.isEmpty())
    }

    @Test fun unknownSlotTerminalFrameClosesWith1008() {
        val c = connected()
        transport.listener!!.onMessage("""{"t":"state","s":"bash","state":"running"}""")
        assertEquals(ControlState.Failed(Failure.Protocol), c.state)
        assertEquals(listOf(1008), transport.closes)
    }

    @Test fun attachAndDetachBeforeConnectedReturnFalseAndSendNothing() {
        val idle = client()
        assertFalse(idle.attach("claude", null))
        assertFalse(idle.detach("claude"))
        assertTrue(transport.sent.isEmpty())
        val c = opened() // hello sent, welcome not yet verified
        val helloOnly = transport.sent.toList()
        assertFalse(c.attach("claude", 3))
        assertFalse(c.detach("claude"))
        assertEquals(helloOnly, transport.sent)
    }

    @Test fun attachAndDetachSendTheExactBytesWhenConnected() {
        val c = connected()
        val before = transport.sent.size
        assertTrue(c.attach("claude", null))
        assertTrue(c.attach("claude", 123))
        assertTrue(c.detach("claude"))
        assertEquals(
            listOf(golden.getString("attach"), golden.getString("attachResume"), golden.getString("detach")),
            transport.sent.drop(before),
        )
    }

    @Test fun attachWithAnUnknownSlotOrBadQSendsNothing() {
        val c = connected()
        val before = transport.sent.size
        assertFalse(c.attach("bash", null))
        assertFalse(c.attach("claude", -1))
        assertFalse(c.detach("bash"))
        assertEquals(before, transport.sent.size)
    }

    @Test fun attachAfterTheConnectionEndedReturnsFalse() {
        val c = connected()
        transport.listener!!.onMessage(bye("revoked"))
        val before = transport.sent.size
        assertFalse(c.attach("claude", null))
        assertEquals(before, transport.sent.size)
    }

    @Test fun anOnFrameCallbackMayCallAttachWithoutDeadlock() {
        val t = FakeTransport()
        lateinit var c: ControlClient
        c = ControlClient(HOST, "0.2.0-v1", t, onFrame = { c.attach(it.s, null) }, nonceSource = { NONCE }, epochSource = { EPOCH })
        c.connect(TOKEN)
        t.listener!!.onOpen()
        t.listener!!.onMessage(welcome(ControlProtocol.serverProof(TOKEN, NONCE)))
        t.listener!!.onMessage(golden.getString("out"))
        assertEquals(golden.getString("attach"), t.sent.last())
    }

    @Test fun sendInputBeforeConnectedAndAfterCloseReturnsFalseAndSendsNothing() {
        val idle = client()
        assertFalse(idle.sendInput("claude", 1, "x"))
        assertTrue(transport.sent.isEmpty())
        val c = opened() // hello sent, welcome not yet verified
        val helloOnly = transport.sent.toList()
        assertFalse(c.sendInput("claude", 1, "x"))
        assertEquals(helloOnly, transport.sent)
        val d = connected()
        d.close()
        val before = transport.sent.size
        assertFalse(d.sendInput("claude", 1, "x"))
        assertEquals(before, transport.sent.size)
    }

    @Test fun sendInputPutsExactlyOneGoldenFrameOnTheTransportWhenConnected() {
        val c = connected()
        val before = transport.sent.size
        assertTrue(c.sendInput("claude", 1, "echo hi\r"))
        assertEquals(listOf(golden.getString("in")), transport.sent.drop(before))
        assertFalse(c.sendInput("bash", 2, "x"))
        assertFalse(c.sendInput("claude", 0, "x"))
        assertEquals(before + 1, transport.sent.size)
    }

    @Test fun ackFrameIsDeliveredToOnFrame() {
        connected()
        transport.listener!!.onMessage(golden.getString("ack"))
        assertEquals(listOf<ControlProtocol.TerminalFrame>(ControlProtocol.TerminalFrame.Ack("claude", 3)), frames)
        assertTrue(transport.closes.isEmpty())
    }

    @Test fun nakFrameIsDeliveredAndKeepsTheConnectionUp() {
        val c = connected()
        transport.listener!!.onMessage(golden.getString("nakNotRunning"))
        assertEquals(
            listOf<ControlProtocol.TerminalFrame>(ControlProtocol.TerminalFrame.Nak("claude", 4, ControlProtocol.NakReason.NOT_RUNNING)),
            frames,
        )
        assertTrue(c.state is ControlState.Connected)
        assertTrue(transport.closes.isEmpty())
    }

    @Test fun nakWithBogusReasonFailsAsProtocol() {
        val c = connected()
        transport.listener!!.onMessage("""{"t":"nak","s":"claude","c":4,"reason":"bogus"}""")
        assertEquals(ControlState.Failed(Failure.Protocol), c.state)
        assertTrue(frames.isEmpty())
    }

    @Test fun unknownFrameTypeStillFailsAsProtocol() {
        val c = connected()
        transport.listener!!.onMessage("""{"t":"bogus","s":"claude"}""")
        assertEquals(ControlState.Failed(Failure.Protocol), c.state)
    }
}
