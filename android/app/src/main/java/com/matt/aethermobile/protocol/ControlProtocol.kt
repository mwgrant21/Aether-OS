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

    // threads.* in the JSON (V3-A3 read-only session thread).
    val THREAD_SLOTS: List<String> = listOf("claude", "terminal2")
    const val THREAD_HISTORY_ENTRIES = 200
    const val THREAD_SNAPSHOT_BYTES = 131_072
    const val THREAD_TEXT_CAP = 4000
    const val THREAD_LABEL_CAP = 80
    const val THREAD_DIFF_INLINE_LINES = 8
    const val THREAD_DETAIL_BYTES = 4096
    const val THREAD_DETAIL_LINES = 60
    const val THREAD_INPUT_BYTES = 2048
    const val THREAD_INPUT_LINES = 30
    const val THREAD_RATE_PER_S = 5
    const val THREAD_RATE_BURST = 10

    /** welcome.caps member titan advertises when it serves the thread frames. */
    const val CAP_THREAD = "thread"

    /** Slack over [THREAD_SNAPSHOT_BYTES] for a tsnap's own envelope and meta (the budget counts the entries array only). */
    private const val THREAD_SNAP_ENVELOPE_SLACK = 1024

    /** Same shape the desktop parser enforces for tget ids. */
    private val THREAD_GET_ID = Regex("^[0-9]{1,12}:[0-9]{1,4}$")

    /** Entry ids on received frames: 1 to 40 characters of digits and colons. */
    private val THREAD_ENTRY_ID = Regex("^[0-9:]{1,40}$")

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

    /** Titan-to-phone terminal frames. Slot ids are always members of [SLOTS]. */
    sealed class TerminalFrame {
        abstract val s: String
        data class Snap(override val s: String, val q: Long, val cols: Int, val rows: Int, val d: String) : TerminalFrame()
        data class Out(override val s: String, val q: Long, val d: String) : TerminalFrame()
        data class Size(override val s: String, val cols: Int, val rows: Int) : TerminalFrame()
        data class State(override val s: String, val state: SlotState) : TerminalFrame()
    }

    enum class ToolState(val wire: String) { RUN("run"), OK("ok"), ERR("err") }
    enum class Work(val wire: String) { WORKING("working"), IDLE("idle"), UNKNOWN("unknown") }
    enum class Wait(val wire: String) { PERM("perm"), QUIET("quiet") }
    enum class Why(val wire: String) { NO_SESSION("no-session"), STARTING("starting"), UNREADABLE("unreadable") }

    /** One thread row. [id] is the transcript line and block ("123456:0"); [ts] is epoch ms, 0 when unknown. */
    sealed class ThreadEntry {
        abstract val id: String
        abstract val ts: Long
        data class User(override val id: String, override val ts: Long, val x: String, val tr: Boolean) : ThreadEntry()
        data class Assistant(override val id: String, override val ts: Long, val x: String, val tr: Boolean) : ThreadEntry()
        data class Tool(
            override val id: String,
            override val ts: Long,
            val n: String,
            val l: String,
            val st: ToolState,
            val sz: Long?,
            val d: Boolean,
            /** Inline diff lines: sign "-" or "+" and the line text. Null when the entry carries none. */
            val df: List<Pair<String, String>>? = null,
            /** Count of diff lines omitted from [df]. */
            val dn: Int? = null,
        ) : ThreadEntry()
        data class Thinking(override val id: String, override val ts: Long, val ms: Long?, val d: Boolean) : ThreadEntry()
    }

    /** Latest session meta; null fields are "unknown", never zero. */
    data class ThreadMeta(
        val ctxTok: Long?,
        val ctxPct: Double?,
        val work: Work,
        val since: Long?,
        val tok: Long?,
        val last: Long?,
        val wait: Wait?,
    )

    /** Titan-to-phone thread frames. Slot ids are always members of [THREAD_SLOTS]. */
    sealed class ThreadFrame {
        abstract val s: String
        data class Snap(override val s: String, val q: Long, val avail: Boolean, val why: Why?, val entries: List<ThreadEntry>, val m: ThreadMeta) : ThreadFrame()
        data class Add(override val s: String, val q: Long, val e: ThreadEntry) : ThreadFrame()
        data class Upd(override val s: String, val q: Long, val e: ThreadEntry) : ThreadFrame()
        data class Meta(override val s: String, val m: ThreadMeta) : ThreadFrame()
        /** Reply to tget. [input] and [x] null = nothing to show; [inMore] and [more] = omitted line counts. */
        data class Detail(override val s: String, val id: String, val input: String?, val inMore: Int, val x: String?, val more: Int) : ThreadFrame()
    }

    /** Largest integer a TypeScript number holds exactly; q is bounded by it. */
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
        val caps: Set<String> = emptySet(),
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
        return Welcome(proof, o.optLong("expiresAtMs", 0L), o.optLong("serverTimeMs", 0L), parseSessions(o.optJSONArray("sessions")), parseCaps(o.optJSONArray("caps")))
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
     * Null unless the frame is a well-formed snap/out/size/state: known slot,
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
            else -> null
        }
    }

    fun buildTattach(s: String): String {
        require(isThreadSlot(s)) { "unknown slot" }
        return "{\"t\":\"tattach\",\"s\":${JSONObject.quote(s)}}"
    }

    fun buildTdetach(s: String): String {
        require(isThreadSlot(s)) { "unknown slot" }
        return "{\"t\":\"tdetach\",\"s\":${JSONObject.quote(s)}}"
    }

    fun buildTget(s: String, id: String): String {
        require(isThreadSlot(s)) { "unknown slot" }
        require(THREAD_GET_ID.matches(id)) { "bad id" }
        return "{\"t\":\"tget\",\"s\":${JSONObject.quote(s)},\"id\":${JSONObject.quote(id)}}"
    }

    /**
     * Null unless the frame is a well-formed tsnap/tadd/tupd/tmeta/tdet for a thread slot. Strict like
     * [parseTerminalFrame]: whole-number numerics, every documented key present, unknown keys ignored. Text over
     * its cap (THREAD_TEXT_CAP characters; tdet text by UTF-8 bytes), more than THREAD_HISTORY_ENTRIES entries, or a
     * tsnap larger than THREAD_SNAPSHOT_BYTES plus its envelope rejects the whole frame.
     */
    fun parseThreadFrame(text: String): ThreadFrame? {
        val o = parseObject(text) ?: return null
        val s = o.opt("s") as? String ?: return null
        if (!isThreadSlot(s)) return null
        return when (o.opt("t")) {
            "tsnap" -> {
                if (text.length > THREAD_SNAPSHOT_BYTES + THREAD_SNAP_ENVELOPE_SLACK) return null
                val q = whole(o.opt("q"), MAX_SAFE_INTEGER) ?: return null
                val avail = o.opt("avail") as? Boolean ?: return null
                val why = if (!o.has("why")) return null else if (o.isNull("why")) null
                    else Why.values().firstOrNull { it.wire == o.opt("why") } ?: return null
                val arr = o.opt("entries") as? org.json.JSONArray ?: return null
                if (arr.length() > THREAD_HISTORY_ENTRIES) return null
                if (!avail && arr.length() != 0) return null
                val entries = ArrayList<ThreadEntry>(arr.length())
                for (i in 0 until arr.length()) entries += parseEntry(arr.opt(i) as? JSONObject ?: return null) ?: return null
                val m = parseMeta(o.opt("m") as? JSONObject ?: return null) ?: return null
                ThreadFrame.Snap(s, q, avail, why, entries, m)
            }
            "tadd", "tupd" -> {
                val q = whole(o.opt("q"), MAX_SAFE_INTEGER) ?: return null
                val e = parseEntry(o.opt("e") as? JSONObject ?: return null) ?: return null
                if (o.opt("t") == "tadd") ThreadFrame.Add(s, q, e) else ThreadFrame.Upd(s, q, e)
            }
            "tmeta" -> ThreadFrame.Meta(s, parseMeta(o.opt("m") as? JSONObject ?: return null) ?: return null)
            "tdet" -> {
                val id = o.opt("id") as? String ?: return null
                if (!THREAD_ENTRY_ID.matches(id)) return null
                val input = nullableText(o, "input", THREAD_INPUT_BYTES) ?: return null
                val x = nullableText(o, "x", THREAD_DETAIL_BYTES) ?: return null
                val inMore = whole(o.opt("inMore"), Int.MAX_VALUE.toLong()) ?: return null
                val more = whole(o.opt("more"), Int.MAX_VALUE.toLong()) ?: return null
                ThreadFrame.Detail(s, id, input.value, inMore.toInt(), x.value, more.toInt())
            }
            else -> null
        }
    }

    private class Nullable<T>(val value: T?)

    /** A present key holding a string of at most [capBytes] UTF-8 bytes, or JSON null; null result = malformed. */
    private fun nullableText(o: JSONObject, key: String, capBytes: Int): Nullable<String>? {
        if (!o.has(key)) return null
        if (o.isNull(key)) return Nullable(null)
        val v = o.opt(key) as? String ?: return null
        return if (v.toByteArray(Charsets.UTF_8).size <= capBytes) Nullable(v) else null
    }

    private fun text(o: JSONObject, key: String, cap: Int): String? {
        val v = o.opt(key) as? String ?: return null
        return if (v.length <= cap) v else null
    }

    /** A present key holding a whole number in 0..max or JSON null; null result = malformed. */
    private fun nullableWhole(o: JSONObject, key: String, max: Long): Nullable<Long>? {
        if (!o.has(key)) return null
        if (o.isNull(key)) return Nullable(null)
        return Nullable(whole(o.opt(key), max) ?: return null)
    }

    private fun parseEntry(o: JSONObject): ThreadEntry? {
        val id = o.opt("id") as? String ?: return null
        if (!THREAD_ENTRY_ID.matches(id)) return null
        val ts = whole(o.opt("ts"), MAX_SAFE_INTEGER) ?: return null
        return when (o.opt("k")) {
            "u", "a" -> {
                val x = text(o, "x", THREAD_TEXT_CAP) ?: return null
                val tr = o.opt("tr") as? Boolean ?: return null
                if (o.opt("k") == "u") ThreadEntry.User(id, ts, x, tr) else ThreadEntry.Assistant(id, ts, x, tr)
            }
            "t" -> {
                val n = text(o, "n", THREAD_TEXT_CAP) ?: return null
                val l = text(o, "l", THREAD_LABEL_CAP) ?: return null
                val st = ToolState.values().firstOrNull { it.wire == o.opt("st") } ?: return null
                val sz = nullableWhole(o, "sz", MAX_SAFE_INTEGER) ?: return null
                val d = o.opt("d") as? Boolean ?: return null
                val df = if (!o.has("df")) null else parseDiff(o.opt("df") as? org.json.JSONArray ?: return null) ?: return null
                val dn = if (!o.has("dn")) null else whole(o.opt("dn"), Int.MAX_VALUE.toLong())?.toInt() ?: return null
                ThreadEntry.Tool(id, ts, n, l, st, sz.value, d, df, dn)
            }
            "th" -> {
                val ms = nullableWhole(o, "ms", MAX_SAFE_INTEGER) ?: return null
                val d = o.opt("d") as? Boolean ?: return null
                ThreadEntry.Thinking(id, ts, ms.value, d)
            }
            else -> null
        }
    }

    private fun parseDiff(a: org.json.JSONArray): List<Pair<String, String>>? {
        if (a.length() > THREAD_DIFF_INLINE_LINES) return null
        val out = ArrayList<Pair<String, String>>(a.length())
        for (i in 0 until a.length()) {
            val p = a.opt(i) as? org.json.JSONArray ?: return null
            if (p.length() != 2) return null
            val sign = p.opt(0) as? String ?: return null
            if (sign != "-" && sign != "+") return null
            val line = p.opt(1) as? String ?: return null
            if (line.length > THREAD_TEXT_CAP) return null
            out += sign to line
        }
        return out
    }

    private fun parseMeta(o: JSONObject): ThreadMeta? {
        val ctxTok = nullableWhole(o, "ctxTok", MAX_SAFE_INTEGER) ?: return null
        if (!o.has("ctxPct")) return null
        val ctxPct = if (o.isNull("ctxPct")) null else {
            val n = o.opt("ctxPct") as? Number ?: return null
            val v = n.toDouble()
            if (v.isNaN() || v.isInfinite() || v < 0.0) return null
            v
        }
        val work = Work.values().firstOrNull { it.wire == o.opt("work") } ?: return null
        val since = nullableWhole(o, "since", MAX_SAFE_INTEGER) ?: return null
        val tok = nullableWhole(o, "tok", MAX_SAFE_INTEGER) ?: return null
        val last = nullableWhole(o, "last", MAX_SAFE_INTEGER) ?: return null
        if (!o.has("wait")) return null
        val wait = if (o.isNull("wait")) null else Wait.values().firstOrNull { it.wire == o.opt("wait") } ?: return null
        return ThreadMeta(ctxTok.value, ctxPct, work, since.value, tok.value, last.value, wait)
    }

    /** Strings only; anything else in caps (or a non-array) is ignored. */
    private fun parseCaps(a: org.json.JSONArray?): Set<String> {
        if (a == null) return emptySet()
        val out = LinkedHashSet<String>()
        for (i in 0 until a.length()) (a.opt(i) as? String)?.let { out += it }
        return out
    }

    private fun isThreadSlot(s: String) = THREAD_SLOTS.contains(s)

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
