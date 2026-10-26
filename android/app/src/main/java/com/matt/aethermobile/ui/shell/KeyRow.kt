package com.matt.aethermobile.ui.shell

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.matt.aethermobile.R
import com.matt.aethermobile.term.InputSender
import com.matt.aethermobile.ui.components.AeNoticeBox
import com.matt.aethermobile.ui.components.AeSecondaryButton
import com.matt.aethermobile.ui.components.aeActive

/** Native key row: sends through the same gated host path as page input. Only composed while connected. */
@Composable
fun KeyRow(enabled: Boolean, ctrlOn: Boolean, actions: ShellActions) {
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            for (k in KEY_ORDER) {
                val label = stringResource(labelRes(k))
                val desc = descRes(k)?.let { stringResource(it) }
                val latched = k == Key.CTRL && ctrlOn
                val ctrlDesc = if (latched) stringResource(R.string.key_ctrl_on_desc) else desc
                val mod = Modifier.width(56.dp).let { if (latched) it.aeActive() else it }
                    .let { if (ctrlDesc != null) it.semantics { contentDescription = ctrlDesc } else it }
                Box(mod) {
                    AeSecondaryButton(
                        label,
                        { if (k == Key.CTRL) actions.onCtrlToggle() else actions.onKey(k.bytes) },
                        enabled = enabled,
                    )
                }
            }
        }
    }
}

/**
 * Amber "N chars not sent" line. Composed by the activity above every screen (locked, error, connected), so a
 * drop that tears the key row down still shows it. Tap to dismiss.
 */
@Composable
fun NotSentLine(notice: NotSentNotice, onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    if (!notice.visible) return
    val count = pluralStringResource(R.plurals.not_sent_chars, notice.chars, notice.chars)
    val why = when (notice.refusal) {
        InputSender.Refusal.TOO_LARGE -> stringResource(R.string.not_sent_too_large)
        InputSender.Refusal.LONE_SURROGATE -> stringResource(R.string.not_sent_bad_text)
        InputSender.Refusal.NOT_RUNNING -> stringResource(R.string.not_sent_not_running)
        InputSender.Refusal.TYPING_OFF -> stringResource(R.string.not_sent_typing_off)
        null -> null
    }
    AeNoticeBox(
        if (why == null) count else "$count. $why",
        amber = true,
        modifier = modifier.padding(horizontal = 12.dp, vertical = 4.dp).clickable(onClick = onDismiss),
    )
}

private fun labelRes(k: Key): Int = when (k) {
    Key.ESC -> R.string.key_esc
    Key.TAB -> R.string.key_tab
    Key.CTRL -> R.string.key_ctrl
    Key.UP -> R.string.key_up
    Key.DOWN -> R.string.key_down
    Key.LEFT -> R.string.key_left
    Key.RIGHT -> R.string.key_right
    Key.PIPE -> R.string.key_pipe
    Key.SLASH -> R.string.key_slash
    Key.DASH -> R.string.key_dash
    Key.Y -> R.string.key_y
    Key.N -> R.string.key_n
}

private fun descRes(k: Key): Int? = when (k) {
    Key.UP -> R.string.key_up_desc
    Key.DOWN -> R.string.key_down_desc
    Key.LEFT -> R.string.key_left_desc
    Key.RIGHT -> R.string.key_right_desc
    else -> null
}
