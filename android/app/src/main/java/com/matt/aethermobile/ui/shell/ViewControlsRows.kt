package com.matt.aethermobile.ui.shell

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.matt.aethermobile.R
import com.matt.aethermobile.ui.components.AeSecondaryButton
import com.matt.aethermobile.ui.components.aeActive
import com.matt.aethermobile.ui.theme.AetherColors
import com.matt.aethermobile.ui.theme.AetherDimens
import com.matt.aethermobile.ui.theme.AetherType

private val dims = AetherDimens()
private val type = AetherType()

/** Burger "View" group under the screen share row: text size (shared Raw/Thread zoom) and orientation lock. */
@Composable
internal fun ViewControlsRows(ui: ViewCtlUi, actions: ShellActions) {
    val readout = if (ui.zoomPx == 0) stringResource(R.string.viewctl_fit) else ui.zoomPx.toString()
    val sizeDesc = stringResource(R.string.viewctl_text_size_desc, readout)
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        BasicText(
            stringResource(R.string.viewctl_header).uppercase(),
            style = type.label.copy(color = AetherColors.textLabel),
            modifier = Modifier.padding(top = 6.dp),
        )
        Row(
            Modifier.fillMaxWidth().heightIn(min = dims.touchMin).padding(horizontal = 12.dp).semantics { contentDescription = sizeDesc },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            BasicText(
                stringResource(R.string.viewctl_text_size),
                style = type.body.copy(color = AetherColors.textBright),
                modifier = Modifier.weight(1f),
            )
            BasicText(readout, style = type.body.copy(color = AetherColors.textBright))
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AeSecondaryButton(stringResource(R.string.action_zoom_out), actions.onZoomOut, Modifier.weight(1f).heightIn(min = dims.touchMin))
            AeSecondaryButton(stringResource(R.string.action_zoom_in), actions.onZoomIn, Modifier.weight(1f).heightIn(min = dims.touchMin))
            AeSecondaryButton(stringResource(R.string.action_fit), actions.onFit, Modifier.weight(1f).heightIn(min = dims.touchMin))
        }
        BasicText(
            stringResource(R.string.viewctl_orientation),
            style = type.body.copy(color = AetherColors.textBright),
            modifier = Modifier.padding(horizontal = 12.dp),
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OrientButton(R.string.viewctl_orient_auto, R.string.viewctl_orient_auto_desc, OrientationMode.AUTO, ui, actions, Modifier.weight(1f))
            OrientButton(R.string.viewctl_orient_portrait, R.string.viewctl_orient_portrait_desc, OrientationMode.PORTRAIT, ui, actions, Modifier.weight(1f))
            OrientButton(R.string.viewctl_orient_landscape, R.string.viewctl_orient_landscape_desc, OrientationMode.LANDSCAPE, ui, actions, Modifier.weight(1f))
        }
    }
}

@Composable
private fun OrientButton(
    label: Int,
    desc: Int,
    mode: OrientationMode,
    ui: ViewCtlUi,
    actions: ShellActions,
    modifier: Modifier,
) {
    val selected = ui.orientation == mode
    val d = stringResource(desc)
    AeSecondaryButton(
        stringResource(label),
        { actions.onSetOrientation(mode) },
        modifier
            .heightIn(min = dims.touchMin)
            .then(if (selected) Modifier.aeActive() else Modifier)
            .semantics { contentDescription = d; this.selected = selected },
    )
}
