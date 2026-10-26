package com.matt.aethermobile

import com.matt.aethermobile.term.BridgeValidator
import com.matt.aethermobile.term.FakeTerminalSource
import com.matt.aethermobile.term.InputSender
import com.matt.aethermobile.term.PageMessage
import com.matt.aethermobile.term.RateLimiter
import com.matt.aethermobile.term.TerminalWebView
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeAndSourceTest {
    private fun parse(s: String?) = BridgeValidator.parse(s)

    @Test fun stdinBridgeMessageCarriesAStrictBoolean() {
        assertEquals("{\"t\":\"stdin\",\"on\":true}", com.matt.aethermobile.term.BridgeOut.stdin(true))
        assertEquals("{\"t\":\"stdin\",\"on\":false}", com.matt.aethermobile.term.BridgeOut.stdin(false))
    }

    @Test fun acceptsEachFixedMessageType() {
        assertEquals(PageMessage.Ready, parse("""{"t":"ready"}"""))
        assertEquals(PageMessage.Input("codex", "ls\r"), parse("""{"t":"input","s":"codex","d":"ls\r"}"""))
        assertEquals(PageMessage.Resize("claude", 80, 24), parse("""{"t":"resize","s":"claude","cols":80,"rows":24}"""))
        assertEquals(PageMessage.Consumed("terminal2", 12), parse("""{"t":"consumed","s":"terminal2","bytes":12}"""))
        assertEquals(PageMessage.Copy("x"), parse("""{"t":"copy","text":"x"}"""))
    }

    @Test fun rejectsUnknownTypesAndMalformedJson() {
        assertNull(parse("""{"t":"kill","s":"claude"}"""))
        assertNull(parse("""{"s":"claude"}"""))
        assertNull(parse("not json"))
        assertNull(parse(null))
        assertNull(parse("""["ready"]"""))
    }

    @Test fun rejectsUnknownSessionAndWrongTypes() {
        assertNull(parse("""{"t":"input","s":"powershell","d":"x"}"""))
        assertNull(parse("""{"t":"input","s":"claude","d":5}"""))
        assertNull(parse("""{"t":"input","s":"claude","d":""}"""))
        assertNull(parse("""{"t":"resize","s":"claude","cols":"80","rows":24}"""))
        assertNull(parse("""{"t":"resize","s":"claude","cols":80.5,"rows":24}"""))
        assertNull(parse("""{"t":"resize","s":"claude","cols":0,"rows":24}"""))
        assertNull(parse("""{"t":"resize","s":"claude","cols":501,"rows":24}"""))
        assertNull(parse("""{"t":"consumed","s":"claude","bytes":-1}"""))
    }

    @Test fun inputSizeCapIsInUtf8Bytes() {
        fun input(d: String) = JSONObject().put("t", "input").put("s", "claude").put("d", d).toString()
        // Over the sender's cap still parses, so the sender can refuse it visibly.
        assertNotNull(parse(input("a".repeat(InputSender.MAX_INPUT_BYTES + 1))))
        val ok = "a".repeat(BridgeValidator.MAX_INPUT_BYTES)
        assertNotNull(parse(input(ok)))
        assertNull(parse(input(ok + "a")))
        // Worst-case JSON escaping of a max paste (~393 K chars) stays under the raw cap.
        assertNotNull(parse(input("\u001b".repeat(InputSender.MAX_INPUT_BYTES))))
        // 131073 two-byte chars = 262146 bytes: under the char count, over the byte ceiling.
        assertNull(parse(input("\u00e9".repeat(BridgeValidator.MAX_INPUT_BYTES / 2 + 1))))
        assertNull(parse("x".repeat(BridgeValidator.MAX_RAW_CHARS + 1)))
    }

    @Test fun rateLimiterCapsPerSecondAndResetsOnNextWindow() {
        var now = 0L
        val rl = RateLimiter(3) { now }
        assertTrue(rl.allow()); assertTrue(rl.allow()); assertTrue(rl.allow())
        assertFalse(rl.allow())
        now = 999; assertFalse(rl.allow())
        now = 1000; assertTrue(rl.allow())
    }

    @Test fun fakeSourceEchoesWithStrictlyIncreasingSeq() {
        val src = FakeTerminalSource()
        val b = JSONObject(src.banner())
        assertEquals("out", b.getString("t")); assertEquals(1, b.getInt("q"))
        val a = JSONObject(src.onInput("hi")!!)
        assertEquals("hi", a.getString("d")); assertEquals(2, a.getInt("q"))
        assertEquals("claude", a.getString("s"))
    }

    @Test fun fakeSourceHandlesEnterBackspaceAndControlKeys() {
        val src = FakeTerminalSource()
        assertEquals("\r\n$ ", JSONObject(src.onInput("\r")!!).getString("d"))
        assertNull(src.onInput("\u007f")) // nothing to erase at line start
        src.onInput("ab")
        assertEquals("\b \b", JSONObject(src.onInput("\u007f")!!).getString("d"))
        assertEquals("^[", JSONObject(src.onInput("\u001b")!!).getString("d"))
    }

    @Test fun onlyTerminalAssetPathsOnTheAssetOriginAreServable() {
        val h = TerminalWebView.ASSET_HOST
        assertTrue(TerminalWebView.isServable("https", h, -1, "/terminal/index.html"))
        assertFalse(TerminalWebView.isServable("http", h, -1, "/terminal/index.html"))
        assertFalse(TerminalWebView.isServable("https", "example.com", -1, "/terminal/index.html"))
        assertFalse(TerminalWebView.isServable("https", h, 8443, "/terminal/index.html"))
        assertFalse(TerminalWebView.isServable("https", h, -1, "/other/x.js"))
        assertFalse(TerminalWebView.isServable("https", h, -1, "/terminal/../secret"))
        assertFalse(TerminalWebView.isServable("https", h, -1, null))
    }

    @Test fun pageUrlIsAllowListed() {
        assertEquals("https://appassets.androidplatform.net/terminal/index.html", TerminalWebView.pageUrl("index.html", false))
        assertNull(TerminalWebView.pageUrl("../x.html", true))
        assertNull(TerminalWebView.pageUrl("https://evil.example/", true))
        assertNull(TerminalWebView.pageUrl("navtest.html", false))
        assertEquals(
            "https://appassets.androidplatform.net/terminal/navtest.html",
            TerminalWebView.pageUrl("navtest.html", true),
        )
    }
}
