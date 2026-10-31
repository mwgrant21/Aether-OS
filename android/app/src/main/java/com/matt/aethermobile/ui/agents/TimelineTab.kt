package com.matt.aethermobile.ui.agents

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import com.matt.aethermobile.R
import com.matt.aethermobile.agents.TimelineUi

/** P12 placeholder: unavailable and empty states, and a count-only fallback for items. P13 replaces the Items branch. */
@Composable
fun TimelineTab(timeline: TimelineUi) {
    val n = timelineNotice(timeline)
    when (n.key) {
        NoticeKey.TIMELINE_UNAVAILABLE -> Dim(stringResource(R.string.agents_timeline_unavailable))
        NoticeKey.TIMELINE_EMPTY -> Dim(stringResource(R.string.agents_timeline_empty))
        else -> {
            val c = n.count ?: 0
            Dim(pluralStringResource(R.plurals.agents_timeline_count, c, c))
            Dim(stringResource(R.string.agents_timeline_items_unsupported))
        }
    }
}
