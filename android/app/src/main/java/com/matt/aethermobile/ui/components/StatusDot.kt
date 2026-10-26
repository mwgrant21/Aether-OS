package com.matt.aethermobile.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import com.matt.aethermobile.ui.theme.AetherColors

/** 8dp state dot. Decorative: the row's text carries the state, so it has no semantics. */
@Composable
fun StatusDot(style: DotStyle, modifier: Modifier = Modifier) {
    Canvas(modifier.size(8.dp).clearAndSetSemantics { }) {
        val c = Offset(size.width / 2, size.height / 2)
        val r = size.minDimension / 2
        when (style) {
            DotStyle.LiveGlow -> {
                drawCircle(AetherColors.success.copy(alpha = 0.25f), radius = r * 2f, center = c)
                drawCircle(AetherColors.success, radius = r, center = c)
            }
            DotStyle.HollowRing -> drawCircle(
                AetherColors.textLabel,
                radius = r - 0.75.dp.toPx(),
                center = c,
                style = Stroke(1.5.dp.toPx()),
            )
            DotStyle.Flat -> drawCircle(AetherColors.textMuted, radius = r, center = c)
        }
    }
}
