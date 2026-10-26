package com.matt.aethermobile.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.unit.dp
import com.matt.aethermobile.ui.theme.AetherColors

private val Scanline = Color(1f, 1f, 1f, 0.018f)

/**
 * Screen backdrop: `radial-gradient(700px 500px at 50% -10%, abyss 0%, deep 55%, void 100%)` with 1px scanlines
 * every 3px over the content. Compose only has circular radial brushes, so the 700dp circle is squashed to 500dp
 * tall about its own centre. The scanlines are one cached path, rebuilt only when the size changes.
 */
@Composable
fun AeScreenBackground(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Box(
        modifier.drawWithCache {
            val centre = Offset(size.width / 2, -0.10f * size.height)
            val rx = 700.dp.toPx()
            val ry = 500.dp.toPx()
            val brush = Brush.radialGradient(
                0f to AetherColors.bgAbyss,
                0.55f to AetherColors.bgDeep,
                1f to AetherColors.bgVoid,
                center = centre,
                radius = rx,
            )
            // Over-covers the screen in the pre-scale space; clipRect trims it to the screen.
            val reach = 2f * maxOf(size.width, size.height)
            val cover = Rect(centre.x - reach, centre.y - reach, centre.x + reach, centre.y + reach)
            val step = 3.dp.toPx()
            val line = 1.dp.toPx()
            val lines = Path()
            var y = 0f
            while (y < size.height) {
                lines.addRect(Rect(0f, y, size.width, y + line))
                y += step
            }
            onDrawWithContent {
                clipRect {
                    withTransform({ scale(1f, ry / rx, pivot = centre) }) {
                        drawRect(brush, topLeft = cover.topLeft, size = cover.size)
                    }
                }
                drawContent()
                drawPath(lines, Scanline)
            }
        },
    ) { content() }
}
