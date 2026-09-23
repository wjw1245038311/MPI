package com.mpi.app

import com.mpi.app.data.Updater
import com.mpi.app.data.compareVersions
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
        val info = Updater.parseManifest(json, "https://relay.example.com")
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
}
