package com.matt.aethermobile.auth

import com.matt.aethermobile.protocol.ControlProtocol
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONException
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Outcome of parsing a scanned QR payload. Only [Ok] may lead to a network call. */
sealed class QrResult {
    /** [code] is canonical: 8 characters, no hyphen. */
    data class Ok(val host: String, val port: Int, val code: String) : QrResult() {
        override fun toString() = "Ok(host=$host, port=$port, code=<redacted>)"
    }
    object WrongScheme : QrResult()
    object Malformed : QrResult()
    object WrongHost : QrResult()
    object WrongPort : QrResult()
    object BadCode : QrResult()
}

/** Outcome of the pairing call. Never carries the code. */
sealed class PairResult {
    data class Paired(val token: String, val expiresAtMs: Long) : PairResult() {
        override fun toString() = "Paired(token=<redacted>, expiresAtMs=$expiresAtMs)"
    }
    object BadCode : PairResult()
    object Declined : PairResult()
    object Burned : PairResult()
    object Unreachable : PairResult()
    data class Error(val status: Int) : PairResult()
}

object Pairing {
    private const val SCHEME = "aethermobile"
    private const val AUTHORITY = "pair"
    private val TOKEN_RE = Regex("^[A-Za-z0-9_-]{43}$")

    /**
     * Parse `aethermobile://pair?host=<ip>&port=47821&code=XXXX-XXXX`.
     * The host must EQUAL [expectedHost] (the baked address): a QR for any other
     * host is [QrResult.WrongHost] and is never dialled. Exactly the three keys
     * host/port/code are accepted, once each; anything else is [QrResult.Malformed].
     */
    fun parseQr(raw: String, expectedHost: String): QrResult {
        val text = raw.trim()
        val prefix = "$SCHEME://"
        if (!text.startsWith(prefix)) return QrResult.WrongScheme
        val rest = text.substring(prefix.length)
        val q = rest.indexOf('?')
        if (q < 0) return QrResult.Malformed
        if (rest.substring(0, q) != AUTHORITY) return QrResult.Malformed
        val query = rest.substring(q + 1)
        if (query.contains('#')) return QrResult.Malformed

        val params = HashMap<String, String>()
        for (pair in query.split('&')) {
            val eq = pair.indexOf('=')
            if (eq <= 0) return QrResult.Malformed
            val key = pair.substring(0, eq)
            if (key != "host" && key != "port" && key != "code") return QrResult.Malformed
            if (params.put(key, pair.substring(eq + 1)) != null) return QrResult.Malformed
        }
        val host = params["host"] ?: return QrResult.Malformed
        val port = params["port"] ?: return QrResult.Malformed
        if (host != expectedHost) return QrResult.WrongHost
        if (port != ControlProtocol.PORT.toString()) return QrResult.WrongPort
        val code = ControlProtocol.normaliseCode(params["code"] ?: return QrResult.BadCode)
            ?: return QrResult.BadCode
        return QrResult.Ok(host, ControlProtocol.PORT, code)
    }

    /** Manual entry: canonical code or null. Same validity rule as the QR path. */
    fun parseManualCode(raw: String): String? = ControlProtocol.normaliseCode(raw)

    /** Canonical code -> the wire form `ABCD-1234`. */
    fun formatCode(canonical: String): String =
        canonical.substring(0, 4) + "-" + canonical.substring(4)

    internal fun isWellFormedToken(token: String): Boolean = TOKEN_RE.matches(token)
}

/**
 * Blocking pairing call: run on a background thread. No cookies, no Origin,
 * redirects off. Refuses to build a request unless [host] is a tailnet address.
 */
class PairingClient private constructor(
    http: OkHttpClient,
    private val host: String,
    private val port: Int,
    private val hostAllowed: (String) -> Boolean,
    callTimeoutMs: Long,
) {
    constructor(http: OkHttpClient, host: String, port: Int) :
        this(http, host, port, ControlProtocol::isTailnetHost, CALL_TIMEOUT_MS)

    private val client: OkHttpClient = http.newBuilder()
        .callTimeout(callTimeoutMs, TimeUnit.MILLISECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    /** [code] may be raw or canonical; an invalid code is [PairResult.BadCode] without any request. */
    fun pair(code: String): PairResult {
        if (!hostAllowed(host)) return PairResult.Unreachable
        val canonical = ControlProtocol.normaliseCode(code) ?: return PairResult.BadCode
        val url = HttpUrl.Builder()
            .scheme("http")
            .host(host)
            .port(port)
            .encodedPath(ControlProtocol.PATH_PAIR)
            .build()
        val body = JSONObject().put("code", Pairing.formatCode(canonical)).toString()
            .toByteArray(Charsets.UTF_8)
            .toRequestBody(JSON_TYPE)
        val request = Request.Builder().url(url).post(body).build()
        return try {
            client.newCall(request).execute().use { resp ->
                when (resp.code) {
                    ControlProtocol.PAIR_OK -> parsePaired(resp.peekBody(MAX_RESPONSE_BYTES).string())
                    ControlProtocol.PAIR_BAD_CODE -> PairResult.BadCode
                    ControlProtocol.PAIR_DECLINED -> PairResult.Declined
                    ControlProtocol.PAIR_BURNED -> PairResult.Burned
                    else -> PairResult.Error(resp.code)
                }
            }
        } catch (t: Throwable) {
            // Any transport failure, IO or not, is "unreachable"; only the VM's own errors escape.
            // Nothing from the exception (text, token, code) is carried out.
            if (t is VirtualMachineError) throw t
            PairResult.Unreachable
        }
    }

    private fun parsePaired(text: String): PairResult {
        val o = try { JSONObject(text) } catch (_: JSONException) { return PairResult.Error(ControlProtocol.PAIR_OK) }
        val token = o.opt("token") as? String ?: return PairResult.Error(ControlProtocol.PAIR_OK)
        val expires = (o.opt("expiresAtMs") as? Number)?.toLong() ?: return PairResult.Error(ControlProtocol.PAIR_OK)
        if (!Pairing.isWellFormedToken(token) || expires <= 0L) return PairResult.Error(ControlProtocol.PAIR_OK)
        return PairResult.Paired(token, expires)
    }

    private companion object {
        const val CALL_TIMEOUT_MS = 70_000L
        const val MAX_RESPONSE_BYTES = 4096L
        val JSON_TYPE = "application/json".toMediaType()
    }
}
