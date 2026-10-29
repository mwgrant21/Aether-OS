package com.matt.aethermobile.ui.shell

import com.matt.aethermobile.FlowState
import com.matt.aethermobile.protocol.ControlProtocol.SlotState
import com.matt.aethermobile.term.TerminalHost

/** The only slot the desktop respawns from a bare Enter. */
const val RESTART_SLOT = "terminal2"

/** The Restart row shows only for an exited terminal2 tab while connected and the host agrees. */
fun restartVisible(cur: TerminalHost.Tab?, flow: FlowState.Connected?, hostRestartable: Boolean): Boolean =
    hostRestartable && flow != null && cur != null && cur.s == RESTART_SLOT && cur.state == SlotState.EXITED

/** Runs [restart] through [gate]; null = tap dropped inside the 400 ms window. A refused restart does not start the window. */
fun attemptRestart(gate: SendGate, nowMs: Long, restart: () -> Boolean): Boolean? =
    gate.attempt(nowMs) { if (restart()) TerminalHost.ComposeResult.SENT else TerminalHost.ComposeResult.NOT_ACCEPTED }
        ?.let { it == TerminalHost.ComposeResult.SENT }
