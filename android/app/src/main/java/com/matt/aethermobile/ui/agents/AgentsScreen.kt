package com.matt.aethermobile.ui.agents

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
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
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.matt.aethermobile.R
import com.matt.aethermobile.agents.AgentsSnapshot
import com.matt.aethermobile.agents.DONE_EXPANDED_DEFAULT
import com.matt.aethermobile.agents.agentsAge
import com.matt.aethermobile.agents.agentsUi
import com.matt.aethermobile.ledger.AgeLabel
import com.matt.aethermobile.ui.shell.mouseDragScroll
import com.matt.aethermobile.ui.theme.AetherColors
import com.matt.aethermobile.ui.theme.AetherType
import com.matt.aethermobile.views.ViewUi
import java.util.Locale
import kotlinx.coroutines.delay

internal val type = AetherType()
private const val TICK_MS = 1_000L

/**
 * The titan clock offset (ControlClient.titanClockOffsetMs) is not reachable from the pane render signature, so the
 * timers and the age line use offset 0 (phone clock). A phone clock that disagrees with titan's skews both by that
 * difference; wiring the offset needs a shell edit.
 */
internal const val TITAN_CLOCK_OFFSET_MS = 0L

/**
 * Read-only Agents pane: ROSTER / FLEET / TIMELINE tabs and a detail sheet for a running agent. Nothing here sends
 * anything to titan, and tapping a needs-input row opens the same detail sheet as any other row (no approval UI).
 */
@Composable
fun AgentsScreen(ui: ViewUi<AgentsSnapshot>, nowMs: Long, modifier: Modifier = Modifier) {
    when (ui) {
        ViewUi.Off, ViewUi.Loading -> Message(stringResource(R.string.agents_loading), modifier)
        ViewUi.NoSnapshot -> Message(stringResource(R.string.agents_no_snapshot), modifier)
        ViewUi.Unreadable -> Message(stringResource(R.string.agents_unreadable), modifier)
        ViewUi.Unsupported -> Message(stringResource(R.string.agents_unsupported), modifier)
        is ViewUi.Ready -> ReadyBody(ui.data, nowMs, modifier)
    }
}

@Composable
private fun Message(text: String, modifier: Modifier) {
    Column(modifier.padding(16.dp)) {
        BasicText(text, style = type.body.copy(color = AetherColors.textMuted))
    }
}

/**
 * The 1 Hz clock. The effect lives in the Ready body, so it exists only while the pane is composed, and
 * repeatOnLifecycle cancels it whenever the host leaves RESUMED. Readers take the [State] and read `.value` in the
 * smallest composable that shows a time, so a tick recomposes those texts and not the whole screen.
 */
@Composable
private fun rememberNow(hostNowMs: Long): State<Long> {
    val now = remember { mutableLongStateOf(hostNowMs) }
    val owner = LocalLifecycleOwner.current
    LaunchedEffect(owner) {
        owner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                now.longValue = System.currentTimeMillis()
                delay(TICK_MS)
            }
        }
    }
    return now
}

@Composable
private fun ReadyBody(snap: AgentsSnapshot, hostNowMs: Long, modifier: Modifier) {
    val ui = remember(snap) { agentsUi(snap) }
    val now = rememberNow(hostNowMs)
    var tab by remember { mutableStateOf(AgentsTab.ROSTER) }
    var openId by remember { mutableStateOf<String?>(null) }
    var doneExpanded by remember { mutableStateOf(DONE_EXPANDED_DEFAULT) }
    val shown = findRunning(ui, openId)
    BackHandler(enabled = shown != null) { openId = null }

    Box(modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            Tabs(tab, ui.needsInputCount, ui.badge) { tab = it }
            val scroll = rememberScrollState()
            Column(
                Modifier.weight(1f).fillMaxWidth().mouseDragScroll(scroll).verticalScroll(scroll)
                    .padding(horizontal = 12.dp, vertical = 14.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                when (tab) {
                    AgentsTab.ROSTER -> RosterTab(ui, now, doneExpanded, { doneExpanded = !doneExpanded }) { openId = nextOpenId(openId, it) }
                    AgentsTab.FLEET -> FleetTab(ui.fleet)
                    AgentsTab.TIMELINE -> TimelineTab(ui.timeline)
                }
                Footer(ui.computedAtMs, now)
            }
        }
        if (shown != null) {
            Scrim { openId = null }
            Box(Modifier.align(Alignment.BottomCenter)) { AgentDetailSheet(shown, now) }
        }
    }
}

@Composable
private fun Tabs(selected: AgentsTab, needsInput: Int, badge: String?, onPick: (AgentsTab) -> Unit) {
    Row(Modifier.fillMaxWidth()) {
        AgentsTab.entries.forEach { t ->
            val on = t == selected
            val label = stringResource(
                when (t) {
                    AgentsTab.ROSTER -> R.string.agents_tab_roster
                    AgentsTab.FLEET -> R.string.agents_tab_fleet
                    AgentsTab.TIMELINE -> R.string.agents_tab_timeline
                },
            )
            val base = if (t == AgentsTab.ROSTER && needsInput > 0) {
                pluralStringResource(R.plurals.agents_tab_roster_badge_desc, needsInput, needsInput)
            } else label
            val desc = if (on) stringResource(R.string.agents_tab_selected, base) else base
            Column(
                Modifier
                    .weight(1f)
                    .heightIn(min = 44.dp)
                    .semantics(mergeDescendants = true) { contentDescription = desc; role = Role.Tab; this.selected = on }
                    .clickable { onPick(t) },
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Row(Modifier.weight(1f).padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    BasicText(
                        label.uppercase(Locale.US),
                        maxLines = 1,
                        style = type.label.copy(color = if (on) AetherColors.cyanBright else AetherColors.textLabel),
                    )
                    if (t == AgentsTab.ROSTER && badge != null) {
                        BasicText(badge, maxLines = 1, style = type.label.copy(color = AetherColors.warn))
                    }
                }
                Box(Modifier.fillMaxWidth().height(2.dp).background(if (on) AetherColors.cyan else Color.Transparent))
            }
        }
    }
}

@Composable
private fun Footer(computedAtMs: Long, now: State<Long>) {
    val age = when (val a = agentsAge(computedAtMs, now.value, TITAN_CLOCK_OFFSET_MS)) {
        AgeLabel.JustNow -> stringResource(R.string.agents_age_just_now)
        is AgeLabel.Minutes -> pluralStringResource(R.plurals.agents_age_minutes, a.n.toInt(), a.n.toInt())
        is AgeLabel.Hours -> pluralStringResource(R.plurals.agents_age_hours, a.n.toInt(), a.n.toInt())
        is AgeLabel.Days -> pluralStringResource(R.plurals.agents_age_days, a.n.toInt(), a.n.toInt())
    }
    BasicText(stringResource(R.string.agents_updated, age), style = type.meta.copy(color = AetherColors.textMuted))
}
