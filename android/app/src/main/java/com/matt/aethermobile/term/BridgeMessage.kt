package com.matt.aethermobile.term

import com.matt.aethermobile.diag.DiagEvent
import com.matt.aethermobile.diag.PageAction
import com.matt.aethermobile.diag.PageKind
import com.matt.aethermobile.diag.PagePointer
import org.json.JSONObject

/** The fixed set of page -> Kotlin messages (design spec 4.4). Anything else is dropped. */
sealed class PageMessage {
    object Ready : PageMessage()
    data class Input(val session: String, val data: String) : PageMessage()
    data class Resize(val session: String, val cols: Int, val rows: Int) : PageMessage()
    data class Consumed(val session: String, val bytes: Int) : PageMessage()
    data class Copy(val text: String) : PageMessage()
}

/**
 * Strict validator for everything the WebView page sends over the bridge. The page is
 * treated as untrusted (hostile terminal output runs in it): exact types, bounded sizes,
 * a closed session-id set, and no field is ever interpreted as code or a path.
 */
object BridgeValidator {
    val SESSIONS = setOf("claude", "terminal2", "codex")
    /** Hostile-page ceiling, deliberately above InputSender's cap so an over-cap paste reaches the sender and is reported. */
    const val MAX_INPUT_BYTES = 256 * 1024
    const val MAX_COPY_BYTES = 64 * 1024
    /** JSON-escape worst case: every char of a max paste as a 6-char escape, plus envelope slack. */
    const val MAX_RAW_CHARS = 6 * InputSender.MAX_INPUT_BYTES + 1024
    const val MAX_COLS = 500
    const val MAX_ROWS = 300
    const val MAX_CONSUMED = 16 * 1024 * 1024

    /** Returns null for anything malformed, unknown, oversized or mistyped. */
    fun parse(raw: String?): PageMessage? {
        if (raw == null || raw.length > MAX_RAW_CHARS) return null
        val o = try { JSONObject(raw) } catch (_: Exception) { return null }
        return when (o.opt("t")) {
            "ready" -> PageMessage.Ready
            "input" -> {
                val s = session(o) ?: return null
                val d = o.opt("d") as? String ?: return null
                if (d.isEmpty() || utf8Size(d) > MAX_INPUT_BYTES) return null
                PageMessage.Input(s, d)
            }
            "resize" -> {
                val s = session(o) ?: return null
                val cols = int(o, "cols", 1, MAX_COLS) ?: return null
                val rows = int(o, "rows", 1, MAX_ROWS) ?: return null
                PageMessage.Resize(s, cols, rows)
            }
            "consumed" -> {
                val s = session(o) ?: return null
                val bytes = int(o, "bytes", 0, MAX_CONSUMED) ?: return null
                PageMessage.Consumed(s, bytes)
            }
            "copy" -> {
                val text = o.opt("text") as? String ?: return null
                if (utf8Size(text) > MAX_COPY_BYTES) return null
                PageMessage.Copy(text)
            }
            else -> null
        }
    }

    const val MAX_DIAG_CHARS = 512

    /**
     * Input-diagnostic page event, parsed apart from [parse] so [PageMessage] stays closed. Every field is an
     * enum or a range-checked whole number; unknown keys are ignored and never copied, so no text can pass.
     */
    fun parseDiag(raw: String?): DiagEvent.Page? {
        if (raw == null || raw.length > MAX_DIAG_CHARS) return null
        val o = try { JSONObject(raw) } catch (_: Exception) { return null }
        if (o.opt("t") != "diag") return null
        val kind = when (o.opt("k")) { "p" -> PageKind.POINTER; "t" -> PageKind.TOUCH; "w" -> PageKind.WHEEL; else -> return null }
        val action = when (o.opt("a")) {
            "down" -> PageAction.DOWN; "move" -> PageAction.MOVE; "up" -> PageAction.UP
            "cancel" -> PageAction.CANCEL; "wheel" -> PageAction.WHEEL; else -> return null
        }
        val pointer = when (o.opt("pt")) {
            "mouse" -> PagePointer.MOUSE; "touch" -> PagePointer.TOUCH; "pen" -> PagePointer.PEN; "" -> PagePointer.NONE
            else -> return null
        }
        return DiagEvent.Page(
            kind, action, pointer,
            button = int(o, "b", -1, 31) ?: return null,
            buttons = int(o, "bs", 0, 63) ?: return null,
            dx = int(o, "dx", -100000, 100000) ?: return null,
            dy = int(o, "dy", -100000, 100000) ?: return null,
            mode = int(o, "dm", 0, 2) ?: return null,
            x = int(o, "x", -10000, 20000) ?: return null,
            y = int(o, "y", -10000, 20000) ?: return null,
            touches = int(o, "n", 0, 20) ?: return null,
        )
    }

    private fun session(o: JSONObject): String? {
        val s = o.opt("s") as? String ?: return null
        return if (s in SESSIONS) s else null
    }

    /** Whole numbers only (Int/Long); a Double, String or Boolean is rejected. */
    private fun int(o: JSONObject, key: String, min: Int, max: Int): Int? {
        val n = when (val v = o.opt(key)) {
            is Int -> v.toLong()
            is Long -> v
            else -> return null
        }
        return if (n in min.toLong()..max.toLong()) n.toInt() else null
    }

    private fun utf8Size(s: String): Int = s.toByteArray(Charsets.UTF_8).size
}

/** One-second window cap; the clock is injected so the policy is unit-testable. */
class RateLimiter(private val maxPerSecond: Int, private val nowMs: () -> Long) {
    private var windowStart = Long.MIN_VALUE
    private var count = 0

    fun allow(): Boolean {
        val now = nowMs()
        if (windowStart == Long.MIN_VALUE || now - windowStart >= 1000) {
            windowStart = now
            count = 0
        }
        count++
        return count <= maxPerSecond
    }
}

/**
 * Kotlin -> page messages (A2 bridge contract), built with org.json so page data is
 * always escaped, never concatenated into JSON.
 */
object BridgeOut {
    fun snap(s: String, q: Long, cols: Int, rows: Int, d: String): String =
        JSONObject().put("t", "snap").put("s", s).put("q", q).put("cols", cols).put("rows", rows).put("d", d).toString()

    fun out(s: String, q: Long, d: String): String =
        JSONObject().put("t", "out").put("s", s).put("q", q).put("d", d).toString()

    fun size(s: String, cols: Int, rows: Int): String =
        JSONObject().put("t", "size").put("s", s).put("cols", cols).put("rows", rows).toString()

    fun show(s: String): String = JSONObject().put("t", "show").put("s", s).toString()

    /** Page keyboard on/off: on only while a running slot is attached over a live connection. */
    fun stdin(on: Boolean): String = JSONObject().put("t", "stdin").put("on", on).toString()

    /** Input diagnostic on/off for the page; the page defaults to off. */
    fun diag(on: Boolean): String = JSONObject().put("t", "diag").put("on", on).toString()

    /** px 0 = fit width, else 8..24 (the host validates). */
    fun zoom(px: Int): String = JSONObject().put("t", "zoom").put("px", px).toString()

    /** Native compose text for the page to turn into `input` messages (it owns bracketed-paste state). */
    fun compose(s: String, d: String, enter: Boolean): String =
        JSONObject().put("t", "compose").put("s", s).put("d", d).put("enter", enter).toString()
}
