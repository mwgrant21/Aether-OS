package com.matt.aethermobile.ui.thread

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.matt.aethermobile.R
import com.matt.aethermobile.protocol.ControlProtocol.ToolState
import com.matt.aethermobile.ui.components.aeInset
import com.matt.aethermobile.ui.theme.AetherColors
import com.matt.aethermobile.ui.theme.Rajdhani
import com.matt.aethermobile.ui.theme.SpaceMono

// Design 1a literals that have no token in AetherColors (scratch-terminal-design.md 1a CSS).
private val UserFill = Color(80, 220, 255, 26)
private val UserBorder = Color(120, 230, 255, 77)
private val ToolBorder = Color(70, 180, 215, 51)
private val DiffAddBg = Color(59, 224, 160, 20)
private val DiffDelBg = Color(95, 138, 151, 20)
private val CodeBg = Color(80, 220, 255, 24)

// Not in strings_thread.xml (owned by A3); moving them there is a one-line change per label.
private const val LABEL_INPUT = "INPUT"
private const val LABEL_OUTPUT = "OUTPUT"
private const val LABEL_NO_TEXT = "No text"

private val ToolShape = RoundedCornerShape(10.dp)
private val BubbleShape = RoundedCornerShape(16.dp, 16.dp, 4.dp, 16.dp)

private val UserStyle = TextStyle(
    fontFamily = Rajdhani, fontWeight = FontWeight.Medium, fontSize = 16.sp, lineHeight = 21.6.sp,
    color = AetherColors.textBright,
)
private val AssistantStyle = TextStyle(
    fontFamily = Rajdhani, fontWeight = FontWeight.Medium, fontSize = 16.sp, lineHeight = 22.4.sp,
    color = AetherColors.text, lineBreak = LineBreak.Paragraph,
)
private val MonoStyle = TextStyle(fontFamily = SpaceMono, fontWeight = FontWeight.Normal, color = AetherColors.textDim)
private val DetailStyle = MonoStyle.copy(fontSize = 12.sp, lineHeight = 17.sp)
private val DiffStyle = MonoStyle.copy(fontSize = 11.5.sp, lineHeight = 19.55.sp)
private const val DETAIL_MAX_LINES = 60

/** Plain BasicText throughout: nothing is selectable and there is no input surface. */
@Composable
fun ThreadRowItem(row: ThreadRow, onToggle: (String) -> Unit, modifier: Modifier = Modifier) {
    when (row) {
        is ThreadRow.UserBubble -> UserBubbleView(row, modifier)
        is ThreadRow.AssistantText -> AssistantView(row, modifier)
        is ThreadRow.ToolRow -> ToolRowView(row, onToggle, modifier)
        is ThreadRow.DiffBlock -> DiffBlockView(row, modifier)
        is ThreadRow.ThinkingRow -> ThinkingRowView(row, onToggle, modifier)
    }
}

@Composable
private fun UserBubbleView(row: ThreadRow.UserBubble, modifier: Modifier) {
    BoxWithConstraints(modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
        // 84% of the content width (the screen already applies the 16 dp side padding).
        BasicText(
            row.text,
            style = UserStyle,
            modifier = Modifier
                .widthIn(max = maxWidth * 0.84f)
                .clip(BubbleShape)
                .background(UserFill, BubbleShape)
                .border(1.dp, UserBorder, BubbleShape)
                .padding(horizontal = 14.dp, vertical = 11.dp),
        )
    }
}

@Composable
private fun AssistantView(row: ThreadRow.AssistantText, modifier: Modifier) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (b in row.blocks) {
            when (b) {
                is MarkdownLite.Block.Paragraph -> BasicText(annotate(b.spans), style = AssistantStyle)
                is MarkdownLite.Block.CodeFence -> Box(
                    Modifier.fillMaxWidth().aeInset().horizontalScroll(rememberScrollState()).padding(10.dp),
                ) {
                    BasicText(
                        b.code,
                        style = MonoStyle.copy(fontSize = 12.sp, lineHeight = 17.sp, color = AetherColors.text),
                        softWrap = false,
                    )
                }
            }
        }
    }
}

private fun annotate(spans: List<MarkdownLite.Span>): AnnotatedString = buildAnnotatedString {
    for (s in spans) {
        when (s.style) {
            MarkdownLite.Style.PLAIN -> append(s.text)
            MarkdownLite.Style.BOLD -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(s.text) }
            MarkdownLite.Style.CODE -> withStyle(
                SpanStyle(fontFamily = SpaceMono, fontSize = 14.sp, background = CodeBg),
            ) { append(s.text) }
        }
    }
}

@Composable
private fun ToolRowView(row: ThreadRow.ToolRow, onToggle: (String) -> Unit, modifier: Modifier) {
    Column(modifier.fillMaxWidth()) {
        val stateName = when (row.state) {
            ToolState.RUN -> "running"
            ToolState.OK -> "done"
            ToolState.ERR -> "failed"
        }
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 44.dp)
                .clip(ToolShape)
                .border(1.dp, ToolBorder, ToolShape)
                .rowToggle(row.expandable, row.expanded, "${row.tag} ${row.label}, $stateName") { onToggle(row.id) }
                .padding(horizontal = 12.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BasicText(
                row.tag,
                style = MonoStyle.copy(fontWeight = FontWeight.Bold, fontSize = 10.sp, letterSpacing = 1.sp, color = AetherColors.cyan),
            )
            Spacer(Modifier.size(8.dp))
            BasicText(
                row.label,
                style = MonoStyle.copy(fontSize = 12.sp),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (row.sizeText.isNotEmpty()) {
                Spacer(Modifier.size(8.dp))
                BasicText(row.sizeText, style = MonoStyle.copy(fontSize = 10.sp, color = AetherColors.textMuted))
            }
            Spacer(Modifier.size(8.dp))
            StateGlyph(row.state)
        }
        if (row.expanded) {
            DetailPanel(row.detail, showInput = true, emptyText = null)
        }
    }
}

@Composable
private fun ThinkingRowView(row: ThreadRow.ThinkingRow, onToggle: (String) -> Unit, modifier: Modifier) {
    val title = stringResource(R.string.thread_thinking)
    val text = if (row.durationText != null) "$title · ${row.durationText}" else title
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 44.dp)
                .clip(ToolShape)
                .border(1.dp, ToolBorder, ToolShape)
                .rowToggle(row.expandable, row.expanded, text) { onToggle(row.id) }
                .padding(horizontal = 12.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BasicText(text, style = MonoStyle.copy(fontSize = 12.sp, color = AetherColors.textMuted))
        }
        if (row.expanded) {
            DetailPanel(row.detail, showInput = false, emptyText = LABEL_NO_TEXT)
        }
    }
}

/** Button + expanded state when [expandable]; a plain labelled row otherwise. */
private fun Modifier.rowToggle(expandable: Boolean, expanded: Boolean, label: String, onClick: () -> Unit): Modifier =
    if (expandable) {
        this.clickable(role = Role.Button, onClick = onClick)
            .semantics(mergeDescendants = true) {
                contentDescription = label
                stateDescription = if (expanded) "Expanded" else "Collapsed"
            }
    } else {
        this.semantics(mergeDescendants = true) { contentDescription = label }
    }

@Composable
private fun DetailPanel(detail: ThreadDetail?, showInput: Boolean, emptyText: String?) {
    val maxH = with(LocalDensity.current) { (DETAIL_MAX_LINES * DetailStyle.lineHeight.value).sp.toDp() }
    Column(
        Modifier
            .fillMaxWidth()
            .padding(top = 6.dp)
            .aeInset()
            .heightIn(max = maxH)
            .verticalScroll(rememberScrollState())
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        when (detail) {
            null, ThreadDetail.Loading -> Row(verticalAlignment = Alignment.CenterVertically) {
                Spinner()
                Spacer(Modifier.size(8.dp))
                BasicText(stringResource(R.string.thread_detail_loading), style = DetailStyle)
            }
            ThreadDetail.Unavailable -> BasicText(stringResource(R.string.thread_detail_unavailable), style = DetailStyle)
            is ThreadDetail.Ready -> {
                val input = detail.input
                if (showInput && !input.isNullOrEmpty()) {
                    SectionLabel(LABEL_INPUT)
                    BasicText(input, style = DetailStyle)
                    MoreNote(detail.inMore)
                    SectionLabel(LABEL_OUTPUT)
                }
                val out = detail.output
                if (out.isNullOrEmpty()) {
                    BasicText(emptyText ?: stringResource(R.string.thread_detail_unavailable), style = DetailStyle)
                } else {
                    BasicText(out, style = DetailStyle)
                }
                MoreNote(detail.more)
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    BasicText(
        text,
        style = MonoStyle.copy(fontWeight = FontWeight.Bold, fontSize = 10.sp, letterSpacing = 1.sp, color = AetherColors.textLabel),
    )
}

@Composable
private fun MoreNote(n: Int) {
    if (n > 0) {
        BasicText(stringResource(R.string.thread_detail_more, "$n lines"), style = DetailStyle.copy(color = AetherColors.textMuted))
    }
}

@Composable
private fun DiffBlockView(row: ThreadRow.DiffBlock, modifier: Modifier) {
    Column(modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        for (l in row.lines) {
            val bg = if (l.added) DiffAddBg else DiffDelBg
            BasicText(
                (if (l.added) "+ " else "- ") + l.text,
                style = DiffStyle.copy(color = if (l.added) AetherColors.success else AetherColors.textMuted),
                modifier = Modifier.fillMaxWidth().background(bg).padding(horizontal = 12.dp),
            )
        }
        if (row.moreLines > 0) {
            BasicText(
                stringResource(R.string.thread_diff_more, "${row.moreLines} lines"),
                style = DiffStyle.copy(color = AetherColors.textMuted),
                modifier = Modifier.padding(horizontal = 12.dp),
            )
        }
    }
}

/** Decorative: the row's contentDescription carries the state. */
@Composable
private fun StateGlyph(state: ToolState) {
    when (state) {
        ToolState.RUN -> Spinner()
        ToolState.OK -> Canvas(Modifier.size(14.dp).clearAndSetSemantics { }) {
            val w = 1.8.dp.toPx()
            drawLine(AetherColors.success, Offset(size.width * 0.15f, size.height * 0.55f), Offset(size.width * 0.4f, size.height * 0.8f), w, StrokeCap.Round)
            drawLine(AetherColors.success, Offset(size.width * 0.4f, size.height * 0.8f), Offset(size.width * 0.85f, size.height * 0.2f), w, StrokeCap.Round)
        }
        ToolState.ERR -> Canvas(Modifier.size(14.dp).clearAndSetSemantics { }) {
            val w = 1.8.dp.toPx()
            drawLine(AetherColors.dangerSoft, Offset(size.width * 0.2f, size.height * 0.2f), Offset(size.width * 0.8f, size.height * 0.8f), w, StrokeCap.Round)
            drawLine(AetherColors.dangerSoft, Offset(size.width * 0.8f, size.height * 0.2f), Offset(size.width * 0.2f, size.height * 0.8f), w, StrokeCap.Round)
        }
    }
}

/** The one animation in the thread view (spec S5: reduced motion keeps the spinner). */
@Composable
fun Spinner(modifier: Modifier = Modifier) {
    val angle by rememberInfiniteTransition(label = "spin").animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Restart),
        label = "spinAngle",
    )
    Canvas(modifier.size(14.dp).clearAndSetSemantics { }) {
        val w = 1.8.dp.toPx()
        rotate(angle) {
            drawArc(
                AetherColors.cyanCore,
                startAngle = 0f,
                sweepAngle = 270f,
                useCenter = false,
                topLeft = Offset(w / 2, w / 2),
                size = Size(size.width - w, size.height - w),
                style = Stroke(w, cap = StrokeCap.Round),
            )
        }
    }
}
