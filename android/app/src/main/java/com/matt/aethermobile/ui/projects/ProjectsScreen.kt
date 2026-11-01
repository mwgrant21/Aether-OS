package com.matt.aethermobile.ui.projects

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.matt.aethermobile.R
import com.matt.aethermobile.ledger.AgeLabel
import com.matt.aethermobile.ledger.Bucket
import com.matt.aethermobile.ledger.BucketKind
import com.matt.aethermobile.ledger.Part
import com.matt.aethermobile.ledger.PartKind
import com.matt.aethermobile.ledger.ageLabel
import com.matt.aethermobile.ledger.hitFraction
import com.matt.aethermobile.ledger.hitPercent
import com.matt.aethermobile.ledger.isStale
import com.matt.aethermobile.ledger.tokensCompact
import com.matt.aethermobile.ledger.usdPrecise
import com.matt.aethermobile.projects.LedgerBlock
import com.matt.aethermobile.projects.MAIN_LABEL
import com.matt.aethermobile.projects.ProjectDetailUi
import com.matt.aethermobile.projects.ProjectRowUi
import com.matt.aethermobile.projects.ProjectsSnapshot
import com.matt.aethermobile.projects.bucketText
import com.matt.aethermobile.projects.detailOf
import com.matt.aethermobile.projects.projectsUi
import com.matt.aethermobile.ui.components.aeInset
import com.matt.aethermobile.ui.components.aePanel
import com.matt.aethermobile.ui.components.aeSoftRow
import com.matt.aethermobile.ui.shell.LocalPaneEnv
import com.matt.aethermobile.ui.shell.mouseDragScroll
import com.matt.aethermobile.ui.theme.AetherColors
import com.matt.aethermobile.ui.theme.AetherType
import com.matt.aethermobile.views.ViewUi
import kotlinx.coroutines.delay

private val type = AetherType()
private const val TICK_MS = 30_000L
private val BarShape = RoundedCornerShape(2.dp)

/** Detail key of the ALL TRANSCRIPTS hero; cannot collide with a wire key (those are non-empty printable text). */
private const val ALL_KEY = "\u0000all"

private enum class Scope { ALL, PROJECT, WORKTREE }
private class Selected(val name: String, val scope: Scope, val block: LedgerBlock)

/**
 * Read-only Projects body: a list (ALL TRANSCRIPTS hero, one row per root, expandable checkouts) and a detail card
 * stack. Which detail is open and which rows are expanded is local state, never saved. Every dollar is an API-rate
 * counterfactual and is labelled so. Back from the detail returns to the list; from the list the shell's Back applies.
 */
@Composable
fun ProjectsScreen(ui: ViewUi<ProjectsSnapshot>, nowMs: Long, modifier: Modifier = Modifier) {
    when (ui) {
        ViewUi.Off, ViewUi.Loading -> Message(stringResource(R.string.projects_loading), modifier)
        ViewUi.NoSnapshot -> Message(stringResource(R.string.projects_no_snapshot), modifier)
        ViewUi.Unreadable -> Message(stringResource(R.string.projects_unreadable), modifier)
        ViewUi.Unsupported -> Message(stringResource(R.string.projects_unsupported), modifier)
        is ViewUi.Ready -> ReadyBody(ui.data, nowMs, modifier)
    }
}

@Composable
private fun Message(text: String, modifier: Modifier) {
    Column(modifier.padding(16.dp)) {
        BasicText(text, style = type.body.copy(color = AetherColors.textMuted))
    }
}

private fun select(s: ProjectsSnapshot, key: String, allName: String): Selected? {
    if (key == ALL_KEY) return Selected(allName, Scope.ALL, s.all)
    for (r in s.roots) {
        if (r.key == key) return Selected(r.name, Scope.PROJECT, r.block)
        for (c in r.children) if (c.key == key) return Selected(r.name + " · " + (c.worktree ?: MAIN_LABEL), Scope.WORKTREE, c.block)
    }
    return null
}

@Composable
private fun ReadyBody(s: ProjectsSnapshot, hostNowMs: Long, modifier: Modifier) {
    var ticks by remember(hostNowMs) { mutableIntStateOf(0) }
    LaunchedEffect(hostNowMs) {
        while (true) { delay(TICK_MS); ticks++ }
    }
    val now = hostNowMs + ticks * TICK_MS
    var openKey by remember { mutableStateOf<String?>(null) }
    var expanded by remember { mutableStateOf(setOf<String>()) }
    val scroll = rememberScrollState()
    BackHandler(enabled = LocalPaneEnv.current.gateBack(openKey != null)) { openKey = null }

    val model = projectsUi(s)
    val allName = stringResource(R.string.projects_detail_all)
    // A key that vanished from a refreshed snapshot falls back to the list rather than showing stale data.
    val selected = openKey?.let { select(s, it, allName) }

    Column(
        modifier.mouseDragScroll(scroll).verticalScroll(scroll).padding(horizontal = 12.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (selected == null) {
            ListBody(
                model.all.usdText, model.rows, model.unscoped?.usdText, s.roots.size, expanded,
                onToggle = { k -> expanded = if (k in expanded) expanded - k else expanded + k },
                onOpen = { openKey = it },
            )
        } else {
            val totalTitle = stringResource(
                when (selected.scope) {
                    Scope.ALL -> R.string.projects_total_all
                    Scope.PROJECT -> R.string.projects_total_project
                    Scope.WORKTREE -> R.string.projects_total_worktree
                },
            )
            DetailBody(selected.name, totalTitle, detailOf(selected.name, selected.block), onBack = { openKey = null })
        }
        Footer(s.computedAtMs, now)
    }
}

@Composable
private fun ListBody(
    allUsd: String,
    rows: List<ProjectRowUi>,
    unscopedUsd: String?,
    projectCount: Int,
    expanded: Set<String>,
    onToggle: (String) -> Unit,
    onOpen: (String) -> Unit,
) {
    Hero(allUsd, projectCount, unscopedUsd != null) { onOpen(ALL_KEY) }
    Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Label(stringResource(R.string.projects_list_title))
        BasicText(
            stringResource(R.string.projects_api_rate_tag),
            style = type.label.copy(color = AetherColors.warn, fontSize = 10.sp, letterSpacing = 1.5.sp),
        )
    }
    rows.forEach { r -> ProjectRow(r, r.key in expanded, { onToggle(r.key) }, onOpen) }
    if (unscopedUsd != null) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            BasicText(
                stringResource(R.string.projects_unscoped_note), Modifier.weight(1f),
                style = type.body.copy(color = AetherColors.textMuted, fontSize = 13.sp),
            )
            BasicText(unscopedUsd, style = type.data.copy(color = AetherColors.textMuted, fontSize = 12.sp), maxLines = 1)
        }
    }
}

@Composable
private fun Hero(usdText: String, projectCount: Int, hasUnscoped: Boolean, onClick: () -> Unit) {
    val meta = stringResource(if (hasUnscoped) R.string.projects_all_meta else R.string.projects_all_meta_none, projectCount)
    val desc = stringResource(R.string.projects_all_desc, usdText)
    Column(
        Modifier
            .fillMaxWidth()
            .aePanel()
            .border(1.dp, AetherColors.borderGlow, RoundedCornerShape(16.dp))
            .semantics(mergeDescendants = true) { contentDescription = desc; role = Role.Button }
            .clickable(onClick = onClick)
            .heightIn(min = 48.dp)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Label(stringResource(R.string.projects_all_title))
            BasicText(
                stringResource(R.string.projects_all_open).uppercase(),
                style = type.label.copy(color = AetherColors.cyanBright, letterSpacing = 1.5.sp),
            )
        }
        BasicText(usdText, style = type.hero.copy(color = AetherColors.cyan, fontSize = 28.sp), maxLines = 1)
        BasicText(meta, style = type.meta.copy(color = AetherColors.textLabel))
    }
}

@Composable
private fun ProjectRow(r: ProjectRowUi, open: Boolean, onToggle: () -> Unit, onOpen: (String) -> Unit) {
    Column(Modifier.fillMaxWidth().aeSoftRow()) {
        val desc = stringResource(R.string.projects_row_desc, r.label, r.usdText)
        Row(Modifier.fillMaxWidth().heightIn(min = 60.dp)) {
            if (r.expandable) {
                val toggleDesc = stringResource(if (open) R.string.projects_row_collapse else R.string.projects_row_expand, r.label)
                Box(
                    Modifier.width(44.dp).fillMaxHeight()
                        .semantics { contentDescription = toggleDesc; role = Role.Button }
                        .clickable(onClick = onToggle),
                    contentAlignment = Alignment.Center,
                ) { BasicText(if (open) "▾" else "▸", style = type.label.copy(color = AetherColors.textLabel, fontSize = 14.sp)) }
            } else {
                Box(Modifier.width(16.dp))
            }
            Column(
                Modifier.weight(1f)
                    .semantics(mergeDescendants = true) { contentDescription = desc; role = Role.Button }
                    .clickable { onOpen(r.key) }
                    .padding(top = 12.dp, bottom = 12.dp, end = 14.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    BasicText(
                        r.label, Modifier.weight(1f),
                        style = type.body.copy(color = AetherColors.textBright, fontSize = 16.sp),
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                    BasicText(r.usdText, style = type.data.copy(color = AetherColors.textLabel), maxLines = 1)
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f)) { Bar(r.bar.toFloat(), 4.dp) }
                    if (r.expandable) {
                        BasicText(
                            stringResource(R.string.projects_row_worktrees, r.children.size),
                            style = type.meta.copy(color = AetherColors.textMuted),
                        )
                    }
                }
            }
        }
        if (open) {
            Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                r.children.forEach { k ->
                    val kd = stringResource(R.string.projects_row_desc, k.label, k.usdText)
                    Row(
                        Modifier.fillMaxWidth().height(44.dp)
                            .semantics(mergeDescendants = true) { contentDescription = kd; role = Role.Button }
                            .clickable { onOpen(k.key) }
                            .padding(start = 44.dp, end = 14.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.size(6.dp).background(AetherColors.textMuted, BarShape))
                        BasicText(
                            k.label, Modifier.weight(1f),
                            style = type.body.copy(color = AetherColors.text),
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                        BasicText(k.usdText, style = type.data.copy(color = AetherColors.textLabel, fontSize = 12.sp), maxLines = 1)
                    }
                }
            }
        }
    }
}

@Composable
private fun DetailBody(name: String, totalTitle: String, d: ProjectDetailUi, onBack: () -> Unit) {
    val backDesc = stringResource(R.string.projects_back_to_list)
    Row(
        Modifier.fillMaxWidth().heightIn(min = 44.dp)
            .semantics(mergeDescendants = true) { contentDescription = backDesc; role = Role.Button }
            .clickable(onClick = onBack),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BasicText("‹", style = type.title.copy(color = AetherColors.textLabel, fontSize = 28.sp))
        BasicText(name, style = type.title.copy(color = AetherColors.textBright), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
    TotalCard(totalTitle, d)
    RollupCard(d.buckets)
    CacheCard(d)
}

@Composable
private fun Card(desc: String, content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth().aePanel().semantics(mergeDescendants = true) { contentDescription = desc }.padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) { content() }
}

@Composable
private fun Label(text: String, color: Color = AetherColors.textLabel) {
    BasicText(text.uppercase(), style = type.label.copy(color = color))
}

@Composable
private fun TotalCard(title: String, d: ProjectDetailUi) {
    Card(stringResource(R.string.projects_total_desc, title, d.usdText)) {
        Label(title)
        BasicText(d.usdText, style = type.hero.copy(color = AetherColors.cyan), maxLines = 1)
        BasicText(
            stringResource(R.string.projects_not_paid_line).uppercase(),
            style = type.label.copy(color = AetherColors.warn, fontSize = 11.sp, letterSpacing = 1.sp),
        )
        BasicText(
            d.tiers ?: stringResource(R.string.projects_no_priced_activity),
            style = type.body.copy(color = AetherColors.textMuted, fontSize = 13.sp),
        )
        d.parts.forEach { PartRow(it) }
    }
}

@Composable
private fun PartRow(p: Part) {
    val name = when (p.kind) {
        PartKind.INPUT -> R.string.projects_part_input
        PartKind.OUTPUT -> R.string.projects_part_output
        PartKind.CACHE_WRITE -> R.string.projects_part_cache_write
        PartKind.CACHE_READ -> R.string.projects_part_cache_read
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Label(stringResource(name))
            BasicText(usdPrecise(p.usd), style = type.data.copy(color = AetherColors.text), maxLines = 1)
        }
        Bar(hitFraction(p.fraction), 3.dp)
    }
}

@Composable
private fun Bar(fraction: Float, h: Dp) {
    Box(Modifier.fillMaxWidth().height(h).background(AetherColors.border, BarShape)) {
        Box(Modifier.fillMaxHeight().fillMaxWidth(fraction).background(AetherColors.cyan, BarShape))
    }
}

@Composable
private fun bucketName(k: BucketKind): String = stringResource(
    when (k) {
        BucketKind.TODAY -> R.string.projects_rollup_today
        BucketKind.WEEK -> R.string.projects_rollup_week
        BucketKind.MONTH -> R.string.projects_rollup_month
    },
)

@Composable
private fun RollupCard(buckets: List<Bucket>) {
    val none = stringResource(R.string.projects_rollup_none)
    // A null bucket reads "no activity observed"; a real 0.0 reads "$0.00".
    val names = buckets.map { bucketName(it.kind) }
    val spoken = buckets.indices.joinToString(". ") { i -> names[i] + ", " + (bucketText(buckets[i]) ?: none) }
    Card(stringResource(R.string.projects_rollup_title) + ". " + spoken) {
        Label(stringResource(R.string.projects_rollup_title), AetherColors.warn)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            buckets.forEach { b ->
                Column(Modifier.weight(1f).aeInset().padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Label(bucketName(b.kind))
                    val t = bucketText(b)
                    if (t == null) {
                        BasicText(none, style = type.meta.copy(color = AetherColors.textMuted, fontStyle = FontStyle.Italic))
                    } else {
                        BasicText(t, style = type.data.copy(color = AetherColors.text), maxLines = 1, overflow = TextOverflow.Clip)
                    }
                }
            }
        }
        BasicText(stringResource(R.string.projects_rollup_note), style = type.meta.copy(color = AetherColors.textMuted))
    }
}

@Composable
private fun CacheCard(d: ProjectDetailUi) {
    val c = d.cache
    val hit = hitPercent(c.hitRate)
    Card(stringResource(R.string.projects_cache_title) + ", " + hit) {
        Label(stringResource(R.string.projects_cache_title))
        if (c.readTokens == 0L) {
            BasicText(stringResource(R.string.projects_cache_none), style = type.body.copy(color = AetherColors.textDim))
        } else {
            BasicText(
                stringResource(R.string.projects_cache_saved, usdPrecise(c.savedUsd)),
                style = type.data.copy(color = AetherColors.success, fontSize = 20.sp),
            )
            BasicText(
                stringResource(R.string.projects_cache_detail, tokensCompact(c.readTokens), usdPrecise(c.wouldHaveUsd), usdPrecise(c.actualUsd)),
                style = type.body.copy(color = AetherColors.textDim),
            )
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Label(stringResource(R.string.projects_hit_rate))
            BasicText(hit, style = type.data.copy(color = AetherColors.text), maxLines = 1)
        }
        Bar(hitFraction(c.hitRate), 5.dp)
    }
}

@Composable
private fun Footer(computedAtMs: Long, nowMs: Long) {
    val age = when (val a = ageLabel(computedAtMs, nowMs)) {
        AgeLabel.JustNow -> stringResource(R.string.projects_age_just_now)
        is AgeLabel.Minutes -> pluralStringResource(R.plurals.projects_age_minutes, a.n.toInt(), a.n.toInt())
        is AgeLabel.Hours -> pluralStringResource(R.plurals.projects_age_hours, a.n.toInt(), a.n.toInt())
        is AgeLabel.Days -> pluralStringResource(R.plurals.projects_age_days, a.n.toInt(), a.n.toInt())
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        BasicText(stringResource(R.string.projects_updated, age), style = type.meta.copy(color = AetherColors.textMuted))
        if (isStale(computedAtMs, nowMs)) {
            BasicText(stringResource(R.string.projects_stale), style = type.meta.copy(color = AetherColors.warn))
        }
    }
}
