package com.matt.aethermobile.ui.shell

import android.content.ContentValues
import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.MediaStore
import android.view.MotionEvent
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.matt.aethermobile.BuildConfig
import com.matt.aethermobile.R
import com.matt.aethermobile.diag.DiagEvent
import com.matt.aethermobile.diag.DiagRecorder
import com.matt.aethermobile.diag.SaveResult
import com.matt.aethermobile.diag.diagFileName
import com.matt.aethermobile.diag.saveToastText
import com.matt.aethermobile.ui.components.AeSecondaryButton
import com.matt.aethermobile.ui.theme.AetherColors
import com.matt.aethermobile.ui.theme.AetherDimens
import com.matt.aethermobile.ui.theme.AetherType
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val dims = AetherDimens()
private val type = AetherType()

/** Process-lifetime input diagnostic. Never persisted: every app start is OFF. */
object InputDiag {
    val recorder = DiagRecorder(SystemClock::elapsedRealtime)
    private var startedAtMs = 0L

    var on by mutableStateOf(false)
        private set

    /** Set by T4b to forward the switch to the page; unused until then. */
    var onChanged: ((Boolean) -> Unit)? = null

    fun switchOn(value: Boolean) {
        if (value == on) return
        on = value
        if (value) {
            recorder.clear()
            startedAtMs = System.currentTimeMillis()
        }
        recorder.enabled = value
        onChanged?.invoke(value)
    }

    /** Header lines come only from this whitelist: version, device model, SDK, start time, debuggable. Never TITAN_IP. */
    fun header(context: Context): List<String> {
        val debuggable = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        val started = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss")
            .format(Instant.ofEpochMilli(startedAtMs).atZone(ZoneId.systemDefault()))
        return listOf(
            "Aether input diagnostic",
            "app ${BuildConfig.VERSION_NAME}",
            "device ${Build.MANUFACTURER} ${Build.MODEL}",
            "sdk ${Build.VERSION.SDK_INT}",
            "started $started",
            "debuggable ${if (debuggable) "yes" else "no"}",
        ).map { line -> line.filter { it.isLetterOrDigit() && it.code < 128 || it in " _=.,:+#()/@<>-" } }
    }
}

fun MotionEvent.toDiag(): DiagEvent.Motion = DiagEvent.Motion(
    source = source,
    action = actionMasked,
    buttonState = buttonState,
    vScroll = getAxisValue(MotionEvent.AXIS_VSCROLL),
    hScroll = getAxisValue(MotionEvent.AXIS_HSCROLL),
    pointers = List(pointerCount) { DiagEvent.Ptr(getToolType(it), getX(it).toInt(), getY(it).toInt()) },
)

/** Writes to Downloads via MediaStore; falls back to the app's external files dir. Call off the main thread. */
fun saveLog(context: Context, text: String, nowMs: Long): SaveResult {
    val name = diagFileName(nowMs, ZoneId.systemDefault())
    val bytes = text.toByteArray(Charsets.UTF_8)
    try {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, "text/plain")
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("insert returned null")
        resolver.openOutputStream(uri)!!.use { it.write(bytes) }
        resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        return SaveResult.Downloads(name)
    } catch (_: Exception) {
        // fall through to the app directory
    }
    return try {
        val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: return SaveResult.Failed
        dir.mkdirs()
        val f = File(dir, name)
        f.writeBytes(bytes)
        SaveResult.AppDir(name, f.absolutePath)
    } catch (_: Exception) {
        SaveResult.Failed
    }
}

private fun saveAsync(context: Context) {
    val app = context.applicationContext
    val text = InputDiag.recorder.dump(InputDiag.header(app))
    Thread {
        val result = saveLog(app, text, System.currentTimeMillis())
        Handler(Looper.getMainLooper()).post {
            Toast.makeText(app, saveToastText(result), Toast.LENGTH_LONG).show()
        }
    }.start()
}

@Composable
fun InputDiagLayoutProbe() {
    val cfg = LocalConfiguration.current
    val imePx = WindowInsets.ime.getBottom(LocalDensity.current)
    val size = LocalWindowInfo.current.containerSize
    LaunchedEffect(cfg.orientation, cfg.keyboard, cfg.hardKeyboardHidden, imePx, size.width, size.height, InputDiag.on) {
        if (InputDiag.on) {
            InputDiag.recorder.record(
                DiagEvent.Layout(cfg.orientation, cfg.keyboard, cfg.hardKeyboardHidden, imePx > 0, imePx, size.width, size.height),
            )
        }
    }
}

@Composable
fun InputDiagRow(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val on = InputDiag.on
    val desc = stringResource(if (on) R.string.diag_on_desc else R.string.diag_off_desc)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = dims.touchMin)
                .toggleable(value = on, role = Role.Switch, onValueChange = { InputDiag.switchOn(it) })
                .semantics { contentDescription = desc }
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Column(Modifier.weight(1f)) {
                BasicText(stringResource(R.string.diag_row_label), style = type.body.copy(color = AetherColors.textBright))
                BasicText(stringResource(R.string.diag_row_hint), style = type.meta.copy(color = AetherColors.textMuted))
            }
            ShareSwitch(on)
        }
        AeSecondaryButton(stringResource(R.string.diag_save), { saveAsync(context) }, Modifier.fillMaxWidth())
    }
}
