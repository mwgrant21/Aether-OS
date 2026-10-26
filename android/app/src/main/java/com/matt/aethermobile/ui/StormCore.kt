package com.matt.aethermobile.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import com.matt.aethermobile.ui.theme.AetherColors

enum class StormMode(val level: Int) { Idle(0), Nominal(1), Surge(2), Breach(3) }

/** Stub with the final signature (T3 replaces the body): flat ring + dot, mode ignored. */
@Composable
fun StormCore(
    sizeDp: Dp,
    mode: StormMode,
    modifier: Modifier = Modifier,
    onDischarge: (() -> Unit)? = null,
) {
    Canvas(modifier.size(sizeDp)) {
        val c = Offset(size.width / 2, size.height / 2)
        val r = size.minDimension * 0.44f
        drawCircle(AetherColors.cyanCore, radius = r, center = c, style = Stroke(width = size.minDimension * 0.09f))
        drawCircle(AetherColors.cyanCore, radius = size.minDimension * 0.16f, center = c)
    }
}
