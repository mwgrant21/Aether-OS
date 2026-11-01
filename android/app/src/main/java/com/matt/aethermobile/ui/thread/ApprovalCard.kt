package com.matt.aethermobile.ui.thread

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.matt.aethermobile.R
import com.matt.aethermobile.ui.theme.AetherColors
import com.matt.aethermobile.ui.theme.AetherDimens
import com.matt.aethermobile.ui.theme.AetherType

private val type = AetherType()
private val dims = AetherDimens()
private val CardShape = RoundedCornerShape(dims.rCard)
private val ButtonShape = RoundedCornerShape(10.dp)
private val TagShape = RoundedCornerShape(4.dp)
private val BoxShape = RoundedCornerShape(8.dp)
private val ButtonText = type.body.copy(fontWeight = FontWeight.Bold, fontSize = 14.sp, letterSpacing = 2.sp, textAlign = TextAlign.Center)

private fun roleColor(role: RiskRole): Color = when (role) {
    RiskRole.SUCCESS -> AetherColors.success
    RiskRole.WARN -> AetherColors.warn
    RiskRole.DANGER -> AetherColors.danger
}

/** Display-only approval card. Renders the [ApprovalView] it is given; DENY and ALLOW are inert, disabled boxes. */
@Composable
fun ApprovalCard(view: ApprovalView, modifier: Modifier = Modifier) {
    val disabledDesc = stringResource(R.string.approval_decisions_disabled_desc)
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 4.dp)
            .background(AetherColors.insetTop, CardShape)
            .border(1.dp, AetherColors.warn, CardShape)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            BasicText(
                view.risk.name,
                Modifier.background(roleColor(riskRole(view.risk)), TagShape).padding(horizontal = 6.dp, vertical = 2.dp),
                style = type.meta.copy(color = AetherColors.bgDeep, fontWeight = FontWeight.Bold),
            )
            BasicText(view.toolLabel, style = type.body.copy(color = AetherColors.textBright, fontWeight = FontWeight.SemiBold))
            Spacer(Modifier.weight(1f))
            if (view.moreCount > 0) {
                BasicText(stringResource(R.string.approval_more, view.moreCount.toString()), style = type.meta.copy(color = AetherColors.textMuted))
            }
            if (view.expired) {
                BasicText(stringResource(R.string.approval_expired), style = type.meta.copy(color = AetherColors.danger))
            } else {
                BasicText(stringResource(R.string.approval_left, view.countdown), style = type.meta.copy(color = AetherColors.warn))
            }
        }
        Box(Modifier.fillMaxWidth().background(AetherColors.bgDeep, BoxShape).border(1.dp, AetherColors.border, BoxShape).padding(8.dp)) {
            BasicText(view.summary, style = type.meta.copy(color = AetherColors.text), maxLines = 12, overflow = TextOverflow.Ellipsis)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(
                Modifier
                    .weight(1f)
                    .heightIn(min = 44.dp)
                    .alpha(0.45f)
                    .semantics { contentDescription = disabledDesc; disabled() }
                    .background(AetherColors.dangerSoft.copy(alpha = 0.14f), ButtonShape)
                    .border(1.dp, AetherColors.dangerSoft.copy(alpha = 0.40f), ButtonShape),
                contentAlignment = Alignment.Center,
            ) {
                BasicText(stringResource(R.string.approval_deny), style = ButtonText.copy(color = AetherColors.dangerSoft))
            }
            Box(
                Modifier
                    .weight(1f)
                    .heightIn(min = 44.dp)
                    .alpha(0.45f)
                    .semantics { contentDescription = disabledDesc; disabled() }
                    .background(AetherColors.success.copy(alpha = 0.18f), ButtonShape)
                    .border(1.dp, AetherColors.success.copy(alpha = 0.40f), ButtonShape),
                contentAlignment = Alignment.Center,
            ) {
                BasicText(stringResource(R.string.approval_allow), style = ButtonText.copy(color = AetherColors.success))
            }
        }
        BasicText(stringResource(R.string.approval_hint), style = type.meta.copy(color = AetherColors.textMuted))
    }
}
