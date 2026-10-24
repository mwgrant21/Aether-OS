package com.matt.aethermobile.auth

import com.matt.aethermobile.protocol.ControlProtocol
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketAddress
import javax.net.SocketFactory
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class PairingTest {
    private val host = "100.84.175.105"
    private val token = "A".repeat(43)

    // ---- QR parsing ----

    private fun qr(raw: String) = Pairing.parseQr(raw, host)

    @Test fun validQr() {
        assertEquals(
            QrResult.Ok(host, 47821, "ABCD2345"),
            qr("aethermobile://pair?host=$host&port=47821&code=ABCD-2345"),
        )
    }

    @Test fun lowercaseCodeIsNormalised() {
        assertEquals(
            QrResult.Ok(host, 47821, "ABCD2345"),
            qr("aethermobile://pair?host=$host&port=47821&code=abcd-2345"),
        )
    }

    @Test fun wrongHostIsRejectedEvenInsideTheTailnetRange() {
        assertEquals(QrResult.WrongHost, qr("aethermobile://pair?host=100.64.0.1&port=47821&code=ABCD-2345"))
        assertEquals(QrResult.WrongHost, qr("aethermobile://pair?host=$host.evil.com&port=47821&code=ABCD-2345"))
    }

    @Test fun wrongPort() {
        assertEquals(QrResult.WrongPort, qr("aethermobile://pair?host=$host&port=8080&code=ABCD-2345"))
    }

    @Test fun wrongSchemeOrAuthority() {
        assertEquals(QrResult.WrongScheme, qr("https://pair?host=$host&port=47821&code=ABCD-2345"))
        assertEquals(QrResult.WrongScheme, qr("AetherMobile://pair?host=$host&port=47821&code=ABCD-2345"))
        assertEquals(QrResult.Malformed, qr("aethermobile://other?host=$host&port=47821&code=ABCD-2345"))
    }

    @Test fun missingCode() {
        assertEquals(QrResult.BadCode, qr("aethermobile://pair?host=$host&port=47821"))
    }

    @Test fun badAlphabetAndLengthCodes() {
        assertEquals(QrResult.BadCode, qr("aethermobile://pair?host=$host&port=47821&code=ABCD-2341")) // '1'
        assertEquals(QrResult.BadCode, qr("aethermobile://pair?host=$host&port=47821&code=ABCD-OIL2")) // O I L
        assertEquals(QrResult.BadCode, qr("aethermobile://pair?host=$host&port=47821&code=ABCD-234"))
    }

    @Test fun trailingJunkIsRejected() {
        assertEquals(QrResult.BadCode, qr("aethermobile://pair?host=$host&port=47821&code=ABCD-2345xyz"))
        assertEquals(QrResult.Malformed, qr("aethermobile://pair?host=$host&port=47821&code=ABCD-2345&x=1"))
        assertEquals(QrResult.Malformed, qr("aethermobile://pair?host=$host&port=47821&code=ABCD-2345#frag"))
        assertEquals(QrResult.Malformed, qr("aethermobile://pair?host=$host&host=$host&port=47821&code=ABCD-2345"))
    }

    @Test fun manualCodeUsesTheSameRule() {
        assertEquals("ABCD2345", Pairing.parseManualCode(" abcd 2345 "))
        assertNull(Pairing.parseManualCode("ABCD-2341"))
    }

    // ---- HTTP client ----

    private lateinit var server: MockWebServer

    @Before fun start() {
        server = MockWebServer()
        server.start()
    }

    @After fun stop() {
        try { server.shutdown() } catch (_: Exception) {}
    }

    // OkHttp never consults Dns for an IP literal, so the fake tailnet address is
    // routed to the loopback mock at the socket layer; the production tailnet guard
    // stays in force.
    private val fakeTailnetHost = "100.64.1.2"

    private val loopbackSockets = object : SocketFactory() {
        private val real = getDefault()
        private fun redirecting() = object : Socket() {
            override fun connect(endpoint: SocketAddress, timeout: Int) {
                val a = endpoint as InetSocketAddress
                super.connect(InetSocketAddress(InetAddress.getLoopbackAddress(), a.port), timeout)
            }
        }
        override fun createSocket(): Socket = redirecting()
        override fun createSocket(h: String, p: Int): Socket = real.createSocket(h, p)
        override fun createSocket(h: String, p: Int, la: InetAddress, lp: Int): Socket = real.createSocket(h, p, la, lp)
        override fun createSocket(a: InetAddress, p: Int): Socket = real.createSocket(a, p)
        override fun createSocket(a: InetAddress, p: Int, la: InetAddress, lp: Int): Socket = real.createSocket(a, p, la, lp)
    }

    private fun client(readTimeoutMs: Long = 5_000L) =
        PairingClient(
            OkHttpClient.Builder()
                .socketFactory(loopbackSockets)
                .readTimeout(readTimeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
                .build(),
            fakeTailnetHost,
            server.port,
        )

    @Test fun requestShapeAndPairedMapping() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"token":"$token","expiresAtMs":1234567}"""))
        val r = client().pair("abcd2345")
        assertEquals(PairResult.Paired(token, 1234567L), r)
        val req = server.takeRequest()
        assertEquals("POST /api/device/pair HTTP/1.1", req.requestLine)
        assertEquals("""{"code":"ABCD-2345"}""", req.body.readUtf8())
        assertEquals("application/json", req.getHeader("Content-Type"))
        assertNull(req.getHeader("Origin"))
        assertNull(req.getHeader("Cookie"))
    }

    @Test fun statusMapping() {
        fun statusFor(code: Int): PairResult {
            server.enqueue(MockResponse().setResponseCode(code).setBody("{}"))
            return client().pair("ABCD2345")
        }
        assertEquals(PairResult.BadCode, statusFor(401))
        assertEquals(PairResult.Declined, statusFor(403))
        assertEquals(PairResult.Burned, statusFor(429))
        assertEquals(PairResult.Error(500), statusFor(500))
        assertEquals(PairResult.Error(400), statusFor(400))
    }

    @Test fun redirectsAreNotFollowed() {
        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "/elsewhere"))
        assertEquals(PairResult.Error(302), client().pair("ABCD2345"))
        assertEquals(1, server.requestCount)
    }

    @Test fun malformedOrOddOkBodiesAreErrors() {
        val bodies = listOf(
            "not json",
            """{"expiresAtMs":5}""",
            """{"token":"$token"}""",
            """{"token":"short","expiresAtMs":5}""",
            """{"token":"${"A".repeat(44)}","expiresAtMs":5}""",
            """{"token":"${"A".repeat(42)}!","expiresAtMs":5}""",
            """{"token":"$token","expiresAtMs":0}""",
            """{"token":7,"expiresAtMs":5}""",
        )
        for (b in bodies) {
            server.enqueue(MockResponse().setResponseCode(200).setBody(b))
            assertEquals(b, PairResult.Error(200), client().pair("ABCD2345"))
        }
    }

    @Test fun timeoutIsUnreachable() {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val c = PairingClient(
            OkHttpClient.Builder().socketFactory(loopbackSockets).build(),
            fakeTailnetHost,
            server.port,
            ControlProtocol::isTailnetHost,
            300L,
        )
        assertEquals(PairResult.Unreachable, c.pair("ABCD2345"))
    }

    @Test fun slowConfirmOutlivesInheritedReadTimeout() {
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setBody("""{"token":"$token","expiresAtMs":1234567}""")
                .setHeadersDelay(800, java.util.concurrent.TimeUnit.MILLISECONDS),
        )
        assertEquals(PairResult.Paired(token, 1234567L), client(200L).pair("ABCD2345"))
    }

    @Test fun nonIoTransportFailureIsUnreachable() {
        val boom = OkHttpClient.Builder()
            .addInterceptor { throw IllegalStateException("secret-token-text") }
            .build()
        val c = PairingClient(boom, fakeTailnetHost, server.port)
        assertEquals(PairResult.Unreachable, c.pair("ABCD2345"))
    }

    @Test fun connectionFailureIsUnreachable() {
        val c = client()
        server.shutdown()
        assertEquals(PairResult.Unreachable, c.pair("ABCD2345"))
    }

    @Test fun invalidCodeNeverReachesTheNetwork() {
        assertEquals(PairResult.BadCode, client().pair("ABCD-2341"))
        assertEquals(0, server.requestCount)
    }

    @Test fun nonTailnetHostIsRefusedWithoutAnyRequest() {
        // Production constructor: the real isTailnetHost guard applies to the loopback mock.
        val c = PairingClient(OkHttpClient.Builder().socketFactory(loopbackSockets).build(), server.hostName, server.port)
        assertEquals(PairResult.Unreachable, c.pair("ABCD2345"))
        assertEquals(0, server.requestCount)
        val tooHigh = PairingClient(OkHttpClient(), "100.128.0.0", 47821)
        assertTrue(tooHigh.pair("ABCD2345") == PairResult.Unreachable)
        assertEquals(0, server.requestCount)
    }

    @Test fun resultsRedactSecretsInToString() {
        val paired = PairResult.Paired(token, 99L).toString()
        assertTrue(paired, !paired.contains(token))
        val ok = QrResult.Ok(host, 47821, "ABCD2345").toString()
        assertTrue(ok, !ok.contains("ABCD2345"))
    }
}
