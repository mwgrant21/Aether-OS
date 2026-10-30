package com.matt.aethermobile.protocol

import org.json.JSONException
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Native copy of protocol/mobile-protocol.json (the single source of truth).
 * ControlProtocolTest loads the JSON and asserts every value here equals it,
 * so drift fails the build. Pure JVM: no android.* imports.
 */
object ControlProtocol {
    const val VERSION = 1
    const val PORT = 47821
    const val PATH_CTL = "/ctl"
    const val PATH_PAIR = "/api/device/pair"
    const val AUTH_SCHEME = "Bearer"

    const val CODE_LENGTH = 8
    const val CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
    const val CODE_TTL_MS = 300_000L
    const val MAX_CODE_FAILURES = 5
    const val PAIR_BODY_CAP_BYTES = 1024
    const val PAIR_CONFIRM_TIMEOUT_MS = 60_000L

    const val TOKEN_BYTES = 32
    const val SLIDING_TTL_MS = 2_592_000_000L
    const val ABSOLUTE_TTL_MS = 15_552_000_000L

    const val HELLO_TIMEOUT_MS = 5_000L
    const val MAX_CONTROL_SOCKETS = 2
    const val CTL_MAX_PAYLOAD_BYTES = 65_536
    const val RECHECK_MS = 10_000L

    const val PAIR_OK = 200
    const val PAIR_BAD_CODE = 401
    const val PAIR_DECLINED = 403
    const val PAIR_BURNED = 429
    const val PAIR_BUSY = 409

    const val PROOF_LABEL = "server"
    const val PROOF_SEPARATOR = "\n"
    const val PROOF_SUFFIX = "/ctl"

    const val EPOCH_BYTES = 8
    const val NONCE_BYTES = 16

    // terminals.* in the JSON.
    const val CHUNK_MAX_BYTES = 16_384
    const val RING_BYTES = 262_144
    const val SNAPSHOT_BYTES = 262_144
    const val SNAPSHOT_SCROLLBACK_LINES = 1000
    const val MIRROR_SCROLLBACK_LINES = 2000

    /** terminals.slots, in wire order. */
    data class Slot(val s: String, val label: String)

    val SLOTS: List<Slot> = listOf(
        Slot("claude", "Terminal"),
        Slot("terminal2", "Terminal 2"),
        Slot("codex", "Codex"),
    )

    /** terminals.states, in the JSON's order. */
    enum class SlotState(val wire: String) {
        NOT_STARTED("not-started"),
        RUNNING("running"),
        EXITED("exited"),
    }

    /** One entry of `welcome.sessions`. */
    data class SessionInfo(
        val s: String,
        val label: String,
        val state: SlotState,
        val cols: Int,
        val rows: Int,
        val q: Long,
    )

    enum class NakReason(val wire: String) { NOT_RUNNING("not-running"), TYPING_OFF("typing-off") }

    /** Titan-to-phone terminal frames. Slot ids are always members of [SLOTS]. */
    sealed class TerminalFrame {
        abstract val s: String
        data class Snap(override val s: String, val q: Long, val cols: Int, val rows: Int, val d: String) : TerminalFrame()
        data class Out(override val s: String, val q: Long, val d: String) : TerminalFrame()
        data class Size(override val s: String, val cols: Int, val rows: Int) : TerminalFrame()
        data class State(override val s: String, val state: SlotState) : TerminalFrame()
        /** Cumulative: every `in` frame with cseq <= [c] on [s] has been processed. */
        data class Ack(override val s: String, val c: Long) : TerminalFrame()
        /** The desktop refused the `in` frame with cseq [c] on [s]; that cseq is consumed. */
        data class Nak(override val s: String, val c: Long, val reason: NakReason) : TerminalFrame()
    }

    // thread.* in the JSON.
    const val THREAD_SLOT = "claude"
    const val THREAD_SNAPSHOT_MAX_EVENTS = 200
    const val THREAD_TEXT_CAP = 8000
    const val THREAD_TARGET_CAP = 160
    const val THREAD_SNAPSHOT_MAX_BYTES = 204_800
    const val PROMPT_SUMMARY_CAP = 1200
    const val THREAD_WORKING_STALE_MS = 120_000L

    /** One transcript event on the Claude thread. [id] is unique per session file. */
    sealed class ThreadEvent {
        abstract val id: String
        abstract val at: Long
        data class User(override val id: String, override val at: Long, val text: String, val truncated: Boolean) : ThreadEvent()
        data class Claude(override val id: String, override val at: Long, val text: String, val truncated: Boolean) : ThreadEvent()
        /** [target], [add] and [del] are null when the wire carries JSON null or omits them. */
        data class Tool(override val id: String, override val at: Long, val name: String, val target: String?, val add: Long?, val del: Long?) : ThreadEvent()
    }

    enum class PromptRisk(val wire: String) { LOW("LOW"), MED("MED"), HIGH("HIGH") }

    /** promptCloseReasons in the JSON, in order. */
    enum class PromptCloseReason(val wire: String) {
        ANSWERED_DESKTOP("answered-desktop"),
        TIMEOUT("timeout"),
    }

    data class PromptInfo(val id: String, val tool: String, val risk: PromptRisk, val summary: String, val ttlMs: Long)

    /** Titan-to-phone thread and prompt frames (one type, one client callback). */
    sealed class ThreadFrame {
        data class Snap(val q: Long, val attached: Boolean, val working: Boolean, val workingSinceMs: Long?, val events: List<ThreadEvent>) : ThreadFrame()
        data class Events(val q: Long, val events: List<ThreadEvent>) : ThreadFrame()
        data class State(val q: Long, val working: Boolean, val workingSinceMs: Long?) : ThreadFrame()
        data class Opened(val prompt: PromptInfo) : ThreadFrame()
        data class Closed(val id: String, val reason: PromptCloseReason) : ThreadFrame()
    }

    /** Largest integer a TypeScript number holds exactly; q is bounded by it. */
    enum class LedgerTier(val wire: String) { OPUS("opus"), SONNET("sonnet"), HAIKU("haiku"), FABLE("fable") }
    data class LedgerTotal(val usd: Double, val input: Double, val output: Double, val cacheCreation: Double, val cacheRead: Double)
    data class LedgerRollups(val today: Double?, val week: Double?, val month: Double?)
    data class LedgerCache(val readTokens: Long, val wouldHaveUsd: Double, val actualUsd: Double, val savedUsd: Double, val hitRate: Double)
    data class LedgerSnapshot(val computedAtMs: Long, val total: LedgerTotal, val tiers: List<LedgerTier>, val rollups: LedgerRollups, val cache: LedgerCache)

    sealed class LedgerFrame {
        /** ledger == null: titan has no snapshot yet. */
        data class Snap(val ledger: LedgerSnapshot?) : LedgerFrame()
    }

    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

    /** Wire names of titan's `bye` reasons, in the JSON's order. */
    enum class ByeReason(val wire: String) {
        REVOKED("revoked"),
        DISABLED("disabled"),
        EXPIRED("expired"),
        SUPERSEDED("superseded"),
        POLICY("policy"),
        SLOW_CONSUMER("slow-consumer"),
        RATE_LIMIT("rate-limit"),
    }

    data class Welcome(
        val proof: String,
        val expiresAtMs: Long,
        val serverTimeMs: Long,
        val sessions: List<SessionInfo> = emptyList(),
        /** `welcome.applied`: last applied input cseq per slot for this device and epoch. */
        val applied: Map<String, Long> = emptyMap(),
    )

    private val secureRandom: SecureRandom by lazy { SecureRandom() }

    /**
     * Pairing code as typed or scanned -> canonical 8 characters (no hyphen),
     * or null when it cannot be a code. Case-insensitive; spaces, hyphens and
     * en/em dashes are ignored.
     */
    fun normaliseCode(raw: String): String? {
        val cleaned = raw.uppercase().filterNot { it.isWhitespace() || it == '-' || it == '–' || it == '—' }
        if (cleaned.length != CODE_LENGTH) return null
        if (!cleaned.all { CODE_ALPHABET.indexOf(it) >= 0 }) return null
        return cleaned
    }

    /** True only for a canonical dotted-quad IPv4 literal (no leading zeros) inside 100.64.0.0/10. */
    fun isTailnetHost(host: String): Boolean {
        val parts = host.split('.')
        if (parts.size != 4) return false
        val octets = parts.map { p ->
            if (p.isEmpty() || p.length > 3 || !p.all { it in '0'..'9' }) return false
            if (p.length > 1 && p[0] == '0') return false
            p.toInt().also { if (it > 255) return false }
        }
        return octets[0] == 100 && octets[1] in 64..127
    }

    /** Raw 32-byte SHA-256 of the token's UTF-8 text: the HMAC key. */
    fun tokenKey(token: String): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8))

    /**
     * HMAC-SHA256(key = tokenKey(token), msg = "server" LF nonce LF "/ctl"),
     * lowercase hex. The nonce is the 32-char hex text used verbatim.
     */
    fun serverProof(token: String, nonce: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(tokenKey(token), "HmacSHA256"))
        val msg = PROOF_LABEL + PROOF_SEPARATOR + nonce + PROOF_SEPARATOR + PROOF_SUFFIX
        return hex(mac.doFinal(msg.toByteArray(Charsets.UTF_8)))
    }

    fun buildHello(app: String, epoch: String, nonce: String): String =
        JSONObject()
            .put("t", "hello")
            .put("v", VERSION)
            .put("app", app)
            .put("epoch", epoch)
            .put("nonce", nonce)
            .toString()

    /** Null unless the frame is a `welcome` carrying a string `proof`. Unknown fields are ignored. */
    fun parseWelcome(text: String): Welcome? {
        val o = parseObject(text) ?: return null
        if (o.optString("t") != "welcome") return null
        val proof = o.opt("proof") as? String ?: return null
        if (proof.isEmpty()) return null
        return Welcome(proof, o.optLong("expiresAtMs", 0L), o.optLong("serverTimeMs", 0L), parseSessions(o.optJSONArray("sessions")), parseApplied(o.optJSONObject("applied")))
    }

    /** Null unless the frame is a `bye` with a known reason. */
    fun parseBye(text: String): ByeReason? {
        val o = parseObject(text) ?: return null
        if (o.optString("t") != "bye") return null
        val reason = o.optString("reason")
        return ByeReason.values().firstOrNull { it.wire == reason }
    }

    /**
     * `{"t":"attach","s":...}` with `,"q":N` only when [q] is given (key absent, never null).
     * Built by hand so the bytes do not depend on JSONObject key order.
     */
    fun buildAttach(s: String, q: Long? = null): String {
        require(isSlot(s)) { "unknown slot" }
        require(q == null || q in 0..MAX_SAFE_INTEGER) { "q out of range" }
        val qPart = if (q == null) "" else ",\"q\":$q"
        return "{\"t\":\"attach\",\"s\":${JSONObject.quote(s)}$qPart}"
    }

    fun buildDetach(s: String): String {
        require(isSlot(s)) { "unknown slot" }
        return "{\"t\":\"detach\",\"s\":${JSONObject.quote(s)}}"
    }

    /**
     * `{"t":"in","s":...,"c":N,"d":...}`. Built by hand like attach so key order is fixed;
     * `d` goes through JSONObject.quote, which escapes quotes, backslash and control chars.
     */
    fun buildIn(s: String, c: Long, d: String): String {
        require(isSlot(s)) { "unknown slot" }
        require(c in 1..MAX_SAFE_INTEGER) { "c out of range" }
        require(d.isNotEmpty()) { "empty input" }
        return "{\"t\":\"in\",\"s\":${JSONObject.quote(s)},\"c\":$c,\"d\":${JSONObject.quote(d)}}"
    }

    /**
     * Null unless the frame is a well-formed snap/out/size/state/ack/nak: known slot,
     * string `d`, whole-number numerics (a JSON 1.5 or 1.0 is rejected), q within
     * 0..2^53-1, known state. Unknown extra fields are ignored.
     */
    fun parseTerminalFrame(text: String): TerminalFrame? {
        val o = parseObject(text) ?: return null
        val s = o.opt("s") as? String ?: return null
        if (!isSlot(s)) return null
        return when (o.opt("t")) {
            "snap" -> {
                val q = whole(o.opt("q"), MAX_SAFE_INTEGER) ?: return null
                val cols = whole(o.opt("cols"), Int.MAX_VALUE.toLong()) ?: return null
                val rows = whole(o.opt("rows"), Int.MAX_VALUE.toLong()) ?: return null
                val d = o.opt("d") as? String ?: return null
                TerminalFrame.Snap(s, q, cols.toInt(), rows.toInt(), d)
            }
            "out" -> {
                val q = whole(o.opt("q"), MAX_SAFE_INTEGER) ?: return null
                val d = o.opt("d") as? String ?: return null
                TerminalFrame.Out(s, q, d)
            }
            "size" -> {
                val cols = whole(o.opt("cols"), Int.MAX_VALUE.toLong()) ?: return null
                val rows = whole(o.opt("rows"), Int.MAX_VALUE.toLong()) ?: return null
                TerminalFrame.Size(s, cols.toInt(), rows.toInt())
            }
            "state" -> {
                val st = SlotState.values().firstOrNull { it.wire == o.opt("state") } ?: return null
                TerminalFrame.State(s, st)
            }
            "ack" -> {
                val c = whole(o.opt("c"), MAX_SAFE_INTEGER) ?: return null
                if (c < 1) return null
                TerminalFrame.Ack(s, c)
            }
            "nak" -> {
                val c = whole(o.opt("c"), MAX_SAFE_INTEGER) ?: return null
                if (c < 1) return null
                val reason = NakReason.values().firstOrNull { it.wire == o.opt("reason") } ?: return null
                TerminalFrame.Nak(s, c, reason)
            }
            else -> null
        }
    }

    fun buildThreadAttach(): String = "{\"t\":\"thread.attach\",\"s\":\"$THREAD_SLOT\"}"

    fun buildThreadDetach(): String = "{\"t\":\"thread.detach\",\"s\":\"$THREAD_SLOT\"}"

    /**
     * Null unless the frame is a well-formed thread.snap/thread.ev/thread.state/prompt/prompt.closed:
     * slot `claude`, whole-number numerics, known event kinds, known risk and close reason.
     * `workingSinceMs`, `target`, `add` and `del` accept JSON null (or absence) as null; any
     * other non-matching type, including the string "null", is rejected. Unknown extra fields are ignored.
     */
    fun parseThreadFrame(text: String): ThreadFrame? {
        val o = parseObject(text) ?: return null
        return when (o.opt("t")) {
            "thread.snap" -> {
                if (o.opt("s") != THREAD_SLOT) return null
                val q = whole(o.opt("q"), MAX_SAFE_INTEGER) ?: return null
                val attached = o.opt("attached") as? Boolean ?: return null
                val working = o.opt("working") as? Boolean ?: return null
                val since = nullableWhole(o, "workingSinceMs") ?: return null
                val events = parseEvents(o.optJSONArray("events")) ?: return null
                ThreadFrame.Snap(q, attached, working, since.value, events)
            }
            "thread.ev" -> {
                if (o.opt("s") != THREAD_SLOT) return null
                val q = whole(o.opt("q"), MAX_SAFE_INTEGER) ?: return null
                val events = parseEvents(o.optJSONArray("events")) ?: return null
                ThreadFrame.Events(q, events)
            }
            "thread.state" -> {
                if (o.opt("s") != THREAD_SLOT) return null
                val q = whole(o.opt("q"), MAX_SAFE_INTEGER) ?: return null
                val working = o.opt("working") as? Boolean ?: return null
                val since = nullableWhole(o, "workingSinceMs") ?: return null
                ThreadFrame.State(q, working, since.value)
            }
            "prompt" -> {
                val id = o.opt("id") as? String ?: return null
                val tool = o.opt("tool") as? String ?: return null
                val risk = PromptRisk.values().firstOrNull { it.wire == o.opt("risk") } ?: return null
                val summary = o.opt("summary") as? String ?: return null
                val ttl = whole(o.opt("ttlMs"), MAX_SAFE_INTEGER) ?: return null
                if (id.isEmpty()) return null
                ThreadFrame.Opened(PromptInfo(id, tool, risk, summary, ttl))
            }
            "prompt.closed" -> {
                val id = o.opt("id") as? String ?: return null
                val reason = PromptCloseReason.values().firstOrNull { it.wire == o.opt("reason") } ?: return null
                if (id.isEmpty()) return null
                ThreadFrame.Closed(id, reason)
            }
            else -> null
        }
    }

    fun buildLedgerAttach(): String = "{\"t\":\"ledger.attach\"}"

    fun buildLedgerDetach(): String = "{\"t\":\"ledger.detach\"}"

    /**
     * Null unless the frame is a well-formed ledger.snap: `ledger` present and JSON null or an
     * object whose fields all have the exact types of the wire contract. Money accepts any finite
     * JSON number (5, 5.0, 889.44) that is >= 0, never a string; rollup buckets accept JSON null;
     * an unknown tier fails the whole frame. Unknown extra fields are ignored. Values are never logged.
     */
    fun parseLedgerFrame(text: String): LedgerFrame? {
        val o = parseObject(text) ?: return null
        if (o.opt("t") != "ledger.snap") return null
        if (!o.has("ledger")) return null
        if (o.isNull("ledger")) return LedgerFrame.Snap(null)
        val l = o.optJSONObject("ledger") ?: return null
        val computedAtMs = whole(l.opt("computedAtMs"), MAX_SAFE_INTEGER) ?: return null
        val t = l.optJSONObject("total") ?: return null
        val total = LedgerTotal(
            money(t.opt("usd")) ?: return null,
            money(t.opt("input")) ?: return null,
            money(t.opt("output")) ?: return null,
            money(t.opt("cacheCreation")) ?: return null,
            money(t.opt("cacheRead")) ?: return null,
        )
        val arr = l.optJSONArray("tiers") ?: return null
        val tiers = ArrayList<LedgerTier>(arr.length())
        for (i in 0 until arr.length()) {
            tiers += LedgerTier.values().firstOrNull { it.wire == arr.opt(i) } ?: return null
        }
        val r = l.optJSONObject("rollups") ?: return null
        val rollups = LedgerRollups(
            (nullableMoney(r, "today") ?: return null).value,
            (nullableMoney(r, "week") ?: return null).value,
            (nullableMoney(r, "month") ?: return null).value,
        )
        val c = l.optJSONObject("cache") ?: return null
        val readTokens = whole(c.opt("readTokens"), MAX_SAFE_INTEGER) ?: return null
        val hitRate = (c.opt("hitRate") as? Number)?.toDouble()?.takeIf { it.isFinite() && it in 0.0..1.0 } ?: return null
        val cache = LedgerCache(
            readTokens,
            money(c.opt("wouldHaveUsd")) ?: return null,
            money(c.opt("actualUsd")) ?: return null,
            money(c.opt("savedUsd")) ?: return null,
            hitRate,
        )
        return LedgerFrame.Snap(LedgerSnapshot(computedAtMs, total, tiers, rollups, cache))
    }

    /** A finite JSON number >= 0 (Int, Long or Double alike), else null. A string is never accepted. */
    private fun money(v: Any?): Double? = (v as? Number)?.toDouble()?.takeIf { it.isFinite() && it >= 0.0 }

    /** JSON null -> Opt(null); a money number -> Opt(n); absent, a string or anything else -> null (malformed). */
    private fun nullableMoney(o: JSONObject, key: String): Opt<Double>? {
        if (!o.has(key)) return null
        if (o.isNull(key)) return Opt(null)
        return money(o.opt(key))?.let { Opt(it) }
    }

    /** Wraps a nullable parse result so "present and null" differs from "malformed". */
    private class Opt<T>(val value: T?)

    /** Absent or JSON null -> Opt(null); a whole number -> Opt(n); anything else (string "null", 1.5, ...) -> null (malformed). */
    private fun nullableWhole(o: JSONObject, key: String): Opt<Long>? {
        if (!o.has(key) || o.isNull(key)) return Opt(null)
        return whole(o.opt(key), MAX_SAFE_INTEGER)?.let { Opt(it) }
    }

    private fun parseEvents(a: org.json.JSONArray?): List<ThreadEvent>? {
        if (a == null) return null
        val out = ArrayList<ThreadEvent>(a.length())
        for (i in 0 until a.length()) {
            val e = a.optJSONObject(i) ?: return null
            val id = e.opt("id") as? String ?: return null
            val at = whole(e.opt("at"), MAX_SAFE_INTEGER) ?: return null
            when (val k = e.opt("k")) {
                "user", "claude" -> {
                    val text = e.opt("text") as? String ?: return null
                    val truncated = e.opt("truncated") as? Boolean ?: return null
                    out += if (k == "user") ThreadEvent.User(id, at, text, truncated) else ThreadEvent.Claude(id, at, text, truncated)
                }
                "tool" -> {
                    val name = e.opt("name") as? String ?: return null
                    val target: String? = if (!e.has("target") || e.isNull("target")) null else (e.opt("target") as? String ?: return null)
                    val add = nullableWhole(e, "add") ?: return null
                    val del = nullableWhole(e, "del") ?: return null
                    out += ThreadEvent.Tool(id, at, name, target, add.value, del.value)
                }
                else -> return null
            }
        }
        return out
    }

    private fun isSlot(s: String) = SLOTS.any { it.s == s }

    /** A JSON integer (Int or Long, never Double or String) in 0..max, else null. */
    private fun whole(v: Any?, max: Long): Long? {
        val n = when (v) {
            is Int -> v.toLong()
            is Long -> v
            else -> return null
        }
        return if (n in 0..max) n else null
    }

    /** Known slots with whole-number cseq only; anything else is skipped, like an unknown field. */
    private fun parseApplied(o: JSONObject?): Map<String, Long> {
        if (o == null) return emptyMap()
        val out = LinkedHashMap<String, Long>()
        for (k in o.keys()) {
            if (!isSlot(k)) continue
            out[k] = whole(o.opt(k), MAX_SAFE_INTEGER) ?: continue
        }
        return out
    }

    /** Well-formed entries only; a malformed entry is skipped, like an unknown field. */
    private fun parseSessions(a: org.json.JSONArray?): List<SessionInfo> {
        if (a == null) return emptyList()
        val out = ArrayList<SessionInfo>()
        for (i in 0 until a.length()) {
            val o = a.optJSONObject(i) ?: continue
            val s = o.opt("s") as? String ?: continue
            val label = o.opt("label") as? String ?: continue
            if (!isSlot(s)) continue
            val state = SlotState.values().firstOrNull { it.wire == o.opt("state") } ?: continue
            val cols = whole(o.opt("cols"), Int.MAX_VALUE.toLong()) ?: continue
            val rows = whole(o.opt("rows"), Int.MAX_VALUE.toLong()) ?: continue
            val q = whole(o.opt("q"), MAX_SAFE_INTEGER) ?: continue
            out += SessionInfo(s, label, state, cols.toInt(), rows.toInt(), q)
        }
        return out
    }

    fun newEpoch(random: SecureRandom = secureRandom): String = randomHex(random, EPOCH_BYTES)

    fun newNonce(random: SecureRandom = secureRandom): String = randomHex(random, NONCE_BYTES)

    private fun parseObject(text: String): JSONObject? =
        try { JSONObject(text) } catch (_: JSONException) { null }

    private fun randomHex(random: SecureRandom, n: Int): String =
        hex(ByteArray(n).also { random.nextBytes(it) })

    private fun hex(bytes: ByteArray): String {
        val digits = "0123456789abcdef"
        val sb = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            sb.append(digits[(b.toInt() shr 4) and 0xf])
            sb.append(digits[b.toInt() and 0xf])
        }
        return sb.toString()
    }
}
