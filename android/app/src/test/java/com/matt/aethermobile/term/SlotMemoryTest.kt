package com.matt.aethermobile.term

import com.matt.aethermobile.protocol.ControlProtocol.SessionInfo
import com.matt.aethermobile.protocol.ControlProtocol.SlotState
import org.junit.Assert.assertEquals
import org.junit.Test

class SlotMemoryTest {
    private class FakeStore(var value: String? = null, val throws: Boolean = false) : SlotStore {
        var puts = 0
        override fun get(): String? = if (throws) throw IllegalStateException("boom") else value
        override fun put(slot: String) { if (throws) throw IllegalStateException("boom"); puts++; value = slot }
    }

    private fun sess(c: SlotState, t2: SlotState, x: SlotState) = listOf(
        SessionInfo("claude", "Terminal", c, 100, 30, 0),
        SessionInfo("terminal2", "Terminal 2", t2, 100, 30, 0),
        SessionInfo("codex", "Codex", x, 100, 30, 0),
    )

    private val R = SlotState.RUNNING
    private val E = SlotState.EXITED
    private val N = SlotState.NOT_STARTED

    @Test fun storedRunningSlotWins() {
        assertEquals("terminal2", SlotMemory(FakeStore("terminal2")).pick(sess(R, R, R)))
    }

    @Test fun storedNotRunningFallsBackToFirstRunning() {
        assertEquals("terminal2", SlotMemory(FakeStore("codex")).pick(sess(E, R, E)))
        assertEquals("claude", SlotMemory(FakeStore("codex")).pick(sess(R, R, N)))
    }

    @Test fun nothingStoredPicksFirstRunning() {
        assertEquals("terminal2", SlotMemory(FakeStore()).pick(sess(N, R, R)))
    }

    @Test fun nothingRunningAndNothingStoredIsClaude() {
        assertEquals("claude", SlotMemory(FakeStore()).pick(sess(E, N, E)))
    }

    @Test fun bogusStoredValueIsIgnored() {
        assertEquals("codex", SlotMemory(FakeStore("powershell")).pick(sess(E, E, R)))
    }

    @Test fun rememberIgnoresUnknownSlot() {
        val s = FakeStore()
        SlotMemory(s).remember("bogus")
        assertEquals(0, s.puts)
        assertEquals(null, s.value)
    }

    @Test fun fallbackNeverOverwritesStoredPreference() {
        val s = FakeStore("terminal2")
        val m = SlotMemory(s)
        assertEquals("claude", m.pick(sess(R, E, N)))
        assertEquals("terminal2", s.value)
        assertEquals("terminal2", m.pick(sess(R, R, N)))
        assertEquals(0, s.puts)
    }

    @Test fun throwingStoreStillYieldsValidSlot() {
        val m = SlotMemory(FakeStore(throws = true))
        m.remember("codex")
        assertEquals("terminal2", m.pick(sess(N, R, R)))
    }
}
