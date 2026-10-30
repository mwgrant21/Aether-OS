package com.matt.aethermobile.ui.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ViewControlsModelTest {
    private class FakeStore : ViewPrefsStore {
        var z: Int? = null
        var o: String? = null
        override fun getZoom() = z
        override fun putZoom(px: Int) { z = px }
        override fun getOrientation() = o
        override fun putOrientation(key: String) { o = key }
    }

    private class ThrowingStore : ViewPrefsStore {
        override fun getZoom(): Int? = throw IllegalStateException("boom")
        override fun putZoom(px: Int) = throw IllegalStateException("boom")
        override fun getOrientation(): String? = throw IllegalStateException("boom")
        override fun putOrientation(key: String) = throw IllegalStateException("boom")
    }

    @Test fun zoomMissingIsDefault() = assertEquals(14, ViewPrefs(FakeStore()).loadZoom())

    @Test fun storedFitRoundTrips() {
        val s = FakeStore().apply { z = 0 }
        assertEquals(0, ViewPrefs(s).loadZoom())
    }

    @Test fun storedInRangeRoundTrips() {
        val s = FakeStore().apply { z = 18 }
        assertEquals(18, ViewPrefs(s).loadZoom())
    }

    @Test fun storedOutOfRangeFallsBackToDefault() {
        for (bad in listOf(7, 25, -3)) {
            val s = FakeStore().apply { z = bad }
            assertEquals("stored $bad", 14, ViewPrefs(s).loadZoom())
        }
    }

    @Test fun saveInvalidZoomIsNotWritten() {
        val s = FakeStore()
        ViewPrefs(s).saveZoom(99)
        assertNull(s.z)
    }

    @Test fun saveFitAndInRangeAreWritten() {
        val s = FakeStore()
        val p = ViewPrefs(s)
        p.saveZoom(0)
        assertEquals(0, s.z)
        p.saveZoom(10)
        assertEquals(10, s.z)
    }

    @Test fun throwingStoreIsSwallowed() {
        val p = ViewPrefs(ThrowingStore())
        assertEquals(14, p.loadZoom())
        p.saveZoom(12)
        assertEquals(OrientationMode.AUTO, p.loadOrientation())
        p.saveOrientation(OrientationMode.PORTRAIT)
    }

    @Test fun orientationMissingOrGarbageIsAuto() {
        val s = FakeStore()
        assertEquals(OrientationMode.AUTO, ViewPrefs(s).loadOrientation())
        s.o = "sideways"
        assertEquals(OrientationMode.AUTO, ViewPrefs(s).loadOrientation())
    }

    @Test fun eachOrientationRoundTrips() {
        for (m in OrientationMode.values()) {
            val p = ViewPrefs(FakeStore())
            p.saveOrientation(m)
            assertEquals(m, p.loadOrientation())
        }
    }

    @Test fun requestedOrientationValues() {
        assertEquals(-1, OrientationMode.AUTO.requested)
        assertEquals(1, OrientationMode.PORTRAIT.requested)
        assertEquals(6, OrientationMode.LANDSCAPE.requested)
    }

    @Test fun threadScaleMapping() {
        assertEquals(1f, threadScale(0), 0f)
        assertEquals(1f, threadScale(14), 0f)
        assertEquals(0.7f, threadScale(8), 0f)
        assertEquals(1.5f, threadScale(24), 0f)
        assertEquals(18 / 14f, threadScale(18), 1e-6f)
    }

    @Test fun viewCtlDefaults() {
        val u = ViewCtlUi()
        assertEquals(14, u.zoomPx)
        assertEquals(OrientationMode.AUTO, u.orientation)
    }
}
