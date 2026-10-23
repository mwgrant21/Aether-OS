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

    const val PROOF_LABEL = "server"
    const val PROOF_SEPARATOR = "\n"
    const val PROOF_SUFFIX = "/ctl"

    const val EPOCH_BYTES = 8
    const val NONCE_BYTES = 16

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

    data class Welcome(val proof: String, val expiresAtMs: Long, val serverTimeMs: Long)

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
        return Welcome(proof, o.optLong("expiresAtMs", 0L), o.optLong("serverTimeMs", 0L))
    }

    /** Null unless the frame is a `bye` with a known reason. */
    fun parseBye(text: String): ByeReason? {
        val o = parseObject(text) ?: return null
        if (o.optString("t") != "bye") return null
        val reason = o.optString("reason")
        return ByeReason.values().firstOrNull { it.wire == reason }
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
