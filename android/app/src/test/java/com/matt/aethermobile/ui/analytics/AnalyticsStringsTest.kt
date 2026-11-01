package com.matt.aethermobile.ui.analytics

import com.matt.aethermobile.analytics.EMPTY_BURN
import com.matt.aethermobile.analytics.EMPTY_COMMANDS
import com.matt.aethermobile.analytics.EMPTY_LONGEST
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AnalyticsStringsTest {
    private val xml: String by lazy {
        val f = File("src/main/res/values/strings_analytics.xml")
        assertTrue("run from the app module: ${f.absolutePath}", f.exists())
        f.readText()
    }

    private fun string(name: String): String =
        Regex("<string name=\"$name\">([^<]*)</string>").find(xml)!!.groupValues[1]

    @Test fun emptyStatesAreTheDesktopSentencesVerbatim() {
        assertEquals(EMPTY_LONGEST, string("analytics_empty_longest"))
        assertEquals(EMPTY_BURN, string("analytics_empty_burn"))
        assertEquals(EMPTY_COMMANDS, string("analytics_empty_commands"))
    }

    @Test fun countsAreUsedWithPluralsNotInlineEnglish() {
        assertTrue(xml.contains("<plurals name=\"analytics_burn_calls\">"))
        assertTrue(xml.contains("<plurals name=\"analytics_age_minutes\">"))
    }
}
