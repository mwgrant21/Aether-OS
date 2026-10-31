package com.matt.aethermobile.ui.shell

import android.content.pm.ActivityInfo

/** Auto = no lock. [requested] is what Activity.requestedOrientation takes. */
enum class OrientationMode(val key: String, val requested: Int) {
    AUTO("auto", ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED),
    PORTRAIT("portrait", ActivityInfo.SCREEN_ORIENTATION_PORTRAIT),
    LANDSCAPE("landscape", ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);

    companion object {
        /** null or unknown -> [AUTO]. */
        fun fromKey(key: String?): OrientationMode = entries.firstOrNull { it.key == key } ?: AUTO
    }
}

/** Everything the burger rows read. zoomPx 0 = Fit. Defaults = the shipped defaults. */
data class ViewCtlUi(
    val zoomPx: Int = Zoom.DEFAULT,
    val orientation: OrientationMode = OrientationMode.AUTO,
)

/** Where the view prefs live. null = never stored. */
interface ViewPrefsStore {
    fun getZoom(): Int?
    fun putZoom(px: Int)
    fun getOrientation(): String?
    fun putOrientation(key: String)
}

/** Sanitizing wrapper: only values the host and page accept are written or returned. */
class ViewPrefs(private val store: ViewPrefsStore) {
    fun loadZoom(): Int {
        val stored = try { store.getZoom() } catch (_: Exception) { null }
        return if (stored != null && validZoom(stored)) stored else Zoom.DEFAULT
    }

    fun saveZoom(px: Int) {
        if (!validZoom(px)) return
        try { store.putZoom(px) } catch (_: Exception) { /* best effort */ }
    }

    fun loadOrientation(): OrientationMode =
        OrientationMode.fromKey(try { store.getOrientation() } catch (_: Exception) { null })

    fun saveOrientation(mode: OrientationMode) {
        try { store.putOrientation(mode.key) } catch (_: Exception) { /* best effort */ }
    }

    private fun validZoom(px: Int) = px == 0 || px in Zoom.MIN..Zoom.MAX
}

/** Thread (Compose sp) scale for the shared zoom: 0 (Fit) -> 1f; else px/14f clamped to 0.7f..1.5f. */
fun threadScale(px: Int): Float =
    if (px == 0) 1f else (px / Zoom.DEFAULT.toFloat()).coerceIn(0.7f, 1.5f)
