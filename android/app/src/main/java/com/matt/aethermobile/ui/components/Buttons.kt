package com.matt.aethermobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.matt.aethermobile.ui.theme.AetherColors
import com.matt.aethermobile.ui.theme.AetherDimens
import com.matt.aethermobile.ui.theme.Rajdhani

private val dims = AetherDimens()
private val ButtonShape = RoundedCornerShape(10.dp)
private const val DISABLED_ALPHA = 0.45f

private fun buttonText(color: Color) = TextStyle(
    fontFamily = Rajdhani,
    fontWeight = FontWeight.Bold,
    fontSize = 14.sp,
    letterSpacing = 2.sp,
    color = color,
    textAlign = TextAlign.Center,
)

/**
 * Every button keeps at least the 44dp touch target (touchMin) on both axes. The guard leads the chain in the
 * composables ([touchGuard], before the caller's modifier) so a caller's size modifier cannot undercut it.
 */
private fun Modifier.touchGuard(): Modifier = sizeIn(minWidth = dims.touchMin, minHeight = dims.touchMin)

private fun Modifier.buttonBase(enabled: Boolean, onClick: () -> Unit): Modifier =
    height(dims.buttonH)
        .alpha(if (enabled) 1f else DISABLED_ALPHA)
        .clip(ButtonShape)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick)

@Composable
fun AePrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Box(
        Modifier
            .touchGuard()
            .then(modifier)
            .fillMaxWidth()
            .buttonBase(enabled, onClick)
            .background(Brush.horizontalGradient(listOf(AetherColors.cyanCore, AetherColors.cyanDeep)), ButtonShape)
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) { BasicText(text, style = buttonText(AetherColors.cyanInk)) }
}

@Composable
fun AeSecondaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Box(
        Modifier
            .touchGuard()
            .then(modifier)
            .fillMaxWidth()
            .buttonBase(enabled, onClick)
            .border(1.dp, AetherColors.activeBorder, ButtonShape)
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) { BasicText(text, style = buttonText(AetherColors.cyanBright)) }
}
