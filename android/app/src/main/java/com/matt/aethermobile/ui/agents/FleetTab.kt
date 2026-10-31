package com.matt.aethermobile.ui.agents

import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import com.matt.aethermobile.R
import com.matt.aethermobile.agents.FleetUi
import com.matt.aethermobile.ui.theme.AetherColors

/** P12 placeholder: unavailable and empty states, and a count-only fallback for rows. P13 replaces the Rows branch. */
@Composable
fun FleetTab(fleet: FleetUi) {
    val n = fleetNotice(fleet)
    when (n.key) {
        NoticeKey.FLEET_UNAVAILABLE -> Dim(stringResource(R.string.agents_fleet_unavailable))
        NoticeKey.FLEET_EMPTY -> Dim(stringResource(R.string.agents_fleet_empty))
        else -> {
            val c = n.count ?: 0
            Dim(pluralStringResource(R.plurals.agents_fleet_count, c, c))
            Dim(stringResource(R.string.agents_fleet_rows_unsupported))
        }
    }
}

@Composable
internal fun Dim(text: String) {
    BasicText(text, style = type.body.copy(color = AetherColors.textMuted))
}
