package com.matt.aethermobile.ui.shell

import com.matt.aethermobile.FlowState
import com.matt.aethermobile.term.TerminalHost

/** Send is gated exactly like the key row; the field itself stays editable while this is false. */
fun composeEnabled(cur: TerminalHost.Tab?, flow: FlowState.Connected?, hostAccepts: Boolean): Boolean =
    keysEnabled(cur, flow, hostAccepts)

/**
 * Only a hand-off to the page clears the field. NOT_ACCEPTED and TOO_LARGE keep the text, so a long message
 * survives a drop or an oversize refusal (the host has already counted it in the not-sent line).
 */
fun shouldClear(r: TerminalHost.ComposeResult): Boolean = r == TerminalHost.ComposeResult.SENT
