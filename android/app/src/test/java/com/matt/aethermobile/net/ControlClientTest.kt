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

    override fun open(url: String, headers: Map<String, String>, listener: Transport.Listener) {
        opens++
        this.url = url
        this.headers = headers
        this.listener = listener
    }

    override fun send(text: String): Boolean { sent += text; return true }
    override fun close(code: Int, reason: String) { closes += code }
}

class ControlClientTest {
    private val transport = FakeTransport()
    private val states = mutableListOf<ControlState>()

    private fun client(host: String = HOST) = ControlClient(
        host = host,
        appVersion = "0.2.0-v1",
        transport = transport,
        onState = { states += it },
        nonceSource = { NONCE },
        epochSource = { EPOCH },
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
}
