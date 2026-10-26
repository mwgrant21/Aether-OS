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
        assertEquals(resp.getInt("busy"), ControlProtocol.PAIR_BUSY)
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

    @Test fun terminalConstantsEqualTheSharedJson() {
        val term = spec.getJSONObject("terminals")
        assertEquals(term.getInt("chunkMaxBytes"), ControlProtocol.CHUNK_MAX_BYTES)
        assertEquals(term.getInt("ringBytes"), ControlProtocol.RING_BYTES)
        assertEquals(term.getInt("snapshotBytes"), ControlProtocol.SNAPSHOT_BYTES)
        assertEquals(term.getInt("snapshotScrollbackLines"), ControlProtocol.SNAPSHOT_SCROLLBACK_LINES)
        assertEquals(term.getInt("mirrorScrollbackLines"), ControlProtocol.MIRROR_SCROLLBACK_LINES)
        assertEquals(strings(term.getJSONArray("states")), ControlProtocol.SlotState.values().map { it.wire })
        val slots = term.getJSONArray("slots")
        assertEquals(slots.length(), ControlProtocol.SLOTS.size)
        for (i in 0 until slots.length()) {
            assertEquals(slots.getJSONObject(i).getString("s"), ControlProtocol.SLOTS[i].s)
            assertEquals(slots.getJSONObject(i).getString("label"), ControlProtocol.SLOTS[i].label)
        }
        val msgs = spec.getJSONObject("messages")
        assertEquals(listOf("hello", "attach", "detach", "in"), strings(msgs.getJSONArray("phoneToTitan")))
        assertEquals(listOf("welcome", "bye", "snap", "out", "size", "state", "ack", "nak"), strings(msgs.getJSONArray("titanToPhone")))
    }

    // Byte equality with the golden, not key-set equality: this is the TS/Kotlin agreement proof.
    @Test fun buildAttachAndDetachAreByteIdenticalToTheGoldens() {
        assertEquals(frames.getString("attach"), ControlProtocol.buildAttach("claude"))
        assertEquals(frames.getString("attachResume"), ControlProtocol.buildAttach("claude", 123))
        assertEquals(frames.getString("detach"), ControlProtocol.buildDetach("claude"))
    }

    @Test fun buildAttachOmitsQEntirelyWhenAbsent() {
        val absent = ControlProtocol.buildAttach("codex", null)
        assertFalse(absent, absent.contains("\"q\""))
        assertFalse(absent, absent.contains("null"))
        assertEquals("""{"t":"attach","s":"codex","q":0}""", ControlProtocol.buildAttach("codex", 0))
    }

    @Test fun buildAttachAndDetachRejectUnknownSlotsAndBadQ() {
        for (bad in listOf("", "Claude", "claude ", "bash")) {
            assertFailsIllegal { ControlProtocol.buildAttach(bad) }
            assertFailsIllegal { ControlProtocol.buildDetach(bad) }
        }
        assertFailsIllegal { ControlProtocol.buildAttach("claude", -1) }
        assertFailsIllegal { ControlProtocol.buildAttach("claude", 9_007_199_254_740_992L) }
    }

    private fun assertFailsIllegal(block: () -> Unit) {
        try { block() } catch (_: IllegalArgumentException) { return }
        throw AssertionError("expected IllegalArgumentException")
    }

    @Test fun terminalGoldensParse() {
        // The goldens contain JSON escapes (\u001b, \r\n); the parsed d is the real control bytes.
        assertEquals(
            ControlProtocol.TerminalFrame.Snap("claude", 124, 100, 30, "\u001b[1mhi\u001b[0m\r\n"),
            ControlProtocol.parseTerminalFrame(frames.getString("snap")),
        )
        assertEquals(
            ControlProtocol.TerminalFrame.Out("claude", 125, "\u001b[32mok\u001b[0m\r\n"),
            ControlProtocol.parseTerminalFrame(frames.getString("out")),
        )
        assertEquals(
            ControlProtocol.TerminalFrame.Size("claude", 120, 40),
            ControlProtocol.parseTerminalFrame(frames.getString("size")),
        )
        assertEquals(
            ControlProtocol.TerminalFrame.State("claude", ControlProtocol.SlotState.RUNNING),
            ControlProtocol.parseTerminalFrame(frames.getString("state")),
        )
    }

    @Test fun terminalFramesIgnoreUnknownFieldsButRejectMistypedOnes() {
        assertEquals(
            ControlProtocol.TerminalFrame.Out("codex", 4, "x"),
            ControlProtocol.parseTerminalFrame("""{"t":"out","s":"codex","q":4,"d":"x","future":[1]}"""),
        )
        val bad = listOf(
            """{"t":"out","s":"codex","q":4}""",                       // no d
            """{"t":"out","s":"codex","q":4,"d":5}""",                 // d not a string
            """{"t":"out","s":"codex","q":"4","d":"x"}""",             // q a string
            """{"t":"out","s":"codex","q":4.5,"d":"x"}""",             // q fractional
            """{"t":"out","s":"codex","q":4.0,"d":"x"}""",             // q a float literal
            """{"t":"out","s":"codex","q":-1,"d":"x"}""",              // q negative
            """{"t":"out","s":"codex","q":9007199254740992,"d":"x"}""", // q beyond 2^53-1
            """{"t":"out","s":"nope","q":4,"d":"x"}""",                // unknown slot
            """{"t":"out","q":4,"d":"x"}""",                           // no slot
            """{"t":"out","s":7,"q":4,"d":"x"}""",                     // slot not a string
            """{"t":"snap","s":"claude","q":1,"cols":100,"d":""}""",   // no rows
            """{"t":"snap","s":"claude","q":1,"cols":"100","rows":30,"d":""}""",
            """{"t":"snap","s":"claude","q":1,"cols":10.5,"rows":30,"d":""}""",
            """{"t":"snap","s":"claude","q":1,"cols":-1,"rows":30,"d":""}""",
            """{"t":"size","s":"claude","cols":120}""",
            """{"t":"size","s":"claude","cols":120,"rows":null}""",
            """{"t":"state","s":"claude","state":"paused"}""",
            """{"t":"state","s":"claude"}""",
            """{"t":"hello","s":"claude"}""",
            """{"t":"welcome","proof":"ab"}""",
            """{"s":"claude","q":1,"d":"x"}""",
            "not json",
            "",
        )
        for (f in bad) assertNull(f, ControlProtocol.parseTerminalFrame(f))
    }

    @Test fun welcomeSessionsGoldenParsesToThreeSessionInfos() {
        val w = ControlProtocol.parseWelcome(frames.getString("welcomeSessions"))!!
        assertEquals(
            listOf(
                ControlProtocol.SessionInfo("claude", "Terminal", ControlProtocol.SlotState.RUNNING, 100, 30, 12),
                ControlProtocol.SessionInfo("terminal2", "Terminal 2", ControlProtocol.SlotState.NOT_STARTED, 0, 0, 0),
                ControlProtocol.SessionInfo("codex", "Codex", ControlProtocol.SlotState.EXITED, 80, 24, 5),
            ),
            w.sessions,
        )
        assertEquals(vec.getString("proof"), w.proof)
        assertEquals(emptyList<ControlProtocol.SessionInfo>(), ControlProtocol.parseWelcome(frames.getString("welcome"))!!.sessions)
    }

    @Test fun malformedSessionEntriesAreSkippedNotFatal() {
        val w = ControlProtocol.parseWelcome(
            """{"t":"welcome","proof":"ab","sessions":[{"s":"claude","label":"T","state":"running","cols":1.5,"rows":2,"q":0},""" +
                """{"s":"nope","label":"T","state":"running","cols":1,"rows":2,"q":0},7,""" +
                """{"s":"codex","label":"Codex","state":"running","cols":1,"rows":2,"q":3}]}""",
        )!!
        assertEquals(listOf("codex"), w.sessions.map { it.s })
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

    @Test fun buildInIsByteIdenticalToTheGolden() {
        assertEquals(frames.getString("in"), ControlProtocol.buildIn("claude", 1, "echo hi\r"))
    }

    @Test fun buildInEscapesQuotesBackslashEscAndKeepsNonBmp() {
        val d = "a\"b\\\u001b[A😀"
        val built = ControlProtocol.buildIn("codex", 7, d)
        val o = JSONObject(built)
        assertEquals(d, o.getString("d"))
        assertEquals(7, o.getInt("c"))
        assertTrue(built, built.contains("\\u001b"))
        assertTrue(built.startsWith("""{"t":"in","s":"codex","c":7,"d":"a\"b\\"""))
    }

    @Test fun buildInRejectsUnknownSlotBadCseqAndEmptyInput() {
        assertFailsIllegal { ControlProtocol.buildIn("bash", 1, "x") }
        assertFailsIllegal { ControlProtocol.buildIn("claude", 0, "x") }
        assertFailsIllegal { ControlProtocol.buildIn("claude", 9_007_199_254_740_992L, "x") }
        assertFailsIllegal { ControlProtocol.buildIn("claude", 1, "") }
    }

    @Test fun ackGoldenParsesAndBadAcksAreNull() {
        assertEquals(ControlProtocol.TerminalFrame.Ack("claude", 3), ControlProtocol.parseTerminalFrame(frames.getString("ack")))
        for (bad in listOf(
            """{"t":"ack","s":"claude","c":0}""",
            """{"t":"ack","s":"claude","c":1.5}""",
            """{"t":"ack","s":"claude","c":"3"}""",
            """{"t":"ack","s":"claude"}""",
            """{"t":"ack","s":"bash","c":1}""",
        )) assertNull(bad, ControlProtocol.parseTerminalFrame(bad))
    }

    @Test fun nakGoldensParseAndBadNaksAreNull() {
        assertEquals(
            ControlProtocol.TerminalFrame.Nak("claude", 4, ControlProtocol.NakReason.NOT_RUNNING),
            ControlProtocol.parseTerminalFrame(frames.getString("nakNotRunning")),
        )
        assertEquals(
            ControlProtocol.TerminalFrame.Nak("terminal2", 9, ControlProtocol.NakReason.TYPING_OFF),
            ControlProtocol.parseTerminalFrame(frames.getString("nakTypingOff")),
        )
        for (bad in listOf(
            """{"t":"nak","s":"claude","c":4,"reason":"bogus"}""",
            """{"t":"nak","s":"claude","c":4}""",
            """{"t":"nak","s":"claude","c":0,"reason":"not-running"}""",
            """{"t":"nak","s":"claude","c":1.5,"reason":"not-running"}""",
            """{"t":"nak","s":"bash","c":1,"reason":"not-running"}""",
        )) assertNull(bad, ControlProtocol.parseTerminalFrame(bad))
    }

    @Test fun welcomeAppliedGoldenParsesAndOmittedMeansEmpty() {
        assertEquals(mapOf("claude" to 3L), ControlProtocol.parseWelcome(frames.getString("welcomeApplied"))!!.applied)
        assertEquals(emptyMap<String, Long>(), ControlProtocol.parseWelcome(frames.getString("welcome"))!!.applied)
        val w = ControlProtocol.parseWelcome("""{"t":"welcome","proof":"ab","applied":{"bash":2,"codex":1.5,"claude":4}}""")!!
        assertEquals(mapOf("claude" to 4L), w.applied)
    }
}
