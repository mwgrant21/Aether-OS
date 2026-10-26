package com.matt.aethermobile.ui.auth

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.matt.aethermobile.ErrorKind
import com.matt.aethermobile.Notice
import com.matt.aethermobile.R
import com.matt.aethermobile.protocol.ControlProtocol
import com.matt.aethermobile.ui.StormCore
import com.matt.aethermobile.ui.StormMode
import com.matt.aethermobile.ui.components.AeNoticeBox
import com.matt.aethermobile.ui.components.AePrimaryButton
import com.matt.aethermobile.ui.components.AeSecondaryButton
import com.matt.aethermobile.ui.components.aeInset
import com.matt.aethermobile.ui.components.aePanel
import com.matt.aethermobile.ui.theme.AetherColors
import com.matt.aethermobile.ui.theme.AetherTheme
import com.matt.aethermobile.ui.theme.SpaceMono
import kotlinx.coroutines.delay

/** What the auth screens can ask of the activity. */
class AuthActions(
    val onPair: (raw: String) -> Unit,
    val onScan: () -> Unit,
    val onUnlock: () -> Unit,
    val onRetry: () -> Unit,
)

@Composable
fun AuthScreen(model: AuthScreen, actions: AuthActions, modifier: Modifier = Modifier) {
    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        when (model) {
            AuthScreen.NotConfigured -> {
                StormCore(110.dp, StormMode.Idle)
                Heading(stringResource(R.string.title_not_configured))
            }
            is AuthScreen.Pair -> PairBody(model.notice, actions)
            AuthScreen.Pairing -> PairingBody()
            AuthScreen.Saving -> {
                Target(onClick = null, description = stringResource(R.string.title_save))
                Heading(stringResource(R.string.title_save))
                Body(stringResource(R.string.body_save))
            }
            AuthScreen.Connecting -> {
                StormCore(110.dp, StormMode.Nominal)
                Heading(stringResource(R.string.title_connecting))
                ScanBar()
            }
            is AuthScreen.Locked -> {
                StormCore(110.dp, StormMode.Idle)
                Heading(stringResource(R.string.title_locked))
                Target(onClick = actions.onUnlock, description = stringResource(R.string.action_unlock))
                Spacer(Modifier.height(16.dp))
                if (model.notice != null) {
                    AeNoticeBox(noticeText(model.notice), amber = true)
                } else {
                    Body(stringResource(R.string.body_locked))
                }
            }
            is AuthScreen.Error -> {
                StormCore(110.dp, StormMode.Idle)
                Heading(stringResource(R.string.title_error))
                Body(stringResource(errorText(model.kind)))
                Spacer(Modifier.height(20.dp))
                AePrimaryButton(stringResource(R.string.action_retry), actions.onRetry)
            }
        }
    }
}

@Composable
private fun PairBody(notice: Notice?, actions: AuthActions) {
    // The code lives only in this remember: never persisted, never logged, cleared on every submit.
    var code by remember { mutableStateOf("") }
    StormCore(150.dp, StormMode.Idle)
    Heading(stringResource(R.string.title_pair))
    Column(Modifier.fillMaxWidth().aePanel().padding(15.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        BasicText(
            stringResource(R.string.auth_on_titan).uppercase(),
            style = AetherTheme.type.label.copy(color = AetherColors.cyanBright),
        )
        listOf(R.string.auth_step_1, R.string.auth_step_2, R.string.auth_step_3).forEachIndexed { i, res ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                BasicText("${i + 1}", style = AetherTheme.type.data.copy(color = AetherColors.cyan))
                BasicText(stringResource(res), style = AetherTheme.type.body.copy(color = AetherColors.text))
            }
        }
    }
    Spacer(Modifier.height(16.dp))
    val shape = RoundedCornerShape(10.dp)
    val hint = stringResource(R.string.hint_code)
    BasicTextField(
        value = code,
        onValueChange = { code = CodeInput.filter(it) },
        singleLine = true,
        textStyle = TextStyle(
            fontFamily = SpaceMono,
            fontWeight = FontWeight.Bold,
            fontSize = 22.sp,
            letterSpacing = 6.sp,
            color = AetherColors.textBright,
            textAlign = TextAlign.Center,
        ),
        cursorBrush = SolidColor(AetherColors.cyanBright),
        keyboardOptions = KeyboardOptions(
            capitalization = KeyboardCapitalization.Characters,
            autoCorrectEnabled = false,
            keyboardType = KeyboardType.Password,
        ),
        modifier = Modifier.fillMaxWidth().height(56.dp).semantics { contentDescription = hint },
        decorationBox = { inner ->
            Box(
                Modifier.fillMaxSize()
                    .background(AetherColors.insetBottom, shape)
                    .border(1.dp, AetherColors.borderStrong, shape),
                contentAlignment = Alignment.Center,
            ) {
                if (code.isEmpty()) {
                    BasicText(hint, style = AetherTheme.type.body.copy(color = AetherColors.textMuted, letterSpacing = 2.sp))
                }
                inner()
            }
        },
    )
    Spacer(Modifier.height(12.dp))
    AePrimaryButton(
        stringResource(R.string.action_pair),
        onClick = {
            val submitted = code
            code = ""
            actions.onPair(submitted)
        },
        enabled = CodeInput.isSubmittable(code),
    )
    Spacer(Modifier.height(10.dp))
    AeSecondaryButton(stringResource(R.string.action_scan), actions.onScan)
    if (notice != null) {
        Spacer(Modifier.height(14.dp))
        AeNoticeBox(noticeText(notice), amber = true)
    }
}

@Composable
private fun PairingBody() {
    // Cosmetic only: seeded from the protocol constant, holds at 0:00, never drives a flow decision.
    var remaining by remember { mutableIntStateOf((ControlProtocol.PAIR_CONFIRM_TIMEOUT_MS / 1000).toInt()) }
    LaunchedEffect(Unit) {
        while (remaining > 0) {
            delay(1000)
            remaining -= 1
        }
    }
    StormCore(150.dp, StormMode.Surge)
    Heading(stringResource(R.string.title_pairing))
    BasicText(countdownText(remaining), style = AetherTheme.type.hero.copy(color = AetherColors.cyanBright))
    Spacer(Modifier.height(12.dp))
    ScanBar()
}

@Composable
private fun Heading(text: String) {
    Spacer(Modifier.height(16.dp))
    BasicText(
        text.uppercase(),
        style = AetherTheme.type.title.copy(color = AetherColors.textBright, textAlign = TextAlign.Center),
    )
    Spacer(Modifier.height(10.dp))
}

@Composable
private fun Body(text: String) {
    BasicText(text, style = AetherTheme.type.body.copy(color = AetherColors.textDim, textAlign = TextAlign.Center))
}

/** 84dp pulsing fingerprint target: concentric arcs. Tappable only when [onClick] is set. */
@Composable
private fun Target(onClick: (() -> Unit)?, description: String) {
    val a by rememberInfiniteTransition(label = "target").animateFloat(
        initialValue = 0.45f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1400, easing = LinearEasing), RepeatMode.Reverse),
        label = "targetAlpha",
    )
    var mod = Modifier.size(84.dp).alpha(a)
    if (onClick != null) mod = mod.clickable(role = Role.Button, onClick = onClick)
    Canvas(mod.semantics { contentDescription = description }) {
        val c = Offset(size.width / 2, size.height / 2)
        for ((i, r) in listOf(38f, 29f, 20f, 11f).withIndex()) {
            val rr = r.dp.toPx()
            drawArc(
                AetherColors.cyanBright.copy(alpha = 1f - i * 0.18f),
                startAngle = 200f,
                sweepAngle = 280f,
                useCenter = false,
                topLeft = Offset(c.x - rr, c.y - rr),
                size = Size(rr * 2, rr * 2),
                style = Stroke(2.dp.toPx(), cap = StrokeCap.Round),
            )
        }
    }
}

/** Indeterminate scan bar: a short cyan segment sweeping a thin track. */
@Composable
private fun ScanBar() {
    val x by rememberInfiniteTransition(label = "scan").animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1600, easing = LinearEasing), RepeatMode.Reverse),
        label = "scanX",
    )
    Canvas(Modifier.padding(top = 8.dp).fillMaxWidth().height(3.dp).aeInset()) {
        val seg = size.width * 0.3f
        drawRect(AetherColors.cyanBright, Offset((size.width - seg) * x, 0f), Size(seg, size.height))
    }
}

@Composable
private fun noticeText(n: Notice): String = stringResource(
    when (n) {
        Notice.BadCode -> R.string.notice_bad_code
        Notice.Declined -> R.string.notice_declined
        Notice.Burned -> R.string.notice_burned
        Notice.PairBusy -> R.string.notice_pair_busy
        Notice.Unreachable -> R.string.notice_unreachable
        Notice.ServerError -> R.string.notice_server_error
        Notice.ScanFailed -> R.string.notice_scan_failed
        Notice.WrongQr -> R.string.notice_wrong_qr
        Notice.SaveCancelled -> R.string.notice_save_cancelled
        Notice.SaveFailed -> R.string.notice_save_failed
        Notice.Revoked -> R.string.notice_revoked
        Notice.KeyInvalidated -> R.string.notice_key_invalidated
        Notice.TryAgain -> R.string.notice_try_again
        Notice.Cancelled -> R.string.notice_cancelled
        Notice.Lockout -> R.string.notice_lockout
        Notice.BiometricUnavailable -> R.string.notice_biometric_unavailable
    },
)

private fun errorText(k: ErrorKind): Int = when (k) {
    ErrorKind.Unreachable -> R.string.error_unreachable
    ErrorKind.ConnectionRefused -> R.string.error_refused
    ErrorKind.NotListening -> R.string.error_not_listening
    ErrorKind.Busy -> R.string.error_busy
    ErrorKind.ProofMismatch -> R.string.error_proof
    ErrorKind.Protocol -> R.string.error_protocol
    ErrorKind.Superseded -> R.string.error_superseded
    ErrorKind.Disabled -> R.string.error_disabled
    ErrorKind.Closed -> R.string.error_closed
}
