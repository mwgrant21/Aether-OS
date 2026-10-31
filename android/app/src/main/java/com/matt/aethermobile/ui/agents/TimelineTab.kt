package com.matt.aethermobile.ui.agents

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.matt.aethermobile.R
import com.matt.aethermobile.agents.TimelineItem
import com.matt.aethermobile.agents.TimelineKind
import com.matt.aethermobile.agents.TimelineUi
import com.matt.aethermobile.agents.dispatchUsage
import com.matt.aethermobile.agents.timelineAge
import com.matt.aethermobile.ui.theme.AetherColors

/** Newest first, exactly as titan sent it, down a vertical rail. */
@Composable
fun TimelineTab(timeline: TimelineUi, now: State<Long>) {
    when (timeline) {
        is TimelineUi.Unavailable -> Dim(stringResource(R.string.agents_timeline_unavailable))
        is TimelineUi.Empty -> Dim(stringResource(R.string.agents_timeline_empty))
        is TimelineUi.Items -> Column {
            timeline.items.forEach { TimelineRow(it, now) }
        }
    }
}

@Composable
private fun TimelineRow(item: TimelineItem, now: State<Long>) {
    val kindName = stringResource(
        when (item.kind) {
            TimelineKind.ANOMALY -> R.string.agents_timeline_kind_anomaly
            TimelineKind.DISPATCH -> R.string.agents_timeline_kind_dispatch
            TimelineKind.TOOL -> R.string.agents_timeline_kind_tool
        },
    )
    val usage = dispatchUsage(item)
    val usageText = usage?.let { stringResource(R.string.agents_timeline_usage, it.tokens, it.toolUses, it.duration) }
    val desc = if (usageText != null) stringResource(R.string.agents_timeline_row_usage_desc, kindName, item.label, usageText)
    else stringResource(R.string.agents_timeline_row_desc, kindName, item.label)
    Row(
        Modifier.fillMaxWidth().height(IntrinsicSize.Min).semantics(mergeDescendants = true) { contentDescription = desc },
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Rail(item.kind)
        Column(Modifier.weight(1f).padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            BasicText(item.label, style = type.body.copy(color = if (item.kind == TimelineKind.ANOMALY) AetherColors.warn else AetherColors.textBright))
            if (usageText != null) BasicText(usageText, style = type.meta.copy(color = AetherColors.textDim))
            AgoText(item.atMs, now)
        }
    }
}

/** Reads the clock itself so a tick recomposes only this text. */
@Composable
private fun AgoText(atMs: Long, now: State<Long>) {
    BasicText(ageText(timelineAge(atMs, now.value, TITAN_CLOCK_OFFSET_MS)), style = type.meta.copy(color = AetherColors.textMuted))
}

/** Rail column: the line runs the full row height, the marker sits at the top. Anomaly square amber, dispatch circle cyan with glow, tool circle muted. */
@Composable
private fun Rail(kind: TimelineKind) {
    val line = AetherColors.borderMid
    val color = when (kind) {
        TimelineKind.ANOMALY -> AetherColors.warn
        TimelineKind.DISPATCH -> AetherColors.cyan
        TimelineKind.TOOL -> AetherColors.textMuted
    }
    Box(
        Modifier
            .width(16.dp)
            .fillMaxHeight()
            .drawBehind {
                val cx = size.width / 2f
                drawLine(line, Offset(cx, 0f), Offset(cx, size.height), strokeWidth = 1.dp.toPx())
                val cy = 8.dp.toPx()
                when (kind) {
                    TimelineKind.ANOMALY -> {
                        val s = 9.dp.toPx()
                        drawRect(color, Offset(cx - s / 2f, cy - s / 2f), Size(s, s))
                    }
                    TimelineKind.DISPATCH -> {
                        drawCircle(color.copy(alpha = 0.18f), 8.dp.toPx(), Offset(cx, cy))
                        drawCircle(color.copy(alpha = 0.35f), 6.dp.toPx(), Offset(cx, cy))
                        drawCircle(color, 4.dp.toPx(), Offset(cx, cy))
                    }
                    TimelineKind.TOOL -> drawCircle(color, 3.5.dp.toPx(), Offset(cx, cy))
                }
            },
    )
}
