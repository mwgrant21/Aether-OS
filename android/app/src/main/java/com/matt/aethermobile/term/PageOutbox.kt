package com.matt.aethermobile.term

/**
 * Host -> page delivery state, main thread only except [generation]. Messages are tagged with the
 * generation current when they were posted; [reset] bumps it so a delivery already queued on the
 * main looper cannot reach the next page. Before the page is ready a bounded backlog is held; on
 * overflow it is dropped and [onResync] runs once the page is ready, so the host can re-attach.
 */
class PageOutbox(private val max: Int, private val onResync: () -> Unit) {
    @Volatile
    var generation = 0
        private set
    private var send: ((String) -> Unit)? = null
    private val queued = ArrayList<String>()
    private var overflowed = false

    fun submit(gen: Int, msg: String) {
        if (gen != generation) return
        val s = send
        if (s != null) { s(msg); return }
        if (overflowed) return
        if (queued.size >= max) {
            queued.clear()
            overflowed = true
            return
        }
        queued.add(msg)
    }

    fun ready(sender: (String) -> Unit) {
        send = sender
        queued.forEach(sender)
        queued.clear()
        if (overflowed) {
            overflowed = false
            onResync()
        }
    }

    fun reset() {
        generation++
        send = null
        queued.clear()
        overflowed = false
    }
}
