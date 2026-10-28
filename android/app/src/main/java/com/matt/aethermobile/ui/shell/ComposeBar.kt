package com.matt.aethermobile.ui.shell

import android.os.SystemClock
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.matt.aethermobile.R
import com.matt.aethermobile.term.TerminalHost
import com.matt.aethermobile.ui.components.AeSecondaryButton
import com.matt.aethermobile.ui.theme.AetherColors
import com.matt.aethermobile.ui.theme.AetherType

private val type = AetherType()
private val FieldShape = RoundedCornerShape(10.dp)

/**
 * Multi-line compose field plus Send, nearest the keyboard. The IME Enter key inserts a newline and never sends.
 * Send hands the text to the page via [onCompose] (the page decides bracketed paste) with Enter; the field is
 * cleared only when [shouldClear] says the page got it. [SendGate] drops a double-tap. The field stays editable while Send is disabled.
 * The draft is owned by the caller (ShellScreen), so it outlives this bar being removed on a drop.
 */
@Composable
fun ComposeBar(draft: String, onDraft: (String) -> Unit, sendEnabled: Boolean, onCompose: (String, Boolean) -> TerminalHost.ComposeResult) {
    val focus = remember { FocusRequester() }
    val gate = remember { SendGate() }
    val sendDesc = stringResource(R.string.compose_send_desc)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        Box(
            Modifier
                .weight(1f)
                .heightIn(min = 44.dp)
                .border(1.dp, AetherColors.border, FieldShape)
                .padding(horizontal = 10.dp, vertical = 10.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            BasicTextField(
                value = draft,
                onValueChange = onDraft,
                modifier = Modifier.fillMaxWidth().focusRequester(focus),
                textStyle = type.body.copy(color = AetherColors.textBright),
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
                    if (draft.isEmpty()) {
                        BasicText(stringResource(R.string.compose_hint), style = type.body.copy(color = AetherColors.textMuted))
                    }
                    inner()
                },
            )
        }
        AeSecondaryButton(
            stringResource(R.string.compose_send),
            {
                val r = gate.attempt(SystemClock.elapsedRealtime()) { onCompose(draft, true) }
                if (r != null && shouldClear(r)) onDraft("")
                focus.requestFocus()
            },
            Modifier.width(80.dp).semantics { contentDescription = sendDesc },
            enabled = sendEnabled,
        )
    }
}
