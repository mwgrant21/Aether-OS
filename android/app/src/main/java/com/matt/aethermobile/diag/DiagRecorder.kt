package com.matt.aethermobile.diag

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Input diagnostic core (pure JVM). Redaction is by TYPE: no event below has a String field, so
 * typed text, key characters, tokens or the tailnet address cannot enter the log. The only free
 * text in a dump is the header the caller passes to [DiagRecorder.dump].
 */
sealed interface DiagEvent {
    data class Ptr(val toolType: Int, val x: Int, val y: Int)

    data class Motion(
        val source: Int,
        val action: Int,
        val buttonState: Int,
        val vScroll: Float,
        val hScroll: Float,
        val pointers: List<Ptr>,
    ) : DiagEvent

    data class Layout(
        val orientation: Int,
        val keyboard: Int,
        val hardKeyboardHidden: Int,
        val imeVisible: Boolean,
        val imeHeightPx: Int,
        val widthPx: Int,
        val heightPx: Int,
    ) : DiagEvent

    data class Page(
        val kind: PageKind,
        val action: PageAction,
        val pointer: PagePointer,
        val button: Int,
        val buttons: Int,
        val dx: Int,
        val dy: Int,
        val mode: Int,
        val x: Int,
        val y: Int,
        val touches: Int,
    ) : DiagEvent
}

enum class PageKind { POINTER, TOUCH, WHEEL }
enum class PageAction { DOWN, MOVE, UP, CANCEL, WHEEL }
enum class PagePointer { MOUSE, TOUCH, PEN, NONE }

/** Bounded line buffer: drops the oldest line when full and counts what it dropped. */
class DiagRing(val cap: Int = 500) {
    private val lines = ArrayDeque<String>()
    var dropped = 0
        private set

    @Synchronized
    fun add(line: String) {
        if (lines.size >= cap) {
            lines.removeFirst()
            dropped++
        }
        lines.addLast(line)
    }

    @Synchronized
    fun snapshot(): List<String> = lines.toList()

    @Synchronized
    fun clear() {
        lines.clear()
        dropped = 0
    }
}

class DiagRecorder(private val clockMs: () -> Long, val ring: DiagRing = DiagRing()) {
    @Volatile
    var enabled = false

    private var baseMs = clockMs()
    private var lastMotionKey: List<Int>? = null
    private var lastMotionAt = 0L
    private var coalesced = 0
    private var lastLayout: DiagEvent.Layout? = null

    /** Empties the ring and restarts the relative clock; used when the diagnostic is switched on. */
    @Synchronized
    fun clear() {
        ring.clear()
        baseMs = clockMs()
        lastMotionKey = null
        coalesced = 0
        lastLayout = null
    }

    @Synchronized
    fun record(e: DiagEvent) {
        if (!enabled) return
        val now = clockMs()
        when (e) {
            is DiagEvent.Motion -> {
                val key = listOf(e.source, e.action, e.pointers.firstOrNull()?.toolType ?: -1, e.buttonState)
                val isMove = e.action == ACT_MOVE || e.action == ACT_HOVER_MOVE
                if (isMove && key == lastMotionKey && now - lastMotionAt < COALESCE_MS) {
                    coalesced++
                    return
                }
                emit(now, motionLine(e))
                lastMotionKey = key
                lastMotionAt = now
            }
            is DiagEvent.Layout -> {
                if (e == lastLayout) return
                lastLayout = e
                emit(now, layoutLine(e))
            }
            is DiagEvent.Page -> emit(now, pageLine(e))
        }
    }

    private fun emit(now: Long, body: String) {
        if (coalesced > 0) {
            ring.add("# coalesced $coalesced moves")
            coalesced = 0
        }
        val t = (now - baseMs).coerceAtLeast(0)
        ring.add("+${t / 1000}.${(t % 1000).toString().padStart(3, '0')} $body")
    }

    fun dump(header: List<String>): String {
        val sb = StringBuilder()
        header.forEach { sb.append(it).append('\n') }
        if (ring.dropped > 0) sb.append("# dropped=").append(ring.dropped).append('\n')
        ring.snapshot().forEach { sb.append(it).append('\n') }
        return sb.toString()
    }

    companion object {
        const val COALESCE_MS = 40L
        const val ACT_MOVE = 2
        const val ACT_HOVER_MOVE = 7
    }
}

internal fun sourceName(s: Int): String = when (s) {
    0x1002 -> "0x1002(TOUCHSCREEN)"
    0x2002 -> "0x2002(MOUSE)"
    0x4002 -> "0x4002(STYLUS)"
    else -> "0x" + Integer.toHexString(s)
}

internal fun actionName(a: Int): String = when (a) {
    0 -> "DOWN"
    1 -> "UP"
    2 -> "MOVE"
    3 -> "CANCEL"
    4 -> "OUTSIDE"
    5 -> "POINTER_DOWN"
    6 -> "POINTER_UP"
    7 -> "HOVER_MOVE"
    8 -> "SCROLL"
    9 -> "HOVER_ENTER"
    10 -> "HOVER_EXIT"
    else -> "ACT$a"
}

internal fun toolName(t: Int): String = when (t) {
    0 -> "UNKNOWN"
    1 -> "FINGER"
    2 -> "STYLUS"
    3 -> "MOUSE"
    4 -> "ERASER"
    else -> "TOOL$t"
}

private fun motionLine(e: DiagEvent.Motion): String {
    val sb = StringBuilder("M src=${sourceName(e.source)} act=${actionName(e.action)} btn=${e.buttonState} vs=${e.vScroll} hs=${e.hScroll}")
    e.pointers.forEachIndexed { i, p -> sb.append(" p$i=${toolName(p.toolType)}@${p.x},${p.y}") }
    return sb.toString()
}

private fun layoutLine(e: DiagEvent.Layout): String =
    "L orient=${e.orientation} kb=${e.keyboard} hkh=${e.hardKeyboardHidden} ime=${if (e.imeVisible) "yes" else "no"}/${e.imeHeightPx} win=${e.widthPx}x${e.heightPx}"

private fun pageLine(e: DiagEvent.Page): String =
    "P kind=${e.kind} act=${e.action} pt=${e.pointer} b=${e.button} bs=${e.buttons} dx=${e.dx} dy=${e.dy} dm=${e.mode} xy=${e.x},${e.y} n=${e.touches}"

private val FILE_STAMP = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss")

fun diagFileName(epochMs: Long, zone: ZoneId): String =
    "aether-input-diag-" + FILE_STAMP.format(Instant.ofEpochMilli(epochMs).atZone(zone)) + ".txt"

sealed interface SaveResult {
    data class Downloads(val name: String) : SaveResult
    data class AppDir(val name: String, val path: String) : SaveResult
    data object Failed : SaveResult
}

fun saveToastText(r: SaveResult): String = when (r) {
    is SaveResult.Downloads -> "Saved ${r.name} to Downloads"
    is SaveResult.AppDir -> "Saved ${r.name} to ${r.path} (Downloads unavailable)"
    SaveResult.Failed -> "Could not save log"
}
