package com.matt.aethermobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.matt.aethermobile.ui.theme.AetherColors
import com.matt.aethermobile.ui.theme.AetherDimens
import com.matt.aethermobile.ui.theme.AetherType

private val AmberBorder = Color(255, 176, 32, 102)
private val AmberFill = Color(255, 176, 32, 15)
private val InfoBorder = Color(70, 180, 215, 77)
private val InfoFill = Color(70, 180, 215, 15)

private val dims = AetherDimens()
private val type = AetherType()
private val NoticeShape = RoundedCornerShape(dims.rRow)
private val AmberBody = type.body.copy(color = AetherColors.warnSoft)
private val InfoBody = type.body.copy(color = AetherColors.textDim)

/** Notice box: amber for warnings, cyan info otherwise. */
@Composable
fun AeNoticeBox(text: String, amber: Boolean, modifier: Modifier = Modifier) {
    val shape = NoticeShape
    val border = if (amber) AmberBorder else InfoBorder
    val fill = if (amber) AmberFill else InfoFill
    val style = if (amber) AmberBody else InfoBody
    Box(modifier.fillMaxWidth().background(fill, shape).border(1.dp, border, shape).padding(12.dp)) {
        BasicText(text, style = style)
    }
}
