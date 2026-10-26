package com.matt.aethermobile.ui.components

import com.matt.aethermobile.protocol.ControlProtocol

/** Design rule 1: glow means live. Only [LiveGlow] glows. */
enum class DotStyle(val glows: Boolean) {
    LiveGlow(true),
    HollowRing(false),
    Flat(false),
}

fun dotStyleFor(state: ControlProtocol.SlotState): DotStyle = when (state) {
    ControlProtocol.SlotState.RUNNING -> DotStyle.LiveGlow
    ControlProtocol.SlotState.NOT_STARTED -> DotStyle.HollowRing
    ControlProtocol.SlotState.EXITED -> DotStyle.Flat
}
