package com.matt.aethermobile.ui

import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.random.Random

/**
 * Pure math behind StormCore (port of design/storm-core.js). No Compose or android.* imports so a
 * JVM test can pin it. All coordinates are in the 268-unit native box.
 */
object StormGeo {
    const val N = 268f
    const val C = 134f
    const val R = 71f
    const val RING = 118f

    /** CSS farthest-corner radius of the 268 box (134 * sqrt 2); the JS glow gradient is sized by it. */
    const val GLOW_R = 189.5f
}

data class Pt(val x: Float, val y: Float)

enum class BoltKind { Storm, Surface, Ring }

class Bolt(
    val pts: List<Pt>,
    val branches: List<List<Pt>>,
    var life: Float,
    val width: Float,
    val colorArgb: Long,
    /** Clip radius around the core centre; 0 = unclipped. */
    val clip: Float = 0f,
    /** Glow point at the ring end of a ring bolt. */
    val flash: Pt? = null,
    /** Per-frame random brightness factor, set by the clock (0.5..1). */
    var flicker: Float = 1f,
)

class Puff(
    val ax: Float, val ay: Float, val px: Float, val py: Float,
    val sx: Float, val sy: Float, val r: Float, val a: Float, val hue: Int,
)

object StormCoreMath {
    private val RATES = floatArrayOf(0.4f, 1f, 2.5f, 4.4f)
    private val POWERS = floatArrayOf(0.6f, 1f, 1.35f, 1.7f)

    /** Core breath period in seconds per mode: idle 3.6, live 2.2-2.6, surge 1.1-1.2 (README). */
    private val PULSE_SEC = floatArrayOf(3.6f, 2.4f, 1.15f, 1.1f)

    const val DISPLACEMENT_DECAY = 0.55f

    fun clampMode(m: Int): Int = max(0, min(3, m))
    fun rateFor(m: Int): Float = RATES[clampMode(m)]
    fun powerFor(m: Int): Float = POWERS[clampMode(m)]
    fun pulseSecFor(m: Int): Float = PULSE_SEC[clampMode(m)]

    /** Accumulates a 0..1 cycle phase so a period change continues from the current phase. */
    fun advancePhase(phase: Double, dtMs: Double, periodSec: Float): Double {
        val p = phase + dtMs / (periodSec * 1000.0)
        return p - floor(p)
    }

    /** Header-size cores skip nebula puffs and cap bolts (cost). */
    fun drawsPuffs(sizeDp: Float): Boolean = sizeDp > 48f
    fun maxBolts(sizeDp: Float): Int = if (sizeDp > 48f) 14 else 3

    /** JS: `Math.random() < RATES[m] * 0.17 * step` once per frame; step = dtMs / 16. */
    fun shouldSpawn(random: Random, mode: Int, step: Float): Boolean =
        random.nextFloat() < rateFor(mode) * 0.17f * step

    /** Frame time step as the JS clamps it: dt capped at 48 ms, in 16 ms units. */
    fun stepFor(dtMs: Float): Float = min(48f, dtMs) / 16f

    /** Bolt brightness for a frame: life^0.65 * flicker. */
    fun boltAlpha(life: Float, flicker: Float): Float = life.coerceAtLeast(0f).pow(0.65f) * flicker

    /** Port of `seg`: appends midpoint-displaced points between a and b, ending with b. */
    fun seg(random: Random, pts: MutableList<Pt>, a: Pt, b: Pt, disp: Float, depth: Int) {
        if (depth <= 0) {
            pts.add(b)
            return
        }
        val mx = (a.x + b.x) / 2
        val my = (a.y + b.y) / 2
        val nx = -(b.y - a.y)
        val ny = b.x - a.x
        val len = hypot(nx, ny).let { if (it == 0f) 1f else it }
        val off = (random.nextFloat() - 0.5f) * disp
        val m = Pt(mx + nx / len * off, my + ny / len * off)
        seg(random, pts, a, m, disp * DISPLACEMENT_DECAY, depth - 1)
        seg(random, pts, m, b, disp * DISPLACEMENT_DECAY, depth - 1)
    }

    /** Port of `makeBolt`. Main path has 2^depth + 1 points. */
    fun makeBolt(
        random: Random, a: Pt, b: Pt, disp: Float, depth: Int,
        branchP: Float, width: Float, colorArgb: Long, clip: Float = 0f, flash: Pt? = null,
    ): Bolt {
        val pts = ArrayList<Pt>()
        pts.add(a)
        seg(random, pts, a, b, disp, depth)
        val branches = ArrayList<List<Pt>>()
        var i = 2
        while (i < pts.size - 1) {
            if (random.nextFloat() <= branchP) {
                val p = pts[i]
                val dir = atan2(b.y - a.y, b.x - a.x) + (random.nextFloat() - 0.5f) * 1.9f
                val l = 16f + random.nextFloat() * 32f
                val end = Pt(p.x + cos(dir) * l, p.y + sin(dir) * l)
                val bp = ArrayList<Pt>()
                bp.add(p)
                seg(random, bp, p, end, disp * 0.5f, max(2, depth - 2))
                branches.add(bp)
            }
            i += 2
        }
        return Bolt(pts, branches, 1f, width, colorArgb, clip, flash)
    }

    /** Port of `spawn`: one bolt on the sphere surface or from the sphere out to the ring. */
    fun spawnBolt(random: Random, kind: BoltKind, power: Float): Bolt {
        val c = StormGeo.C
        val r = StormGeo.R
        val ang = random.nextFloat() * (Math.PI * 2).toFloat()
        val onSurface = kind != BoltKind.Ring && (kind == BoltKind.Surface || random.nextFloat() > 0.45f)
        return if (onSurface) {
            val spread = 0.8f + random.nextFloat() * 2f
            val rr = r * 0.94f
            makeBolt(
                random,
                Pt(c + cos(ang) * rr, c + sin(ang) * rr),
                Pt(c + cos(ang + spread) * rr, c + sin(ang + spread) * rr),
                24f * power, 5, 0.34f, 1.1f, 0xFFBFF4FFL, clip = r,
            )
        } else {
            val j = (random.nextFloat() - 0.5f) * 0.45f
            val b = Pt(c + cos(ang + j) * StormGeo.RING, c + sin(ang + j) * StormGeo.RING)
            makeBolt(
                random,
                Pt(c + cos(ang) * r * 0.99f, c + sin(ang) * r * 0.99f),
                b, 13f * power, 4, 0.24f, 1.35f, 0xFFEAFCFFL, clip = 0f, flash = b,
            )
        }
    }

    /** Port of `seedPuffs`: 16 nebula puffs. */
    fun seedPuffs(random: Random): List<Puff> = List(16) { i ->
        Puff(
            ax = 8f + random.nextFloat() * 34f, ay = 8f + random.nextFloat() * 34f,
            px = random.nextFloat() * 6.28f, py = random.nextFloat() * 6.28f,
            sx = 0.00006f + random.nextFloat() * 0.00016f, sy = 0.00006f + random.nextFloat() * 0.00016f,
            r = 16f + random.nextFloat() * 30f, a = 0.035f + random.nextFloat() * 0.07f, hue = i % 3,
        )
    }
}
