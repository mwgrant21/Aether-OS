package com.matt.aethermobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.matt.aethermobile.ui.theme.AetherColors
import com.matt.aethermobile.ui.theme.AetherDimens

private val dims = AetherDimens()

private fun Modifier.surface(r: Dp, top: Color, bottom: Color, border: Color): Modifier {
    val shape = RoundedCornerShape(r)
    return this
        .clip(shape)
        .background(Brush.verticalGradient(listOf(top, bottom)), shape)
        .border(1.dp, border, shape)
}

/** Main card: r16 panel gradient + border. */
fun Modifier.aePanel(): Modifier =
    surface(dims.rPanel, AetherColors.panelTop, AetherColors.panelBottom, AetherColors.border)

/** List row: r12 soft panel. */
fun Modifier.aeSoftRow(): Modifier =
    surface(dims.rRow, AetherColors.panelSoftTop, AetherColors.panelSoftBottom, AetherColors.border)

/** Inset tile: r9. */
fun Modifier.aeInset(): Modifier =
    surface(dims.rTile, AetherColors.insetTop, AetherColors.insetBottom, AetherColors.border)

/** Selected/active row: r12 cyan fill + active border. */
fun Modifier.aeActive(): Modifier {
    val shape = RoundedCornerShape(dims.rRow)
    return then(
        Modifier.clip(shape).background(AetherColors.activeFill, shape).border(1.dp, AetherColors.activeBorder, shape),
    )
}

/** Dropdown / sheet: glow border, cyan glow and deep drop shadow. */
fun Modifier.aeSheet(shape: RoundedCornerShape = RoundedCornerShape(dims.rSheet)): Modifier =
    then(
        Modifier
            .shadow(24.dp, shape, ambientColor = Color(60, 180, 220, 56), spotColor = Color.Black.copy(alpha = 0.6f))
            .clip(shape)
            .background(Brush.verticalGradient(listOf(AetherColors.panelTop, AetherColors.panelBottom)), shape)
            .border(1.dp, AetherColors.borderGlow, shape),
    )
