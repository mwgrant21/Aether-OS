package com.matt.aethermobile.ui.agents

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.matt.aethermobile.R
import com.matt.aethermobile.agents.TimelineUi

/** P12 placeholder: only the unavailable and empty states. P13 fills in [TimelineUi.Items]. */
@Composable
fun TimelineTab(timeline: TimelineUi) {
    when (timeline) {
        is TimelineUi.Unavailable -> Dim(stringResource(R.string.agents_timeline_unavailable))
        is TimelineUi.Empty -> Dim(stringResource(R.string.agents_timeline_empty))
        is TimelineUi.Items -> Unit
    }
}
