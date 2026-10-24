package com.matt.aethermobile.protocol

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.SecureRandom

class ControlProtocolTest {
    // Gradle runs unit tests with cwd = android/app.
    private val spec = JSONObject(File("../../protocol/mobile-protocol.json").readText(Charsets.UTF_8))
    private val vec = spec.getJSONObject("proof").getJSONObject("vectors")
    private val frames = spec.getJSONObject("frames")

    private fun strings(a: JSONArray) = (0 until a.length()).map { a.getString(it) }

    @Test fun constantsEqualTheSharedJson() {
        val pairing = spec.getJSONObject("pairing")
        val token = spec.getJSONObject("token")
        val limits = spec.getJSONObject("limits")
        val resp = spec.getJSONObject("pairResponses")
        val proof = spec.getJSONObject("proof")
        assertEquals(spec.getInt("v"), ControlProtocol.VERSION)
        assertEquals(spec.getInt("port"), ControlProtocol.PORT)
        assertEquals(spec.getJSONObject("paths").getString("ctl"), ControlProtocol.PATH_CTL)
        assertEquals(spec.getJSONObject("paths").getString("pair"), ControlProtocol.PATH_PAIR)
        assertEquals(spec.getJSONObject("auth").getString("scheme"), ControlProtocol.AUTH_SCHEME)
        assertEquals(pairing.getInt("codeLength"), ControlProtocol.CODE_LENGTH)
        assertEquals(pairing.getString("codeAlphabet"), ControlProtocol.CODE_ALPHABET)
        assertEquals(pairing.getLong("codeTtlMs"), ControlProtocol.CODE_TTL_MS)
        assertEquals(pairing.getInt("maxCodeFailures"), ControlProtocol.MAX_CODE_FAILURES)
        assertEquals(pairing.getInt("bodyCapBytes"), ControlProtocol.PAIR_BODY_CAP_BYTES)
        assertEquals(pairing.getLong("confirmTimeoutMs"), ControlProtocol.PAIR_CONFIRM_TIMEOUT_MS)
        assertEquals(token.getInt("bytes"), ControlProtocol.TOKEN_BYTES)
        assertEquals(token.getLong("slidingTtlMs"), ControlProtocol.SLIDING_TTL_MS)
        assertEquals(token.getLong("absoluteTtlMs"), ControlProtocol.ABSOLUTE_TTL_MS)
        assertEquals(limits.getLong("helloTimeoutMs"), ControlProtocol.HELLO_TIMEOUT_MS)
        assertEquals(limits.getInt("maxControlSockets"), ControlProtocol.MAX_CONTROL_SOCKETS)
        assertEquals(limits.getInt("ctlMaxPayloadBytes"), ControlProtocol.CTL_MAX_PAYLOAD_BYTES)
        assertEquals(limits.getLong("recheckMs"), ControlProtocol.RECHECK_MS)
        assertEquals(resp.getInt("ok"), ControlProtocol.PAIR_OK)
        assertEquals(resp.getInt("badCode"), ControlProtocol.PAIR_BAD_CODE)
        assertEquals(resp.getInt("declined"), ControlProtocol.PAIR_DECLINED)
        assertEquals(resp.getInt("burned"), ControlProtocol.PAIR_BURNED)
        assertEquals(proof.getString("label"), ControlProtocol.PROOF_LABEL)
        assertEquals(proof.getString("separator"), ControlProtocol.PROOF_SEPARATOR)
        assertEquals(proof.getString("suffix"), ControlProtocol.PROOF_SUFFIX)
        assertEquals(
            strings(spec.getJSONObject("messages").getJSONArray("byeReasons")),
            ControlProtocol.ByeReason.values().map { it.wire },
        )
    }

    @Test fun tokenKeyIsRawSha256OfTheToken() {
        val key = ControlProtocol.tokenKey(vec.getString("token"))
        assertEquals(32, key.size)
        assertEquals(vec.getString("tokenSha256Hex"), key.joinToString("") { "%02x".format(it) })
    }

    // The cross-language check: Node computed this vector, Kotlin must match it.
    @Test fun serverProofReproducesTheSharedVector() {
        assertEquals(
            vec.getString("proof"),
            ControlProtocol.serverProof(vec.getString("token"), vec.getString("nonce")),
        )
    }

    @Test fun serverProofChangesWithTokenAndNonce() {
        val good = vec.getString("proof")
        assertFalse(good == ControlProtocol.serverProof(vec.getString("token") + "x", vec.getString("nonce")))
        assertFalse(good == ControlProtocol.serverProof(vec.getString("token"), vec.getString("nonce").uppercase()))
    }

    @Test fun normaliseCodeAcceptsTypedForms() {
        assertEquals("ABCD2345", ControlProtocol.normaliseCode("abcd-2345"))
        assertEquals("ABCD2345", ControlProtocol.normaliseCode(" abcd 2345 "))
        assertEquals("ABCD2345", ControlProtocol.normaliseCode("ABCD–2345"))
        assertEquals("ABCD2345", ControlProtocol.normaliseCode("abcd—2345"))
        assertNull(ControlProtocol.normaliseCode("ABCD-234"))
        assertNull(ControlProtocol.normaliseCode("ABCD-23456"))
        assertNull(ControlProtocol.normaliseCode("ABCD-2I45")) // I is not in the alphabet
        assertNull(ControlProtocol.normaliseCode(""))
    }

    @Test fun isTailnetHostCoversTheCgnatRangeOnly() {
        for (h in listOf("100.64.0.0", "100.127.255.255", "100.84.175.105")) assertTrue(h, ControlProtocol.isTailnetHost(h))
        for (h in listOf(
            "100.63.255.255", "100.128.0.0", "192.168.1.1", "titan", "localhost", "",
            "100.84.175.105.evil.com", "100.84.175", "100.84.175.256", "100.84.175.-1", "100.84..1",
            "100.084.1.1x", "1000.84.1.1",
            "100.064.1.1", "100.84.0175.105", "100.84.01.1", "100.84.1.00", "100.00064.1.1",
        )) assertFalse(h, ControlProtocol.isTailnetHost(h))
    }

    @Test fun helloMatchesTheGoldenFrame() {
        val hello = ControlProtocol.buildHello("0.2.0-v1", "0123456789abcdef", "00112233445566778899aabbccddeeff")
        val golden = JSONObject(frames.getString("hello"))
        val got = JSONObject(hello)
        assertEquals(golden.keys().asSequence().toSet(), got.keys().asSequence().toSet())
        for (k in golden.keys()) assertEquals(k, golden.get(k), got.get(k))
    }

    @Test fun welcomeParsesGoldenAndIgnoresUnknownFields() {
        val w = ControlProtocol.parseWelcome(frames.getString("welcome"))!!
        assertEquals(vec.getString("proof"), w.proof)
        assertEquals(1790000000000L, w.serverTimeMs)
        assertEquals(1792592000000L, w.expiresAtMs)
        val extra = ControlProtocol.parseWelcome("""{"t":"welcome","proof":"ab","serverTimeMs":1,"expiresAtMs":2,"future":{"x":1}}""")!!
        assertEquals("ab", extra.proof)
    }

    @Test fun welcomeWithoutProofOrWrongTypeIsNull() {
        assertNull(ControlProtocol.parseWelcome("""{"t":"welcome","v":1,"serverTimeMs":1,"expiresAtMs":2}"""))
        assertNull(ControlProtocol.parseWelcome("""{"t":"welcome","proof":7}"""))
        assertNull(ControlProtocol.parseWelcome("""{"t":"bye","proof":"ab"}"""))
        assertNull(ControlProtocol.parseWelcome("not json"))
    }

    @Test fun byeParsesGoldenAndRejectsUnknown() {
        assertEquals(ControlProtocol.ByeReason.REVOKED, ControlProtocol.parseBye(frames.getString("bye")))
        for (r in ControlProtocol.ByeReason.values()) {
            assertEquals(r, ControlProtocol.parseBye("""{"t":"bye","reason":"${r.wire}"}"""))
        }
        assertNull(ControlProtocol.parseBye("""{"t":"bye","reason":"because"}"""))
        assertNull(ControlProtocol.parseBye("""{"t":"welcome","reason":"revoked"}"""))
        assertNull(ControlProtocol.parseBye("{"))
    }

    @Test fun epochAndNonceAreFreshLowercaseHexOfTheRightLength() {
        val rnd = SecureRandom()
        val e = ControlProtocol.newEpoch(rnd)
        val n = ControlProtocol.newNonce(rnd)
        assertTrue(Regex("^[0-9a-f]{16}$").matches(e))
        assertTrue(Regex("^[0-9a-f]{32}$").matches(n))
        assertFalse(n == ControlProtocol.newNonce(rnd))
        assertTrue(Regex("^[0-9a-f]{32}$").matches(ControlProtocol.newNonce()))
    }
}
