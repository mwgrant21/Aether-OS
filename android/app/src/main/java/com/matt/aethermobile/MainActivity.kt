package com.matt.aethermobile

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.MotionEvent
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
import com.matt.aethermobile.ui.shell.InputDiag
import com.matt.aethermobile.ui.shell.NotSentLine
import com.matt.aethermobile.ui.shell.toDiag
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
import androidx.core.content.edit
import androidx.core.view.WindowCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.matt.aethermobile.auth.BiometricCallback
import com.matt.aethermobile.auth.BiometricGate
import com.matt.aethermobile.auth.BiometricFailure
import com.matt.aethermobile.auth.PairResult
import com.matt.aethermobile.auth.Pairing
import com.matt.aethermobile.auth.PairingClient
import com.matt.aethermobile.auth.QrResult
import com.matt.aethermobile.auth.ScreenShare
import com.matt.aethermobile.auth.ShareStart
import com.matt.aethermobile.auth.ShareUi
import com.matt.aethermobile.auth.TokenVault
import com.matt.aethermobile.auth.UnlockStart
import com.matt.aethermobile.net.ControlClient
import com.matt.aethermobile.net.ControlState
import com.matt.aethermobile.net.Failure
import com.matt.aethermobile.net.OkHttpTransport
import com.matt.aethermobile.net.TerminalFeed
import com.matt.aethermobile.ledger.LedgerHost
import com.matt.aethermobile.ledger.LedgerUi
import com.matt.aethermobile.thread.ThreadHost
import com.matt.aethermobile.thread.ThreadUi
import com.matt.aethermobile.thread.ViewMode
import com.matt.aethermobile.protocol.ControlProtocol
import com.matt.aethermobile.protocol.ControlProtocol.SlotState
import com.matt.aethermobile.term.FrameRouter
import com.matt.aethermobile.term.InputSender
import com.matt.aethermobile.term.SlotMemory
import com.matt.aethermobile.term.SlotStore
import com.matt.aethermobile.ui.components.AeScreenBackground
import com.matt.aethermobile.ui.auth.AuthActions
import com.matt.aethermobile.ui.auth.AuthScreen
import com.matt.aethermobile.ui.auth.authScreenFor
import com.matt.aethermobile.ui.shell.AppView
import com.matt.aethermobile.ui.shell.NotSentNotice
import com.matt.aethermobile.ui.shell.ShellActions
import com.matt.aethermobile.ui.shell.clearsDraft
import com.matt.aethermobile.ui.shell.ShellScreen
import com.matt.aethermobile.ui.shell.ShellUiState
import com.matt.aethermobile.ui.shell.Zoom
import com.matt.aethermobile.ui.shell.OrientationMode
import com.matt.aethermobile.ui.shell.ViewCtlUi
import com.matt.aethermobile.ui.shell.ViewPrefs
import com.matt.aethermobile.ui.shell.ViewPrefsStore
import com.matt.aethermobile.ui.theme.AetherTheme
import com.matt.aethermobile.ui.thread.graceRerenderDelayMs
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
    private val slotMemory by lazy {
        val prefs = getSharedPreferences("aether_ui", MODE_PRIVATE)
        SlotMemory(object : SlotStore {
            override fun get(): String? = prefs.getString("last_slot", null)
            override fun put(slot: String) { prefs.edit { putString("last_slot", slot) } }
        })
    }
    private val viewPrefs by lazy {
        val prefs = getSharedPreferences("aether_ui", MODE_PRIVATE)
        ViewPrefs(object : ViewPrefsStore {
            override fun getZoom(): Int? = if (prefs.contains("zoom_px")) prefs.getInt("zoom_px", Zoom.DEFAULT) else null
            override fun putZoom(px: Int) { prefs.edit { putInt("zoom_px", px) } }
            override fun getOrientation(): String? = prefs.getString("orientation", null)
            override fun putOrientation(key: String) { prefs.edit { putString("orientation", key) } }
        })
    }
    private val controller = FlowController(SystemClock::elapsedRealtime)
    private val handler = Handler(Looper.getMainLooper())
    private val relockTimer = Runnable { if (!isDestroyed) applyEffects(controller.onRelockTimer()) }
    private val deferredTimer = Runnable { if (!isDestroyed) applyEffects(controller.onDeferredTimer()) }
    private val graceRerender = Runnable { if (!isDestroyed) renderTabs() }
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
    // A screen-share enable prompt (no CryptoObject) is up on the shared [prompt]; routed in its callbacks.
    private var sharePending = false

    // Created once here and handed to ShellScreen, which only re-parents it; never recreated by a factory.
    private lateinit var webHolder: FrameLayout
    private lateinit var screen: TerminalScreen

    // Terminal state. The host is rebuilt per connection (fresh TerminalFeed); touched on the main thread.
    private var termHost: TerminalHost? = null
        set(v) { field = v; router.host = v }
    // Thread model for the Claude slot, one per connection (like the sender); touched on the main thread.
    private var threadHost: ThreadHost? = null
    private var view = ViewMode.THREAD // memory only; survives reconnects
    // Ledger feed holder, one per connection; appView is memory only and resets on lock.
    private var ledgerHost: LedgerHost? = null
    private var appView = AppView.TERMINAL
    private val router = FrameRouter()
    private var selected = "claude"
    private var zoomPx = Zoom.DEFAULT // 0 = fit width (the Fit button)
    private var orientation = OrientationMode.AUTO
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
        val restartAvailable: Boolean = false,
        val view: ViewMode = ViewMode.THREAD,
        val thread: ThreadUi = ThreadUi.EMPTY,
        val share: ShareUi = ScreenShare.state.ui(),
        val appView: AppView = AppView.TERMINAL,
        val ledger: LedgerUi = LedgerUi.Off,
        val viewCtl: ViewCtlUi = ViewCtlUi(),
    )

    private var ui by mutableStateOf(UiSnapshot(FlowState.NotConfigured, emptyList(), "claude"))

    override fun onCreate(savedInstanceState: Bundle?) {
        // A fresh launch always starts secure; recreation with the process alive keeps share mode.
        ScreenShare.state.onActivityCreate(freshLaunch = savedInstanceState == null)
        // No screenshots, blank recents thumbnail (design spec 1.4) unless share mode is on. Must precede content.
        applySecureFlag()
        super.onCreate(savedInstanceState)
        zoomPx = viewPrefs.loadZoom()
        orientation = viewPrefs.loadOrientation()
        requestedOrientation = orientation.requested
        WindowCompat.setDecorFitsSystemWindows(window, false)
        screen = TerminalScreen(
            this,
            debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0,
            onPage = { termHost?.onPage(it) },
            onRenderGone = { if (!isDestroyed) onRenderGone() },
            onResync = { termHost?.resync() },
            onDiag = { InputDiag.recorder.record(it) },
        )
        InputDiag.onChanged = { screen.setDiag(it) }
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

    /** The only place FLAG_SECURE is touched: held unless screen share mode is on. */
    private fun applySecureFlag() {
        if (ScreenShare.state.secureWanted) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }

    private fun toggleShare(want: Boolean) {
        if (!want) {
            ScreenShare.state.disable()
            applySecureFlag()
            renderTabs()
            return
        }
        if (ScreenShare.state.on || pending != null || sharePending) return
        when (ScreenShare.state.requestEnable(BiometricGate.canAuthenticate(this))) {
            ShareStart.ShowPrompt -> {
                if (!authenticateShare()) ScreenShare.state.onPromptNotShown()
                renderTabs()
            }
            ShareStart.AlreadyOn -> Unit
            is ShareStart.Refused -> renderTabs()
        }
    }

    /** True when the prompt is up. Same single [prompt] as unlock, no CryptoObject, routed by [sharePending]. */
    private fun authenticateShare(): Boolean {
        val p = prompt ?: return false
        if (isFinishing || isDestroyed || pending != null || sharePending) return false
        if (!lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) return false
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(getString(R.string.share_prompt_title))
            .setSubtitle(getString(R.string.share_prompt_subtitle))
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setNegativeButtonText(getString(R.string.prompt_cancel))
            .setConfirmationRequired(false)
            .build()
        sharePending = true
        return try {
            p.authenticate(info)
            true
        } catch (_: IllegalStateException) {
            sharePending = false
            false
        } catch (_: IllegalArgumentException) {
            sharePending = false
            false
        }
    }

    // Input diagnostic: records only whitelisted MotionEvent metadata (no keys, no text); never alters delivery.
    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        try { if (InputDiag.recorder.enabled) InputDiag.recorder.record(ev.toDiag()) } catch (_: Exception) { }
        return super.dispatchTouchEvent(ev)
    }

    override fun dispatchGenericMotionEvent(ev: MotionEvent): Boolean {
        try { if (InputDiag.recorder.enabled) InputDiag.recorder.record(ev.toDiag()) } catch (_: Exception) { }
        return super.dispatchGenericMotionEvent(ev)
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
        sharePending = false
        try { prompt?.cancelAuthentication() } catch (_: RuntimeException) { }
        prompt = null
        termHost?.onDisconnected()
        termHost = null
        threadHost?.onDisconnected()
        threadHost = null
        ledgerHost?.onDisconnected()
        ledgerHost = null
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
                if (pending != null || sharePending) {
                    pending = null
                    sharePending = false
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
        if (pending != null || sharePending) return // a prompt is already up; do not stack another
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
                    if (sharePending) {
                        sharePending = false
                        if (flow is FlowState.Connected) {
                            ScreenShare.state.onAuthenticated()
                            applySecureFlag()
                        }
                        renderTabs()
                        return
                    }
                    val cb = pending
                    pending = null
                    val cipher = result.cryptoObject?.cipher
                    if (cb == null) return
                    if (cipher == null) cb.onFailure(BiometricFailure.Other) else cb.onSuccess(cipher)
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    if (sharePending) {
                        sharePending = false
                        ScreenShare.state.onAuthFailed(BiometricFailure.fromCode(errorCode))
                        renderTabs()
                        return
                    }
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
        if (isFinishing || isDestroyed || pending != null || sharePending) return false
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
        // first) must reach the screen. Only an ack (gen-filtered: a late ack must not clear a newer notice), a slot
        // switch or a dismiss clears it.
        fun onMain(f: () -> Unit) = runOnUiThread { if (!isDestroyed) { f(); renderTabs() } }
        inputSender = InputSender(
            { s, c, d -> client?.sendInput(s, c, d) ?: false },
            { System.currentTimeMillis() },
            onNotSent = { n -> onMain { notice = notice.add(n) } },
            onRefused = { r -> onMain { notice = notice.refused(r) } },
            onAcked = { runOnUiThread { if (gen == connGen && !isDestroyed) { notice = NotSentNotice.NONE; renderTabs() } } },
        )
        val th = newHost()
        val tth = newThreadHost()
        val lth = newLedgerHost()
        val c = ControlClient(host, BuildConfig.VERSION_NAME, OkHttpTransport(), onState = { s ->
            // Transport threads: marshal to main, and drop anything from a superseded connection.
            runOnUiThread { if (gen == connGen && !isDestroyed) onClientState(s) }
        }, onThreadFrame = { f ->
            // Transport thread; the host drops frames it is not attached for.
            if (gen == connGen) tth.onFrame(f)
        }, onLedgerFrame = { f ->
            if (gen == connGen) lth.onFrame(f)
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
        threadHost?.onDisconnected()
        threadHost = tth
        ledgerHost?.onDisconnected()
        ledgerHost = lth
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

    private fun newThreadHost(): ThreadHost {
        var tth: ThreadHost? = null
        tth = ThreadHost(
            sendAttach = { client?.threadAttach() ?: false },
            sendDetach = { client?.threadDetach() ?: false },
            onChanged = { handler.post { if (!isDestroyed && threadHost === tth) renderTabs() } },
            onFirstContent = { Log.d(TAG, "first_thread_rendered") },
        )
        return tth
    }

    private fun newLedgerHost(): LedgerHost {
        var lth: LedgerHost? = null
        lth = LedgerHost(
            sendAttach = { client?.ledgerAttach() ?: false },
            sendDetach = { client?.ledgerDetach() ?: false },
            onChanged = { handler.post { if (!isDestroyed && ledgerHost === lth) renderTabs() } },
        )
        return lth
    }

    /** The ledger feed is live exactly when the Ledger view is open on a welcomed connection. */
    private fun syncLedger() {
        val h = ledgerHost ?: return
        if (terminalLive) h.onConnected()
        h.activate(terminalLive && appView == AppView.LEDGER)
    }

    fun openView(v: AppView) {
        appView = v
        syncLedger()
        renderTabs()
    }

    /** Thread is live exactly when Claude is selected, the view is Thread and the connection is welcomed. */
    private fun syncThread() {
        val t = threadHost ?: return
        if (terminalLive) t.onConnected()
        t.activate(terminalLive && selected == "claude" && view == ViewMode.THREAD)
    }

    fun setView(v: ViewMode) {
        view = v
        if (v == ViewMode.THREAD && terminalLive) termHost?.let { if (!it.isAttached(selected)) it.select(selected) }
        syncThread()
        renderTabs()
    }

    private fun startTerminal(sessions: List<ControlProtocol.SessionInfo>) {
        val th = termHost ?: return
        lastSessions = sessions
        terminalLive = true
        th.onSessions(sessions)
        selected = slotMemory.pick(sessions)
        th.select(selected)
        th.zoom(zoomPx)
        syncThread()
        syncLedger()
        renderTabs()
    }

    /** The flow left Connected (lock, relock, error, socket closed): stop frames and drop what the page rendered. */
    private fun endTerminal() {
        if (!terminalLive) return
        terminalLive = false
        termHost?.onDisconnected()
        termHost = null
        threadHost?.onDisconnected()
        // Lock/relock/error: leave the Ledger (detach while the socket may still be up) and drop its figures.
        appView = AppView.TERMINAL
        ledgerHost?.activate(false)
        ledgerHost?.onDisconnected()
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
        slotMemory.remember(s) // the only writer: a user tap, never the automatic fallback
        notice = NotSentNotice.NONE
        termHost?.select(s)
        appView = AppView.TERMINAL
        syncLedger()
        syncThread()
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

    /** Null host: the bar is only composed while connected, so nothing is counted here. */
    private fun sendCompose(text: String, enter: Boolean): TerminalHost.ComposeResult =
        (termHost?.sendCompose(text, enter) ?: TerminalHost.ComposeResult.NOT_ACCEPTED).also { renderTabs() }

    private fun restartTerminal2(): Boolean = (termHost?.restartTerminal2() ?: false).also { renderTabs() }

    private fun toggleCtrl() {
        termHost?.let { it.setCtrlLatch(!it.ctrlLatched()) }
        renderTabs()
    }

    private fun setZoom(px: Int) {
        zoomPx = px
        termHost?.zoom(px)
        viewPrefs.saveZoom(px)
        renderTabs()
    }

    private fun setOrientation(mode: OrientationMode) {
        orientation = mode
        requestedOrientation = mode.requested
        viewPrefs.saveOrientation(mode)
        renderTabs()
    }

    private fun stepZoom(delta: Int) {
        setZoom(Zoom.stepped(zoomPx, delta))
    }

    private fun renderTabs() {
        val tabs = termHost?.tabs() ?: ControlProtocol.SLOTS.map { TerminalHost.Tab(it.s, it.label, SlotState.NOT_STARTED) }
        val t = threadHost?.snapshot() ?: ThreadUi.EMPTY
        ui = UiSnapshot(
            flow, tabs, selected, termHost?.ctrlLatched() == true, termHost?.typingAccepted() == true, notice,
            restartAvailable = termHost?.restartAvailable() == true,
            view = view,
            thread = t,
            share = ScreenShare.state.ui(),
            appView = appView,
            ledger = ledgerHost?.snapshot() ?: LedgerUi.Off,
            viewCtl = ViewCtlUi(zoomPx, orientation),
        )
        handler.removeCallbacks(graceRerender)
        graceRerenderDelayMs(t, System.currentTimeMillis())?.let { handler.postDelayed(graceRerender, it) }
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
                    state = ShellUiState(connected != null, snap.tabs, snap.selected, connected, snap.ctrlOn, snap.hostAccepts, clearsDraft(snap.flow), restartAvailable = snap.restartAvailable, view = snap.view, thread = snap.thread, share = snap.share, appView = snap.appView, ledger = snap.ledger, viewCtl = snap.viewCtl, nowMs = System.currentTimeMillis()),
                    actions = ShellActions(
                        onSelectSlot = ::selectSlot,
                        onLockNow = { dispatch(FlowEvent.LockNow) },
                        onZoomOut = { stepZoom(-Zoom.STEP) },
                        onZoomIn = { stepZoom(Zoom.STEP) },
                        onFit = { setZoom(0) },
                        onKey = ::sendKey,
                        onCtrlToggle = ::toggleCtrl,
                        onCompose = ::sendCompose,
                        onRestart = ::restartTerminal2,
                        onSetView = ::setView,
                        onToggleShare = ::toggleShare,
                        onOpenView = ::openView,
                        onSetOrientation = ::setOrientation,
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
