package com.matt.aethermobile.ui.thread

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.selection.SelectionContainer
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
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.matt.aethermobile.R
import com.matt.aethermobile.term.TerminalHost
import com.matt.aethermobile.thread.ThreadUi
import com.matt.aethermobile.ui.theme.AetherColors
import com.matt.aethermobile.ui.theme.AetherType
import kotlinx.coroutines.delay

private val type = AetherType()
private val UserBubbleShape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp, bottomEnd = 4.dp, bottomStart = 16.dp)
private val ToolShape = RoundedCornerShape(10.dp)
private val ThreadBodyStyle = type.body.copy(fontSize = 16.sp, lineHeight = 22.sp)
private val ToolTagStyle = type.meta.copy(fontWeight = FontWeight.Bold, fontSize = 10.sp, letterSpacing = 1.sp)
private val ToolTargetStyle = type.meta.copy(fontSize = 12.sp)

/**
 * Claude thread: bubbles, tool lines and a working line, newest at the bottom, over the composer.
 * Takes the whole [ThreadUi]: the oldest pending prompt shows as a display-only approval card between the list and
 * the composer.
 */
@Composable
fun ThreadScreen(
    ui: ThreadUi,
    listState: LazyListState,
    draft: String,
    onDraft: (String) -> Unit,
    sendEnabled: Boolean,
    onCompose: (String, Boolean) -> TerminalHost.ComposeResult,
    modifier: Modifier = Modifier,
) {
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
                verticalArrangement = Arrangement.spacedBy(14.dp, Alignment.Bottom),
                contentPadding = PaddingValues(start = 16.dp, top = 18.dp, end = 16.dp, bottom = 10.dp),
            ) {
                items(rows, key = { it.key }) { row -> RowView(row) }
            }
        }
        approval?.let { ApprovalCard(it) }
        ThreadComposer(draft, onDraft, sendEnabled, onCompose)
    }
}

@Composable
private fun RowView(row: ThreadRow) {
    when (row) {
        is ThreadRow.User -> BoxWithConstraints(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
            Column(
                Modifier
                    .widthIn(max = maxWidth * 0.84f)
                    .background(AetherColors.activeFill, UserBubbleShape)
                    .border(1.dp, AetherColors.activeBorder, UserBubbleShape)
                    .padding(horizontal = 14.dp, vertical = 11.dp),
            ) { RowText(row.text, row.truncated, AetherColors.textBright) }
        }
        is ThreadRow.Claude -> Column(Modifier.fillMaxWidth()) { RowText(row.text, row.truncated, AetherColors.text) }
        is ThreadRow.Tool -> Row(
            Modifier
                .fillMaxWidth()
                .semantics(mergeDescendants = true) { contentDescription = row.desc }
                .background(AetherColors.insetTop, ToolShape)
                .border(1.dp, AetherColors.border, ToolShape)
                .padding(horizontal = 12.dp, vertical = 9.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BasicText(row.tag, style = ToolTagStyle.copy(color = AetherColors.cyan), maxLines = 1)
            BasicText(
                row.target.orEmpty(),
                Modifier.weight(1f),
                style = ToolTargetStyle.copy(color = AetherColors.textDim),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            row.add?.let { BasicText("+$it", style = type.meta.copy(color = AetherColors.success), maxLines = 1) }
            row.del?.let { BasicText("−$it", style = type.meta.copy(color = AetherColors.textMuted), maxLines = 1) }
        }
        is ThreadRow.Working -> {
            val text = if (row.seconds == null) stringResource(R.string.thread_working_no_time)
            else stringResource(R.string.thread_working, formatElapsed(row.seconds))
            Row(Modifier.padding(start = 4.dp, top = 2.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                Canvas(Modifier.size(7.dp)) {
                    drawCircle(AetherColors.cyanCore.copy(alpha = 0.3f), radius = size.minDimension)
                    drawCircle(AetherColors.cyanCore, radius = size.minDimension / 2)
                }
                Spacer(Modifier.width(8.dp))
                BasicText(text, style = type.meta.copy(color = AetherColors.textMuted))
            }
        }
    }
}

@Composable
private fun RowText(text: String, truncated: Boolean, color: Color) {
    // SelectionContainer stacks its children at the origin, so keep them in one Column.
    SelectionContainer {
        Column {
            BasicText(text, style = ThreadBodyStyle.copy(color = color))
            if (truncated) BasicText(stringResource(R.string.thread_truncated), style = type.meta.copy(color = AetherColors.textMuted))
        }
    }
}
