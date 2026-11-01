package com.matt.aethermobile.ui.agents

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.matt.aethermobile.R
import com.matt.aethermobile.agents.AgentGroup
import com.matt.aethermobile.agents.AgentGroupUi
import com.matt.aethermobile.agents.AgentsUi
import com.matt.aethermobile.agents.DoneRowUi
import com.matt.aethermobile.agents.RunningRowUi
import com.matt.aethermobile.agents.agentElapsed
import com.matt.aethermobile.ui.components.aeInset
import com.matt.aethermobile.ui.shell.LocalPaneEnv
import com.matt.aethermobile.ui.theme.AetherColors
import java.util.Locale

private val RowShape = RoundedCornerShape(12.dp)

@Composable
private fun groupName(g: AgentGroup): String = stringResource(
    when (g) {
        AgentGroup.NEEDS_INPUT -> R.string.agents_group_needs_input
        AgentGroup.WORKING -> R.string.agents_group_working
        AgentGroup.DONE -> R.string.agents_group_done
    },
)

@Composable
fun RosterTab(ui: AgentsUi, now: State<Long>, doneExpanded: Boolean, onToggleDone: () -> Unit, onTapRunning: (String) -> Unit) {
    if (ui.emptyRoster != null) Dim(stringResource(R.string.agents_empty_roster))
    ui.groups.forEach { g ->
        if (g.group == AgentGroup.DONE) DoneGroup(g, doneExpanded, onToggleDone)
        else {
            GroupHeader(g, Modifier)
            g.running.forEach { RunningRow(it, now, onTapRunning) }
        }
    }
}

@Composable
private fun GroupHeader(g: AgentGroupUi, modifier: Modifier) {
    val name = groupName(g.group)
    val color = if (g.group == AgentGroup.NEEDS_INPUT) AetherColors.warn else AetherColors.textLabel
    BasicText(
        stringResource(R.string.agents_group_header, name.uppercase(Locale.US), g.count),
        modifier,
        style = type.label.copy(color = color),
    )
}

@Composable
private fun DoneGroup(g: AgentGroupUi, expanded: Boolean, onToggle: () -> Unit) {
    val name = groupName(g.group)
    val desc = pluralStringResource(R.plurals.agents_group_desc, g.count, name, g.count)
    val state = stringResource(if (expanded) R.string.agents_done_expanded else R.string.agents_done_collapsed)
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .semantics(mergeDescendants = true) { role = Role.Button; contentDescription = desc; stateDescription = state }
            .clickable(onClick = onToggle),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        BasicText(
            stringResource(R.string.agents_group_header, name.uppercase(Locale.US), g.count),
            style = type.label.copy(color = AetherColors.textLabel),
        )
        BasicText(
            stringResource(if (expanded) R.string.agents_done_hide else R.string.agents_done_show).uppercase(Locale.US),
            style = type.label.copy(color = AetherColors.cyan),
        )
    }
    if (expanded) g.done.forEach { DoneRow(it) }
}

@Composable
private fun RunningRow(r: RunningRowUi, now: State<Long>, onTap: (String) -> Unit) {
    // The description omits the time on purpose: reading the clock here would recompose the whole row every second.
    val desc = stringResource(if (r.needsInput) R.string.agents_row_needs_input_desc else R.string.agents_row_running_desc, r.type, r.headline)
    Row(
        Modifier
            .fillMaxWidth()
            .aeInset()
            .heightIn(min = 56.dp)
            .semantics(mergeDescendants = true) { role = Role.Button; contentDescription = desc }
            .clickable { onTap(r.id) }
            .padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (r.needsInput) PulseRing { Avatar(r.type, 40) } else Avatar(r.type, 40)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                BasicText(r.type, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, style = type.body.copy(color = AetherColors.textBright))
                ElapsedText(r.startedAtMs, now, type.data.copy(color = AetherColors.cyanBright))
            }
            BasicText(r.headline, maxLines = 2, overflow = TextOverflow.Ellipsis, style = type.meta.copy(color = AetherColors.text))
            if (r.narration != null) {
                BasicText(r.narration, maxLines = 2, overflow = TextOverflow.Ellipsis, style = type.meta.copy(color = AetherColors.textMuted, fontStyle = FontStyle.Italic))
            }
        }
    }
}

@Composable
private fun DoneRow(r: DoneRowUi) {
    val meta = stringResource(R.string.agents_done_meta, r.tokens, r.toolUses, r.elapsed)
    Column(
        Modifier.fillMaxWidth().aeInset().padding(10.dp).semantics(mergeDescendants = true) {},
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        BasicText(r.type, maxLines = 1, overflow = TextOverflow.Ellipsis, style = type.body.copy(color = AetherColors.textBright))
        BasicText(r.headline, maxLines = 2, overflow = TextOverflow.Ellipsis, style = type.meta.copy(color = AetherColors.textMuted))
        BasicText(meta, style = type.meta.copy(color = AetherColors.textDim))
    }
}

/** Reads the clock itself so a tick recomposes only this text. */
@Composable
internal fun ElapsedText(startedAtMs: Long, now: State<Long>, style: TextStyle) {
    val offsetMs = LocalPaneEnv.current.titanClockOffsetMs
    BasicText(agentElapsed(startedAtMs, now.value, offsetMs), maxLines = 1, style = style)
}

/** 48dp (or [size]) striped avatar with the first letter of the type. */
@Composable
internal fun Avatar(typeName: String, size: Int) {
    val a = Color(0xFF0E3340)
    val b = Color(0xFF123F4E)
    Box(
        Modifier
            .size(size.dp)
            .clip(RowShape)
            .drawBehind {
                drawRect(a)
                val step = 10.dp.toPx()
                var x = -size.dp.toPx()
                while (x < this.size.width) {
                    drawLine(b, Offset(x, this.size.height), Offset(x + this.size.height, 0f), strokeWidth = 5.dp.toPx())
                    x += step
                }
            }
            .border(1.dp, AetherColors.borderMid, RowShape),
        contentAlignment = Alignment.Center,
    ) {
        BasicText(
            typeName.take(1).uppercase(Locale.US),
            style = type.title.copy(color = AetherColors.cyanBright),
        )
    }
}

/**
 * Amber ring that pulses. The transition is composed only while the host lifecycle is RESUMED; otherwise the ring is
 * drawn static, so a backgrounded or paused screen runs no animation.
 */
@Composable
private fun PulseRing(content: @Composable () -> Unit) {
    val owner = LocalLifecycleOwner.current
    val state by owner.lifecycle.currentStateFlow.collectAsState()
    if (state.isAtLeast(Lifecycle.State.RESUMED)) PulsingRing(content) else Ring(1f, content)
}

@Composable
private fun PulsingRing(content: @Composable () -> Unit) {
    val a by rememberInfiniteTransition(label = "needs-input-ring").animateFloat(
        initialValue = 0.45f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Reverse),
        label = "needs-input-alpha",
    )
    Ring(a, content)
}

@Composable
private fun Ring(ringAlpha: Float, content: @Composable () -> Unit) {
    Box(Modifier.border(2.dp, AetherColors.warn.copy(alpha = ringAlpha), RowShape).padding(2.dp)) { content() }
}
