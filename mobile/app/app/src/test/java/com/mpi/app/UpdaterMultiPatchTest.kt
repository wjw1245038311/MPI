package com.mpi.app

import com.mpi.app.data.Updater
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 多基线增量清单：APK 变大后「跨一版就只能下全量」是主要痛点，
 * 客户端必须能从 `patches[]` 里挑出基线正好等于当前安装版本的那一条。
 */
class UpdaterMultiPatchTest {

    private val manifest = """
        {
          "version": "0.6.0",
          "file": "mpi-android-native-0.6.0.apk",
          "size": 1000,
          "sha256": "AB",
          "patches": [
            {"from": "0.5.8", "file": "p-0.5.8.bin", "size": 30, "sha256": "C8"},
            {"from": "0.5.9", "file": "p-0.5.9.bin", "size": 40, "sha256": "C9", "url": "https://cdn.example.com/p9.bin"}
          ]
        }
    """.trimIndent()

    @Test
    fun `the patch whose base equals the installed version is chosen`() {
        val info = Updater.parseManifest(manifest, "https://relay.example.com/download")!!
        assertEquals("p-0.5.9.bin", info.bestPatch("0.5.9")?.file)
        assertEquals("https://cdn.example.com/p9.bin", info.bestPatch("0.5.9")?.url)
        // 相对名走 base 拼接
        assertEquals("https://relay.example.com/download/p-0.5.8.bin", info.bestPatch("0.5.8")?.url)
        assertNull(info.bestPatch("0.5.7"))
        assertTrue(info.patchUsable("0.5.8"))
        assertTrue(!info.patchUsable("0.5.7"))
    }

    @Test
    fun `legacy single patch still works and patches wins when both exist`() {
        val legacy = """
            {"version":"0.6.0","file":"x.apk","size":10,"sha256":"AB",
             "patch":{"from":"0.5.9","file":"old.bin","size":5,"sha256":"CE"}}
        """.trimIndent()
        val info = Updater.parseManifest(legacy, "https://r")!!
        assertEquals("old.bin", info.bestPatch("0.5.9")?.file)

        val both = """
            {"version":"0.6.0","file":"x.apk","size":10,"sha256":"AB",
             "patch":{"from":"0.5.9","file":"old.bin","size":5},
             "patches":[{"from":"0.5.9","file":"new.bin","size":4}]}
        """.trimIndent()
        assertEquals("new.bin", Updater.parseManifest(both, "https://r")!!.bestPatch("0.5.9")?.file)
    }

    @Test
    fun `malformed entries are dropped instead of poisoning the list`() {
        val json = """
            {"version":"0.6.0","file":"x.apk","size":10,
             "patches":[{"from":"0.5.9"},{"file":"p.bin"},{"from":"0.5.8","file":"ok.bin","size":7}]}
        """.trimIndent()
        val info = Updater.parseManifest(json, "https://r")!!
        assertEquals(1, info.patches.size)
        assertEquals("ok.bin", info.bestPatch("0.5.8")?.file)
        assertNull(info.bestPatch("0.5.9"))
    }
}
