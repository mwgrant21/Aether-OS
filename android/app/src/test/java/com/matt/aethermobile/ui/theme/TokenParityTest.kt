package com.matt.aethermobile.ui.theme

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TokenParityTest {
    private val values = File("src/main/res/values")

    private fun xmlColors(): Map<String, Long> =
        Regex("""<color name="ae_(\w+)">#([0-9A-Fa-f]{8})</color>""")
            .findAll(File(values, "ae_colors.xml").readText())
            .associate { it.groupValues[1].uppercase() to it.groupValues[2].toLong(16) }

    private fun kotlinColors(): Map<String, Long> =
        AeArgb::class.java.declaredFields
            .filter { java.lang.reflect.Modifier.isStatic(it.modifiers) && it.type == Long::class.javaPrimitiveType }
            .associate { f -> f.isAccessible = true; f.name to f.getLong(null) }

    @Test fun everyXmlColourHasAnEqualConstant() {
        val xml = xmlColors()
        val kt = kotlinColors()
        assertTrue("no colours parsed", xml.isNotEmpty())
        for ((name, v) in xml) {
            assertEquals("AeArgb.$name", v, kt[name])
        }
    }

    @Test fun noConstantWithoutXmlColour() {
        val extra = kotlinColors().keys - xmlColors().keys
        assertTrue("AeArgb constants without XML colour: $extra", extra.isEmpty())
    }

    @Test fun dimensMatchReadme() {
        val text = File(values, "ae_dimens.xml").readText()
        fun dp(name: String) = Regex("""<dimen name="$name">(\d+)dp</dimen>""").find(text)!!.groupValues[1].toInt()
        assertEquals(14, dp("ae_r_card"))
        assertEquals(16, dp("ae_r_panel"))
        assertEquals(24, dp("ae_r_sheet"))
        assertEquals(60, dp("ae_header_h"))
        assertEquals(44, dp("ae_touch_min"))
        val d = AetherDimens()
        assertEquals(14f, d.rCard.value, 0f)
        assertEquals(60f, d.headerH.value, 0f)
        assertEquals(44f, d.touchMin.value, 0f)
    }
}
