package com.mpi.app

import com.mpi.app.data.HostRepository
import com.mpi.app.data.SessionState
import com.mpi.app.protocol.Envelope
import com.mpi.app.protocol.RemotePermission
import com.mpi.app.protocol.RemoteThreadState
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M1-4：主机数据仓库（纯单元测试，不需要中继）。
 *
 * 重点在**降级行为是否诚实**：单个项目失败不能把整列清空，也不能悄悄少一块；
 * 主机加了个不认识的会话状态不能让客户端崩。
 */
class HostRepositoryTest {

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val sessionState = MutableStateFlow<SessionState>(SessionState.Connected("host-1"))
    private val requestCount = AtomicInteger()

    @After
    fun tearDown() {
        scope.cancel()
    }

    private fun json(text: String): JsonElement = Envelope.json.parseToJsonElement(text)

    private fun repository(
        pollMs: Long = 5_000,
        handler: suspend (type: String, payload: JsonElement?) -> JsonElement?,
    ): HostRepository = HostRepository(
        scope = scope,
        request = { type, payload ->
            requestCount.incrementAndGet()
            handler(type, payload)
        },
        sessionState = sessionState,
        pollIntervalMs = pollMs,
    )

    // ---- 正常路径 ----

    @Test
    fun `loads projects and threads into the snapshot`() = runBlocking {
        val repo = repository { type, _ ->
            when (type) {
                "projects.list" -> json(
                    """{"projects":[{"id":"p1","name":"项目一","threadCount":1,"updatedAt":100}]}""",
                )

                "threads.list" -> json(
                    """{"threads":[{"id":"t1","projectId":"p1","title":"修复登录","preview":"p","updatedAt":200,
                        "messageCount":7,"state":"running","permission":"full"}]}""",
                )

                else -> null
            }
        }

        repo.refresh()

        val snapshot = repo.snapshot.value
        assertTrue("已连上时应为在线", snapshot.online)
        assertEquals(1, snapshot.projects.size)
        assertEquals("项目一", snapshot.projects.single().name)
        val thread = snapshot.threadsByProject.getValue("p1").single()
        assertEquals("修复登录", thread.title)
        assertEquals(RemoteThreadState.Running, thread.state)
        assertEquals(RemotePermission.Full, thread.permission)
        assertEquals(7, thread.messageCount)
        assertNull(snapshot.error)
        assertFalse(snapshot.loading)
    }

    @Test
    fun `an unknown thread state maps to Unknown instead of crashing`() = runBlocking {
        val repo = repository { type, _ ->
            when (type) {
                "projects.list" -> json("""{"projects":[{"id":"p1","name":"P"}]}""")
                else -> json("""{"threads":[{"id":"t1","projectId":"p1","state":"quantum","permission":"whatever"}]}""")
            }
        }

        repo.refresh()

        val thread = repo.snapshot.value.threadsByProject.getValue("p1").single()
        assertEquals("主机加了新状态也不能让客户端崩", RemoteThreadState.Unknown, thread.state)
        assertEquals("未知权限按最保守处理", RemotePermission.Sandbox, thread.permission)
    }

    @Test
    fun `missing payload fields fall back to defaults`() = runBlocking {
        val repo = repository { type, _ ->
            when (type) {
                "projects.list" -> json("""{"projects":[{"id":"p1"}]}""")
                else -> json("""{"threads":[{"id":"t1"}]}""")
            }
        }

        repo.refresh()

        val project = repo.snapshot.value.projects.single()
        assertEquals("", project.name)
        assertEquals(0, project.threadCount)
        val thread = repo.snapshot.value.threadsByProject.getValue("p1").single()
        assertEquals(RemoteThreadState.Unknown, thread.state)
    }

    @Test
    fun `threads are filtered by projectId in the request payload`() = runBlocking {
        val seen = mutableListOf<String>()
        val repo = repository { type, payload ->
            if (type == "projects.list") {
                json("""{"projects":[{"id":"pA","name":"A"},{"id":"pB","name":"B"}]}""")
            } else {
                val projectId = (payload as JsonObject)["projectId"]?.jsonPrimitive?.content.orEmpty()
                seen += projectId
                json("""{"threads":[{"id":"t-$projectId","projectId":"$projectId"}]}""")
            }
        }

        repo.refresh()

        assertEquals("每个项目各发一次 threads.list", listOf("pA", "pB").sorted(), seen.sorted())
        assertEquals(setOf("pA", "pB"), repo.snapshot.value.threadsByProject.keys)
    }

    // ---- 降级与失败 ----

    @Test
    fun `one project failing keeps the others and records a partial error`() = runBlocking {
        val repo = repository { type, payload ->
            if (type == "projects.list") {
                json("""{"projects":[{"id":"good","name":"好的"},{"id":"bad","name":"坏的"}]}""")
            } else {
                val projectId = (payload as JsonObject)["projectId"]?.jsonPrimitive?.content
                if (projectId == "bad") throw IllegalStateException("主机返回了错误")
                json("""{"threads":[{"id":"t1","projectId":"good","title":"正常"}]}""")
            }
        }

        repo.refresh()

        val snapshot = repo.snapshot.value
        assertEquals("整列仍可用", 1, snapshot.threadsByProject.getValue("good").size)
        assertTrue("失败的那个项目会话列表为空", snapshot.threadsByProject.getValue("bad").isEmpty())
        assertEquals("必须记下局部失败（不能悄悄少一块）", 1, snapshot.partialErrors.size)
        assertTrue(snapshot.partialErrors.single().contains("坏的"))
    }

    @Test
    fun `a top level failure sets a readable error and clears loading`() = runBlocking {
        val repo = repository { _, _ -> throw IllegalStateException("中继断了") }

        repo.refresh()

        val snapshot = repo.snapshot.value
        assertFalse("失败后不能一直显示加载中", snapshot.loading)
        assertEquals("中继断了", snapshot.error)
    }

    @Test
    fun `a malformed project entry is reported rather than silently dropped`() = runBlocking {
        val repo = repository { type, _ ->
            if (type == "projects.list") json("""{"projects":[{"name":"没有 id"}]}""") else json("""{"threads":[]}""")
        }

        repo.refresh()

        val snapshot = repo.snapshot.value
        assertTrue("整列失败要报出来，不能只少一条", snapshot.error != null)
        assertTrue(snapshot.projects.isEmpty())
    }

    // ---- 刷新节流与轮询 ----

    @Test
    fun `concurrent refreshes coalesce into a single round`() = runBlocking {
        val repo = repository { type, _ ->
            delay(120) // 让两次刷新重叠
            if (type == "projects.list") json("""{"projects":[{"id":"p1","name":"P"}]}""") else json("""{"threads":[]}""")
        }

        val first = async { repo.refresh() }
        val second = async { repo.refresh() }
        first.await()
        second.await()

        // 一轮 = projects.list 一次 + threads.list 一次
        assertEquals("重叠的刷新应被合并", 2, requestCount.get())
    }

    @Test
    fun `polls while a thread is running and stops once it idles`() = runBlocking {
        val running = java.util.concurrent.atomic.AtomicBoolean(true)
        val repo = repository(pollMs = 60) { type, _ ->
            if (type == "projects.list") {
                json("""{"projects":[{"id":"p1","name":"P"}]}""")
            } else {
                val state = if (running.get()) "running" else "idle"
                json("""{"threads":[{"id":"t1","projectId":"p1","state":"$state"}]}""")
            }
        }

        repo.refresh()
        assertTrue("有会话在跑时应进入轮询", repo.snapshot.value.hasRunning)

        val afterFirst = requestCount.get()
        withTimeout(3_000) { while (requestCount.get() <= afterFirst) delay(20) }

        // 变为空闲后，轮询应停下来
        running.set(false)
        withTimeout(3_000) {
            while (repo.snapshot.value.hasRunning) delay(20)
        }
        delay(300) // 给在途的轮询一个收尾机会
        val settled = requestCount.get()
        delay(400)
        assertEquals("空闲后不应再有请求", settled, requestCount.get())
    }

    @Test
    fun `going offline clears online and stops polling`() = runBlocking {
        val repo = repository(pollMs = 50) { type, _ ->
            if (type == "projects.list") json("""{"projects":[{"id":"p1","name":"P"}]}""") else json("""{"threads":[{"id":"t1","projectId":"p1","state":"running"}]}""")
        }
        repo.start()
        withTimeout(3_000) { while (!repo.snapshot.value.hasRunning) delay(20) }

        sessionState.value = SessionState.Failed(com.mpi.app.data.SessionFailure.Network, "断了")
        withTimeout(3_000) { while (repo.snapshot.value.online) delay(20) }

        delay(200)
        val settled = requestCount.get()
        delay(300)
        assertEquals("离线后必须停止轮询（别无线重试打满主机）", settled, requestCount.get())
    }
}
