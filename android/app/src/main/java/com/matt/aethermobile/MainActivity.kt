package com.matt.aethermobile

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.WindowManager
import android.content.pm.ApplicationInfo
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.activity.compose.setContent
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import com.matt.aethermobile.ui.shell.NotSentLine
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.matt.aethermobile.auth.BiometricCallback
import com.matt.aethermobile.auth.BiometricFailure
import com.matt.aethermobile.auth.PairResult
import com.matt.aethermobile.auth.Pairing
import com.matt.aethermobile.auth.PairingClient
import com.matt.aethermobile.auth.QrResult
import com.matt.aethermobile.auth.TokenVault
import com.matt.aethermobile.auth.UnlockStart
import com.matt.aethermobile.net.ControlClient
import com.matt.aethermobile.net.ControlState
import com.matt.aethermobile.net.Failure
import com.matt.aethermobile.net.OkHttpTransport
import com.matt.aethermobile.net.TerminalFeed
import com.matt.aethermobile.protocol.ControlProtocol
import com.matt.aethermobile.protocol.ControlProtocol.SlotState
import com.matt.aethermobile.term.FrameRouter
import com.matt.aethermobile.term.InputSender
import com.matt.aethermobile.ui.components.AeScreenBackground
import com.matt.aethermobile.ui.auth.AuthActions
import com.matt.aethermobile.ui.auth.AuthScreen
import com.matt.aethermobile.ui.auth.authScreenFor
import com.matt.aethermobile.ui.shell.NotSentNotice
import com.matt.aethermobile.ui.shell.ShellActions
import com.matt.aethermobile.ui.shell.ShellScreen
import com.matt.aethermobile.ui.shell.ShellUiState
import com.matt.aethermobile.ui.theme.AetherTheme
import com.matt.aethermobile.term.TerminalHost
import com.matt.aethermobile.term.TerminalScreen
import okhttp3.OkHttpClient
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import javax.crypto.Cipher

/**
 * V1 unlock flow: pair (QR or typed code) -> PC confirm -> fingerprint to save -> connected;
 * cold open -> fingerprint -> connected; 60 s background relock. All decisions live in the pure
 * [AppFlow]; this class runs its [Effect]s. V2 adds the live terminal view: while the flow is
 * Connected, [TerminalScreen] (hardened WebView, pre-warmed in onCreate) is fed by a per-connection
 * [TerminalHost]; leaving Connected disconnects the host and reloads the page clean. No input (V3).
 *
 * Lifecycle: this class is a thin adapter. onStart/onStop (and the RESUMED/PAUSED observer)
 * forward the real callbacks synchronously to [FlowController], which owns relock bookkeeping
 * and decides when a prompt may show; the activity runs the [Effect]s it returns and owns the
 * two timers' Handler.postDelayed calls. Nothing is posted to run "after start".
 *
 * Token handling: after every transition, any token field is cleared unless [AppFlow.holdsToken]
 * says the new state may hold one. The pairing code is a local that never reaches a field or the
 * UI, and the typed field (compose state in AuthScreens) is cleared on submit. The token String lives in at
 * most two fields: [saveToken] (only between pair success and the end of the save attempt, nulled on every
 * exit path) and [sessionToken] (the relock window, nulled by Effect.DropToken). Neither is shown or
 * logged. All state changes run on the main thread; network callbacks marshal via runOnUiThread.
 */
class MainActivity : AppCompatActivity() {
    private companion object {
        const val TAG = "AetherFlow"
    }

    private val vault by lazy { TokenVault(this) }
    private val controller = FlowController(SystemClock::elapsedRealtime)
    private val handler = Handler(Looper.getMainLooper())
    private val relockTimer = Runnable { if (!isDestroyed) applyEffects(controller.onRelockTimer()) }
    private val deferredTimer = Runnable { if (!isDestroyed) applyEffects(controller.onDeferredTimer()) }
    private val io: ExecutorService = Executors.newSingleThreadExecutor()
    private val http = OkHttpClient()
    private val host = BuildConfig.TITAN_IP

    private val flow: FlowState get() = controller.state

    // Token held only for a save attempt; moved to sessionToken or nulled before the attempt ends.
    private var saveToken: String? = null

    // Token held only for the relock window.
    private var sessionToken: String? = null

    private var client: ControlClient? = null
    @Volatile private var connGen = 0

    // ONE prompt instance for the activity's life, reused across relock re-prompts.
    private var prompt: BiometricPrompt? = null
    private var pending: BiometricCallback? = null

    // Created once here and handed to ShellScreen, which only re-parents it; never recreated by a factory.
    private lateinit var webHolder: FrameLayout
    private lateinit var screen: TerminalScreen

    // Terminal state. The host is rebuilt per connection (fresh TerminalFeed); touched on the main thread.
    private var termHost: TerminalHost? = null
        set(v) { field = v; router.host = v }
    private val router = FrameRouter()
    private var selected = "claude"
    private var zoomPx = 0 // 0 = fit width
    private var snapLogged = false
    private var terminalLive = false
    private var lastSessions: List<ControlProtocol.SessionInfo> = emptyList()

    /** Everything the Compose tree reads; replaced wholesale by [renderTabs] (main thread only). */
    private class UiSnapshot(
        val flow: FlowState,
        val tabs: List<TerminalHost.Tab>,
        val selected: String,
        val ctrlOn: Boolean = false,
        val hostAccepts: Boolean = false,
        val notice: NotSentNotice = NotSentNotice.NONE,
    )

    private var ui by mutableStateOf(UiSnapshot(FlowState.NotConfigured, emptyList(), "claude"))

    override fun onCreate(savedInstanceState: Bundle?) {
        // No screenshots, blank recents thumbnail (design spec 1.4). Must precede content.
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        screen = TerminalScreen(
            this,
            debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0,
            onPage = { termHost?.onPage(it) },
            onRenderGone = { if (!isDestroyed) onRenderGone() },
            onResync = { termHost?.resync() },
        )
        webHolder = FrameLayout(this)
        webHolder.addView(
            screen.webView,
            ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        setContent { AetherTheme { Root() } }

        prompt = createPrompt()
        lifecycle.addObserver(LifecycleEventObserver { _, event ->
            // Delivered when currentState is already RESUMED / back to STARTED (not inside onResume).
            when (event) {
                Lifecycle.Event.ON_RESUME -> applyEffects(controller.onResume())
                Lifecycle.Event.ON_PAUSE -> controller.onPause()
                else -> Unit
            }
        })
        render()
    }

    override fun onStart() {
        super.onStart()
        applyEffects(controller.onStart(configured = host.isNotEmpty()) { vaultHasToken() })
    }

    override fun onStop() {
        applyEffects(controller.onStop())
        super.onStop()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        connGen++
        try { client?.close() } catch (_: RuntimeException) { }
        client = null
        sessionToken = null
        saveToken = null
        pending = null
        try { prompt?.cancelAuthentication() } catch (_: RuntimeException) { }
        prompt = null
        termHost?.onDisconnected()
        termHost = null
        if (::screen.isInitialized) screen.destroy()
        io.shutdownNow()
        super.onDestroy()
    }

    // ---- flow plumbing -------------------------------------------------------------------

    private fun dispatch(event: FlowEvent) = applyEffects(controller.dispatch(event))

    private val pendingEffects = ArrayDeque<Effect>()
    private var applying = false

    /**
     * FIFO and non-reentrant: an effect that dispatches synchronously (an inline Connect
     * failure) only enqueues its follow-up effects; the outermost call drains them in order.
     */
    private fun applyEffects(effects: List<Effect>) {
        pendingEffects.addAll(effects)
        if (applying) return
        applying = true
        try {
            while (true) run(pendingEffects.removeFirstOrNull() ?: break)
        } finally {
            applying = false
        }
        if (!AppFlow.holdsToken(flow)) {
            saveToken = null
            sessionToken = null
        }
        render()
    }

    private fun run(effect: Effect) {
        Log.d(TAG, "effect $effect")
        when (effect) {
            Effect.BeginSave -> beginSave()
            Effect.BeginUnlock -> beginUnlock()
            Effect.Connect -> connect()
            Effect.CloseSocket -> closeSocket()
            Effect.DropToken -> sessionToken = null
            Effect.DiscardSaveToken -> saveToken = null
            Effect.ClearVault -> try { vault.clear() } catch (_: Exception) { }
            Effect.CancelPrompt -> {
                // A prompt that cannot survive the stop must not leave a stuck callback.
                if (pending != null) {
                    pending = null
                    try { prompt?.cancelAuthentication() } catch (_: RuntimeException) { }
                }
            }
            Effect.StartRelockTimer -> handler.postDelayed(relockTimer, AppFlow.RELOCK_AFTER_MS)
            Effect.CancelRelockTimer -> handler.removeCallbacks(relockTimer)
            Effect.StartDeferredTimer -> handler.postDelayed(deferredTimer, AppFlow.DEFERRED_SAVE_MAX_MS)
            Effect.CancelDeferredTimer -> handler.removeCallbacks(deferredTimer)
        }
    }

    private fun vaultHasToken(): Boolean = try { vault.hasToken() } catch (_: Exception) { false }

    // ---- pairing -------------------------------------------------------------------------

    private fun onPair(raw: String) {
        if (flow !is FlowState.NeedsPair) return
        val code = Pairing.parseManualCode(raw)
        if (code == null) dispatch(FlowEvent.InputRejected(Notice.BadCode)) else submitPair(code)
    }

    private fun onScanClicked() {
        if (flow !is FlowState.NeedsPair) return
        try {
            val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
            GmsBarcodeScanning.getClient(this, options).startScan()
                .addOnSuccessListener { barcode -> onScanned(barcode.rawValue) }
                .addOnFailureListener { scanFailed() }
        } catch (_: RuntimeException) {
            scanFailed()
        }
    }

    private fun scanFailed() {
        if (!isDestroyed && flow is FlowState.NeedsPair) dispatch(FlowEvent.InputRejected(Notice.ScanFailed))
    }

    private fun onScanned(raw: String?) {
        if (isDestroyed || flow !is FlowState.NeedsPair) return
        val parsed = if (raw == null) null else Pairing.parseQr(raw, host)
        if (parsed is QrResult.Ok) submitPair(parsed.code) else dispatch(FlowEvent.InputRejected(Notice.WrongQr))
    }

    private fun submitPair(code: String) {
        dispatch(FlowEvent.PairSubmitted)
        if (flow != FlowState.Pairing) return
        try {
            io.execute {
                val result = try {
                    PairingClient(http, host, ControlProtocol.PORT).pair(code)
                } catch (t: Throwable) {
                    if (t is VirtualMachineError) throw t
                    PairResult.Unreachable
                }
                runOnUiThread { onPairResult(result) }
            }
        } catch (_: RuntimeException) {
            dispatch(FlowEvent.PairResult(PairKind.Unreachable))
        }
    }

    private fun onPairResult(result: PairResult) {
        if (isDestroyed || flow != FlowState.Pairing) return
        val kind = when (result) {
            is PairResult.Paired -> {
                saveToken = result.token
                // The controller parks this as SaveDeferred when the activity is not RESUMED.
                PairKind.Paired
            }
            PairResult.BadCode -> PairKind.BadCode
            PairResult.Declined -> PairKind.Declined
            PairResult.Burned -> PairKind.Burned
            PairResult.Busy -> PairKind.Busy
            PairResult.Unreachable -> PairKind.Unreachable
            is PairResult.Error -> PairKind.Other
        }
        dispatch(FlowEvent.PairResult(kind))
    }

    // ---- save / unlock -------------------------------------------------------------------

    private fun beginSave() {
        val cipher = try { vault.beginSave() } catch (_: Exception) { null }
        if (cipher == null) {
            saveToken = null
            dispatch(FlowEvent.SaveFailed)
            return
        }
        val shown = authenticate(cipher, R.string.prompt_save_title, R.string.prompt_save_subtitle, object : BiometricCallback {
            override fun onSuccess(cipher: Cipher) {
                // Take the token out of the field first: no path below can leave it behind.
                val token = saveToken
                saveToken = null
                val saved = token != null && flow == FlowState.SavePrompt &&
                    try { vault.completeSave(cipher, token) } catch (_: Exception) { false }
                if (saved) {
                    sessionToken = token
                    dispatch(FlowEvent.SaveDone)
                } else {
                    dispatch(FlowEvent.SaveFailed)
                }
            }

            override fun onFailure(reason: BiometricFailure) {
                saveToken = null
                dispatch(if (reason == BiometricFailure.UserCancelled) FlowEvent.SaveCancelled else FlowEvent.SaveFailed)
            }
        })
        if (!shown) {
            saveToken = null
            dispatch(FlowEvent.SaveFailed)
        }
    }

    private fun beginUnlock() {
        if (pending != null) return // a prompt is already up; do not stack another
        when (val start = try { vault.beginUnlock() } catch (_: Exception) { UnlockStart.Unavailable }) {
            UnlockStart.Empty -> dispatch(FlowEvent.UnlockStartResult(UnlockKind.Empty))
            UnlockStart.Invalidated -> dispatch(FlowEvent.UnlockStartResult(UnlockKind.Invalidated))
            UnlockStart.Unavailable -> dispatch(FlowEvent.UnlockStartResult(UnlockKind.Unavailable))
            is UnlockStart.Ready -> {
                dispatch(FlowEvent.UnlockStartResult(UnlockKind.Ready))
                val shown = authenticate(start.cipher, R.string.prompt_unlock_title, R.string.prompt_unlock_subtitle, object : BiometricCallback {
                    override fun onSuccess(cipher: Cipher) = onUnlockAuthenticated(cipher)

                    override fun onFailure(reason: BiometricFailure) {
                        dispatch(FlowEvent.UnlockAuthFailed(authFail(reason)))
                    }
                })
                if (!shown) dispatch(FlowEvent.UnlockAuthFailed(AuthFail.Other))
            }
        }
    }

    private fun onUnlockAuthenticated(cipher: Cipher) {
        val token = try { vault.completeUnlock(cipher) } catch (_: Exception) { null }
        if (token == null) {
            // Wiped (corrupt/tampered) -> Pair; transient -> stay Locked with a retry message.
            dispatch(FlowEvent.UnlockDecryptFailed(vaultWiped = !vaultHasToken()))
        } else if (flow is FlowState.Locked) {
            Log.d(TAG, "unlock_ok")
            sessionToken = token
            dispatch(FlowEvent.UnlockDone)
        }
    }

    private fun authFail(reason: BiometricFailure): AuthFail = when (reason) {
        BiometricFailure.UserCancelled -> AuthFail.Cancelled
        BiometricFailure.Lockout, BiometricFailure.LockoutPermanent -> AuthFail.Lockout
        BiometricFailure.NoHardware, BiometricFailure.NoneEnrolled -> AuthFail.Unavailable
        BiometricFailure.Other -> AuthFail.Other
    }

    /** The prompt constructor throws on a destroyed or finishing activity; never crash on that. */
    private fun createPrompt(): BiometricPrompt? = try {
        BiometricPrompt(
            this,
            ContextCompat.getMainExecutor(this),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    val cb = pending
                    pending = null
                    val cipher = result.cryptoObject?.cipher
                    if (cb == null) return
                    if (cipher == null) cb.onFailure(BiometricFailure.Other) else cb.onSuccess(cipher)
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    val cb = pending
                    pending = null
                    cb?.onFailure(BiometricFailure.fromCode(errorCode))
                }
            },
        )
    } catch (_: IllegalStateException) {
        null
    } catch (_: IllegalArgumentException) {
        null
    }

    /** True when the prompt is up; false (nothing shown, [callback] unused) on any refusal. */
    private fun authenticate(cipher: Cipher, titleRes: Int, subtitleRes: Int, callback: BiometricCallback): Boolean {
        val p = prompt ?: return false
        if (isFinishing || isDestroyed || pending != null) return false
        // BiometricPrompt drops authenticate() silently (no callback) once the state is saved.
        if (!lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) return false
        val available = BiometricManager.from(this)
            .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        if (available != BiometricManager.BIOMETRIC_SUCCESS) return false
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(getString(titleRes))
            .setSubtitle(getString(subtitleRes))
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setNegativeButtonText(getString(R.string.prompt_cancel))
            .setConfirmationRequired(false)
            .build()
        pending = callback
        return try {
            p.authenticate(info, BiometricPrompt.CryptoObject(cipher))
            true
        } catch (_: IllegalStateException) {
            pending = null
            false
        } catch (_: IllegalArgumentException) {
            pending = null
            false
        }
    }

    // ---- connection ----------------------------------------------------------------------

    private fun connect() {
        val token = sessionToken
        if (token == null) {
            dispatch(FlowEvent.ClientFailed(ErrorKind.Closed))
            return
        }
        val gen = ++connGen
        // One sender per connection: its cseq must follow the desktop's per-epoch counter across host rebuilds.
        // Callbacks arrive on transport or host threads: marshal to main. The notice is NOT cleared here and
        // the not-sent report is not gen-filtered: the dying connection's drop report (closeSocket bumps connGen
        // first) must reach the screen. Only an ack, a slot switch or a dismiss clears it.
        fun onMain(f: () -> Unit) = runOnUiThread { if (!isDestroyed) { f(); renderTabs() } }
        inputSender = InputSender(
            { s, c, d -> client?.sendInput(s, c, d) ?: false },
            { System.currentTimeMillis() },
            onNotSent = { n -> onMain { notice = notice.add(n) } },
            onRefused = { r -> onMain { notice = notice.refused(r) } },
            onAcked = { onMain { notice = NotSentNotice.NONE } },
        )
        val th = newHost()
        val c = ControlClient(host, BuildConfig.VERSION_NAME, OkHttpTransport(), onState = { s ->
            // Transport threads: marshal to main, and drop anything from a superseded connection.
            runOnUiThread { if (gen == connGen && !isDestroyed) onClientState(s) }
        }, onFrame = { f ->
            // Transport thread: route to the CURRENT host (it is replaced on renderer loss), and only for this connection.
            if (gen == connGen) router.route(f)
            if (f is ControlProtocol.TerminalFrame.Snap && !snapLogged) {
                snapLogged = true
                Log.d(TAG, "first_snap_rendered")
            }
        })
        client = c
        termHost = th
        snapLogged = false
        try {
            c.connect(token)
        } catch (_: RuntimeException) {
            dispatch(FlowEvent.ClientFailed(ErrorKind.Unreachable))
        }
    }

    private fun closeSocket() {
        connGen++ // late callbacks (including our own Closed("local")) are ignored
        endTerminal()
        val c = client
        client = null
        try { c?.close() } catch (_: RuntimeException) { }
    }

    /** Names and fixed reasons only, no payload fields: Connected carries expiry/server time and must not be printed. */
    private fun describe(s: ControlState): String = when (s) {
        is ControlState.Closed -> "Closed(${s.reason})"
        is ControlState.Failed -> "Failed(${s.failure.name})"
        else -> s::class.java.simpleName
    }

    private fun onClientState(s: ControlState) {
        Log.d(TAG, "control state ${describe(s)} flow=${flow::class.java.simpleName}")
        when (s) {
            ControlState.Idle, ControlState.Connecting -> Unit
            is ControlState.Connected -> {
                Log.d(TAG, "welcome")
                dispatch(FlowEvent.ClientConnected(s.expiresAtMs, s.serverTimeMs))
                if (flow is FlowState.Connected) startTerminal(s.sessions)
            }
            ControlState.Revoked -> dispatch(FlowEvent.ClientRevoked)
            ControlState.Superseded -> dispatch(FlowEvent.ClientFailed(ErrorKind.Superseded))
            ControlState.Disabled -> dispatch(FlowEvent.ClientFailed(ErrorKind.Disabled))
            is ControlState.Closed -> dispatch(FlowEvent.ClientFailed(ErrorKind.Closed))
            is ControlState.Failed -> dispatch(FlowEvent.ClientFailed(errorKind(s.failure)))
        }
    }

    private fun errorKind(f: Failure): ErrorKind = when (f) {
        Failure.HostRefused, Failure.Unreachable -> ErrorKind.Unreachable
        Failure.ConnectionRefused -> ErrorKind.ConnectionRefused
        Failure.NotListening -> ErrorKind.NotListening
        Failure.Busy -> ErrorKind.Busy
        Failure.ProofMismatch -> ErrorKind.ProofMismatch
        Failure.Protocol -> ErrorKind.Protocol
    }

    // ---- terminal ------------------------------------------------------------------------

    private var inputSender: InputSender? = null
    /** Chars not sent, shown until the next ack, a slot switch or a dismiss; survives a drop (main thread only). */
    private var notice = NotSentNotice.NONE

    private fun newHost(): TerminalHost {
        var th: TerminalHost? = null
        th = TerminalHost(
            attach = { s, q -> client?.attach(s, q) ?: false },
            detach = { s -> client?.detach(s) ?: false },
            post = screen::post, // posts to the UI thread; never waits under the host monitor
            feed = TerminalFeed(),
            sharedSender = inputSender,
            onTabsChanged = { handler.post { if (!isDestroyed && termHost === th) renderTabs() } },
        )
        return th
    }

    private fun startTerminal(sessions: List<ControlProtocol.SessionInfo>) {
        val th = termHost ?: return
        lastSessions = sessions
        terminalLive = true
        th.onSessions(sessions)
        selected = sessions.firstOrNull { it.state == SlotState.RUNNING }?.s ?: "claude"
        th.select(selected)
        th.zoom(zoomPx)
        renderTabs()
    }

    /** The flow left Connected (lock, relock, error, socket closed): stop frames and drop what the page rendered. */
    private fun endTerminal() {
        if (!terminalLive) return
        terminalLive = false
        termHost?.onDisconnected()
        termHost = null
        screen.reset()
    }

    private fun onRenderGone() {
        // The page lost its state: rebuild the host (fresh feed) and re-attach from a snapshot.
        val old = termHost ?: return
        old.onDisconnected(connectionLost = false) // same connection: unacked input is not "not sent"
        termHost = newHost()
        if (flow is FlowState.Connected) startTerminal(lastSessions)
    }

    private fun selectSlot(s: String) {
        selected = s
        notice = NotSentNotice.NONE
        termHost?.select(s)
        renderTabs()
    }

    private fun dismissNotice() {
        notice = NotSentNotice.NONE
        renderTabs()
    }

    private fun sendKey(bytes: String) {
        termHost?.sendKeys(bytes)
        renderTabs() // a latched Ctrl is consumed by the key
    }

    private fun toggleCtrl() {
        termHost?.let { it.setCtrlLatch(!it.ctrlLatched()) }
        renderTabs()
    }

    private fun setZoom(px: Int) {
        zoomPx = px
        termHost?.zoom(px)
    }

    private fun stepZoom(delta: Int) {
        val base = if (zoomPx == 0) 14 else zoomPx
        setZoom((base + delta).coerceIn(8, 24))
    }

    private fun renderTabs() {
        val tabs = termHost?.tabs() ?: ControlProtocol.SLOTS.map { TerminalHost.Tab(it.s, it.label, SlotState.NOT_STARTED) }
        ui = UiSnapshot(flow, tabs, selected, termHost?.ctrlLatched() == true, termHost?.typingAccepted() == true, notice)
    }

    // ---- rendering -----------------------------------------------------------------------

    private fun render() {
        if (!::screen.isInitialized) return
        if (flow !is FlowState.Connected) endTerminal()
        renderTabs()
    }

    @Composable
    private fun Root() {
        val snap = ui
        val authModel = authScreenFor(snap.flow)
        val connected = snap.flow as? FlowState.Connected
        AeScreenBackground {
            Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.systemBars.union(WindowInsets.ime))) {
                // Always composed so the holder is attached once and never torn down by a state change.
                ShellScreen(
                    state = ShellUiState(connected != null, snap.tabs, snap.selected, connected, snap.ctrlOn, snap.hostAccepts),
                    actions = ShellActions(
                        onSelectSlot = ::selectSlot,
                        onLockNow = { dispatch(FlowEvent.LockNow) },
                        onZoomOut = { stepZoom(-2) },
                        onZoomIn = { stepZoom(2) },
                        onFit = { setZoom(0) },
                        onKey = ::sendKey,
                        onCtrlToggle = ::toggleCtrl,
                    ),
                    terminalHolder = webHolder,
                )
                if (authModel != null) {
                    AuthScreen(
                        authModel,
                        AuthActions(
                            onPair = ::onPair,
                            onScan = ::onScanClicked,
                            onUnlock = { dispatch(FlowEvent.UnlockRequested) },
                            onRetry = { dispatch(FlowEvent.Retry(vaultHasToken())) },
                        ),
                    )
                }
                // Above every screen, so a drop that tears the key row down still shows what was not sent.
                NotSentLine(snap.notice, ::dismissNotice, Modifier.align(Alignment.TopCenter).padding(top = 60.dp))
            }
        }
    }
}
