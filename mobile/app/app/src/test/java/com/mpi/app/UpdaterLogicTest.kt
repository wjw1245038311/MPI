package com.mpi.app

import com.mpi.app.data.Updater
import com.mpi.app.data.UpdateInfo
import com.mpi.app.data.UpdatePatch
import com.mpi.app.data.compareVersions
import com.mpi.app.ui.downloadTrailing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** M6：版本比较与更新清单解析（纯函数）。 */
class UpdaterLogicTest {

    @Test
    fun `version comparison is numeric, not lexicographic`() {
        assertTrue("0.10 必须大于 0.9", compareVersions("0.10.0", "0.9.0") > 0)
        assertTrue(compareVersions("0.3.0", "0.2.9") > 0)
        assertTrue(compareVersions("0.2.0", "0.3.0") < 0)
        assertEquals(0, compareVersions("v0.3.0", "0.3.0"))
    }

    @Test
    fun `isNewer compares against a given running version`() {
        assertTrue(Updater.isNewer("0.4.0", "0.3.0"))
        assertTrue(!Updater.isNewer("0.3.0", "0.3.0"))
        assertTrue(!Updater.isNewer("0.2.0", "0.3.0"))
    }

    @Test
    fun `manifest parsing needs version and file and builds the relay url`() {
        val json =
            """{"version":"0.4.0","file":"mpi-android-native-0.4.0.apk","size":123,"sha256":"AB12","github":"https://example.com/x.apk"}"""
        val info = Updater.parseManifest(json, "https://relay.example.com/download")
        assertEquals("0.4.0", info?.version)
        assertEquals("https://relay.example.com/download/mpi-android-native-0.4.0.apk", info?.url)
        assertEquals(123L, info?.size)
        assertEquals("AB12", info?.sha256)
        assertEquals("https://example.com/x.apk", info?.github)
    }

    @Test
    fun `incomplete or broken manifests are rejected`() {
        assertNull(Updater.parseManifest("{}", "https://relay.example.com"))
        assertNull(Updater.parseManifest("""{"version":"0.4.0"}""", "https://relay.example.com"))
        assertNull(Updater.parseManifest("not json", "https://relay.example.com"))
    }

    // ---- 增量（APK 差量）----

    @Test
    fun `patch field is parsed and gated by the base version`() {
        val json =
            """{"version":"0.6.0","file":"mpi-android-native-0.6.0.apk","size":100,"sha256":"AB","patch":{"from":"0.5.9","file":"p.bin","size":40,"sha256":"CD"}}"""
        val info = Updater.parseManifest(json, "https://relay.example.com/download")!!
        assertEquals("0.5.9", info.patch?.from)
        assertEquals("https://relay.example.com/download/p.bin", info.patch?.url)
        assertEquals(40L, info.patch?.size)
        // 基线正好是当前版本才能走增量；差一版就不行
        assertTrue(info.patchUsable("0.5.9"))
        assertTrue(!info.patchUsable("0.5.8"))
        assertTrue(!info.patchUsable("0.6.0"))
    }

    @Test
    fun `missing or half-formed patch stays null`() {
        assertNull(Updater.parseManifest("""{"version":"0.6.0","file":"x.apk"}""", "https://r")?.patch)
        // 缺 file → 视为没有增量（不能拿一个下不下来的 patch 去试）
        assertNull(
            Updater.parseManifest("""{"version":"0.6.0","file":"x.apk","patch":{"from":"0.5.9"}}""", "https://r")?.patch,
        )
    }

    @Test
    fun `download trailing shows both sizes only when the patch is usable`() {
        val info = UpdateInfo(
            version = "0.6.0",
            file = "x.apk",
            url = "u",
            size = 28L * 1024 * 1024,
            sha256 = "",
            github = null,
            patch = UpdatePatch(from = "0.5.9", file = "p.bin", url = "pu", size = 15L * 1024 * 1024, sha256 = ""),
        )
        assertEquals("增量 15.0 MB（全量 28.0 MB）", downloadTrailing(info, "0.5.9"))
        assertEquals("28.0 MB", downloadTrailing(info, "0.5.8"))
    }
}
