package com.matt.aethermobile.ui

import android.content.Context
import android.provider.Settings
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.random.Random

enum class StormMode(val level: Int) { Idle(0), Nominal(1), Surge(2), Breach(3) }

/**
 * Compose Canvas port of design/storm-core.js. The only frame source is `withFrameNanos` inside
 * `repeatOnLifecycle(RESUMED)`, so nothing is scheduled while the host is paused or the composable
 * has left the composition. Reduced motion (animator scale 0): rotations and lightning freeze, the
 * core pulse keeps breathing at half speed.
 */
@Composable
fun StormCore(
    sizeDp: Dp,
    mode: StormMode,
    modifier: Modifier = Modifier,
    onDischarge: (() -> Unit)? = null,
    hitDp: Dp = sizeDp,
) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val st = remember { StormState() }
    val modeNow by rememberUpdatedState(mode.level)
    val sizeNow by rememberUpdatedState(sizeDp.value)
    val dischargeNow by rememberUpdatedState(onDischarge)

    LaunchedEffect(owner, st) {
        owner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            st.reduced = animationsDisabled(context)
            var last = -1L
            while (true) {
                androidx.compose.runtime.withFrameNanos { nanos ->
                    val dtMs = if (last < 0) 16f else ((nanos - last) / 1_000_000f).coerceIn(0f, 1000f)
                    last = nanos
                    st.advance(dtMs, modeNow, sizeNow)
                }
            }
        }
    }

    // The Box is the tap target (at least hitDp); the Canvas stays sizeDp, centred.
    // Default hitDp = sizeDp is the old layout.
    Box(
        modifier.size(maxOf(hitDp, sizeDp)).pointerInput(Unit) {
            detectTapGestures {
                st.strike()
                dischargeNow?.invoke()
            }
        },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.size(sizeDp)) {
            st.tick // read so each frame invalidates only this draw
            drawStorm(st, modeNow, sizeNow)
        }
    }
}

private fun animationsDisabled(context: Context): Boolean =
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f

private class StormState {
    val random = Random.Default
    val puffs = StormCoreMath.seedPuffs(random)
    val bolts = ArrayList<Bolt>()
    var reduced = false
    var elapsedMs = 0.0
    var motionMs = 0.0
    var breathPhase = 0.0
    var swirlPhase = 0.0
    var strikesLeft = 0
    var nextStrikeAt = 0.0
    var tick by mutableLongStateOf(0L)

    val mainPath = Path()
    val branchPath = Path()
    val spherePath = Path().apply { addOval(Rect(Offset(StormGeo.C, StormGeo.C), StormGeo.R)) }
    val puffPath = Path().apply { addOval(Rect(Offset(StormGeo.C, StormGeo.C), StormGeo.R * 0.99f)) }

    fun strike() {
        strikesLeft = 6
        nextStrikeAt = elapsedMs
    }

    fun advance(dtMs: Float, mode: Int, sizeDp: Float) {
        elapsedMs += dtMs
        val pulseSec = StormCoreMath.pulseSecFor(mode)
        breathPhase = StormCoreMath.advancePhase(breathPhase, if (reduced) dtMs * 0.5 else dtMs.toDouble(), pulseSec)
        if (!reduced) {
            motionMs += dtMs
            swirlPhase = StormCoreMath.advancePhase(swirlPhase, dtMs.toDouble(), pulseSec * 4f)
            val step = StormCoreMath.stepFor(dtMs)
            val cap = StormCoreMath.maxBolts(sizeDp)
            if (bolts.size < cap && StormCoreMath.shouldSpawn(random, mode, step)) {
                bolts.add(StormCoreMath.spawnBolt(random, BoltKind.Storm, StormCoreMath.powerFor(mode)))
            }
            while (strikesLeft > 0 && elapsedMs >= nextStrikeAt) {
                val p = StormCoreMath.powerFor(mode) * 1.6f
                if (bolts.size < cap) bolts.add(StormCoreMath.spawnBolt(random, BoltKind.Surface, p))
                if (bolts.size < cap) bolts.add(StormCoreMath.spawnBolt(random, BoltKind.Ring, p))
                strikesLeft--
                nextStrikeAt += 50.0
            }
            for (b in bolts) {
                b.life -= 0.075f * step
                b.flicker = 0.5f + random.nextFloat() * 0.5f
            }
            bolts.removeAll { it.life <= 0f }
        } else {
            strikesLeft = 0
            bolts.clear()
        }
        tick++
    }
}

private fun rgba(r: Int, g: Int, b: Int, a: Float) = Color(r / 255f, g / 255f, b / 255f, a)

private val CYAN = Color(0xFF7EF0FF)
private val SPHERE_CENTER = Offset(StormGeo.C - 71f + 0.44f * 142f, StormGeo.C - 71f + 0.36f * 142f)
private const val SPHERE_GRAD_R = 120.8f

private val ARC_SEGS = arrayOf(
    0f to 18f, 34f to 46f, 96f to 132f, 150f to 158f, 214f to 262f, 286f to 300f,
)

private val GLOW_BRUSH = Brush.radialGradient(
    0f to rgba(95, 240, 255, 0.26f), 0.66f to Color.Transparent,
    center = Offset(StormGeo.C, StormGeo.C), radius = StormGeo.GLOW_R,
)
private val SWEEP_BRUSH = Brush.sweepGradient(
    0f to Color.Transparent, 292f / 360f to Color.Transparent,
    352f / 360f to rgba(191, 244, 255, 0.95f), 1f to Color.Transparent,
    center = Offset(StormGeo.C, StormGeo.C),
)
private val SPHERE_BRUSH = Brush.radialGradient(
    0.03f to Color(0xFFC8F7FF), 0.20f to Color(0xFF1FC6E4), 0.52f to Color(0xFF0A4C5E),
    0.80f to Color(0xFF03212B), 1f to Color(0xFF020B11),
    center = SPHERE_CENTER, radius = SPHERE_GRAD_R,
)
private val SWIRL_BRUSH = Brush.sweepGradient(
    0f to Color.Transparent, 0.05f to Color.Transparent,
    0.13f to Color(0xFF7EF0FF), 0.24f to rgba(126, 240, 255, 0f),
    0.42f to Color(0xFF17B8D8), 0.56f to rgba(23, 184, 216, 0f),
    0.74f to Color(0xFFEAFCFF), 0.86f to Color(0xFF17B8D8),
    0.96f to rgba(23, 184, 216, 0f), 1f to Color.Transparent,
    center = Offset(StormGeo.C, StormGeo.C),
)
private val VIGNETTE_BRUSH = Brush.radialGradient(
    0.20f to Color.Transparent, 0.52f to rgba(2, 10, 16, 0.34f), 0.74f to rgba(2, 10, 16, 0.7f),
    0.90f to rgba(2, 10, 16, 0.93f), 1f to rgba(2, 10, 16, 1f),
    center = SPHERE_CENTER, radius = SPHERE_GRAD_R,
)
private val PUFF_COLS = arrayOf(intArrayOf(126, 240, 255), intArrayOf(23, 184, 216), intArrayOf(191, 244, 255))

private fun DrawScope.drawStorm(st: StormState, mode: Int, sizeDp: Float) {
    val s = size.minDimension / StormGeo.N
    withTransform({ scale(s, s, Offset.Zero) }) {
        val c = Offset(StormGeo.C, StormGeo.C)
        val t = st.motionMs

        drawCircle(GLOW_BRUSH, radius = StormGeo.C, center = c)

        // 60 ticks, every 5th long, 110 s per turn.
        val spin110 = (t / 110_000.0 * 360.0)
        for (i in 0 until 60) {
            val long = i % 5 == 0
            val a = ((i * 6 + spin110) * PI / 180.0)
            val dx = sin(a).toFloat()
            val dy = -cos(a).toFloat()
            val len = if (long) 13f else 7f
            drawLine(
                if (long) rgba(126, 240, 255, 0.95f) else rgba(70, 180, 215, 0.4f),
                Offset(c.x + dx * 134f, c.y + dy * 134f),
                Offset(c.x + dx * (134f - len), c.y + dy * (134f - len)),
                strokeWidth = if (long) 2f else 1f,
            )
        }

        drawArcRing(116f, rgba(95, 240, 255, 0.48f), (t / 24_000.0 * 360.0).toFloat())
        rotate((t / 3_200.0 * 360.0).toFloat() - 90f, c) {
            drawCircle(SWEEP_BRUSH, radius = 115f, center = c, style = Stroke(2f))
        }
        drawArcRing(76f, rgba(120, 235, 255, 0.46f), -(t / 15_000.0 * 360.0).toFloat())

        // Two orbiting nodes, 11 s reverse.
        val orbit = -(t / 11_000.0 * 2 * PI)
        val ox = sin(orbit).toFloat() * 90f
        val oy = -cos(orbit).toFloat() * 90f
        drawCircle(CYAN.copy(alpha = 0.3f), 9f, Offset(c.x + ox, c.y + oy))
        drawCircle(CYAN, 3.5f, Offset(c.x + ox, c.y + oy))
        drawCircle(CYAN.copy(alpha = 0.18f), 7f, Offset(c.x - ox, c.y - oy))
        drawCircle(CYAN.copy(alpha = 0.6f), 2.5f, Offset(c.x - ox, c.y - oy))

        // Sphere with coreBreath.
        val ph = (0.5 - 0.5 * cos(2 * PI * st.breathPhase)).toFloat()
        val scale = 0.955f + (1.05f - 0.955f) * ph
        val bright = 0.9f + (1.24f - 0.9f) * ph
        withTransform({ scale(scale, scale, c) }) {
            drawCircle(
                Brush.radialGradient(
                    StormGeo.R / StormGeo.C to rgba(80, 220, 255, 0.34f * bright), 1f to Color.Transparent,
                    center = c, radius = StormGeo.C,
                ),
                radius = StormGeo.C, center = c,
            )
            drawCircle(SPHERE_BRUSH, radius = StormGeo.R, center = c)
            clipPath(st.spherePath) {
                val swirlDeg = (st.swirlPhase * 360.0).toFloat() - 90f
                rotate(swirlDeg, c) {
                    drawCircle(SWIRL_BRUSH, radius = StormGeo.R * 1.3f, center = c, alpha = 0.8f, blendMode = BlendMode.Screen)
                }
                drawCircle(
                    Brush.radialGradient(
                        0f to Color.White.copy(alpha = 0.7f), 1f to Color.Transparent,
                        center = Offset(107.7f, 93.5f), radius = 12f,
                    ),
                    radius = 12f, center = Offset(107.7f, 93.5f),
                )
                drawCircle(rgba(126, 240, 255, ((bright - 0.9f) * 0.3f).coerceAtLeast(0f)), StormGeo.R, c, blendMode = BlendMode.Plus)
                drawCircle(VIGNETTE_BRUSH, radius = StormGeo.R, center = c)
            }
            drawCircle(rgba(126, 240, 255, 0.35f), StormGeo.R - 1.5f, c, style = Stroke(3f))
            drawCircle(rgba(126, 240, 255, 0.28f), StormGeo.R - 0.5f, c, style = Stroke(1f))
        }

        if (StormCoreMath.drawsPuffs(sizeDp)) drawNebula(st, mode)
        for (b in st.bolts) drawBolt(st, b)
    }
}

private fun DrawScope.drawArcRing(radius: Float, color: Color, rotDeg: Float) {
    val c = StormGeo.C
    val r = radius - 0.5f
    for ((a0, a1) in ARC_SEGS) {
        drawArc(
            color, a0 + rotDeg - 90f, a1 - a0, false,
            topLeft = Offset(c - r, c - r), size = Size(r * 2, r * 2), style = Stroke(1f),
        )
    }
}

private fun DrawScope.drawNebula(st: StormState, mode: Int) {
    val ts = st.motionMs.toFloat()
    val boost = 1f + mode * 0.22f
    clipPath(st.puffPath) {
        for (q in st.puffs) {
            val x = StormGeo.C + cos(ts * q.sx + q.px) * q.ax + sin(ts * q.sy * 0.7f + q.py) * 6f
            val y = StormGeo.C + sin(ts * q.sy + q.py) * q.ay + cos(ts * q.sx * 0.8f + q.px) * 6f
            var flash = 0f
            for (b in st.bolts) {
                val mid = b.pts[b.pts.size / 2]
                val d = hypot(mid.x - x, mid.y - y)
                if (d < q.r * 2.2f) flash += b.life.pow(0.5f) * (1f - d / (q.r * 2.2f))
            }
            val alpha = min(0.5f, q.a * boost + flash * 0.5f)
            val rad = q.r * (1f + flash * 0.35f)
            val col = PUFF_COLS[q.hue]
            drawCircle(
                Brush.radialGradient(
                    0f to rgba(col[0], col[1], col[2], alpha),
                    0.55f to rgba(col[0], col[1], col[2], alpha * 0.35f),
                    1f to rgba(col[0], col[1], col[2], 0f),
                    center = Offset(x, y), radius = rad,
                ),
                radius = rad, center = Offset(x, y), blendMode = BlendMode.Plus,
            )
        }
    }
}

private fun DrawScope.drawBolt(st: StormState, b: Bolt) {
    val a = StormCoreMath.boltAlpha(b.life, b.flicker)
    val col = Color(b.colorArgb)
    fun fill(p: Path, pts: List<Pt>) {
        p.rewind()
        p.moveTo(pts[0].x, pts[0].y)
        for (i in 1 until pts.size) p.lineTo(pts[i].x, pts[i].y)
    }
    fun strokeAll(w: Float, al: Float, color: Color) {
        val style = Stroke(w, cap = StrokeCap.Round, join = StrokeJoin.Round)
        drawPath(st.mainPath, color, al * a, style, blendMode = BlendMode.Plus)
        for (br in b.branches) {
            fill(st.branchPath, br)
            drawPath(st.branchPath, color, al * a * 0.5f, style, blendMode = BlendMode.Plus)
        }
    }
    fill(st.mainPath, b.pts)
    val body = {
        strokeAll(7f * b.width, 0.11f, col)
        strokeAll(2.5f * b.width, 0.32f, col)
        strokeAll(b.width, 0.95f, Color.White)
    }
    if (b.clip > 0f) clipPath(st.spherePath) { body() } else body()
    b.flash?.let { f ->
        val center = Offset(f.x, f.y)
        drawCircle(
            Brush.radialGradient(
                0f to rgba(191, 244, 255, 0.6f * a), 1f to rgba(191, 244, 255, 0f),
                center = center, radius = 20f,
            ),
            radius = 20f, center = center, blendMode = BlendMode.Plus,
        )
    }
}
