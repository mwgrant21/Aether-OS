package com.matt.aethermobile.ui.shell

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.matt.aethermobile.R
import com.matt.aethermobile.ui.components.AeSecondaryButton

/** The COPY / CANCEL bar shows only in Raw, while connected, and while the page reports a selection. */
fun selectionBarVisible(rawBody: Boolean, selection: Boolean, connected: Boolean): Boolean =
    rawBody && selection && connected

@Composable
fun SelectionBar(onCopy: () -> Unit, onCancel: () -> Unit) {
    val copyDesc = stringResource(R.string.sel_copy_desc)
    val cancelDesc = stringResource(R.string.sel_cancel_desc)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        AeSecondaryButton(stringResource(R.string.sel_copy), onCopy, Modifier.weight(1f).semantics { contentDescription = copyDesc })
        AeSecondaryButton(stringResource(R.string.sel_cancel), onCancel, Modifier.weight(1f).semantics { contentDescription = cancelDesc })
    }
}
