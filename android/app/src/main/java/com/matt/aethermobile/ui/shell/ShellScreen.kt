package com.matt.aethermobile.ui.shell

import android.view.View
import android.view.ViewGroup
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.matt.aethermobile.FlowState
import com.matt.aethermobile.R
import com.matt.aethermobile.term.TerminalHost
import com.matt.aethermobile.ui.StormCore
import com.matt.aethermobile.ui.StormMode
import com.matt.aethermobile.ui.components.AeSecondaryButton
import com.matt.aethermobile.ui.components.DotStyle
import com.matt.aethermobile.ui.components.StatusDot
import com.matt.aethermobile.ui.components.aeActive
import com.matt.aethermobile.ui.components.aeSheet
import com.matt.aethermobile.ui.theme.AetherColors
import com.matt.aethermobile.ui.theme.AetherDimens
import com.matt.aethermobile.ui.theme.AetherType

data class ShellUiState(
    /** False hides all chrome and collapses the terminal area to 0x0; the holder stays composed (D6). */
    val connected: Boolean,
    val tabs: List<TerminalHost.Tab>,
    val selected: String,
    val flow: FlowState.Connected?,
)

class ShellActions(
    val onSelectSlot: (String) -> Unit,
    val onLockNow: () -> Unit,
    val onZoomOut: () -> Unit,
    val onZoomIn: () -> Unit,
    val onFit: () -> Unit,
)

private val dims = AetherDimens()
private val type = AetherType()
private val BurgerShape = RoundedCornerShape(12.dp)
private val BurgerBorder = Color(70, 180, 215, 71)
private val BurgerFill = Color(10, 32, 43, 153)
private val Scrim = Color(2, 10, 16, 153)
private val MenuShape = RoundedCornerShape(dims.rPanel)

/** Header, burger dropdown, terminal area and zoom row. Only the holder [ViewGroup] is passed in, never the WebView. */
@Composable
fun ShellScreen(state: ShellUiState, actions: ShellActions, terminalHolder: ViewGroup, modifier: Modifier = Modifier) {
    var menu by remember { mutableStateOf(MenuState()) }
    val menuOpen = menu.open && state.connected
    // ShellScreen stays composed while Locked (D6): a menu left open must not reappear on reconnect.
    LaunchedEffect(state.connected) { if (!state.connected) menu = MenuState() }
    val cur = state.tabs.firstOrNull { it.s == state.selected }
    val slideOffsetPx = with(LocalDensity.current) { 10.dp.roundToPx() }
    BackHandler(enabled = menuOpen) { menu = menu.onBack() }

    Box(modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().then(if (menuOpen) Modifier.blur(2.dp) else Modifier)) {
            if (state.connected) {
                Header(
                    title = titleFor(state.tabs, state.selected),
                    status = statusFor(cur, state.flow),
                    amber = amber(cur, state.flow),
                    live = anyRunning(state.tabs),
                    menuOpen = menuOpen,
                    onBurger = { menu = menu.onBurger() },
                )
            }
            // Always composed (D6): a conditional host could leave the pre-warmed WebView unattached.
            Box(if (state.connected) Modifier.weight(1f).fillMaxWidth() else Modifier.size(0.dp)) {
                AndroidView(
                    factory = { terminalHolder.also { (it.parent as? ViewGroup)?.removeView(it) } },
                    modifier = Modifier.fillMaxSize(),
                    update = { it.visibility = if (state.connected) View.VISIBLE else View.GONE },
                )
            }
            if (state.connected) ZoomRow(actions)
        }
        if (state.connected) {
            if (menuOpen) {
                Box(
                    Modifier.fillMaxSize().background(Scrim).clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                    ) { menu = menu.onScrim() },
                )
            }
            AnimatedVisibility(
                visible = menuOpen,
                modifier = Modifier.align(Alignment.TopEnd).padding(top = dims.headerH + 6.dp, end = 12.dp),
                enter = fadeIn(tween(200)) + slideInVertically(tween(200)) { -slideOffsetPx },
                exit = fadeOut(tween(120)) + slideOutVertically(tween(120)) { 0 },
            ) {
                Dropdown(
                    tabs = state.tabs,
                    selected = state.selected,
                    flow = state.flow,
                    onSelect = { s -> menu = menu.onSelectSlot(); actions.onSelectSlot(s) },
                    onLock = { menu = menu.onLock(); actions.onLockNow() },
                )
            }
        }
    }
}

@Composable
private fun Header(title: String, status: StatusLine, amber: Boolean, live: Boolean, menuOpen: Boolean, onBurger: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().height(dims.headerH).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // 40dp core drawn inside a 44dp tap target (StormCore hitDp); the tap is discharge only.
        StormCore(dims.headerCore, if (live) StormMode.Nominal else StormMode.Idle, onDischarge = {}, hitDp = dims.touchMin)
        Column(Modifier.weight(1f)) {
            BasicText(title, style = type.title.copy(color = AetherColors.textBright), maxLines = 1)
            val line = statusText(status)
            if (line.isNotEmpty()) {
                BasicText(
                    line,
                    style = type.meta.copy(color = if (amber) AetherColors.warn else AetherColors.textMuted),
                    maxLines = 1,
                )
            }
        }
        Burger(menuOpen, onBurger)
    }
}

@Composable
private fun statusText(status: StatusLine): String {
    return when (status) {
        StatusLine.None -> ""
        StatusLine.NotStarted -> stringResource(R.string.status_not_started)
        StatusLine.Exited -> stringResource(R.string.status_exited)
        StatusLine.AwaitingOutput -> stringResource(R.string.status_waiting_output)
        is StatusLine.Days -> daysText(status.daysLeft, status.warn)
    }
}

@Composable
private fun daysText(daysLeft: Int, warn: Boolean): String {
    val days = pluralStringResource(R.plurals.days_left, daysLeft, daysLeft)
    return if (warn) stringResource(R.string.days_left_warn, days) else days
}

@Composable
private fun Burger(open: Boolean, onClick: () -> Unit) {
    val desc = stringResource(if (open) R.string.menu_close else R.string.menu_open)
    Box(
        Modifier
            .size(dims.touchMin)
            .background(if (open) AetherColors.activeFill else BurgerFill, BurgerShape)
            .border(1.dp, if (open) AetherColors.activeBorder else BurgerBorder, BurgerShape)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { contentDescription = desc },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.size(20.dp)) {
            val w = 2.dp.toPx()
            val c = AetherColors.cyanCore
            val m = 3.dp.toPx()
            if (open) {
                drawLine(c, Offset(m, m), Offset(size.width - m, size.height - m), w, StrokeCap.Round)
                drawLine(c, Offset(size.width - m, m), Offset(m, size.height - m), w, StrokeCap.Round)
            } else {
                val widths = floatArrayOf(20.dp.toPx(), 14.dp.toPx(), 20.dp.toPx())
                for (i in 0..2) {
                    val y = (4 + i * 6).dp.toPx() + w / 2
                    drawLine(c, Offset(0f, y), Offset(widths[i], y), w, StrokeCap.Butt)
                }
            }
        }
    }
}

@Composable
private fun Dropdown(
    tabs: List<TerminalHost.Tab>,
    selected: String,
    flow: FlowState.Connected?,
    onSelect: (String) -> Unit,
    onLock: () -> Unit,
) {
    val sweep by rememberInfiniteTransition(label = "menu-sweep").animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(3200, easing = LinearEasing), RepeatMode.Restart),
        label = "sweep",
    )
    Column(
        Modifier
            .width(dims.menuW)
            .aeSheet(MenuShape)
            .pointerInput(Unit) { detectTapGestures { } } // taps on the sheet itself must not reach the scrim
            .drawWithContent {
                drawContent()
                val band = 24.dp.toPx()
                val y = size.height * sweep
                drawRect(
                    Brush.verticalGradient(
                        listOf(Color.Transparent, AetherColors.cyanCore.copy(alpha = 0.18f), Color.Transparent),
                        startY = y - band,
                        endY = y + band,
                    ),
                    topLeft = Offset(0f, y - band),
                    size = Size(size.width, band * 2),
                )
            }
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        BasicText(stringResource(R.string.menu_terminals).uppercase(), style = type.label.copy(color = AetherColors.textLabel))
        for (row in slotRows(tabs, selected)) {
            val stateText = when (row.text) {
                SlotText.Running -> stringResource(R.string.status_running)
                SlotText.NotStarted -> stringResource(R.string.status_not_started)
                SlotText.Exited -> stringResource(R.string.status_exited)
            }
            Row(
                Modifier
                    .fillMaxWidth()
                    .height(dims.touchMin)
                    .then(if (row.selected) Modifier.aeActive() else Modifier)
                    .clickable(onClick = { onSelect(row.s) })
                    .semantics(mergeDescendants = true) {
                        role = Role.Button
                        this.selected = row.selected
                    }
                    .padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                StatusDot(row.dot)
                BasicText(row.label, style = type.body.copy(color = AetherColors.textBright), modifier = Modifier.weight(1f), maxLines = 1)
                BasicText(stateText, style = TextStyle(fontFamily = type.meta.fontFamily, fontSize = 10.sp, color = AetherColors.textMuted), maxLines = 1)
            }
        }
        Footer(flow, onLock)
    }
}

@Composable
private fun Footer(flow: FlowState.Connected?, onLock: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(top = 8.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            StatusDot(DotStyle.LiveGlow)
            Column {
                BasicText(stringResource(R.string.title_connected), style = type.body.copy(color = AetherColors.textBright))
                if (flow != null) {
                    BasicText(
                        daysText(flow.daysLeft, flow.warn),
                        style = type.meta.copy(color = if (flow.warn) AetherColors.warn else AetherColors.textMuted),
                    )
                }
            }
        }
        AeSecondaryButton(stringResource(R.string.action_lock_now).uppercase(), onLock)
    }
}

@Composable
private fun ZoomRow(actions: ShellActions) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        AeSecondaryButton(stringResource(R.string.action_zoom_out), actions.onZoomOut, Modifier.weight(1f))
        AeSecondaryButton(stringResource(R.string.action_zoom_in), actions.onZoomIn, Modifier.weight(1f))
        AeSecondaryButton(stringResource(R.string.action_fit), actions.onFit, Modifier.weight(1f))
    }
}
