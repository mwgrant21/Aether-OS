package com.matt.aethermobile.ui.ledger

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.matt.aethermobile.ui.shell.mouseDragScroll
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.matt.aethermobile.R
import com.matt.aethermobile.ledger.AgeLabel
import com.matt.aethermobile.ledger.Bucket
import com.matt.aethermobile.ledger.BucketKind
import com.matt.aethermobile.ledger.LedgerUi
import com.matt.aethermobile.ledger.Part
import com.matt.aethermobile.ledger.PartKind
import com.matt.aethermobile.ledger.ageLabel
import com.matt.aethermobile.ledger.hitFraction
import com.matt.aethermobile.ledger.hitPercent
import com.matt.aethermobile.ledger.isStale
import com.matt.aethermobile.ledger.rollupOf
import com.matt.aethermobile.ledger.shares
import com.matt.aethermobile.ledger.tierLine
import com.matt.aethermobile.ledger.tokensCompact
import com.matt.aethermobile.ledger.usd
import com.matt.aethermobile.ledger.usdPrecise
import com.matt.aethermobile.protocol.ControlProtocol
import com.matt.aethermobile.ui.components.AeNoticeBox
import com.matt.aethermobile.ui.components.aeInset
import com.matt.aethermobile.ui.components.aePanel
import com.matt.aethermobile.ui.theme.AetherColors
import com.matt.aethermobile.ui.theme.AetherType
import kotlinx.coroutines.delay
import kotlin.math.roundToLong

private val type = AetherType()
private const val TICK_MS = 30_000L
private val BarShape = RoundedCornerShape(2.dp)

/**
 * Read-only Ledger body: no click targets, no inputs, nothing saved. Every dollar figure is an API-rate counterfactual
 * and is labelled so. [nowMs] is supplied by the host; while composed the screen advances it every 30 s so the age
 * line stays current between renders.
 */
@Composable
fun LedgerScreen(ui: LedgerUi, nowMs: Long, modifier: Modifier = Modifier) {
    when (ui) {
        LedgerUi.Off -> Message(stringResource(R.string.ledger_loading), modifier)
        LedgerUi.Loading -> Message(stringResource(R.string.ledger_loading), modifier)
        LedgerUi.NoSnapshot -> Message(stringResource(R.string.ledger_no_snapshot), modifier)
        is LedgerUi.Ready -> ReadyBody(ui.snapshot, nowMs, modifier)
    }
}

@Composable
private fun Message(text: String, modifier: Modifier) {
    Column(modifier.padding(16.dp)) {
        BasicText(text, style = type.body.copy(color = AetherColors.textMuted))
    }
}

@Composable
private fun ReadyBody(s: ControlProtocol.LedgerSnapshot, hostNowMs: Long, modifier: Modifier) {
    var ticks by remember(hostNowMs) { mutableIntStateOf(0) }
    LaunchedEffect(hostNowMs) {
        while (true) { delay(TICK_MS); ticks++ }
    }
    val now = hostNowMs + ticks * TICK_MS
    val scroll = rememberScrollState()

    Column(
        modifier.mouseDragScroll(scroll).verticalScroll(scroll).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        AeNoticeBox(stringResource(R.string.ledger_basis_note), amber = true)
        BasicText(stringResource(R.string.ledger_scope_line), style = type.meta.copy(color = AetherColors.textMuted))
        TotalCard(s.total, s.tiers)
        CacheCard(s.cache)
        RollupCard(s.rollups)
        Footer(s.computedAtMs, now)
    }
}

@Composable
private fun Card(desc: String, content: @Composable () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .aePanel()
            .semantics(mergeDescendants = true) { contentDescription = desc }
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) { content() }
}

@Composable
private fun Label(text: String, color: androidx.compose.ui.graphics.Color = AetherColors.textLabel) {
    BasicText(text.uppercase(), style = type.label.copy(color = color))
}

@Composable
private fun spoken(v: Double): String {
    val cents = (v * 100).roundToLong().coerceAtLeast(0L)
    val d = (cents / 100).toInt()
    val c = (cents % 100).toInt()
    return pluralStringResource(R.plurals.ledger_spoken_dollars, d, d) + " " + pluralStringResource(R.plurals.ledger_spoken_cents, c, c)
}

@Composable
private fun TotalCard(t: ControlProtocol.LedgerTotal, tiers: List<ControlProtocol.LedgerTier>) {
    Card(stringResource(R.string.ledger_total_desc, spoken(t.usd))) {
        Label(stringResource(R.string.ledger_total_title))
        BasicText(usd(t.usd), style = type.hero.copy(color = AetherColors.cyan), maxLines = 1)
        Label(stringResource(R.string.ledger_api_rate_tag), AetherColors.warn)
        BasicText(
            tierLine(tiers) ?: stringResource(R.string.ledger_no_priced_activity),
            style = type.meta.copy(color = AetherColors.textDim),
        )
        shares(t).forEach { PartRow(it) }
    }
}

@Composable
private fun PartRow(p: Part) {
    val name = when (p.kind) {
        PartKind.INPUT -> R.string.ledger_part_input
        PartKind.OUTPUT -> R.string.ledger_part_output
        PartKind.CACHE_WRITE -> R.string.ledger_part_cache_write
        PartKind.CACHE_READ -> R.string.ledger_part_cache_read
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Label(stringResource(name))
            BasicText(usdPrecise(p.usd), style = type.data.copy(color = AetherColors.text), maxLines = 1)
        }
        Bar(hitFraction(p.fraction))
    }
}

@Composable
private fun Bar(fraction: Float) {
    Box(Modifier.fillMaxWidth().height(4.dp).background(AetherColors.border, BarShape)) {
        Box(Modifier.fillMaxHeight().fillMaxWidth(fraction).background(AetherColors.cyan, BarShape))
    }
}

@Composable
private fun CacheCard(c: ControlProtocol.LedgerCache) {
    val hit = hitPercent(c.hitRate)
    val desc = if (c.readTokens == 0L) stringResource(R.string.ledger_cache_desc_none, hit)
    else stringResource(R.string.ledger_cache_desc, spoken(c.savedUsd), hit)
    Card(desc) {
        Label(stringResource(R.string.ledger_cache_title))
        if (c.readTokens == 0L) {
            BasicText(stringResource(R.string.ledger_cache_none), style = type.body.copy(color = AetherColors.textDim))
        } else {
            BasicText(
                stringResource(R.string.ledger_cache_saved, usdPrecise(c.savedUsd)),
                style = type.data.copy(color = AetherColors.success, fontSize = 20.sp),
            )
            BasicText(
                stringResource(
                    R.string.ledger_cache_detail,
                    tokensCompact(c.readTokens), usdPrecise(c.wouldHaveUsd), usdPrecise(c.actualUsd),
                ),
                style = type.body.copy(color = AetherColors.textDim),
            )
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Label(stringResource(R.string.ledger_hit_rate))
            BasicText(hit, style = type.data.copy(color = AetherColors.text), maxLines = 1)
        }
        Bar(hitFraction(c.hitRate))
    }
}

@Composable
private fun bucketName(k: BucketKind): String = stringResource(
    when (k) {
        BucketKind.TODAY -> R.string.ledger_rollup_today
        BucketKind.WEEK -> R.string.ledger_rollup_week
        BucketKind.MONTH -> R.string.ledger_rollup_month
    },
)

@Composable
private fun RollupCard(r: ControlProtocol.LedgerRollups) {
    val buckets = rollupOf(r)
    val none = stringResource(R.string.ledger_rollup_none)
    // A null bucket reads "no activity observed"; it is never formatted as a dollar amount.
    val items = buckets.map { b -> bucketName(b.kind) to (b.usd?.let { spoken(it) } ?: none) }
    val itemDescs = items.map { (n, v) -> stringResource(R.string.ledger_rollup_item_desc, n, v) }
    val desc = stringResource(R.string.ledger_rollup_desc, itemDescs.joinToString(". "))
    Card(desc) {
        Label(stringResource(R.string.ledger_rollup_title), AetherColors.warn)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            buckets.forEach { Tile(it, none, Modifier.weight(1f)) }
        }
        BasicText(stringResource(R.string.ledger_rollup_note), style = type.meta.copy(color = AetherColors.textMuted))
    }
}

@Composable
private fun Tile(b: Bucket, none: String, modifier: Modifier) {
    Column(modifier.aeInset().padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Label(bucketName(b.kind))
        val v = b.usd
        if (v == null) {
            BasicText(none, style = type.meta.copy(color = AetherColors.textMuted, fontStyle = FontStyle.Italic))
        } else {
            BasicText(usdPrecise(v), style = type.data.copy(color = AetherColors.text), maxLines = 1, overflow = TextOverflow.Clip)
        }
    }
}

@Composable
private fun Footer(computedAtMs: Long, nowMs: Long) {
    val age = when (val a = ageLabel(computedAtMs, nowMs)) {
        AgeLabel.JustNow -> stringResource(R.string.ledger_age_just_now)
        is AgeLabel.Minutes -> pluralStringResource(R.plurals.ledger_age_minutes, a.n.toInt(), a.n.toInt())
        is AgeLabel.Hours -> pluralStringResource(R.plurals.ledger_age_hours, a.n.toInt(), a.n.toInt())
        is AgeLabel.Days -> pluralStringResource(R.plurals.ledger_age_days, a.n.toInt(), a.n.toInt())
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        BasicText(stringResource(R.string.ledger_updated, age), style = type.meta.copy(color = AetherColors.textMuted))
        if (isStale(computedAtMs, nowMs)) {
            BasicText(stringResource(R.string.ledger_stale), style = type.meta.copy(color = AetherColors.warn))
        }
    }
}
