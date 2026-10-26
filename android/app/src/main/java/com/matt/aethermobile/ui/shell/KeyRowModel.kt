package com.matt.aethermobile.ui.shell

import com.matt.aethermobile.FlowState
import com.matt.aethermobile.protocol.ControlProtocol.SlotState
import com.matt.aethermobile.term.InputSender
import com.matt.aethermobile.term.TerminalHost

/** Keys on the key row. [CTRL] is a latch, never sent itself; every other key sends [bytes]. */
enum class Key(val bytes: String) {
    ESC("\u001b"),
    TAB("\t"),
    CTRL(""),
    UP("\u001b[A"),
    DOWN("\u001b[B"),
    RIGHT("\u001b[C"),
    LEFT("\u001b[D"),
    PIPE("|"),
    SLASH("/"),
    DASH("-"),
    Y("y"),
    N("n"),
}

/** Left-to-right order on the row. */
val KEY_ORDER: List<Key> = listOf(
    Key.ESC, Key.TAB, Key.CTRL, Key.UP, Key.DOWN, Key.LEFT, Key.RIGHT, Key.PIPE, Key.SLASH, Key.DASH, Key.Y, Key.N,
)

/**
 * Mirrors the host's typing gate (connected, the slot RUNNING): the row is disabled whenever the host would
 * drop the keys. The host re-checks (active, attached, RUNNING) in sendKeys; this keeps the UI honest.
 */
fun keysEnabled(cur: TerminalHost.Tab?, flow: FlowState.Connected?): Boolean =
    flow != null && cur != null && cur.state == SlotState.RUNNING

/** Chars not sent since the last successful ack or slot switch, and why the last whole-input refusal happened. */
data class NotSentNotice(val chars: Int = 0, val refusal: InputSender.Refusal? = null) {
    val visible: Boolean get() = chars > 0
    fun add(n: Int) = copy(chars = chars + n)
    fun refused(r: InputSender.Refusal) = copy(refusal = r)
    companion object {
        val NONE = NotSentNotice()
    }
}
