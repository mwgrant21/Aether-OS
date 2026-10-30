package com.matt.aethermobile.projects

import com.matt.aethermobile.ledger.Bucket
import com.matt.aethermobile.ledger.Part
import com.matt.aethermobile.ledger.rollupOf
import com.matt.aethermobile.ledger.shares
import com.matt.aethermobile.ledger.tierLine
import com.matt.aethermobile.ledger.usd

/** Smallest bar the list draws, so a tiny project is still visible. */
const val MIN_BAR_FRACTION = 0.02

/** Label of a root's own checkout row ("main" in the design); a worktree child shows its worktree name instead. */
const val MAIN_LABEL = "main"

/** Cost-share bar: max(2%, usd / maxUsd), clamped to 1. A zero or empty maxUsd gives the minimum, never NaN. */
fun barFraction(usd: Double, maxUsd: Double): Double =
    if (maxUsd > 0.0) (usd / maxUsd).coerceIn(MIN_BAR_FRACTION, 1.0) else MIN_BAR_FRACTION

/** One list row. Row meta is the tier line only: the wire carries no session count, so there is no "N sess". */
data class ProjectRowUi(
    val key: String,
    val label: String,
    val usd: Double,
    val usdText: String,
    val bar: Double,
    val tiers: String?,
    val children: List<ProjectRowUi>,
    val expandable: Boolean,
)

/** What the detail card shows for one root, child or the all/unscoped block. */
data class ProjectDetailUi(
    val title: String,
    val usdText: String,
    val parts: List<Part>,
    val buckets: List<Bucket>,
    val tiers: String?,
    val cache: com.matt.aethermobile.protocol.ControlProtocol.LedgerCache,
)

data class ProjectsUi(
    val computedAtMs: Long,
    val all: ProjectDetailUi,
    val unscoped: ProjectDetailUi?,
    val rows: List<ProjectRowUi>,
)

/** A rollup bucket as text: null (no activity observed) is null so the screen prints its own sentence; a real 0.0 is "$0.00". */
fun bucketText(b: Bucket): String? = b.usd?.let(::usd)

fun detailOf(title: String, b: LedgerBlock) =
    ProjectDetailUi(title, usd(b.total.usd), shares(b.total), rollupOf(b.rollups), tierLine(b.tiers), b.cache)

/** Rows keep the order received. Bars are relative to the largest root; a root's children to the largest sibling. */
fun projectsUi(s: ProjectsSnapshot): ProjectsUi {
    val maxRoot = s.roots.maxOfOrNull { it.block.total.usd } ?: 0.0
    val rows = s.roots.map { r ->
        val maxKid = r.children.maxOfOrNull { it.block.total.usd } ?: 0.0
        val kids = r.children.map { c ->
            ProjectRowUi(
                c.key, c.worktree ?: MAIN_LABEL, c.block.total.usd, usd(c.block.total.usd),
                barFraction(c.block.total.usd, maxKid), tierLine(c.block.tiers), emptyList(), false,
            )
        }
        ProjectRowUi(
            r.key, r.name, r.block.total.usd, usd(r.block.total.usd),
            barFraction(r.block.total.usd, maxRoot), tierLine(r.block.tiers), kids, kids.size > 1,
        )
    }
    return ProjectsUi(s.computedAtMs, detailOf("all", s.all), s.unscoped?.let { detailOf("unscoped", it) }, rows)
}

/** Age of the snapshot on titan's clock: titan time = phone now + titanClockOffsetMs. */
fun projectsAge(computedAtMs: Long, phoneNowMs: Long, titanClockOffsetMs: Long) =
    com.matt.aethermobile.ledger.ageLabel(computedAtMs, phoneNowMs + titanClockOffsetMs)
