package com.matt.aethermobile.ui.thread

import android.os.SystemClock
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.matt.aethermobile.R
import com.matt.aethermobile.term.TerminalHost
import com.matt.aethermobile.ui.shell.ImeShowEffect
import com.matt.aethermobile.ui.shell.LocalHardKeyboard
import com.matt.aethermobile.ui.shell.LocalImeVisible
import com.matt.aethermobile.ui.shell.SendGate
import com.matt.aethermobile.ui.shell.refocusAfterSend
import com.matt.aethermobile.ui.shell.shouldClear
import com.matt.aethermobile.ui.theme.AetherColors
import com.matt.aethermobile.ui.theme.AetherDimens
import com.matt.aethermobile.ui.theme.AetherType

private val PillShape = RoundedCornerShape(22.dp)
private val HintStyle = AetherType().body.copy(fontWeight = FontWeight.Medium, fontSize = 16.sp, color = AetherColors.textMuted)

/**
 * Package pill composer for the claude Thread: a multi-line field plus a Send badge. The IME Enter key inserts a
 * newline and never sends. Send hands the draft to the page via [onCompose] with Enter (the page decides bracketed
 * paste) and clears it only when [shouldClear] says the page got it; [SendGate] drops a double-tap. The field stays
 * editable while [sendEnabled] is false. The draft is owned by the caller so it is shared with the Raw bar.
 */
@Composable
fun ThreadComposer(draft: String, onDraft: (String) -> Unit, sendEnabled: Boolean, onCompose: (String, Boolean) -> TerminalHost.ComposeResult) {
    val focus = remember { FocusRequester() }
    ImeShowEffect(focus)
    val refocus = refocusAfterSend(LocalHardKeyboard.current, LocalImeVisible.current)
    val gate = remember { SendGate() }
    val sendDesc = stringResource(R.string.compose_send_desc)
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .shadow(8.dp, PillShape, ambientColor = Color(60, 180, 220, 56), spotColor = Color(60, 180, 220, 56))
            .background(Brush.verticalGradient(listOf(AetherColors.insetTop, AetherColors.insetBottom)), PillShape)
            .border(BorderStroke(1.dp, AetherColors.borderGlow), PillShape)
            .heightIn(min = 44.dp)
            .padding(start = 16.dp, end = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.weight(1f).padding(vertical = 10.dp), contentAlignment = Alignment.CenterStart) {
            BasicTextField(
                value = draft,
                onValueChange = onDraft,
                modifier = Modifier.fillMaxWidth().focusRequester(focus),
                textStyle = HintStyle.copy(color = AetherColors.textBright),
                cursorBrush = SolidColor(AetherColors.cyanCore),
                minLines = 1,
                maxLines = 4,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = KeyboardType.Text,
                    imeAction = ImeAction.Default,
                ),
                decorationBox = { inner ->
                    if (draft.isEmpty()) BasicText(stringResource(R.string.thread_composer_hint), style = HintStyle)
                    inner()
                },
            )
        }
        val touch = AetherDimens().touchMin
        Box(
            Modifier
                .sizeIn(minWidth = touch, minHeight = touch)
                .semantics { contentDescription = sendDesc; role = Role.Button }
                .clickable(enabled = sendEnabled) {
                    val r = gate.attempt(SystemClock.elapsedRealtime()) { onCompose(draft, true) }
                    if (r != null && shouldClear(r)) onDraft("")
                    if (refocus) focus.requestFocus()
                },
            contentAlignment = Alignment.Center,
        ) {
            Box(Modifier.size(36.dp).background(AetherColors.cyanCore.copy(alpha = if (sendEnabled) 1f else 0.45f), CircleShape), contentAlignment = Alignment.Center) {
                Canvas(Modifier.size(16.dp)) {
                    val w = 2.dp.toPx()
                    val c = size.width / 2
                    drawLine(AetherColors.cyanInk, Offset(c, size.height), Offset(c, 1f), w, StrokeCap.Round)
                    drawLine(AetherColors.cyanInk, Offset(c, 1f), Offset(1f, c), w, StrokeCap.Round)
                    drawLine(AetherColors.cyanInk, Offset(c, 1f), Offset(size.width - 1f, c), w, StrokeCap.Round)
                }
            }
        }
    }
}
