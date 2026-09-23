package com.mpi.app

import com.mpi.app.data.ThreadCache
import java.io.File
import java.nio.file.Files
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * 本地缓存 A 方案：会话快照缓存。
 *
 * 这些是 JVM 单测——缓存只依赖文件系统，和 Android 无关。
 */
class ThreadCacheTest {

    private lateinit var dir: File

    private fun cache(
        maxEntries: Int = ThreadCache.DEFAULT_MAX_ENTRIES,
        maxBytesPerEntry: Long = ThreadCache.DEFAULT_MAX_BYTES_PER_ENTRY,
    ) = ThreadCache(dir, maxEntries = maxEntries, maxBytesPerEntry = maxBytesPerEntry)

    private fun snapshot(id: String) = Json.parseToJsonElement("""{"snapshot":{"id":"$id","messages":[]}}""")

    /** 不依赖内部实现的统计：直接数磁盘上所有缓存文件。 */
    private fun allCacheFiles(): List<File> =
        dir.walkTopDown().filter { it.isFile && it.name.endsWith(ThreadCache.EXTENSION) }.toList()

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("mpi-thread-cache-test").toFile()
    }

    @After
    fun tearDown() {
        dir.deleteRecursively()
    }

    @Test
    fun `write then read returns the payload and a timestamp`() {
        val store = cache()
        store.write("host-a", "t-1", snapshot("t-1"))

        val cached = store.read("host-a", "t-1")
        assertNotNull(cached)
        assertNotNull(cached!!.payload)
        assertEquals("t-1", ((cached.payload as JsonObject)["snapshot"] as JsonObject)["id"]?.toString()?.trim('"'))
        assertTrue(cached.savedAt > 0)
    }

    @Test
    fun `read of an unknown thread returns null`() {
        assertNull(cache().read("host-a", "missing"))
    }

    @Test
    fun `a corrupt cache file is deleted and treated as absent`() {
        val store = cache()
        store.write("host-a", "t-1", snapshot("t-1"))

        val file = allCacheFiles().single()
        file.writeText("{ this is not json")

        assertNull(store.read("host-a", "t-1"))
        assertFalse(file.exists())
    }

    @Test
    fun `the same thread id under different hosts does not collide`() {
        val store = cache()
        store.write("host-a", "t-1", snapshot("from-a"))
        store.write("host-b", "t-1", snapshot("from-b"))

        val a = store.read("host-a", "t-1")!!.payload as JsonObject
        val b = store.read("host-b", "t-1")!!.payload as JsonObject
        assertEquals("\"from-a\"", (a["snapshot"] as JsonObject)["id"].toString())
        assertEquals("\"from-b\"", (b["snapshot"] as JsonObject)["id"].toString())
    }

    @Test
    fun `an oversized snapshot is not cached`() {
        val store = cache(maxBytesPerEntry = 32)
        store.write("host-a", "t-1", snapshot("t-1"))
        assertNull(store.read("host-a", "t-1"))
    }

    @Test
    fun `prune keeps only the newest entries`() {
        val store = cache(maxEntries = 2)
        store.write("host-a", "t-1", snapshot("t-1"))
        store.write("host-a", "t-2", snapshot("t-2"))
        store.write("host-a", "t-3", snapshot("t-3"))

        assertEquals(2, allCacheFiles().size)
    }

    @Test
    fun `deleteHost removes that host cache only`() {
        val store = cache()
        store.write("host-a", "t-1", snapshot("t-1"))
        store.write("host-b", "t-1", snapshot("t-1"))

        store.deleteHost("host-a")
        assertNull(store.read("host-a", "t-1"))
        assertNotNull(store.read("host-b", "t-1"))
    }
}
