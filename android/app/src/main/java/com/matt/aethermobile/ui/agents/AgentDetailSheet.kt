package com.matt.aethermobile.ui.agents

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.matt.aethermobile.R
import com.matt.aethermobile.agents.RunningRowUi
import com.matt.aethermobile.agents.agentElapsed
import com.matt.aethermobile.ui.components.aeSheet
import com.matt.aethermobile.ui.theme.AetherColors
import java.util.Locale

private val SheetShape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)

@Composable
internal fun Scrim(onDismiss: () -> Unit) {
    val dismiss = stringResource(R.string.agents_sheet_dismiss)
    Box(
        Modifier.fillMaxSize().background(Color(2, 10, 16, 166))
            .semantics { contentDescription = dismiss; role = Role.Button }
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onDismiss),
    )
}

/**
 * Detail of one running agent: avatar, type, model badge, headline, live elapsed, then the PROMPT in pre-wrap (plain
 * text, newlines and spaces kept). Read-only: no actions of any kind, including for a needs-input agent.
 */
@Composable
fun AgentDetailSheet(r: RunningRowUi, now: State<Long>) {
    val label = stringResource(R.string.agents_sheet_label)
    Column(
        Modifier.fillMaxWidth().fillMaxHeight(0.8f).aeSheet(SheetShape)
            .semantics { contentDescription = label }
            // Swallow taps so a press inside the sheet never reaches the scrim.
            .pointerInput(Unit) { detectTapGestures { } }
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Box(Modifier.fillMaxWidth().height(18.dp), contentAlignment = Alignment.Center) {
            Box(Modifier.width(40.dp).height(4.dp).background(Color(126, 240, 255, 89), RoundedCornerShape(2.dp)))
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Avatar(r.type, 48)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        BasicText(r.type, Modifier.weight(1f, fill = false), style = type.title.copy(color = AetherColors.textBright))
                        if (r.modelBadge != null) ModelBadge(r.modelBadge)
                    }
                    SheetElapsed(r.startedAtMs, now)
                }
            }
            BasicText(r.headline, style = type.body.copy(color = AetherColors.text, fontSize = 17.sp))
            BasicText(
                stringResource(R.string.agents_sheet_prompt).uppercase(Locale.US),
                style = type.label.copy(color = AetherColors.textMuted),
            )
            // BasicText renders newlines and runs of spaces as given, which is the pre-wrap the desktop uses.
            BasicText(
                r.prompt ?: stringResource(R.string.agents_prompt_empty),
                style = type.meta.copy(
                    color = if (r.prompt == null) AetherColors.textMuted else AetherColors.text,
                    fontSize = 13.sp,
                ),
            )
        }
    }
}

@Composable
private fun SheetElapsed(startedAtMs: Long, now: State<Long>) {
    BasicText(
        stringResource(R.string.agents_sheet_elapsed, agentElapsed(startedAtMs, now.value, TITAN_CLOCK_OFFSET_MS)),
        style = type.data.copy(color = AetherColors.cyanBright),
    )
}

@Composable
private fun ModelBadge(text: String) {
    BasicText(
        text,
        Modifier.border(1.dp, AetherColors.textDim, RoundedCornerShape(4.dp)).padding(horizontal = 8.dp, vertical = 4.dp),
        style = type.label.copy(color = AetherColors.textDim, fontSize = 11.sp, letterSpacing = 1.sp),
        maxLines = 1,
    )
}
