package com.matt.aethermobile.ui

import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.pow
import kotlin.math.sqrt
import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class StormCoreMathTest {
    private val a = Pt(10f, 20f)
    private val b = Pt(210f, 20f)

    private fun bolt(seed: Int, depth: Int, disp: Float = 24f) =
        StormCoreMath.makeBolt(Random(seed), a, b, disp, depth, 0.3f, 1f, 0xFFFFFFFFL)

    @Test fun boltStartsAtAEndsAtBWithPowerOfTwoPoints() {
        for (depth in 1..6) {
            val bo = bolt(depth, depth)
            assertEquals(a, bo.pts.first())
            assertEquals(b, bo.pts.last())
            assertEquals((1 shl depth) + 1, bo.pts.size)
        }
    }

    @Test fun depthZeroIsAStraightTwoPointSegment() {
        assertEquals(listOf(a, b), bolt(1, 0).pts)
    }

    @Test fun displacementShrinksByDecayPerLevel() {
        // Horizontal chord: deviation from it is |y - 20|. Every point's deviation is bounded by the
        // sum of the per-level half-displacements disp/2 * 0.55^k (k < depth).
        val disp = 24f
        for (depth in 1..5) {
            var bound = 0f
            for (k in 0 until depth) bound += disp / 2 * 0.55f.pow(k)
            for (seed in 0 until 40) {
                val dev = bolt(seed, depth, disp).pts.maxOf { abs(it.y - 20f) }
                assertTrue("depth $depth seed $seed dev $dev > $bound", dev <= bound + 1e-3f)
            }
        }
        // One level only: the single midpoint moves at most disp/2.
        assertTrue(bolt(7, 1, disp).pts[1].let { abs(it.y - 20f) <= disp / 2 + 1e-3f })
    }

    @Test fun sameSeedGivesIdenticalBolt() {
        val x = bolt(99, 5)
        val y = bolt(99, 5)
        assertEquals(x.pts, y.pts)
        assertEquals(x.branches, y.branches)
        assertTrue(bolt(100, 5).pts != x.pts)
    }

    @Test fun clampModeClamps() {
        assertEquals(0, StormCoreMath.clampMode(-1))
        assertEquals(3, StormCoreMath.clampMode(4))
        assertEquals(3, StormCoreMath.clampMode(99))
        assertEquals(2, StormCoreMath.clampMode(2))
    }

    @Test fun ratesAndPowersMatchJsAndNeverDecrease() {
        assertEquals(listOf(0.4f, 1f, 2.5f, 4.4f), (0..3).map { StormCoreMath.rateFor(it) })
        assertEquals(listOf(0.6f, 1f, 1.35f, 1.7f), (0..3).map { StormCoreMath.powerFor(it) })
        for (m in 0..2) {
            assertTrue(StormCoreMath.rateFor(m) <= StormCoreMath.rateFor(m + 1))
            assertTrue(StormCoreMath.powerFor(m) <= StormCoreMath.powerFor(m + 1))
        }
        assertEquals(StormCoreMath.rateFor(3), StormCoreMath.rateFor(50), 0f)
    }

    @Test fun pulseMatchesReadmeAndQuickensWithMode() {
        assertEquals(3.6f, StormCoreMath.pulseSecFor(0), 0f)
        assertTrue(StormCoreMath.pulseSecFor(1) in 2.2f..2.6f)
        assertTrue(StormCoreMath.pulseSecFor(2) in 1.1f..1.2f)
        for (m in 0..2) assertTrue(StormCoreMath.pulseSecFor(m) >= StormCoreMath.pulseSecFor(m + 1))
    }

    @Test fun spawnSchedulingScalesWithStepAndRate() {
        val r = Random(5)
        assertTrue((0 until 200).none { StormCoreMath.shouldSpawn(r, 3, 0f) })
        assertTrue((0 until 200).all { StormCoreMath.shouldSpawn(r, 0, 100f) })
        val idle = (0 until 4000).count { StormCoreMath.shouldSpawn(Random(it), 0, 1f) }
        val breach = (0 until 4000).count { StormCoreMath.shouldSpawn(Random(it), 3, 1f) }
        assertTrue(breach > idle)
        assertEquals(3f, StormCoreMath.stepFor(48f), 0f)
        assertEquals(3f, StormCoreMath.stepFor(5000f), 0f)
    }

    @Test fun smallCoreSkipsPuffsAndCapsBolts() {
        assertTrue(!StormCoreMath.drawsPuffs(40f))
        assertTrue(!StormCoreMath.drawsPuffs(48f))
        assertTrue(StormCoreMath.drawsPuffs(150f))
        assertTrue(StormCoreMath.maxBolts(40f) < StormCoreMath.maxBolts(150f))
    }

    @Test fun spawnedBoltsStayInsideTheNativeBox() {
        val r = Random(11)
        repeat(100) {
            val kind = BoltKind.values()[it % 3]
            val bo = StormCoreMath.spawnBolt(r, kind, 1.7f)
            assertEquals((1 shl (if (bo.clip > 0f) 5 else 4)) + 1, bo.pts.size)
            assertTrue(bo.pts.first().let { p -> hypot(p.x - 134f, p.y - 134f) <= 71f + 1e-3f })
            assertEquals(bo.clip == 0f, bo.flash != null)
            if (kind != BoltKind.Storm) assertEquals(kind == BoltKind.Ring, bo.flash != null)
        }
    }

    @Test fun puffSeedingIsDeterministicAndHasSixteenInThreeHues() {
        val p = StormCoreMath.seedPuffs(Random(3))
        assertEquals(16, p.size)
        assertEquals(setOf(0, 1, 2), p.map { it.hue }.toSet())
        assertEquals(p.map { it.r }, StormCoreMath.seedPuffs(Random(3)).map { it.r })
    }

    @Test fun advancePhaseAccumulates() {
        val p = StormCoreMath.advancePhase(StormCoreMath.advancePhase(0.0, 600.0, 2.4f), 600.0, 2.4f)
        assertEquals(0.5, p, 1e-6)
    }

    @Test fun advancePhaseWrapsIntoUnitRange() {
        assertEquals(0.15, StormCoreMath.advancePhase(0.9, 600.0, 2.4f), 1e-6)
        var p = 0.0
        repeat(500) {
            p = StormCoreMath.advancePhase(p, 37.0, 1.1f)
            assertTrue(p >= 0.0 && p < 1.0)
        }
    }

    @Test fun periodChangeDoesNotJumpPhase() {
        val p = StormCoreMath.advancePhase(0.0, 1000.0, 3.6f)
        assertEquals(p, StormCoreMath.advancePhase(p, 0.0, 1.15f), 0.0)
        assertEquals(p + 100.0 / 1150.0, StormCoreMath.advancePhase(p, 100.0, 1.15f), 1e-6)
    }

    @Test fun glowRadiusIsFarthestCorner() {
        assertEquals(StormGeo.C * sqrt(2f), StormGeo.GLOW_R, 0.05f)
    }
}
