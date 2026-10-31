package com.matt.aethermobile.ui.memory

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.matt.aethermobile.R
import com.matt.aethermobile.ledger.AgeLabel
import com.matt.aethermobile.ledger.ageLabel
import com.matt.aethermobile.ledger.isStale
import com.matt.aethermobile.memory.GroupKind
import com.matt.aethermobile.memory.MemoryFilter
import com.matt.aethermobile.memory.MemoryKind
import com.matt.aethermobile.memory.MemoryRowUi
import com.matt.aethermobile.memory.MemoryScope
import com.matt.aethermobile.memory.MemorySnapshot
import com.matt.aethermobile.memory.MemoryStatus
import com.matt.aethermobile.memory.TombstoneCause
import com.matt.aethermobile.memory.TombstoneUi
import com.matt.aethermobile.memory.memoryUi
import com.matt.aethermobile.ui.components.aeActive
import com.matt.aethermobile.ui.components.aeInset
import com.matt.aethermobile.ui.components.aeSheet
import com.matt.aethermobile.ui.components.aeSoftRow
import com.matt.aethermobile.ui.shell.mouseDragScroll
import com.matt.aethermobile.ui.theme.AetherColors
import com.matt.aethermobile.ui.theme.AetherType
import com.matt.aethermobile.views.ViewUi
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.delay

private val type = AetherType()
private const val TICK_MS = 30_000L
private val BarShape = RoundedCornerShape(3.dp)
private val SheetShape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)

/** What the open sheet shows. A live id and a tombstone id are separate number spaces, so the kind is part of the key. */
private sealed interface Open {
    data class Live(val id: Long) : Open
    data class Tomb(val id: Long) : Open
}

/**
 * Read-only Memory body: scope chips, memories grouped SHARED / per agent (or the tombstone list), and a detail bottom
 * sheet. The chip, the open row and the scroll are local state, never saved. The sheet closes on its scrim and on Back;
 * the Back handler is enabled only while a sheet is open so the shell's own Back applies otherwise. Nothing here
 * sends input, and the extraction cost the design shows is not on the wire, so it renders nothing.
 */
@Composable
fun MemoryScreen(ui: ViewUi<MemorySnapshot>, nowMs: Long, modifier: Modifier = Modifier) {
    when (ui) {
        ViewUi.Off, ViewUi.Loading -> Message(stringResource(R.string.memory_loading), modifier)
        ViewUi.NoSnapshot -> Message(stringResource(R.string.memory_no_snapshot), modifier)
        ViewUi.Unreadable -> Message(stringResource(R.string.memory_unreadable), modifier)
        ViewUi.Unsupported -> Message(stringResource(R.string.memory_unsupported), modifier)
        is ViewUi.Ready -> ReadyBody(ui.data, nowMs, modifier)
    }
}

@Composable
private fun Message(text: String, modifier: Modifier) {
    Column(modifier.padding(16.dp)) {
        BasicText(text, style = type.body.copy(color = AetherColors.textMuted))
    }
}

@Composable
private fun ReadyBody(s: MemorySnapshot, hostNowMs: Long, modifier: Modifier) {
    var ticks by remember(hostNowMs) { mutableIntStateOf(0) }
    LaunchedEffect(hostNowMs) {
        while (true) { delay(TICK_MS); ticks++ }
    }
    val now = hostNowMs + ticks * TICK_MS
    var chosen by remember { mutableStateOf<MemoryFilter>(MemoryFilter.All) }
    var open by remember { mutableStateOf<Open?>(null) }
    val scroll = rememberScrollState()

    // A chip whose agent vanished from a refreshed snapshot falls back to All.
    val first = memoryUi(s, chosen)
    val filter = if (chosen in first.chips) chosen else MemoryFilter.All
    val model = if (filter == chosen) first else memoryUi(s, filter)

    // A row that vanished from a refreshed snapshot closes the sheet rather than showing stale data.
    val shownLive: MemoryRowUi? = (open as? Open.Live)?.let { o ->
        memoryUi(s, MemoryFilter.All).groups.flatMap { it.rows }.firstOrNull { it.id == o.id }
    }
    val shownTomb: TombstoneUi? = (open as? Open.Tomb)?.let { o ->
        memoryUi(s, MemoryFilter.Tombstones).tombstones.firstOrNull { it.id == o.id }
    }
    val sheetOpen = shownLive != null || shownTomb != null
    BackHandler(enabled = sheetOpen) { open = null }

    Box(modifier) {
        Column(
            Modifier.fillMaxSize().mouseDragScroll(scroll).verticalScroll(scroll).padding(horizontal = 12.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Chips(model.chips, filter) { chosen = it }
            if (filter == MemoryFilter.Tombstones) {
                Label(stringResource(R.string.memory_tombstones_title, model.tombstones.size))
                if (model.tombstones.isEmpty()) Dim(stringResource(R.string.memory_empty_tombstones))
                model.tombstones.forEach { t -> TombRow(t) { open = Open.Tomb(t.id) } }
            } else {
                if (model.groups.all { it.rows.isEmpty() }) Dim(stringResource(R.string.memory_empty_live))
                model.groups.forEach { g ->
                    Label(
                        when (g.kind) {
                            GroupKind.SHARED -> stringResource(R.string.memory_group_shared, g.rows.size)
                            GroupKind.AGENT -> stringResource(R.string.memory_group_agent, (g.agent ?: "").uppercase(Locale.US), g.rows.size)
                        },
                    )
                    g.rows.forEach { r -> LiveRow(r) { open = Open.Live(r.id) } }
                }
            }
            Footer(model.computedAtMs, now)
        }
        if (sheetOpen) {
            Scrim { open = null }
            Box(Modifier.align(Alignment.BottomCenter)) {
                if (shownLive != null) LiveSheet(shownLive) else if (shownTomb != null) TombSheet(shownTomb)
            }
        }
    }
}

@Composable
private fun Label(text: String, color: Color = AetherColors.textLabel) {
    BasicText(text.uppercase(Locale.US), style = type.label.copy(color = color))
}

@Composable
private fun Dim(text: String) {
    BasicText(text, style = type.body.copy(color = AetherColors.textMuted), modifier = Modifier.padding(horizontal = 4.dp))
}

@Composable
private fun Chips(chips: List<MemoryFilter>, selected: MemoryFilter, onPick: (MemoryFilter) -> Unit) {
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        chips.forEach { c ->
            val label = chipLabel(c)
            val on = c == selected
            val desc = if (on) stringResource(R.string.memory_chip_selected, label) else label
            BasicText(
                label.uppercase(Locale.US),
                Modifier
                    .heightIn(min = 44.dp)
                    .then(if (on) Modifier.aeActive() else Modifier.aeInset())
                    .semantics { contentDescription = desc; role = Role.Button }
                    .clickable { onPick(c) }
                    .padding(horizontal = 14.dp, vertical = 12.dp),
                style = type.label.copy(color = if (on) AetherColors.cyanBright else AetherColors.textLabel, letterSpacing = 1.5.sp),
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun chipLabel(c: MemoryFilter): String = when (c) {
    MemoryFilter.All -> stringResource(R.string.memory_chip_all)
    MemoryFilter.Shared -> stringResource(R.string.memory_chip_shared)
    is MemoryFilter.Agent -> c.name
    MemoryFilter.Live -> stringResource(R.string.memory_chip_live)
    MemoryFilter.Tombstones -> stringResource(R.string.memory_chip_tombstones)
}

@Composable
private fun kindName(k: MemoryKind): String = stringResource(
    when (k) {
        MemoryKind.DECISION -> R.string.memory_kind_decision
        MemoryKind.PREFERENCE -> R.string.memory_kind_preference
        MemoryKind.OVERRULE -> R.string.memory_kind_overrule
        MemoryKind.HABIT -> R.string.memory_kind_habit
        MemoryKind.REVISION -> R.string.memory_kind_revision
    },
)

@Composable
private fun statusName(s: MemoryStatus): String = stringResource(
    when (s) {
        MemoryStatus.OPEN -> R.string.memory_status_open
        MemoryStatus.MOVING -> R.string.memory_status_moving
        MemoryStatus.SETTLED -> R.string.memory_status_settled
    },
)

@Composable
private fun scopeName(s: MemoryScope): String = stringResource(
    if (s == MemoryScope.SHARED) R.string.memory_scope_shared else R.string.memory_scope_private,
)

@Composable
private fun causeBadge(c: TombstoneCause): String = stringResource(
    when (c) {
        TombstoneCause.SUPERSEDED -> R.string.memory_cause_badge_superseded
        TombstoneCause.OPERATOR -> R.string.memory_cause_badge_operator
        TombstoneCause.INVALIDATED -> R.string.memory_cause_badge_invalidated
    },
)

@Composable
private fun causeText(c: TombstoneCause): String = stringResource(
    when (c) {
        TombstoneCause.SUPERSEDED -> R.string.memory_cause_superseded
        TombstoneCause.OPERATOR -> R.string.memory_cause_operator
        TombstoneCause.INVALIDATED -> R.string.memory_cause_invalidated
    },
)

private fun salienceText(v: Double): String = String.format(Locale.US, "%.2f", v)

private fun whenText(ms: Long): String = SimpleDateFormat("MMM d, h:mm a", Locale.US).format(Date(ms))

@Composable
private fun KindBadge(text: String, color: Color, modifier: Modifier = Modifier) {
    BasicText(
        text,
        modifier.border(1.dp, color, RoundedCornerShape(4.dp)).padding(vertical = 5.dp),
        style = type.label.copy(color = color, fontSize = 11.sp, letterSpacing = 1.sp, textAlign = TextAlign.Center),
        maxLines = 1, overflow = TextOverflow.Clip,
    )
}

@Composable
private fun LiveRow(r: MemoryRowUi, onClick: () -> Unit) {
    val kind = kindName(r.kind)
    val sal = salienceText(r.salience)
    val desc = stringResource(R.string.memory_row_desc, kind, r.content, sal)
    Row(
        Modifier.fillMaxWidth().aeSoftRow()
            .semantics(mergeDescendants = true) { contentDescription = desc; role = Role.Button }
            .clickable(onClick = onClick)
            .heightIn(min = 52.dp).padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        KindBadge(kind, Color(r.color), Modifier.width(78.dp))
        BasicText(
            r.content, Modifier.weight(1f),
            style = type.body.copy(color = AetherColors.textBright, fontSize = 14.sp),
            maxLines = 2, overflow = TextOverflow.Ellipsis,
        )
        BasicText(sal, style = type.data.copy(color = AetherColors.textLabel, fontSize = 11.sp), maxLines = 1)
    }
}

@Composable
private fun TombRow(t: TombstoneUi, onClick: () -> Unit) {
    val scope = scopeName(t.scope)
    val desc = stringResource(R.string.memory_tomb_row_desc, scope, t.content)
    Row(
        Modifier.fillMaxWidth().aeSoftRow()
            .semantics(mergeDescendants = true) { contentDescription = desc; role = Role.Button }
            .clickable(onClick = onClick)
            .heightIn(min = 52.dp).padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        KindBadge(causeBadge(t.cause), AetherColors.textDim, Modifier.width(78.dp))
        BasicText(
            t.content, Modifier.weight(1f),
            style = type.body.copy(color = AetherColors.textDim, fontSize = 14.sp),
            maxLines = 2, overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun Scrim(onDismiss: () -> Unit) {
    val dismiss = stringResource(R.string.memory_sheet_dismiss)
    Box(
        Modifier.fillMaxSize().background(Color(2, 10, 16, 166))
            .semantics { contentDescription = dismiss; role = Role.Button }
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onDismiss),
    )
}

@Composable
private fun Sheet(content: @Composable () -> Unit) {
    val label = stringResource(R.string.memory_sheet_label)
    Column(
        Modifier.fillMaxWidth().fillMaxHeight(0.75f).aeSheet(SheetShape)
            .semantics { contentDescription = label }
            // Swallow taps so a press inside the sheet never reaches the scrim.
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {}
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Box(Modifier.fillMaxWidth().height(18.dp), contentAlignment = Alignment.Center) {
            Box(Modifier.width(40.dp).height(4.dp).background(Color(126, 240, 255, 89), RoundedCornerShape(2.dp)))
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            content()
        }
    }
}

@Composable
private fun Badge(text: String, color: Color) {
    BasicText(
        text,
        Modifier.border(1.dp, color, RoundedCornerShape(4.dp)).padding(horizontal = 8.dp, vertical = 5.dp),
        style = type.label.copy(color = color, fontSize = 11.sp, letterSpacing = 1.sp),
        maxLines = 1,
    )
}

@Composable
private fun Badges(items: List<Pair<String, Color>>) {
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items.forEach { (t, c) -> Badge(t, c) }
    }
}

@Composable
private fun LiveSheet(r: MemoryRowUi) {
    val created = whenText(r.createdAtMs)
    val whenLine = r.updatedAtMs?.let { stringResource(R.string.memory_sheet_when_updated, created, whenText(it)) } ?: created
    Sheet {
        val badges = ArrayList<Pair<String, Color>>()
        badges += kindName(r.kind) to Color(r.color)
        r.status?.let { badges += statusName(it) to AetherColors.textDim }
        Badges(badges)
        BasicText(whenLine, style = type.data.copy(color = AetherColors.textDim, fontSize = 11.sp))
        r.subject?.let { BasicText(it, style = type.title.copy(color = AetherColors.textBright)) }
        Label(stringResource(R.string.memory_sheet_content), AetherColors.textMuted)
        BasicText(r.content, style = type.body.copy(color = AetherColors.text, fontSize = 17.sp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Label(stringResource(R.string.memory_sheet_salience), AetherColors.textMuted)
            Box(Modifier.weight(1f).height(5.dp).background(AetherColors.border, BarShape)) {
                Box(Modifier.fillMaxHeight().fillMaxWidth(r.salienceBar.toFloat()).background(AetherColors.cyan, BarShape))
            }
            BasicText(salienceText(r.salience), style = type.data.copy(color = AetherColors.text, fontSize = 12.sp), maxLines = 1)
        }
    }
}

@Composable
private fun TombSheet(t: TombstoneUi) {
    // The model carries the successor as its English line "superseded by #N"; only the number is taken from it.
    val sup = t.supersededBy?.substringAfter('#', "")?.takeIf { it.isNotEmpty() }
    Sheet {
        val badges = ArrayList<Pair<String, Color>>()
        badges += scopeName(t.scope) to AetherColors.textDim
        t.owner?.takeIf { it.isNotEmpty() }?.let { badges += it to AetherColors.textDim }
        Badges(badges)
        BasicText(
            stringResource(R.string.memory_sheet_when_deleted, whenText(t.deletedAtMs)),
            style = type.data.copy(color = AetherColors.textDim, fontSize = 11.sp),
        )
        Label(stringResource(R.string.memory_sheet_content), AetherColors.textMuted)
        BasicText(t.content, style = type.body.copy(color = AetherColors.text, fontSize = 17.sp))
        Label(stringResource(R.string.memory_sheet_cause), AetherColors.textMuted)
        BasicText(causeText(t.cause), style = type.body.copy(color = AetherColors.text, fontSize = 15.sp))
        if (sup != null) {
            BasicText(
                stringResource(R.string.memory_sheet_superseded_by, sup),
                style = type.data.copy(color = AetherColors.textDim, fontSize = 11.sp),
            )
        }
    }
}

@Composable
private fun Footer(computedAtMs: Long, nowMs: Long) {
    val age = when (val a = ageLabel(computedAtMs, nowMs)) {
        AgeLabel.JustNow -> stringResource(R.string.memory_age_just_now)
        is AgeLabel.Minutes -> pluralStringResource(R.plurals.memory_age_minutes, a.n.toInt(), a.n.toInt())
        is AgeLabel.Hours -> pluralStringResource(R.plurals.memory_age_hours, a.n.toInt(), a.n.toInt())
        is AgeLabel.Days -> pluralStringResource(R.plurals.memory_age_days, a.n.toInt(), a.n.toInt())
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        BasicText(stringResource(R.string.memory_updated, age), style = type.meta.copy(color = AetherColors.textMuted))
        if (isStale(computedAtMs, nowMs)) {
            BasicText(stringResource(R.string.memory_stale), style = type.meta.copy(color = AetherColors.warn))
        }
    }
}
