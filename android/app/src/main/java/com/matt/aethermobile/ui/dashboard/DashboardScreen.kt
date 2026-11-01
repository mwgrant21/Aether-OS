package com.matt.aethermobile.ui.dashboard

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.matt.aethermobile.R
import com.matt.aethermobile.dashboard.DashSnapshot
import com.matt.aethermobile.dashboard.DashStatus
import com.matt.aethermobile.dashboard.EtaChip
import com.matt.aethermobile.dashboard.KpiKey
import com.matt.aethermobile.dashboard.KpiTile
import com.matt.aethermobile.dashboard.NO_DATA
import com.matt.aethermobile.dashboard.ReadinessCopy
import com.matt.aethermobile.dashboard.ReadinessRowUi
import com.matt.aethermobile.dashboard.StripKey
import com.matt.aethermobile.dashboard.dashStatus
import com.matt.aethermobile.dashboard.kpiTiles
import com.matt.aethermobile.dashboard.publishAgeMs
import com.matt.aethermobile.dashboard.readinessRows
import com.matt.aethermobile.dashboard.statusGlows
import com.matt.aethermobile.dashboard.stripItems
import com.matt.aethermobile.ui.StormCore
import com.matt.aethermobile.ui.StormMode
import com.matt.aethermobile.ui.components.aeInset
import com.matt.aethermobile.ui.components.aePanel
import com.matt.aethermobile.ui.shell.LocalPaneEnv
import com.matt.aethermobile.ui.shell.mouseDragScroll
import com.matt.aethermobile.ui.theme.AetherColors
import com.matt.aethermobile.ui.theme.AetherType
import com.matt.aethermobile.views.ViewUi
import java.text.NumberFormat
import java.time.ZoneId
import java.util.Locale
import kotlinx.coroutines.delay

private val type = AetherType()
private const val TICK_MS = 5_000L
private val CoreSize = 236.dp

/**
 * Read-only Dashboard body: recap banner, REACTOR STATUS (core, rate line, snapshot age, KPI tiles), READINESS and the
 * standby strip. Live vs standby is whatever titan published; the phone never re-derives it, and the age line says how
 * old that reading is. Only the recap dismissal is local state (never saved; it returns when the recap text changes).
 * The READINESS card ends with OPEN TERMINAL, which only navigates to the Terminal view.
 */
@Composable
fun DashboardScreen(ui: ViewUi<DashSnapshot>, nowMs: Long, modifier: Modifier = Modifier) {
    when (ui) {
        ViewUi.Off, ViewUi.Loading -> Message(stringResource(R.string.dash_loading), modifier)
        ViewUi.NoSnapshot -> Message(stringResource(R.string.dash_no_snapshot), modifier)
        ViewUi.Unreadable -> Message(stringResource(R.string.dash_unreadable), modifier)
        ViewUi.Unsupported -> Message(stringResource(R.string.dash_unsupported), modifier)
        is ViewUi.Ready -> ReadyBody(ui.data, nowMs, modifier)
    }
}

@Composable
private fun Message(text: String, modifier: Modifier) {
    Column(modifier.padding(16.dp)) {
        BasicText(text, style = type.body.copy(color = AetherColors.textMuted))
    }
}

@Composable
private fun ReadyBody(s: DashSnapshot, hostNowMs: Long, modifier: Modifier) {
    var ticks by remember(hostNowMs) { mutableIntStateOf(0) }
    LaunchedEffect(hostNowMs) {
        while (true) { delay(TICK_MS); ticks++ }
    }
    val env = LocalPaneEnv.current
    val now = hostNowMs + env.titanClockOffsetMs + ticks * TICK_MS
    val scroll = rememberScrollState()

    // The core is composed only while its slot overlaps the viewport; off-screen it leaves the composition and its
    // frame loop (withFrameNanos) stops with it. Both rects are in root coordinates (one space), re-reported on scroll.
    var viewport by remember { mutableStateOf(Rect.Zero) }
    var core by remember { mutableStateOf(Rect.Zero) }
    // derivedStateOf: scroll frames re-report the rects, but this composable recomposes only when the Boolean flips.
    val coreVisible by remember { derivedStateOf { coreOnScreen(core.top, core.bottom, viewport.top, viewport.bottom) } }

    val status = dashStatus(s)
    val glows = statusGlows(s)
    val zone = remember { ZoneId.systemDefault() }

    Column(
        modifier
            .fillMaxSize()
            .onGloballyPositioned { viewport = it.boundsInRoot() }
            .mouseDragScroll(scroll)
            .verticalScroll(scroll)
            .padding(horizontal = 12.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Recap(s)
        Card(stringResource(R.string.dash_reactor_title)) {
            StatusLabel(status, glows)
            Box(
                Modifier
                    .align(Alignment.CenterHorizontally)
                    .size(CoreSize)
                    .onGloballyPositioned { core = it.boundsInRoot() },
            ) {
                if (coreVisible) StormCore(CoreSize, stormMode(status))
            }
            BasicText(
                rateText(s),
                Modifier.align(Alignment.CenterHorizontally),
                style = type.data.copy(color = AetherColors.textBright),
            )
            BasicText(
                stringResource(R.string.dash_age, ageText(publishAgeMs(s, now))),
                Modifier.align(Alignment.CenterHorizontally),
                style = type.meta.copy(color = AetherColors.textMuted),
            )
            val tiles = kpiTiles(s)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Tile(tiles[0], s, Modifier.weight(1f))
                Tile(tiles[1], s, Modifier.weight(1f))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Tile(tiles[2], s, Modifier.weight(1f))
                Tile(tiles[3], s, Modifier.weight(1f))
            }
        }
        Card(stringResource(R.string.dash_readiness_title)) {
            readinessRows(s, now, zone).forEach { ReadinessRow(it) }
            OpenTerminalRow(env.openTerminal)
        }
        Strip(s)
    }
}

private fun stormMode(st: DashStatus): StormMode = when (st) {
    DashStatus.STANDBY -> StormMode.Idle
    DashStatus.NOMINAL -> StormMode.Nominal
    DashStatus.ELEVATED -> StormMode.Surge
    DashStatus.BURN_ALARM -> StormMode.Breach
}

private fun grouped(n: Long): String = NumberFormat.getIntegerInstance(Locale.US).format(n)

private fun Long.toCount(): Int = coerceIn(0L, Int.MAX_VALUE.toLong()).toInt()

@Composable
private fun Recap(s: DashSnapshot) {
    val r = s.recap ?: return
    val parts = ArrayList<String>()
    if (r.dispatches > 0) parts += pluralStringResource(R.plurals.dash_recap_dispatches, r.dispatches.toCount(), grouped(r.dispatches))
    if (r.anomaliesDetected > 0) parts += pluralStringResource(R.plurals.dash_recap_detected, r.anomaliesDetected.toCount(), grouped(r.anomaliesDetected))
    if (r.anomaliesCleared > 0) parts += pluralStringResource(R.plurals.dash_recap_cleared, r.anomaliesCleared.toCount(), grouped(r.anomaliesCleared))
    parts += stringResource(R.string.dash_recap_tokens, grouped(r.tokensBurned))
    val body = parts.reduce { a, b -> stringResource(R.string.dash_recap_join, a, b) }
    val text = stringResource(R.string.dash_recap_lead, body)
    var dismissed by remember(text) { mutableStateOf(false) }
    if (dismissed) return
    Row(
        Modifier.fillMaxWidth().aeInset().padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        BasicText(text, Modifier.weight(1f), style = type.body.copy(color = AetherColors.textBright))
        BasicText(
            stringResource(R.string.dash_recap_dismiss),
            Modifier
                .heightIn(min = 44.dp)
                .semantics { role = Role.Button }
                .clickable { dismissed = true }
                .padding(horizontal = 6.dp, vertical = 12.dp),
            style = type.body.copy(color = AetherColors.textMuted),
        )
    }
}

@Composable
private fun Card(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().aePanel().padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        BasicText(title.uppercase(Locale.US), style = type.label.copy(color = AetherColors.textLabel))
        content()
    }
}

@Composable
private fun StatusLabel(status: DashStatus, glows: Boolean) {
    val color = when (status) {
        DashStatus.NOMINAL -> AetherColors.success
        DashStatus.STANDBY -> AetherColors.textMuted
        DashStatus.ELEVATED -> AetherColors.warn
        DashStatus.BURN_ALARM -> AetherColors.danger
    }
    val name = stringResource(
        when (status) {
            DashStatus.NOMINAL -> R.string.dash_status_nominal
            DashStatus.STANDBY -> R.string.dash_status_standby
            DashStatus.ELEVATED -> R.string.dash_status_elevated
            DashStatus.BURN_ALARM -> R.string.dash_status_burn_alarm
        },
    ).uppercase(Locale.US)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Dot(color, filled = true, glow = glows)
        BasicText(name, style = type.title.copy(color = color))
    }
}

/** Filled dot, or a hollow ring when [filled] is false. Glow only when asked. */
@Composable
private fun Dot(color: Color, filled: Boolean, glow: Boolean) {
    Box(
        Modifier
            .size(14.dp)
            .then(
                if (glow) Modifier.drawBehind {
                    drawCircle(Brush.radialGradient(listOf(color.copy(alpha = 0.55f), Color.Transparent), center, size.minDimension))
                } else Modifier,
            )
            .padding(2.dp)
            .then(if (filled) Modifier.background(color, CircleShape) else Modifier.border(1.5.dp, color, CircleShape)),
    )
}

@Composable
private fun rateText(s: DashSnapshot): String {
    val rate = s.ratePerMin
    return when {
        s.live && rate != null -> stringResource(R.string.dash_rate_live, grouped(Math.round(rate)))
        s.live -> stringResource(R.string.dash_rate_none_live)
        else -> stringResource(R.string.dash_rate_standby)
    }
}

/** Resource-backed twin of DashUiModel.publishAgeLabel (same buckets); the model's own label is English only. */
@Composable
private fun ageText(ageMs: Long): String {
    val sec = ageMs / 1000
    return when {
        sec < 5 -> stringResource(R.string.dash_age_just_now)
        sec < 60 -> stringResource(R.string.dash_age_seconds, sec.toInt())
        sec < 3600 -> stringResource(R.string.dash_age_minutes, (sec / 60).toInt())
        sec < 86_400 -> stringResource(R.string.dash_age_hours, (sec / 3600).toInt())
        else -> stringResource(R.string.dash_age_days, (sec / 86_400).toInt())
    }
}

@Composable
private fun Tile(t: KpiTile, s: DashSnapshot, modifier: Modifier) {
    val label = stringResource(
        when (t.key) {
            KpiKey.MONTH_TOKENS -> R.string.dash_kpi_month_tokens
            KpiKey.DEPLETION_ETA -> R.string.dash_kpi_depletion_eta
            KpiKey.TODAY -> R.string.dash_kpi_today
            KpiKey.BUDGET_LEFT -> R.string.dash_kpi_budget_left
        },
    )
    val eta = t.eta
    val nowWord = stringResource(R.string.dash_eta_now)
    val value = if (eta != null) {
        val v = if (eta.value == "now") nowWord else eta.value
        val resets = eta.resetsText
        if (resets != null) stringResource(R.string.dash_eta_resets, v, if (resets == "now") nowWord else resets) else v
    } else t.value
    val caption = when (t.key) {
        KpiKey.MONTH_TOKENS -> stringResource(R.string.dash_kpi_cap_month)
        KpiKey.DEPLETION_ETA -> stringResource(if (eta?.resetsText != null) R.string.dash_kpi_cap_server else R.string.dash_kpi_cap_draw)
        KpiKey.TODAY -> stringResource(R.string.dash_kpi_cap_api)
        KpiKey.BUDGET_LEFT -> stringResource(R.string.dash_kpi_cap_cap, String.format(Locale.US, "%.1f", s.kpis.capM))
    }
    Column(modifier.aeInset().padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        BasicText(label.uppercase(Locale.US), style = type.label.copy(color = AetherColors.textLabel, fontSize = 10.sp, letterSpacing = 1.5.sp))
        BasicText(value, style = type.data.copy(color = if (value == NO_DATA) AetherColors.textMuted else AetherColors.textBright, fontSize = 16.sp))
        val chip = eta?.chip
        if (chip != null) {
            val (res, c) = when (chip) {
                EtaChip.LIVE -> R.string.dash_chip_live to AetherColors.success
                EtaChip.STALE -> R.string.dash_chip_stale to AetherColors.warn
                EtaChip.EST -> R.string.dash_chip_est to AetherColors.textMuted
            }
            BasicText(stringResource(res).uppercase(Locale.US), style = type.meta.copy(color = c))
        }
        BasicText(caption, style = type.meta.copy(color = AetherColors.textMuted))
    }
}

/** Navigation only: switches to the Terminal view, sends nothing to titan. */
@Composable
private fun OpenTerminalRow(onOpen: () -> Unit) {
    val label = stringResource(R.string.dash_open_terminal)
    Box(
        Modifier.fillMaxWidth().heightIn(min = 44.dp).clickable(role = Role.Button, onClickLabel = label, onClick = onOpen),
        contentAlignment = Alignment.CenterStart,
    ) {
        BasicText(label.uppercase(Locale.US), style = type.label.copy(color = AetherColors.cyanBright))
    }
}

@Composable
private fun ReadinessRow(r: ReadinessRowUi) {
    val text = if (r.time != null) stringResource(readinessRes(r.copy), r.time) else stringResource(readinessRes(r.copy))
    val state = stringResource(if (r.met) R.string.dash_ready_met else R.string.dash_ready_unmet)
    val color = if (r.met) AetherColors.success else AetherColors.textMuted
    Row(
        Modifier.fillMaxWidth().semantics(mergeDescendants = true) { contentDescription = "$text $state" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // Glow is the wire's own flag, never recomputed here.
        Dot(color, filled = r.met, glow = r.glows)
        BasicText(text, Modifier.weight(1f), style = type.body.copy(color = if (r.met) AetherColors.text else AetherColors.textMuted))
    }
}

private fun readinessRes(c: ReadinessCopy): Int = when (c) {
    ReadinessCopy.DESKTOP_RUNNING -> R.string.dash_ready_desktop_running
    ReadinessCopy.DESKTOP_NOT_RUNNING -> R.string.dash_ready_desktop_not_running
    ReadinessCopy.TERMINAL_NONE -> R.string.dash_ready_terminal_none
    ReadinessCopy.TERMINAL_OPEN -> R.string.dash_ready_terminal_open
    ReadinessCopy.TERMINAL_OPEN_SINCE -> R.string.dash_ready_terminal_open_since
    ReadinessCopy.STATUSLINE_NONE -> R.string.dash_ready_statusline_none
    ReadinessCopy.STATUSLINE_LIVE -> R.string.dash_ready_statusline_live
    ReadinessCopy.STATUSLINE_LAST -> R.string.dash_ready_statusline_last
    ReadinessCopy.COLLECTOR_NOT_RUNNING -> R.string.dash_ready_collector_not_running
    ReadinessCopy.COLLECTOR_NO_EVENTS -> R.string.dash_ready_collector_no_events
    ReadinessCopy.COLLECTOR_LAST_EVENT -> R.string.dash_ready_collector_last_event
}

@Composable
private fun Strip(s: DashSnapshot) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        stripItems(s).forEach { i ->
            val n = grouped(i.count)
            val text = when (i.key) {
                StripKey.AGENTS -> stringResource(R.string.dash_strip_agents, n)
                StripKey.ALERTS -> stringResource(R.string.dash_strip_alerts, n)
                StripKey.MEMORY -> pluralStringResource(R.plurals.dash_strip_memory, i.count.toCount(), n)
            }
            BasicText(text, style = type.meta.copy(color = AetherColors.textDim))
        }
    }
}
