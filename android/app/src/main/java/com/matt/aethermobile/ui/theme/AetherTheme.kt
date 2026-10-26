package com.matt.aethermobile.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Spacing, radii and sizes from ae_dimens.xml (1 CSS px = 1 dp). */
class AetherDimens(
    val screenPad: Dp = 12.dp,
    val cardPad: Dp = 15.dp,
    val rChip: Dp = 4.dp,
    val rTile: Dp = 9.dp,
    val rRow: Dp = 12.dp,
    val rCard: Dp = 14.dp,
    val rPanel: Dp = 16.dp,
    val rSheet: Dp = 24.dp,
    val headerH: Dp = 60.dp,
    val touchMin: Dp = 44.dp,
    val buttonH: Dp = 48.dp,
    val headerCore: Dp = 40.dp,
    val menuW: Dp = 288.dp,
)

val LocalAetherColors = staticCompositionLocalOf { AetherColors }
val LocalAetherType = staticCompositionLocalOf { AetherType() }
val LocalAetherDimens = staticCompositionLocalOf { AetherDimens() }

object AetherTheme {
    val colors: AetherColors
        @Composable @ReadOnlyComposable get() = LocalAetherColors.current
    val type: AetherType
        @Composable @ReadOnlyComposable get() = LocalAetherType.current
    val dimens: AetherDimens
        @Composable @ReadOnlyComposable get() = LocalAetherDimens.current
}

@Composable
fun AetherTheme(content: @Composable () -> Unit) {
    CompositionLocalProvider(
        LocalAetherColors provides AetherColors,
        LocalAetherType provides AetherType(),
        LocalAetherDimens provides AetherDimens(),
        content = content,
    )
}
