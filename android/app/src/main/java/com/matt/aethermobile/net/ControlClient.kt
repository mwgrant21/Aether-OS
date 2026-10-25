package com.matt.aethermobile.net

import com.matt.aethermobile.protocol.ControlProtocol
import org.json.JSONException
import org.json.JSONObject
import java.net.ConnectException
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/** Byte-level seam under [ControlClient] so the handshake is JVM-testable. */
interface Transport {
    /** Opens one WebSocket. Events arrive on [listener] from transport-owned threads. */
    fun open(url: String, headers: Map<String, String>, listener: Listener)

    /** Returns false when the frame was not queued. */
    fun send(text: String): Boolean

    fun close(code: Int, reason: String)

    interface Listener {
        fun onOpen()
        fun onMessage(text: String)
        fun onClosed(code: Int, reason: String)

        /** [httpStatus] is set when the upgrade itself was answered with a non-101 response. */
        fun onFailure(httpStatus: Int?, error: Throwable?)
    }
}

enum class Failure {
    /** Host is not an IPv4 literal inside 100.64.0.0/10; nothing was dialled. */
    HostRefused,
    Unreachable,
    ConnectionRefused,
    /** HTTP 404 on upgrade: titan is up but phone control is not enabled. */
    NotListening,
    /** HTTP 503 on upgrade: titan has no free control socket. */
    Busy,
    /** welcome carried a missing or wrong proof: the server does not know the token. */
    ProofMismatch,
    Protocol,
}

sealed class ControlState {
    object Idle : ControlState()
    object Connecting : ControlState()
    data class Connected(
        val expiresAtMs: Long,
        val serverTimeMs: Long,
        val sessions: List<ControlProtocol.SessionInfo> = emptyList(),
    ) : ControlState()

    /** bye revoked/expired, or HTTP 401 on upgrade: the stored token is dead. */
    object Revoked : ControlState()
    object Superseded : ControlState()
    object Disabled : ControlState()

    /** bye policy/slow-consumer/rate-limit, or a transport close with no bye. */
    data class Closed(val reason: String) : ControlState()
    data class Failed(val failure: Failure) : ControlState()
}

/**
 * V1 /ctl client: dials only the baked tailnet host, sends exactly one `hello`,
 * and reports Connected only after the welcome proof verifies against the nonce
 * this client sent. After that it forwards terminal frames to [onFrame] and
 * sends attach/detach. No reconnect (V4), no input.
 *
 * Threading: [onState] is invoked on transport threads (OkHttp), serially per
 * connection; the UI must marshal to the main thread. [onFrame] runs on the
 * same thread, in arrival order, outside the client lock. Frame bodies are
 * never logged. [state] is safe to read
 * from any thread. The first terminal state of a connection wins: a later
 * transport close can never overwrite a bye.
 *
 * The token travels only in the Authorization header. It, the nonce and the
 * proof are never logged and never placed in a URL or exception message.
 */
class ControlClient(
    private val host: String,
    private val appVersion: String,
    private val transport: Transport,
    private val onState: (ControlState) -> Unit = {},
    private val onFrame: (ControlProtocol.TerminalFrame) -> Unit = {},
    private val nonceSource: () -> String = { ControlProtocol.newNonce() },
    private val epochSource: () -> String = { ControlProtocol.newEpoch() },
    /** Runs the task once after the delay; returns a function that cancels it. Injectable so tests need no sleeps. */
    private val scheduler: (delayMs: Long, task: () -> Unit) -> (() -> Unit) = ::scheduleOnTimer,
) {
    @Volatile
    var state: ControlState = ControlState.Idle
        private set

    private var session: Session? = null

    fun connect(token: String) {
        synchronized(this) {
            if (state == ControlState.Connecting || state is ControlState.Connected) return
            if (!ControlProtocol.isTailnetHost(host)) {
                publish(ControlState.Failed(Failure.HostRefused))
                return
            }
            val s = Session(token, nonceSource(), epochSource())
            session = s
            publish(ControlState.Connecting)
            val url = "ws://$host:${ControlProtocol.PORT}${ControlProtocol.PATH_CTL}"
            val headers = mapOf("Authorization" to "${ControlProtocol.AUTH_SCHEME} $token")
            try {
                transport.open(url, headers, s)
            } catch (e: Throwable) {
                if (e is VirtualMachineError) throw e
                // Never carries the exception text: it could echo the URL or headers.
                s.finish(ControlState.Failed(Failure.Unreachable))
            }
        }
    }

    /** Caller-initiated close. Ends the connection quietly as Closed("local"). */
    fun close() {
        val s = synchronized(this) { session } ?: return
        s.finish(ControlState.Closed("local"), closeCode = 1000)
    }

    /** Asks titan to stream [s] (full snapshot when [q] is null, else resume after [q]). False if not Connected, bad args, or not queued. */
    fun attach(s: String, q: Long? = null): Boolean {
        val frame = try { ControlProtocol.buildAttach(s, q) } catch (_: IllegalArgumentException) { return false }
        return sendWhenConnected(frame)
    }

    /** Stops streaming [s]. False if not Connected, unknown slot, or not queued. */
    fun detach(s: String): Boolean {
        val frame = try { ControlProtocol.buildDetach(s) } catch (_: IllegalArgumentException) { return false }
        return sendWhenConnected(frame)
    }

    private fun sendWhenConnected(frame: String): Boolean = synchronized(this) {
        if (state !is ControlState.Connected) return false
        transport.send(frame)
    }

    private fun publish(next: ControlState) {
        state = next
        onState(next)
    }

    private inner class Session(
        private val token: String,
        private val nonce: String,
        private val epoch: String,
    ) : Transport.Listener {
        private var cancelWatchdog: (() -> Unit)? = null
        private var helloSent = false
        private var done = false
        private var welcomed = false

        /** Ends the connection once; returns false if it had already ended. */
        fun finish(next: ControlState, closeCode: Int? = null): Boolean {
            synchronized(this@ControlClient) {
                if (done) return false
                done = true
                cancelWatchdog?.invoke()
                cancelWatchdog = null
                if (session === this) session = null
                if (closeCode != null) transport.close(closeCode, "")
                publish(next)
                return true
            }
        }

        override fun onOpen() {
            synchronized(this@ControlClient) {
                if (done) return
                helloSent = true
                if (!transport.send(ControlProtocol.buildHello(appVersion, epoch, nonce))) {
                    finish(ControlState.Failed(Failure.Unreachable), closeCode = 1001)
                    return
                }
                cancelWatchdog = scheduler(WELCOME_TIMEOUT_MS) {
                    // cancel() cannot stop a task already blocked on this monitor, so re-check here.
                    synchronized(this@ControlClient) {
                        if (!done && !welcomed) finish(ControlState.Failed(Failure.Protocol), closeCode = 1008)
                    }
                }
            }
        }

        override fun onMessage(text: String) {
            var deliver: ControlProtocol.TerminalFrame? = null
            synchronized(this@ControlClient) {
                if (done) return
                if (!helloSent) {
                    finish(ControlState.Failed(Failure.Protocol), closeCode = 1008)
                    return
                }
                when (frameType(text)) {
                    "bye" -> onBye(text)
                    "welcome" -> onWelcome(text)
                    "snap", "out", "size", "state" -> {
                        val frame = if (welcomed) ControlProtocol.parseTerminalFrame(text) else null
                        if (frame == null) {
                            finish(ControlState.Failed(Failure.Protocol), closeCode = 1008)
                        } else {
                            deliver = frame
                        }
                    }
                    else -> finish(ControlState.Failed(Failure.Protocol), closeCode = 1008)
                }
            }
            // Outside the lock so a callback may call attach/detach/close freely; the
            // transport delivers onMessage serially per connection, so order holds.
            deliver?.let(onFrame)
        }

        private fun onBye(text: String) {
            val state = when (ControlProtocol.parseBye(text)) {
                ControlProtocol.ByeReason.REVOKED, ControlProtocol.ByeReason.EXPIRED -> ControlState.Revoked
                ControlProtocol.ByeReason.SUPERSEDED -> ControlState.Superseded
                ControlProtocol.ByeReason.DISABLED -> ControlState.Disabled
                ControlProtocol.ByeReason.POLICY -> ControlState.Closed("policy")
                ControlProtocol.ByeReason.SLOW_CONSUMER -> ControlState.Closed("slow-consumer")
                ControlProtocol.ByeReason.RATE_LIMIT -> ControlState.Closed("rate-limit")
                null -> ControlState.Failed(Failure.Protocol)
            }
            finish(state, closeCode = 1000)
        }

        private fun onWelcome(text: String) {
            if (state is ControlState.Connected) {
                // A second welcome is a protocol violation, not a re-auth.
                finish(ControlState.Failed(Failure.Protocol), closeCode = 1008)
                return
            }
            val welcome = ControlProtocol.parseWelcome(text)
            val expected = ControlProtocol.serverProof(token, nonce).toByteArray(Charsets.UTF_8)
            val got = welcome?.proof?.toByteArray(Charsets.UTF_8)
            // Constant-time compare; a missing proof is a mismatch, never Connected.
            if (welcome == null || got == null || !MessageDigest.isEqual(expected, got)) {
                finish(ControlState.Failed(Failure.ProofMismatch), closeCode = 1008)
                return
            }
            welcomed = true
            cancelWatchdog?.invoke()
            cancelWatchdog = null
            publish(ControlState.Connected(welcome.expiresAtMs, welcome.serverTimeMs, welcome.sessions))
        }

        override fun onClosed(code: Int, reason: String) {
            finish(ControlState.Closed("transport"))
        }

        override fun onFailure(httpStatus: Int?, error: Throwable?) {
            val next = when (httpStatus) {
                401 -> ControlState.Revoked
                404 -> ControlState.Failed(Failure.NotListening)
                503 -> ControlState.Failed(Failure.Busy)
                null -> if (state is ControlState.Connected) {
                    ControlState.Closed("transport")
                } else if (error is ConnectException) {
                    ControlState.Failed(Failure.ConnectionRefused)
                } else {
                    ControlState.Failed(Failure.Unreachable)
                }
                else -> ControlState.Failed(Failure.Protocol)
            }
            finish(next)
        }
    }

    private fun frameType(text: String): String? =
        try { JSONObject(text).optString("t").ifEmpty { null } } catch (_: JSONException) { null }
}

/** Client-side bound on the wait for `welcome` after the socket opens. */
private const val WELCOME_TIMEOUT_MS = 8_000L

private val timer: ScheduledExecutorService by lazy {
    Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "aether-ctl-watchdog").apply { isDaemon = true } }
}

private fun scheduleOnTimer(delayMs: Long, task: () -> Unit): () -> Unit {
    val f = timer.schedule(task, delayMs, TimeUnit.MILLISECONDS)
    return { f.cancel(false) }
}
