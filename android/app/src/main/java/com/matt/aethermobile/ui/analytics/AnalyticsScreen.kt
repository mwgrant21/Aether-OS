package com.matt.aethermobile.ui.analytics

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.matt.aethermobile.R
import com.matt.aethermobile.analytics.AnalyticsSnapshot
import com.matt.aethermobile.analytics.AnalyticsUi
import com.matt.aethermobile.analytics.BurnRowUi
import com.matt.aethermobile.analytics.CommandRowUi
import com.matt.aethermobile.analytics.LogKind
import com.matt.aethermobile.analytics.LogTileUi
import com.matt.aethermobile.analytics.LongestRowUi
import com.matt.aethermobile.analytics.analyticsAge
import com.matt.aethermobile.analytics.analyticsUi
import com.matt.aethermobile.analytics.formatElapsed
import com.matt.aethermobile.analytics.longestElapsed
import com.matt.aethermobile.ledger.AgeLabel
import com.matt.aethermobile.ui.components.aeInset
import com.matt.aethermobile.ui.components.aePanel
import com.matt.aethermobile.ui.shell.mouseDragScroll
import com.matt.aethermobile.ui.theme.AetherColors
import com.matt.aethermobile.ui.theme.AetherType
import com.matt.aethermobile.views.ViewUi
import java.text.NumberFormat
import java.util.Locale
import kotlinx.coroutines.delay

private val type = AetherType()
private const val TICK_MS = 1_000L
private val BarShape = RoundedCornerShape(3.dp)

/**
 * The titan clock offset (ControlClient.titanClockOffsetMs) is not reachable from the pane render signature, so the
 * timers and the age line use offset 0 (phone clock). A phone clock that disagrees with titan's skews both by that
 * difference; wiring the offset needs a shell edit.
 */
private const val TITAN_CLOCK_OFFSET_MS = 0L

/**
 * Read-only Analytics body: log frequency, longest-running agents (live timers), real token burn (tap a row to expand)
 * and top commands. Nothing is saved. The 1 Hz tick lives in a LaunchedEffect inside the Ready body, so it exists
 * only while this pane is composed AND the host is RESUMED; switching panes removes the body and cancels it.
 */
@Composable
fun AnalyticsScreen(ui: ViewUi<AnalyticsSnapshot>, nowMs: Long, modifier: Modifier = Modifier) {
    when (ui) {
        ViewUi.Off, ViewUi.Loading -> Message(stringResource(R.string.analytics_loading), modifier)
        ViewUi.NoSnapshot -> Message(stringResource(R.string.analytics_no_snapshot), modifier)
        ViewUi.Unreadable -> Message(stringResource(R.string.analytics_unreadable), modifier)
        ViewUi.Unsupported -> Message(stringResource(R.string.analytics_unsupported), modifier)
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
private fun ReadyBody(snap: AnalyticsSnapshot, hostNowMs: Long, modifier: Modifier) {
    val ui = remember(snap) { analyticsUi(snap) }
    var now by remember { mutableLongStateOf(hostNowMs) }
    val owner = LocalLifecycleOwner.current
    LaunchedEffect(owner) {
        owner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                now = System.currentTimeMillis()
                delay(TICK_MS)
            }
        }
    }
    val scroll = rememberScrollState()
    Column(
        modifier.fillMaxSize().mouseDragScroll(scroll).verticalScroll(scroll).padding(horizontal = 12.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        LogsCard(ui)
        LongestCard(ui, now)
        BurnCard(ui)
        CommandsCard(ui)
        Footer(ui.computedAtMs, now)
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
private fun Empty(text: String) {
    BasicText(text, style = type.body.copy(color = AetherColors.textMuted))
}

private fun grouped(n: Long): String = NumberFormat.getIntegerInstance(Locale.US).format(n)

private fun Long.toCount(): Int = coerceIn(0L, Int.MAX_VALUE.toLong()).toInt()

private fun logColor(k: LogKind): Color = when (k) {
    LogKind.SUCCESS -> AetherColors.success
    LogKind.INFO -> AetherColors.cyan
    LogKind.DENIED -> AetherColors.dangerSoft
    LogKind.OTHER -> AetherColors.textMuted
}

private fun logLabel(k: LogKind): Int = when (k) {
    LogKind.SUCCESS -> R.string.analytics_log_success
    LogKind.INFO -> R.string.analytics_log_info
    LogKind.DENIED -> R.string.analytics_log_denied
    LogKind.OTHER -> R.string.analytics_log_other
}

@Composable
private fun LogsCard(ui: AnalyticsUi) {
    Card(stringResource(R.string.analytics_logs_title)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            ui.logs.tiles.forEach { LogTile(it, Modifier.weight(1f)) }
        }
        if (ui.logs.shareBarVisible) {
            Row(Modifier.fillMaxWidth().height(8.dp).background(AetherColors.bgAbyss, BarShape)) {
                ui.logs.tiles.filter { it.count > 0L }.forEach { t ->
                    Box(Modifier.weight(t.fraction.toFloat()).height(8.dp).background(logColor(t.kind)))
                }
            }
        }
    }
}

@Composable
private fun LogTile(t: LogTileUi, modifier: Modifier) {
    val label = stringResource(logLabel(t.kind))
    val count = grouped(t.count)
    val desc = stringResource(R.string.analytics_logs_desc, label, count)
    Column(
        modifier.aeInset().padding(horizontal = 8.dp, vertical = 10.dp).semantics(mergeDescendants = true) { contentDescription = desc },
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.size(8.dp).background(logColor(t.kind), CircleShape))
            BasicText(label.uppercase(Locale.US), maxLines = 1, overflow = TextOverflow.Clip, style = type.meta.copy(color = AetherColors.textMuted))
        }
        BasicText(count, maxLines = 1, style = type.data.copy(color = AetherColors.textBright))
    }
}

@Composable
private fun LongestCard(ui: AnalyticsUi, nowMs: Long) {
    Card(stringResource(R.string.analytics_longest_title)) {
        if (ui.emptyLongest != null) Empty(stringResource(R.string.analytics_empty_longest))
        ui.longest.forEach { LongestRow(it, nowMs) }
    }
}

@Composable
private fun LongestRow(r: LongestRowUi, nowMs: Long) {
    Row(Modifier.fillMaxWidth().aeInset().padding(10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            BasicText(r.type, maxLines = 1, overflow = TextOverflow.Ellipsis, style = type.body.copy(color = AetherColors.textBright))
            BasicText(r.description, maxLines = 2, overflow = TextOverflow.Ellipsis, style = type.meta.copy(color = AetherColors.textMuted))
        }
        BasicText(longestElapsed(r.startedAtMs, nowMs, TITAN_CLOCK_OFFSET_MS), style = type.data.copy(color = AetherColors.cyanBright))
    }
}

@Composable
private fun Bar(fraction: Double, color: Color) {
    Box(Modifier.fillMaxWidth().height(6.dp).background(AetherColors.bgAbyss, BarShape)) {
        Box(Modifier.fillMaxWidth(fraction.toFloat().coerceIn(0f, 1f)).height(6.dp).background(color, BarShape))
    }
}

@Composable
private fun BurnCard(ui: AnalyticsUi) {
    var open by remember { mutableStateOf<Int?>(null) }
    Card(stringResource(R.string.analytics_burn_title)) {
        if (ui.emptyBurn != null) Empty(stringResource(R.string.analytics_empty_burn))
        ui.burn.forEachIndexed { i, r ->
            BurnRow(r, expanded = open == i, onToggle = { open = if (open == i) null else i })
        }
    }
}

@Composable
private fun BurnRow(r: BurnRowUi, expanded: Boolean, onToggle: () -> Unit) {
    val calls = r.callsText?.toLongOrNull()
    val callsLabel = if (calls != null) pluralStringResource(R.plurals.analytics_burn_calls, calls.toCount(), r.callsText) else null
    val duration = formatElapsed(r.durationMs)
    val tok = stringResource(R.string.analytics_burn_tokens, r.tokensText)
    val meta = if (callsLabel != null) stringResource(R.string.analytics_burn_meta, callsLabel, duration) else duration
    val desc = stringResource(R.string.analytics_burn_expand_desc, r.type, tok)
    Column(
        Modifier
            .fillMaxWidth()
            .aeInset()
            .heightIn(min = 48.dp)
            .semantics(mergeDescendants = true) { role = Role.Button; contentDescription = desc }
            .clickable(onClick = onToggle)
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                BasicText(r.type, maxLines = 1, overflow = TextOverflow.Ellipsis, style = type.body.copy(color = AetherColors.textBright))
                BasicText(r.description, maxLines = 2, overflow = TextOverflow.Ellipsis, style = type.meta.copy(color = AetherColors.textMuted))
            }
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                BasicText(tok, style = type.data.copy(color = AetherColors.cyanBright))
                BasicText(meta, style = type.meta.copy(color = AetherColors.textMuted))
            }
        }
        Bar(r.barFraction, AetherColors.cyan)
        if (expanded) {
            Stat(R.string.analytics_stat_tokens, r.tokensText)
            if (r.callsText != null) Stat(R.string.analytics_stat_calls, r.callsText)
            if (r.tokPerCall != null) Stat(R.string.analytics_stat_tok_per_call, r.tokPerCall)
            Stat(R.string.analytics_stat_duration, duration)
        }
    }
}

@Composable
private fun Stat(label: Int, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        BasicText(stringResource(label).uppercase(Locale.US), style = type.meta.copy(color = AetherColors.textLabel))
        BasicText(value, style = type.data.copy(color = AetherColors.textBright))
    }
}

@Composable
private fun CommandsCard(ui: AnalyticsUi) {
    Card(stringResource(R.string.analytics_commands_title)) {
        if (ui.emptyCommands != null) Empty(stringResource(R.string.analytics_empty_commands))
        ui.commands.forEachIndexed { i, c -> CommandRow(i + 1, c) }
    }
}

@Composable
private fun CommandRow(rank: Int, c: CommandRowUi) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        BasicText(rank.toString(), Modifier.width(14.dp), style = type.meta.copy(color = AetherColors.textMuted))
        BasicText(c.name, Modifier.width(96.dp), maxLines = 1, overflow = TextOverflow.Ellipsis, style = type.data.copy(color = AetherColors.text))
        Box(Modifier.weight(1f)) { Bar(c.barFraction, AetherColors.cyan) }
        BasicText(grouped(c.count), style = type.data.copy(color = AetherColors.textBright))
    }
}

@Composable
private fun Footer(computedAtMs: Long, nowMs: Long) {
    val age = when (val a = analyticsAge(computedAtMs, nowMs, TITAN_CLOCK_OFFSET_MS)) {
        AgeLabel.JustNow -> stringResource(R.string.analytics_age_just_now)
        is AgeLabel.Minutes -> pluralStringResource(R.plurals.analytics_age_minutes, a.n.toCount(), a.n.toInt())
        is AgeLabel.Hours -> pluralStringResource(R.plurals.analytics_age_hours, a.n.toCount(), a.n.toInt())
        is AgeLabel.Days -> pluralStringResource(R.plurals.analytics_age_days, a.n.toCount(), a.n.toInt())
    }
    BasicText(stringResource(R.string.analytics_updated, age), style = type.meta.copy(color = AetherColors.textMuted))
}
