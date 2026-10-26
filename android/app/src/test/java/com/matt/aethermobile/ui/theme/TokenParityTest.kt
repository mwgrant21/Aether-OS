package com.matt.aethermobile.ui.theme

import androidx.compose.ui.graphics.Color
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

    @Test fun allDimensMatchXml() {
        val text = File(values, "ae_dimens.xml").readText()
        fun dp(name: String) = Regex("""<dimen name="$name">(\d+)dp</dimen>""").find(text)!!.groupValues[1].toFloat()
        val d = AetherDimens()
        val map = mapOf(
            "screenPad" to ("ae_screen_pad" to d.screenPad),
            "cardPad" to ("ae_card_pad" to d.cardPad),
            "rChip" to ("ae_r_chip" to d.rChip),
            "rTile" to ("ae_r_tile" to d.rTile),
            "rRow" to ("ae_r_row" to d.rRow),
            "rCard" to ("ae_r_card" to d.rCard),
            "rPanel" to ("ae_r_panel" to d.rPanel),
            "rSheet" to ("ae_r_sheet" to d.rSheet),
            "headerH" to ("ae_header_h" to d.headerH),
            "touchMin" to ("ae_touch_min" to d.touchMin),
            "buttonH" to ("ae_button_h" to d.buttonH),
            "headerCore" to ("ae_header_core" to d.headerCore),
            "menuW" to ("ae_menu_w" to d.menuW),
        )
        val fields = AetherDimens::class.java.declaredFields.filter { !java.lang.reflect.Modifier.isStatic(it.modifiers) }
        assertEquals("AetherDimens field without a parity entry", map.size, fields.size)
        for ((prop, pair) in map) assertEquals(prop, dp(pair.first), pair.second.value, 0f)
    }

    @Test fun colourObjectUsesMatchingConstant() {
        val argb = kotlinColors()
        val fields = AetherColors::class.java.declaredFields
            .filter { java.lang.reflect.Modifier.isStatic(it.modifiers) && it.type == Long::class.javaPrimitiveType }
        assertEquals("AetherColors vs AeArgb count", argb.size, fields.size)
        for (f in fields) {
            f.isAccessible = true
            val constName = f.name.replace(Regex("([A-Z])"), "_$1").uppercase()
            val expected = argb[constName] ?: error("no AeArgb.$constName for AetherColors.${f.name}")
            assertEquals(f.name, Color(expected).value.toLong(), f.getLong(null))
        }
    }
}
