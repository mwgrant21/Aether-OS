package com.matt.aethermobile.ui.theme

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.matt.aethermobile.R

val Rajdhani = FontFamily(
    Font(R.font.rajdhani_medium, FontWeight.Medium),
    Font(R.font.rajdhani_semibold, FontWeight.SemiBold),
    Font(R.font.rajdhani_bold, FontWeight.Bold),
)

val SpaceMono = FontFamily(
    Font(R.font.space_mono_regular, FontWeight.Normal),
    Font(R.font.space_mono_bold, FontWeight.Bold),
)

/** Type scale from ae_dimens.xml: Rajdhani = display/UI, Space Mono = data. */
class AetherType(
    val title: TextStyle = TextStyle(fontFamily = Rajdhani, fontWeight = FontWeight.Bold, fontSize = 18.sp, letterSpacing = 1.sp),
    val label: TextStyle = TextStyle(fontFamily = Rajdhani, fontWeight = FontWeight.SemiBold, fontSize = 12.sp, letterSpacing = 3.sp),
    val body: TextStyle = TextStyle(fontFamily = Rajdhani, fontWeight = FontWeight.Medium, fontSize = 15.sp),
    val data: TextStyle = TextStyle(fontFamily = SpaceMono, fontWeight = FontWeight.Bold, fontSize = 13.sp),
    val meta: TextStyle = TextStyle(fontFamily = SpaceMono, fontWeight = FontWeight.Normal, fontSize = 11.sp),
    val hero: TextStyle = TextStyle(fontFamily = SpaceMono, fontWeight = FontWeight.Bold, fontSize = 34.sp),
)
