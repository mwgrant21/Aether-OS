package com.matt.aethermobile.ui.agents

import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.matt.aethermobile.R
import com.matt.aethermobile.agents.FleetUi
import com.matt.aethermobile.ui.theme.AetherColors

/** P12 placeholder: only the unavailable and empty states. P13 fills in [FleetUi.Rows]. */
@Composable
fun FleetTab(fleet: FleetUi) {
    when (fleet) {
        is FleetUi.Unavailable -> Dim(stringResource(R.string.agents_fleet_unavailable))
        is FleetUi.Empty -> Dim(stringResource(R.string.agents_fleet_empty))
        is FleetUi.Rows -> Unit
    }
}

@Composable
internal fun Dim(text: String) {
    BasicText(text, style = type.body.copy(color = AetherColors.textMuted))
}
