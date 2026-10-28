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

/**
 * The draft survives a drop (Connecting, Error, Connected again) because it lives above the connected-only branch,
 * but a relock or an unpaired app wipes it: Locked and NeedsPair clear it so no message text outlives the unlock.
 */
fun clearsDraft(flow: FlowState): Boolean = flow is FlowState.Locked || flow is FlowState.NeedsPair

/**
 * Drops a Send tap that lands within [windowMs] of the last accepted one, so a double-tap cannot hand off the text and
 * then a bare Enter (an empty bar + Send presses Enter once). Only a SENT result starts the window; a refusal does not.
 * Time is passed in so the decision stays pure.
 */
class SendGate(private val windowMs: Long = 400L) {
    private var lastSentAt: Long? = null

    /** Runs [compose] unless inside the window; null means the tap was dropped. */
    fun attempt(nowMs: Long, compose: () -> TerminalHost.ComposeResult): TerminalHost.ComposeResult? {
        val last = lastSentAt
        if (last != null && nowMs - last < windowMs) return null
        val r = compose()
        if (r == TerminalHost.ComposeResult.SENT) lastSentAt = nowMs
        return r
    }
}
