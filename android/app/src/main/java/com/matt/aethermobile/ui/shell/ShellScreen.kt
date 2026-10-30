package com.matt.aethermobile.ui.shell

import android.os.SystemClock
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
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.matt.aethermobile.FlowState
import com.matt.aethermobile.R
import com.matt.aethermobile.auth.ShareMessage
import com.matt.aethermobile.auth.ShareUi
import com.matt.aethermobile.term.TerminalHost
import com.matt.aethermobile.ledger.LedgerUi
import com.matt.aethermobile.thread.ThreadUi
import com.matt.aethermobile.thread.ViewMode
import com.matt.aethermobile.ui.StormCore
import com.matt.aethermobile.ui.StormMode
import com.matt.aethermobile.ui.components.AeSecondaryButton
import com.matt.aethermobile.ui.components.DotStyle
import com.matt.aethermobile.ui.components.StatusDot
import com.matt.aethermobile.ui.components.aeActive
import com.matt.aethermobile.ui.components.aeSheet
import com.matt.aethermobile.ui.ledger.LedgerScreen
import com.matt.aethermobile.ui.theme.AetherColors
import com.matt.aethermobile.ui.theme.AetherDimens
import com.matt.aethermobile.ui.theme.AetherType
import com.matt.aethermobile.ui.thread.ThreadScreen

data class ShellUiState(
    /** False hides all chrome and collapses the terminal area to 0x0; the holder stays composed. */
    val connected: Boolean,
    val tabs: List<TerminalHost.Tab>,
    val selected: String,
    val flow: FlowState.Connected?,
    val ctrlOn: Boolean = false,
    /** TerminalHost.typingAccepted(): the host's own gate (active, attached, RUNNING). */
    val hostAccepts: Boolean = false,
    /** [clearsDraft] of the app flow: Locked / NeedsPair wipe the compose draft. */
    val wipeDraft: Boolean = false,
    /** TerminalHost.restartAvailable(): attached to an exited terminal2. */
    val restartAvailable: Boolean = false,
    /** Thread or Raw; the segment only shows for the Claude slot. */
    val view: ViewMode = ViewMode.THREAD,
    val thread: ThreadUi = ThreadUi.EMPTY,
    val share: ShareUi = ShareUi(),
    val appView: AppView = AppView.TERMINAL,
    val ledger: LedgerUi = LedgerUi.Off,
    val nowMs: Long = 0L,
    val viewCtl: ViewCtlUi = ViewCtlUi(),
)

class ShellActions(
    val onSelectSlot: (String) -> Unit,
    val onLockNow: () -> Unit,
    val onZoomOut: () -> Unit,
    val onZoomIn: () -> Unit,
    val onFit: () -> Unit,
    val onKey: (String) -> Unit,
    val onCtrlToggle: () -> Unit,
    val onCompose: (String, Boolean) -> TerminalHost.ComposeResult,
    val onRestart: () -> Boolean,
    val onSetView: (ViewMode) -> Unit,
    /** The argument is the desired new state (true = turn on). Default is temporary until MainActivity wires it. */
    val onToggleShare: (Boolean) -> Unit,
    val onOpenView: (AppView) -> Unit,
    val onSetOrientation: (OrientationMode) -> Unit = {},
)

private val dims = AetherDimens()
private val type = AetherType()
private val BurgerShape = RoundedCornerShape(12.dp)
private val BurgerBorder = Color(70, 180, 215, 71)
private val BurgerFill = Color(10, 32, 43, 153)
private val Scrim = Color(2, 10, 16, 153)
private val MenuShape = RoundedCornerShape(dims.rPanel)

/** Header, zoom row, burger dropdown, terminal area, key row and compose bar. Only the holder [ViewGroup] is passed in, never the WebView. */
@Composable
fun ShellScreen(state: ShellUiState, actions: ShellActions, terminalHolder: ViewGroup, modifier: Modifier = Modifier) {
    var menu by remember { mutableStateOf(MenuState()) }
    // Above the connected-only branch so a drop and reconnect keeps it; saved so rotation keeps it too.
    var draft by rememberSaveable { mutableStateOf("") }
    // Hoisted like draft so the list state outlives the Thread/Raw swap.
    val threadListState = rememberLazyListState()
    val body = bodyFor(state.selected, state.view, state.appView)
    val threadBody = state.connected && body == Body.THREAD
    val rawBody = state.connected && body == Body.RAW
    val ledgerBody = state.connected && body == Body.LEDGER
    val menuOpen = menu.open && state.connected
    // ShellScreen stays composed while Locked: a menu left open must not reappear after a relock.
    LaunchedEffect(state.connected) { if (!state.connected) menu = MenuState() }
    LaunchedEffect(state.wipeDraft) { if (state.wipeDraft) draft = "" }
    val kb = rememberKeyboardUi()
    LaunchedEffect(menuOpen) { if (menuOpen) kb.hide() }
    val cur = state.tabs.firstOrNull { it.s == state.selected }
    val slideOffsetPx = with(LocalDensity.current) { 10.dp.roundToPx() }
    // Registered before the menu handler: the last enabled one wins, so Back closes an open menu first.
    BackHandler(enabled = ledgerBody && !menuOpen) { actions.onOpenView(AppView.TERMINAL) }
    BackHandler(enabled = menuOpen) { menu = menu.onBack() }

    BoxWithConstraints(modifier.fillMaxSize()) {
      val plan = chromePlan(maxWidth.value, maxHeight.value)
      CompositionLocalProvider(LocalImeRequest provides kb.request, LocalHardKeyboard provides kb.hardKeyboard, LocalImeVisible provides kb.imeVisible) {
        Column(Modifier.fillMaxSize()) {
            // The header sits outside the blur and the scrim so the burger stays bright and tappable.
            if (state.connected) {
                Header(
                    title = titleFor(state.tabs, state.selected, state.appView),
                    status = statusFor(cur, state.flow),
                    amber = amber(cur, state.flow),
                    ledgerView = ledgerBody,
                    live = anyRunning(state.tabs),
                    menuOpen = menuOpen,
                    onBurger = { menu = menu.onBurger() },
                    showSegment = showSegment(state.selected, state.appView),
                    view = state.view,
                    onSetView = actions.onSetView,
                    keyboard = kb,
                )
            }
            Column(Modifier.weight(1f).fillMaxWidth().then(if (menuOpen) Modifier.blur(2.dp) else Modifier)) {
                if (rawBody && plan.zoomRow) ZoomRow(actions)
                // Always composed: a conditional host could leave the pre-warmed WebView unattached.
                Box(if (rawBody) Modifier.weight(1f).fillMaxWidth() else Modifier.size(0.dp)) {
                    AndroidView(
                        factory = { terminalHolder.also { (it.parent as? ViewGroup)?.removeView(it) } },
                        modifier = Modifier.fillMaxSize(),
                        update = { it.visibility = if (rawBody) View.VISIBLE else View.GONE },
                    )
                }
                if (threadBody) {
                    val d = LocalDensity.current
                    CompositionLocalProvider(LocalDensity provides Density(d.density, d.fontScale * threadScale(state.viewCtl.zoomPx))) {
                    ThreadScreen(
                        state.thread, threadListState, draft, { draft = it },
                        threadSendEnabled(composeEnabled(cur, state.flow, state.hostAccepts), draft), actions.onCompose,
                        Modifier.weight(1f).fillMaxWidth(),
                    )
                    }
                }
                if (ledgerBody) LedgerScreen(state.ledger, state.nowMs, Modifier.weight(1f).fillMaxWidth())
                // Only composed while connected, so a locked or dropped session shows no keys at all.
                if (rawBody) {
                    if (restartVisible(cur, state.flow, state.restartAvailable)) RestartRow(actions.onRestart)
                    if (plan.keyRow) KeyRow(keysEnabled(cur, state.flow, state.hostAccepts), state.ctrlOn, actions)
                    // Last, so it sits nearest the keyboard.
                    ComposeBar(draft, { draft = it }, composeEnabled(cur, state.flow, state.hostAccepts), actions.onCompose)
                }
            }
        }
        if (state.connected) {
            if (menuOpen) {
                Box(
                    Modifier.fillMaxSize().padding(top = dims.headerH).background(Scrim).clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                    ) { menu = menu.onScrim() },
                )
            }
            AnimatedVisibility(
                visible = menuOpen,
                modifier = Modifier.align(Alignment.TopEnd).padding(top = dims.headerH + 6.dp, end = 12.dp, bottom = 12.dp),
                enter = fadeIn(tween(200)) + slideInVertically(tween(200)) { -slideOffsetPx },
                exit = fadeOut(tween(120)) + slideOutVertically(tween(120)) { 0 },
            ) {
                Dropdown(
                    tabs = state.tabs,
                    selected = state.selected,
                    flow = state.flow,
                    appView = state.appView,
                    onSelect = { s -> menu = menu.onSelectSlot(); actions.onSelectSlot(s) },
                    onSelectView = { v -> menu = menu.onSelectView(); actions.onOpenView(v) },
                    onLock = { menu = menu.onLock(); actions.onLockNow() },
                    share = state.share,
                    onToggleShare = actions.onToggleShare,
                    viewCtl = state.viewCtl,
                    actions = actions,
                )
            }
        }
        // Overlay in the root Box, not a Column sibling, so it never changes the terminal area's measured size.
        if (state.share.on) SharePill(Modifier.align(Alignment.TopCenter).padding(top = dims.headerH + 4.dp))
      }
    }
}

@Composable
private fun SharePill(modifier: Modifier = Modifier) {
    BasicText(
        stringResource(R.string.share_pill),
        style = TextStyle(
            fontFamily = type.label.fontFamily,
            fontWeight = FontWeight.SemiBold,
            fontSize = 10.sp,
            letterSpacing = 1.4.sp,
            color = AetherColors.warn,
        ),
        maxLines = 1,
        modifier = modifier
            .background(AetherColors.bgDeep.copy(alpha = 0.85f), RoundedCornerShape(10.dp))
            .border(1.dp, AetherColors.warn, RoundedCornerShape(10.dp))
            .padding(horizontal = 10.dp, vertical = 3.dp),
    )
}

@Composable
private fun ShareRow(share: ShareUi, onToggleShare: (Boolean) -> Unit) {
    val desc = stringResource(if (share.on) R.string.share_on_desc else R.string.share_off_desc)
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = dims.touchMin)
                .toggleable(value = share.on, role = Role.Switch, onValueChange = onToggleShare)
                .semantics { contentDescription = desc }
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Column(Modifier.weight(1f)) {
                BasicText(stringResource(R.string.share_row_label), style = type.body.copy(color = AetherColors.textBright))
                BasicText(stringResource(R.string.share_row_hint), style = type.meta.copy(color = AetherColors.textMuted))
            }
            ShareSwitch(share.on)
        }
        val msg = share.message
        if (msg != null) {
            BasicText(
                stringResource(
                    when (msg) {
                        ShareMessage.NoHardware -> R.string.share_msg_no_hardware
                        ShareMessage.NoneEnrolled -> R.string.share_msg_none_enrolled
                        ShareMessage.SensorUnavailable -> R.string.share_msg_sensor_unavailable
                        ShareMessage.Lockout -> R.string.share_msg_lockout
                        ShareMessage.Failed -> R.string.share_msg_failed
                    },
                ),
                style = type.meta.copy(color = AetherColors.warn),
                modifier = Modifier.padding(horizontal = 12.dp),
            )
        }
    }
}

/** Track plus thumb from foundation primitives; the toggleable parent carries the semantics. */
@Composable
private fun ShareSwitch(on: Boolean) {
    Box(
        Modifier
            .size(width = 40.dp, height = 22.dp)
            .background(if (on) AetherColors.cyanCore else AetherColors.bgDeep, RoundedCornerShape(11.dp))
            .border(1.dp, if (on) AetherColors.cyanCore else AetherColors.borderMid, RoundedCornerShape(11.dp))
            .padding(2.dp),
        contentAlignment = if (on) Alignment.CenterEnd else Alignment.CenterStart,
    ) {
        Box(
            Modifier
                .size(16.dp)
                .background(if (on) AetherColors.cyanInk else AetherColors.textMuted, RoundedCornerShape(8.dp)),
        )
    }
}

@Composable
private fun Header(
    title: String,
    status: StatusLine,
    amber: Boolean,
    ledgerView: Boolean,
    live: Boolean,
    menuOpen: Boolean,
    onBurger: () -> Unit,
    showSegment: Boolean,
    view: ViewMode,
    onSetView: (ViewMode) -> Unit,
    keyboard: KeyboardUi?,
) {
    val hairline = AetherColors.border
    Row(
        Modifier
            .fillMaxWidth()
            .height(dims.headerH)
            .background(AetherColors.bgDeep.copy(alpha = 0.7f))
            .drawBehind { drawLine(hairline, Offset(0f, size.height - 0.5.dp.toPx()), Offset(size.width, size.height - 0.5.dp.toPx()), 1.dp.toPx()) }
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // 40dp core drawn inside a 44dp tap target (StormCore hitDp); the tap is discharge only.
        StormCore(dims.headerCore, if (live) StormMode.Nominal else StormMode.Idle, onDischarge = {}, hitDp = dims.touchMin)
        val menuDesc = stringResource(if (menuOpen) R.string.menu_close else R.string.menu_open)
        // The whole title block opens and closes the same menu as the burger.
        Column(
            Modifier
                .weight(1f)
                .heightIn(min = dims.touchMin)
                .clickable(role = Role.Button, onClick = onBurger)
                .semantics { contentDescription = menuDesc },
            verticalArrangement = Arrangement.Center,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                BasicText(title, style = type.title.copy(color = AetherColors.textBright), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Canvas(Modifier.size(width = 10.dp, height = 6.dp)) {
                    val path = Path().apply {
                        if (menuOpen) {
                            moveTo(0f, size.height); lineTo(size.width, size.height); lineTo(size.width / 2f, 0f)
                        } else {
                            moveTo(0f, 0f); lineTo(size.width, 0f); lineTo(size.width / 2f, size.height)
                        }
                        close()
                    }
                    drawPath(path, AetherColors.cyanCore)
                }
            }
            val line = if (ledgerView) stringResource(R.string.ledger_subline) else statusText(status)
            if (line.isNotEmpty()) {
                BasicText(
                    line,
                    style = type.meta.copy(color = if (amber) AetherColors.warn else AetherColors.textMuted),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (showSegment) ViewSegment(view, onSetView)
        keyboard?.let { KeyboardToggle(it, Modifier) }
        Burger(menuOpen, onBurger)
    }
}

@Composable
private fun ViewSegment(view: ViewMode, onSetView: (ViewMode) -> Unit) {
    val radius = 14.dp
    val band = 26.dp
    val edge = AetherColors.borderMid
    // One capsule outline over a 26dp band; the halves keep full touchMin tap boxes around it.
    Row(
        Modifier.drawWithContent {
            drawContent()
            val inset = (size.height - band.toPx()) / 2f
            drawRoundRect(
                edge,
                topLeft = Offset(0.5.dp.toPx(), inset + 0.5.dp.toPx()),
                size = Size(size.width - 1.dp.toPx(), band.toPx() - 1.dp.toPx()),
                cornerRadius = CornerRadius(radius.toPx() - 0.5.dp.toPx()),
                style = Stroke(1.dp.toPx()),
            )
        },
    ) {
        SegmentLabel(R.string.view_thread, R.string.view_thread_desc, view == ViewMode.THREAD, RoundedCornerShape(topStart = radius, bottomStart = radius)) { onSetView(ViewMode.THREAD) }
        SegmentLabel(R.string.view_raw, R.string.view_raw_desc, view == ViewMode.RAW, RoundedCornerShape(topEnd = radius, bottomEnd = radius)) { onSetView(ViewMode.RAW) }
    }
}

@Composable
private fun SegmentLabel(label: Int, desc: Int, on: Boolean, shape: Shape, onClick: () -> Unit) {
    val d = stringResource(desc)
    // Tap box is at least touchMin in both axes; the visible pill is the 26dp filled band inside it.
    Box(
        Modifier
            .heightIn(min = dims.touchMin)
            .widthIn(min = dims.touchMin)
            .clickable(role = Role.RadioButton, onClick = onClick)
            .semantics {
                contentDescription = d
                this.selected = on
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .height(26.dp)
                .clip(shape)
                .background(if (on) AetherColors.cyanCore else Color.Transparent)
                .padding(horizontal = 9.dp),
            contentAlignment = Alignment.Center,
        ) {
            BasicText(
                stringResource(label).uppercase(),
                style = TextStyle(
                    fontFamily = type.label.fontFamily,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 10.sp,
                    letterSpacing = 1.4.sp,
                    color = if (on) AetherColors.cyanInk else AetherColors.textMuted,
                ),
                maxLines = 1,
            )
        }
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
    appView: AppView,
    onSelect: (String) -> Unit,
    onSelectView: (AppView) -> Unit,
    onLock: () -> Unit,
    share: ShareUi,
    onToggleShare: (Boolean) -> Unit,
    viewCtl: ViewCtlUi,
    actions: ShellActions,
) {
    val scroll = rememberScrollState()
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
            // Bounded by the space below the header (see the caller's bottom padding), so short windows scroll.
            .mouseDragScroll(scroll)
            .verticalScroll(scroll)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        BasicText(stringResource(R.string.menu_terminals).uppercase(), style = type.label.copy(color = AetherColors.textLabel))
        for (row in slotRows(tabs, selected)) {
            val stateText = stringResource(
                when (row.caps) {
                    SlotCaps.ThreadRaw -> R.string.caps_thread_raw
                    SlotCaps.ThreadRawNotStarted -> R.string.caps_thread_raw_not_started
                    SlotCaps.ThreadRawExited -> R.string.caps_thread_raw_exited
                    SlotCaps.RawOnly -> R.string.caps_raw_only
                    SlotCaps.RawOnlyNotStarted -> R.string.caps_raw_only_not_started
                    SlotCaps.RawOnlyExited -> R.string.caps_raw_only_exited
                },
            )
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
        BasicText(stringResource(R.string.menu_views).uppercase(), style = type.label.copy(color = AetherColors.textLabel), modifier = Modifier.padding(top = 6.dp))
        for (row in viewRows(appView)) {
            val label = stringResource(R.string.view_ledger)
            val desc = stringResource(R.string.view_ledger_desc)
            Row(
                Modifier
                    .fillMaxWidth()
                    .height(dims.touchMin)
                    .then(if (row.selected) Modifier.aeActive() else Modifier)
                    .clickable(onClick = { onSelectView(row.view) })
                    .semantics(mergeDescendants = true) {
                        role = Role.Button
                        contentDescription = desc
                        this.selected = row.selected
                    }
                    .padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Box(Modifier.size(7.dp).background(if (row.selected) Color(0xFF7EF0FF) else AetherColors.textLabel))
                BasicText(label, style = type.body.copy(color = AetherColors.textBright), modifier = Modifier.weight(1f), maxLines = 1)
            }
        }
        ShareRow(share, onToggleShare)
        ViewControlsRows(viewCtl, actions)
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
private fun RestartRow(onRestart: () -> Boolean) {
    val gate = remember { SendGate() }
    val desc = stringResource(R.string.action_restart_desc)
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) {
        AeSecondaryButton(
            stringResource(R.string.action_restart),
            { attemptRestart(gate, SystemClock.elapsedRealtime(), onRestart) },
            Modifier.weight(1f).semantics { contentDescription = desc },
        )
    }
}

@Composable
private fun ZoomRow(actions: ShellActions) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        AeSecondaryButton(stringResource(R.string.action_zoom_out), actions.onZoomOut, Modifier.weight(1f))
        AeSecondaryButton(stringResource(R.string.action_zoom_in), actions.onZoomIn, Modifier.weight(1f))
        AeSecondaryButton(stringResource(R.string.action_fit), actions.onFit, Modifier.weight(1f))
    }
}
