package com.matt.aethermobile.term

import org.json.JSONObject

/**
 * V0 stand-in for titan: turns typed input into local-echo output so the whole
 * page -> Kotlin -> page bridge path is exercised before any network exists.
 * Frames use the real protocol's `out` shape (`t`, `s`, `q`, `d`; q strictly +1).
 */
class FakeTerminalSource(private val session: String = "claude") {
    private var seq = 0L
    private var lineLength = 0

    fun banner(): String =
        frame("Aether Mobile V0 - local fake source, no network.\r\nType to see local echo.\r\n$PROMPT")

    /** Echo for one input chunk as a single `out` frame, or null if there is nothing to draw. */
    fun onInput(d: String): String? {
        val out = StringBuilder()
        d.codePoints().forEach { cp ->
            when {
                cp == '\r'.code || cp == '\n'.code -> { out.append("\r\n").append(PROMPT); lineLength = 0 }
                cp == 0x7f || cp == 0x08 -> if (lineLength > 0) { out.append("\b \b"); lineLength-- }
                cp == '\t'.code -> { out.append("    "); lineLength += 4 }
                cp < 0x20 -> out.append('^').append((cp + 64).toChar())
                else -> { out.appendCodePoint(cp); lineLength++ }
            }
        }
        return if (out.isEmpty()) null else frame(out.toString())
    }

    private fun frame(data: String): String {
        seq++
        return JSONObject().put("t", "out").put("s", session).put("q", seq).put("d", data).toString()
    }

    companion object {
        const val PROMPT = "$ "
    }
}
