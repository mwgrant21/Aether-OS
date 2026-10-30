package com.matt.aethermobile.ui.shell

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.matt.aethermobile.R
import com.matt.aethermobile.term.SoftInputGate
import com.matt.aethermobile.ui.theme.AetherColors
import com.matt.aethermobile.ui.theme.AetherDimens

/** Bumped by the header toggle; composers watching it take focus and show the IME. */
class ImeRequest {
    var showTick by mutableIntStateOf(0)
}

val LocalImeRequest = compositionLocalOf { ImeRequest() }
val LocalHardKeyboard = compositionLocalOf { false }
val LocalImeVisible = compositionLocalOf { false }

class KeyboardUi(
    val imeVisible: Boolean,
    val hardKeyboard: Boolean,
    val mode: ImeMode,
    val toggle: () -> Unit,
    val hide: () -> Unit,
    val request: ImeRequest,
)

@Composable
fun rememberKeyboardUi(): KeyboardUi {
    val config = LocalConfiguration.current
    val hard = hardKeyboardPresent(config.keyboard, config.hardKeyboardHidden)
    val imeVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    var modeName by rememberSaveable { mutableStateOf(ImeMode.AUTO.name) }
    val mode = ImeMode.valueOf(modeName)
    val request = remember { ImeRequest() }
    val controller = LocalSoftwareKeyboardController.current
    SideEffect { SoftInputGate.allowed = softImeAllowed(hard, mode) }
    val hide: () -> Unit = { controller?.hide() }
    val toggle: () -> Unit = {
        val next = nextImeMode(imeVisible)
        modeName = next.name
        if (next == ImeMode.USER_HIDDEN) hide() else request.showTick++
    }
    return KeyboardUi(imeVisible, hard, mode, toggle, hide, request)
}

private val KbdFill = Color(10, 32, 43, 153)
private val KbdBorder = Color(70, 180, 215, 71)
private val KbdShape = RoundedCornerShape(12.dp)

/** Same 44dp chrome as the burger; a keyboard glyph, struck through while the IME is hidden. */
@Composable
fun KeyboardToggle(ui: KeyboardUi, modifier: Modifier = Modifier) {
    val desc = stringResource(if (ui.imeVisible) R.string.ime_hide_desc else R.string.ime_show_desc)
    Box(
        modifier
            .size(AetherDimens().touchMin)
            .background(if (ui.imeVisible) AetherColors.activeFill else KbdFill, KbdShape)
            .border(1.dp, if (ui.imeVisible) AetherColors.activeBorder else KbdBorder, KbdShape)
            .clickable(role = Role.Button, onClick = ui.toggle)
            .semantics { contentDescription = desc },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.size(22.dp)) {
            val c = AetherColors.cyanCore
            val sw = 1.5.dp.toPx()
            val bodyH = size.height * 0.64f
            val top = (size.height - bodyH) / 2f
            drawRoundRect(c, Offset(sw / 2, top), Size(size.width - sw, bodyH), CornerRadius(3.dp.toPx()), style = Stroke(sw))
            val r = 1.dp.toPx()
            for (row in 0..1) {
                val y = top + bodyH * (0.33f + 0.34f * row)
                for (i in 0..3) drawCircle(c, r, Offset(size.width * (0.2f + 0.2f * i), y))
            }
            if (!ui.imeVisible) drawLine(c, Offset(size.width * 0.1f, size.height * 0.95f), Offset(size.width * 0.9f, size.height * 0.05f), sw, StrokeCap.Round)
        }
    }
}

/** Takes focus and shows the IME when the header toggle asks for it. */
@Composable
fun ImeShowEffect(focus: FocusRequester) {
    val req = LocalImeRequest.current
    val kb = LocalSoftwareKeyboardController.current
    LaunchedEffect(req.showTick) {
        if (req.showTick > 0) {
            focus.requestFocus()
            kb?.show()
        }
    }
}
