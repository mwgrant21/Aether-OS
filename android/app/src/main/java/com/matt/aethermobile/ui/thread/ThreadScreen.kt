package com.matt.aethermobile.ui.thread

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import com.matt.aethermobile.R
import com.matt.aethermobile.protocol.ControlProtocol.ThreadMeta
import com.matt.aethermobile.ui.components.AeScreenBackground
import com.matt.aethermobile.ui.components.AeSecondaryButton
import com.matt.aethermobile.ui.components.aeSoftRow
import com.matt.aethermobile.ui.theme.AetherColors
import com.matt.aethermobile.ui.theme.AetherTheme
import com.matt.aethermobile.ui.theme.Rajdhani
import com.matt.aethermobile.ui.theme.SpaceMono
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.min

private val MetaStyle = TextStyle(fontFamily = SpaceMono, fontWeight = FontWeight.Normal, fontSize = 11.sp, color = AetherColors.textMuted)

/**
 * The read-only 1a session thread. State lives in the caller (A5 over A2's ThreadHost): [rows] come from
 * [ThreadUiModel.rowsFor], [meta] is the latest tmeta, [serverOffsetMs] is `serverTimeMs - now` captured at
 * Connected. There is no text field, no selection and no clipboard use anywhere in this package.
 *
 * [headerStart] is the slot left of the context bar (A5 puts the THREAD | TERM switch there).
 */
@Composable
fun ThreadScreen(
    rows: List<ThreadRow>,
    meta: ThreadMeta,
    serverOffsetMs: Long,
    onToggle: (String) -> Unit,
    onOpenTerminal: () -> Unit,
    modifier: Modifier = Modifier,
    headerStart: @Composable () -> Unit = {},
) {
    // 1 Hz tick for the working/last-activity text, only while the screen is RESUMED.
    val lifecycleState by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val resumed = lifecycleState.isAtLeast(Lifecycle.State.RESUMED)
    var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(resumed) {
        while (resumed) {
            nowMs = System.currentTimeMillis()
            delay(1000)
        }
    }

    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    // Follow the tail only while the user is at the bottom; updated when a scroll settles, never by new content.
    var follow by remember { mutableStateOf(true) }
    LaunchedEffect(listState) {
        snapshotFlow { listState.isScrollInProgress }.collect { moving ->
            if (!moving) follow = !listState.canScrollForward
        }
    }
    val last = rows.lastOrNull()
    LaunchedEffect(last, rows.size) {
        if (follow && rows.isNotEmpty()) {
            listState.scrollToItem(rows.size - 1)
            listState.scrollBy(100_000f)
        }
    }
    val atBottom by remember { derivedStateOf { !listState.canScrollForward } }

    val banner = ThreadUiModel.bannerFor(meta, ThreadViewMode.THREAD)
    val working = ThreadUiModel.workingText(meta, nowMs, serverOffsetMs)
    val lastActivity = ThreadUiModel.lastActivityText(meta, nowMs, serverOffsetMs)

    AetherTheme {
        AeScreenBackground(modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize()) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    headerStart()
                    CtxBar(meta)
                }
                if (banner != null) {
                    Column(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp).aeSoftRow().padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        BasicText(bannerText(banner.stringName), style = MetaStyle.copy(fontSize = 12.sp, color = AetherColors.warnSoft))
                        AeSecondaryButton(stringResource(R.string.thread_open_terminal), onOpenTerminal)
                    }
                }
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    LazyColumn(
                        state = listState,
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 18.dp, bottom = 10.dp),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        // The diff block shares its tool row's entry id, so the key includes the row kind.
                        items(rows, key = { "${it::class.simpleName}:${it.id}" }, contentType = { it::class }) { row ->
                            ThreadRowItem(row, onToggle)
                        }
                    }
                    if (!atBottom) {
                        Box(
                            Modifier
                                .align(Alignment.BottomCenter)
                                .padding(bottom = 10.dp)
                                .heightIn(min = 44.dp)
                                .clip(RoundedCornerShape(22.dp))
                                .background(AetherColors.activeFill)
                                .border(1.dp, AetherColors.activeBorder, RoundedCornerShape(22.dp))
                                .clickable(role = Role.Button) {
                                    follow = true
                                    scope.launch {
                                        if (rows.isNotEmpty()) {
                                            listState.scrollToItem(rows.size - 1)
                                            listState.scrollBy(100_000f)
                                        }
                                    }
                                }
                                .padding(horizontal = 18.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            BasicText(
                                stringResource(R.string.thread_new_pill),
                                style = TextStyle(fontFamily = Rajdhani, fontWeight = FontWeight.Bold, fontSize = 14.sp, letterSpacing = 2.sp, color = AetherColors.cyanBright),
                            )
                        }
                    }
                }
                val status = working ?: lastActivity
                if (status != null) {
                    BasicText(status, style = MetaStyle, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
                }
                BasicText(
                    stringResource(R.string.thread_read_only),
                    style = MetaStyle.copy(fontSize = 12.sp),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                )
            }
        }
    }
}

/** 5 dp bar + "CTX 36.9%". Shows only the text when only a token count is known, nothing when neither is. */
@Composable
private fun CtxBar(meta: ThreadMeta) {
    val text = ThreadUiModel.ctxText(meta) ?: return
    val pct = meta.ctxPct?.takeIf { !it.isNaN() && it > 0.0 }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (pct != null) {
            Box(Modifier.width(56.dp).height(5.dp).clip(RoundedCornerShape(3.dp)).background(AetherColors.border)) {
                Box(Modifier.fillMaxHeight().fillMaxWidth(min(pct, 100.0).toFloat() / 100f).background(AetherColors.cyan))
            }
        }
        BasicText(text, style = MetaStyle.copy(color = AetherColors.cyan))
    }
}

@Composable
private fun bannerText(stringName: String): String = when (stringName) {
    "thread_banner_perm" -> stringResource(R.string.thread_banner_perm)
    else -> stringResource(R.string.thread_banner_quiet)
}
