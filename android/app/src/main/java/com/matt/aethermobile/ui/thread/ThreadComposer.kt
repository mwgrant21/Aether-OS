package com.matt.aethermobile.ui.thread

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.matt.aethermobile.R
import com.matt.aethermobile.ui.theme.AetherColors
import com.matt.aethermobile.ui.theme.AetherType

private val PillShape = RoundedCornerShape(22.dp)
private val HintStyle = AetherType().body.copy(fontWeight = FontWeight.Medium, fontSize = 16.sp, color = AetherColors.textMuted)

/** Package pill composer, display-only: no text field, no click or focus handling, so it cannot raise the keyboard. */
@Composable
fun DisabledComposer() {
    val desc = stringResource(R.string.thread_composer_disabled_desc)
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .shadow(8.dp, PillShape, ambientColor = Color(60, 180, 220, 56), spotColor = Color(60, 180, 220, 56))
            .background(Brush.verticalGradient(listOf(AetherColors.insetTop, AetherColors.insetBottom)), PillShape)
            .border(BorderStroke(1.dp, AetherColors.borderGlow), PillShape)
            .heightIn(min = 44.dp)
            .semantics { contentDescription = desc; disabled() }
            .padding(start = 16.dp, end = 12.dp, top = 10.dp, bottom = 10.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BasicText(stringResource(R.string.thread_composer_hint), style = HintStyle)
        Box(Modifier.size(36.dp).background(AetherColors.cyanCore.copy(alpha = 0.45f), CircleShape), contentAlignment = Alignment.Center) {
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
