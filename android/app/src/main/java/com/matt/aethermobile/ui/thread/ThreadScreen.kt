package com.matt.aethermobile.ui.thread

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.matt.aethermobile.R
import com.matt.aethermobile.thread.ThreadUi
import com.matt.aethermobile.ui.components.AeSecondaryButton
import com.matt.aethermobile.ui.theme.AetherColors
import com.matt.aethermobile.ui.theme.AetherType
import kotlinx.coroutines.delay

private val type = AetherType()
private val BubbleShape = RoundedCornerShape(12.dp)
private val ToolShape = RoundedCornerShape(6.dp)
private val FieldShape = RoundedCornerShape(10.dp)

/**
 * Read-only Claude thread: bubbles, tool lines and a working line, newest at the bottom, over a disabled composer.
 * Takes the whole [ThreadUi]: the oldest pending prompt shows as a display-only approval card between the list and
 * the composer.
 */
@Composable
fun ThreadScreen(ui: ThreadUi, listState: LazyListState, modifier: Modifier = Modifier) {
    var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val ticking = needsClock(ui, nowMs)
    LaunchedEffect(ticking) {
        if (ticking) while (true) { nowMs = System.currentTimeMillis(); delay(1000) }
    }
    val rows = threadRows(ui, nowMs)
    val empty = emptyStateFor(ui)
    // nowMs can be one tick stale in the first composition that shows a prompt after an idle period; the ticking
    // effect refreshes it at once, so a wrong countdown shows for at most one frame.
    val approval = approvalFor(ui.prompts, nowMs)

    // Read BEFORE the new rows are laid out: canScrollForward still describes the previous layout when this
    // composition first sees a changed last key or row count. The effect below is not restarted by later
    // recompositions, so it keeps the value from the composition that launched it. An empty list cannot scroll,
    // so the first fill counts as at the bottom.
    val wasAtBottom = !listState.canScrollForward
    val lastKey = rows.lastOrNull()?.key
    val lastCount = rows.size
    LaunchedEffect(lastKey, lastCount, approval?.id) {
        if (shouldScrollToEnd(wasAtBottom, appended = lastCount > 0)) {
            listState.animateScrollToItem(lastCount - 1)
            // The item's top is now at the viewport top; a tall last row still has its tail below.
            var guard = 0
            while (listState.canScrollForward && guard++ < 8) listState.scrollBy(1e9f)
        }
    }

    Column(modifier) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (empty != null) {
                val res = if (empty == ThreadEmpty.NoSession) R.string.thread_empty_no_session else R.string.thread_empty_waiting
                BasicText(
                    stringResource(res),
                    Modifier.align(Alignment.Center).padding(24.dp),
                    style = type.body.copy(color = AetherColors.textMuted),
                )
            }
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(7.dp, Alignment.Bottom),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
            ) {
                items(rows, key = { it.key }) { row -> RowView(row) }
            }
        }
        approval?.let { ApprovalCard(it) }
        DisabledComposer()
    }
}

@Composable
private fun RowView(row: ThreadRow) {
    when (row) {
        is ThreadRow.User -> Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
            Bubble(row.text, row.truncated, AetherColors.textBright, Modifier.fillMaxWidth(0.92f).background(AetherColors.activeFill, BubbleShape))
        }
        is ThreadRow.Claude -> Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterStart) {
            Bubble(
                row.text, row.truncated, AetherColors.text,
                Modifier.fillMaxWidth(0.92f)
                    .background(AetherColors.panelSoftTop, BubbleShape)
                    .border(1.dp, AetherColors.border, BubbleShape),
            )
        }
        is ThreadRow.Tool -> Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).background(AetherColors.insetTop, ToolShape)) {
            Box(Modifier.width(2.dp).fillMaxHeight().background(AetherColors.cyanDeep))
            BasicText(
                row.text,
                Modifier.padding(horizontal = 8.dp, vertical = 5.dp),
                style = type.meta.copy(color = AetherColors.textMuted),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        is ThreadRow.Working -> {
            val text = if (row.seconds == null) stringResource(R.string.thread_working_no_time) else stringResource(R.string.thread_working, row.seconds)
            BasicText(text, Modifier.padding(horizontal = 4.dp, vertical = 2.dp), style = type.meta.copy(color = AetherColors.cyanCore))
        }
    }
}

@Composable
private fun Bubble(text: String, truncated: Boolean, color: Color, modifier: Modifier) {
    Column(modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
        BasicText(text, style = type.body.copy(color = color))
        if (truncated) BasicText(stringResource(R.string.thread_truncated), style = type.meta.copy(color = AetherColors.textMuted))
    }
}

/** Looks like the compose bar but holds no text field, so it cannot take focus or raise the keyboard. */
@Composable
private fun DisabledComposer() {
    val desc = stringResource(R.string.thread_composer_disabled_desc)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        Box(
            Modifier
                .weight(1f)
                .heightIn(min = 44.dp)
                .semantics { contentDescription = desc; disabled() }
                .border(1.dp, AetherColors.border, FieldShape)
                .padding(horizontal = 10.dp, vertical = 10.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            BasicText(stringResource(R.string.thread_composer_hint), style = type.body.copy(color = AetherColors.textMuted))
        }
        AeSecondaryButton(stringResource(R.string.compose_send), {}, Modifier.width(80.dp), enabled = false)
    }
}
