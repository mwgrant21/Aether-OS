package com.matt.aethermobile.ui.agents

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.matt.aethermobile.R
import com.matt.aethermobile.agents.FleetRowUi
import com.matt.aethermobile.agents.FleetUi
import com.matt.aethermobile.ui.components.aeInset
import com.matt.aethermobile.ui.theme.AetherColors

/** Other sessions on titan, oldest first. [expandedKey] is the stable row key; [onToggle] receives the tapped key. */
@Composable
fun FleetTab(fleet: FleetUi, now: State<Long>, expandedKey: String?, onToggle: (String) -> Unit) {
    when (fleet) {
        is FleetUi.Unavailable -> Dim(stringResource(R.string.agents_fleet_unavailable))
        is FleetUi.Empty -> Dim(stringResource(R.string.agents_fleet_empty))
        is FleetUi.Rows -> fleet.rows.forEach { FleetRowItem(it, now, it.key == expandedKey, onToggle) }
    }
}

@Composable
private fun FleetRowItem(r: FleetRowUi, now: State<Long>, expanded: Boolean, onToggle: (String) -> Unit) {
    val status = stringResource(if (r.busy) R.string.agents_fleet_status_busy else R.string.agents_fleet_status_idle)
    val desc = stringResource(R.string.agents_fleet_row_desc, r.title, r.name, status)
    val state = stringResource(if (expanded) R.string.agents_done_expanded else R.string.agents_done_collapsed)
    Column(
        Modifier
            .fillMaxWidth()
            .aeInset()
            .heightIn(min = 56.dp)
            .semantics(mergeDescendants = true) { role = Role.Button; contentDescription = desc; stateDescription = state }
            .clickable { onToggle(r.key) }
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            BasicText(r.title, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, style = type.body.copy(color = AetherColors.textBright))
            ElapsedText(r.startedAtMs, now, type.data.copy(color = AetherColors.cyanBright))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            BasicText(r.name, Modifier.weight(1f, fill = false), maxLines = 1, overflow = TextOverflow.Ellipsis, style = type.meta.copy(color = AetherColors.text))
            BasicText(stringResource(R.string.agents_fleet_separator), style = type.meta.copy(color = AetherColors.textMuted))
            StatusChip(status, r.busy)
        }
        if (expanded) {
            val detail = if (r.pid != null) stringResource(R.string.agents_fleet_detail_pid, r.kind, r.pid) else stringResource(R.string.agents_fleet_detail, r.kind)
            BasicText(detail, style = type.meta.copy(color = AetherColors.textMuted))
        }
    }
}

@Composable
private fun StatusChip(text: String, busy: Boolean) {
    val c = if (busy) AetherColors.cyanBright else AetherColors.textMuted
    val shape = RoundedCornerShape(6.dp)
    BasicText(
        text,
        Modifier.border(1.dp, c, shape).background(c.copy(alpha = 0.12f), shape).padding(horizontal = 6.dp, vertical = 1.dp),
        maxLines = 1,
        style = type.label.copy(color = c),
    )
}

@Composable
internal fun Dim(text: String) {
    BasicText(text, style = type.body.copy(color = AetherColors.textMuted))
}
