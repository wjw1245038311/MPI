package com.mpi.app

import com.mpi.app.data.CachedHome
import com.mpi.app.data.HomeCache
import com.mpi.app.data.HostSnapshot
import com.mpi.app.protocol.RemotePermission
import com.mpi.app.protocol.RemoteProject
import com.mpi.app.protocol.RemoteThreadState
import com.mpi.app.protocol.RemoteThreadSummary
import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** 本地缓存 A 方案：首页列表缓存（断网首屏不空白）。 */
class HomeCacheTest {

    private lateinit var dir: File

    private fun cache() = HomeCache(dir)

    private fun sample(): HostSnapshot = HostSnapshot(
        online = true,
        projects = listOf(RemoteProject(id = "p1", name = "MPI", threadCount = 1, updatedAt = 100)),
        threadsByProject = mapOf(
            "p1" to listOf(
                RemoteThreadSummary(
                    id = "t1",
                    projectId = "p1",
                    title = "修复登录",
                    preview = "预览",
                    updatedAt = 200,
                    messageCount = 3,
                    state = RemoteThreadState.Running,
                    permission = RemotePermission.Full,
                    pinned = true,
                ),
            ),
        ),
    )

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("mpi-home-cache-test").toFile()
    }

    @After
    fun tearDown() {
        dir.deleteRecursively()
    }

    @Test
    fun `save then load round-trips the list`() {
        val store = cache()
        store.save("host-a", sample())

        val loaded: CachedHome? = store.load("host-a")
        assertNotNull(loaded)
        val snapshot = loaded!!.snapshot
        assertEquals("p1", snapshot.projects.single().id)
        val thread = snapshot.threadsByProject.getValue("p1").single()
        assertEquals("修复登录", thread.title)
        assertEquals(RemoteThreadState.Running, thread.state)
        assertEquals(RemotePermission.Full, thread.permission)
        assertTrue(thread.pinned)
        assertTrue(loaded.savedAt > 0)
        assertEquals(loaded.savedAt, snapshot.cachedAt)
    }

    @Test
    fun `loaded snapshot is never marked online`() {
        // 磁盘上恢复一个假的 online 会让人以为连上了，必须由真实连接覆盖
        val store = cache()
        store.save("host-a", sample())
        assertFalse(store.load("host-a")!!.snapshot.online)
    }

    @Test
    fun `load of an unknown host returns null`() {
        assertNull(cache().load("nobody"))
    }

    @Test
    fun `a corrupt cache file is deleted and treated as absent`() {
        val store = cache()
        store.save("host-a", sample())
        val file = dir.listFiles()!!.single()
        file.writeText("not json at all")

        assertNull(store.load("host-a"))
        assertFalse(file.exists())
    }

    @Test
    fun `deleteHost and clear remove the cache`() {
        val store = cache()
        store.save("host-a", sample())
        store.deleteHost("host-a")
        assertNull(store.load("host-a"))

        store.save("host-a", sample())
        store.clear()
        assertNull(store.load("host-a"))
    }
}
