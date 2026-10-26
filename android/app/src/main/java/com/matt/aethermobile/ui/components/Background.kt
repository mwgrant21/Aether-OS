package com.matt.aethermobile.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.matt.aethermobile.ui.theme.AetherColors

private val Scanline = Color(1f, 1f, 1f, 0.018f)

/** Screen backdrop: radial abyss -> deep -> void from the top, with 1px scanlines every 3px over the content. */
@Composable
fun AeScreenBackground(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Box(
        modifier.drawWithContent {
            drawRect(
                Brush.radialGradient(
                    0f to AetherColors.bgAbyss,
                    0.55f to AetherColors.bgDeep,
                    1f to AetherColors.bgVoid,
                    center = Offset(size.width / 2, 0f),
                    radius = maxOf(size.width, size.height),
                ),
            )
            drawContent()
            val step = 3.dp.toPx()
            val line = 1.dp.toPx()
            var y = 0f
            while (y < size.height) {
                drawRect(Scanline, topLeft = Offset(0f, y), size = Size(size.width, line))
                y += step
            }
        },
    ) { content() }
}
