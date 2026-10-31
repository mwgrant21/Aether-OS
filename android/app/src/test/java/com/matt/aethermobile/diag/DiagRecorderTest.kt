package com.matt.aethermobile.diag

import android.view.InputDevice
import android.view.MotionEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

class DiagRecorderTest {
    private var now = 0L
    private val rec = DiagRecorder({ now }).also { it.enabled = true }

    private fun mv(action: Int = 2, src: Int = 0x2002, btn: Int = 1, x: Int = 120, y: Int = 340) =
        DiagEvent.Motion(src, action, btn, 0f, 0f, listOf(DiagEvent.Ptr(3, x, y)))

    private fun layout(ime: Boolean = false) = DiagEvent.Layout(2, 1, 2, ime, if (ime) 800 else 0, 2340, 1080)

    @Test fun ringCapsAndCountsDropped() {
        val r = DiagRing(500)
        for (i in 1..503) r.add("l$i")
        val s = r.snapshot()
        assertEquals(500, s.size)
        assertEquals(3, r.dropped)
        assertEquals("l4", s.first())
        assertEquals("l503", s.last())
        r.clear()
        assertEquals(0, r.snapshot().size)
        assertEquals(0, r.dropped)
    }

    @Test fun disabledRecordsNothing() {
        rec.enabled = false
        rec.record(mv())
        assertTrue(rec.ring.snapshot().isEmpty())
    }

    @Test fun formatsMouseMove() {
        now = 1234
        rec.record(mv())
        assertEquals("+1.234 M src=0x2002(MOUSE) act=MOVE btn=1 vs=0.0 hs=0.0 p0=MOUSE@120,340", rec.ring.snapshot()[0])
    }

    @Test fun formatsScroll() {
        rec.record(DiagEvent.Motion(0x2002, 8, 0, -1f, 0f, listOf(DiagEvent.Ptr(3, 5, 6))))
        assertTrue(rec.ring.snapshot()[0].contains("act=SCROLL btn=0 vs=-1.0 hs=0.0"))
    }

    @Test fun formatsMultiPointerTouch() {
        rec.record(DiagEvent.Motion(0x1002, 5, 0, 0f, 0f, listOf(DiagEvent.Ptr(1, 10, 20), DiagEvent.Ptr(1, 30, 40))))
        val l = rec.ring.snapshot()[0]
        assertTrue(l, l.contains("src=0x1002(TOUCHSCREEN) act=POINTER_DOWN"))
        assertTrue(l, l.endsWith("p0=FINGER@10,20 p1=FINGER@30,40"))
    }

    @Test fun coalescesFastMoves() {
        for (t in listOf(0L, 10L, 20L)) { now = t; rec.record(mv(x = t.toInt())) }
        assertEquals(1, rec.ring.snapshot().size)
        now = 25
        rec.record(mv(action = 1))
        val s = rec.ring.snapshot()
        assertEquals("# coalesced 2 moves", s[1])
        assertTrue(s[2].contains("act=UP"))
    }

    @Test fun moveAfter41msIsKept() {
        now = 0; rec.record(mv())
        now = 41; rec.record(mv())
        assertEquals(2, rec.ring.snapshot().size)
    }

    @Test fun layoutDedup() {
        rec.record(layout()); rec.record(layout()); rec.record(layout(ime = true)); rec.record(layout())
        assertEquals(3, rec.ring.snapshot().size)
        assertTrue(rec.ring.snapshot()[0].contains("L orient=2 kb=1 hkh=2 ime=no/0 win=2340x1080"))
    }

    @Test fun clearRestartsLog() {
        rec.record(layout())
        rec.clear()
        assertTrue(rec.ring.snapshot().isEmpty())
        rec.record(layout())
        assertEquals(1, rec.ring.snapshot().size)
    }

    @Test fun dumpIsRedactedAndSampleFormat() {
        rec.record(mv()); rec.record(layout())
        rec.record(DiagEvent.Motion(0x2002, 8, 0, -1f, 0f, listOf(DiagEvent.Ptr(3, 5, 6))))
        rec.record(DiagEvent.Page(PageKind.POINTER, PageAction.MOVE, PagePointer.MOUSE, 0, 1, 0, 0, 0, 12, -3, 0))
        rec.record(DiagEvent.Motion(0x1002, 5, 0, 0f, 0f, listOf(DiagEvent.Ptr(1, 10, 20), DiagEvent.Ptr(1, 30, 40))))
        val out = rec.dump(listOf("Aether input diagnostic", "app 1.0 x", "device Google Pixel sdk=35 debuggable=no"))
        println("--- sample dump ---\n$out--- end ---")
        val ok = Regex("^[A-Za-z0-9 _=.,:+#()/@<>-]*$")
        out.lines().forEach { assertTrue("bad line: $it", ok.matches(it)) }
        assertFalse(out.contains("tailnet"))
        assertFalse(out.contains("100."))
    }

    @Test fun dumpReportsDropped() {
        val r = DiagRecorder({ 0 }, DiagRing(2)).also { it.enabled = true }
        for (i in 1..3) r.record(DiagEvent.Page(PageKind.WHEEL, PageAction.WHEEL, PagePointer.NONE, 0, 0, 0, i, 0, 0, 0, 0))
        val lines = r.dump(listOf("h")).trim().lines()
        assertEquals(listOf("h", "# dropped=1"), lines.take(2))
        assertEquals(4, lines.size)
    }

    @Test fun fileNameAndToasts() {
        assertEquals("aether-input-diag-19700101-000000.txt", diagFileName(0, ZoneId.of("UTC")))
        assertEquals("Saved a.txt to Downloads", saveToastText(SaveResult.Downloads("a.txt")))
        assertEquals("Saved a.txt to /p/a.txt (Downloads unavailable)", saveToastText(SaveResult.AppDir("a.txt", "/p/a.txt")))
        assertEquals("Could not save log", saveToastText(SaveResult.Failed))
    }

    @Test fun mirroredConstantsMatchAndroid() {
        assertEquals(InputDevice.SOURCE_TOUCHSCREEN, 0x1002)
        assertEquals(InputDevice.SOURCE_MOUSE, 0x2002)
        assertEquals(InputDevice.SOURCE_STYLUS, 0x4002)
        assertEquals(MotionEvent.ACTION_MOVE, DiagRecorder.ACT_MOVE)
        assertEquals(MotionEvent.ACTION_HOVER_MOVE, DiagRecorder.ACT_HOVER_MOVE)
        assertEquals("DOWN", actionName(MotionEvent.ACTION_DOWN))
        assertEquals("UP", actionName(MotionEvent.ACTION_UP))
        assertEquals("CANCEL", actionName(MotionEvent.ACTION_CANCEL))
        assertEquals("OUTSIDE", actionName(MotionEvent.ACTION_OUTSIDE))
        assertEquals("POINTER_DOWN", actionName(MotionEvent.ACTION_POINTER_DOWN))
        assertEquals("POINTER_UP", actionName(MotionEvent.ACTION_POINTER_UP))
        assertEquals("SCROLL", actionName(MotionEvent.ACTION_SCROLL))
        assertEquals("HOVER_ENTER", actionName(MotionEvent.ACTION_HOVER_ENTER))
        assertEquals("HOVER_EXIT", actionName(MotionEvent.ACTION_HOVER_EXIT))
        assertEquals("FINGER", toolName(MotionEvent.TOOL_TYPE_FINGER))
        assertEquals("STYLUS", toolName(MotionEvent.TOOL_TYPE_STYLUS))
        assertEquals("MOUSE", toolName(MotionEvent.TOOL_TYPE_MOUSE))
        assertEquals("ERASER", toolName(MotionEvent.TOOL_TYPE_ERASER))
        assertEquals("UNKNOWN", toolName(MotionEvent.TOOL_TYPE_UNKNOWN))
    }
}
