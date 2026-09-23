package com.mpi.app

import com.mpi.app.data.Appearance
import com.mpi.app.data.FontSize
import com.mpi.app.ui.appearanceLabel
import com.mpi.app.ui.fontSizeLabel
import org.junit.Assert.assertEquals
import org.junit.Test

/** 批 5：本地设置（外观 / 字号）的读写口径与显示名。 */
class SettingsLogicTest {

    @Test
    fun `unknown stored values fall back to system and normal`() {
        assertEquals(Appearance.System, Appearance.fromStored(null))
        assertEquals(Appearance.System, Appearance.fromStored("whatever"))
        assertEquals(Appearance.Light, Appearance.fromStored("light"))
        assertEquals(Appearance.Dark, Appearance.fromStored("dark"))

        assertEquals(FontSize.Normal, FontSize.fromStored(null))
        assertEquals(FontSize.Normal, FontSize.fromStored("huge"))
        assertEquals(FontSize.Small, FontSize.fromStored("small"))
        assertEquals(FontSize.Large, FontSize.fromStored("large"))
    }

    @Test
    fun `wire values round-trip`() {
        Appearance.values().forEach { mode ->
            assertEquals(mode, Appearance.fromStored(mode.wire))
        }
        FontSize.values().forEach { size ->
            assertEquals(size, FontSize.fromStored(size.wire))
        }
    }

    @Test
    fun `labels are stable`() {
        assertEquals("跟随系统", appearanceLabel(Appearance.System))
        assertEquals("浅色", appearanceLabel(Appearance.Light))
        assertEquals("深色", appearanceLabel(Appearance.Dark))
        assertEquals("小", fontSizeLabel(FontSize.Small))
        assertEquals("标准", fontSizeLabel(FontSize.Normal))
        assertEquals("大", fontSizeLabel(FontSize.Large))
    }

    @Test
    fun `font scales increase monotonically`() {
        assertEquals(true, FontSize.Small.scale < FontSize.Normal.scale)
        assertEquals(true, FontSize.Normal.scale < FontSize.Large.scale)
    }
}
