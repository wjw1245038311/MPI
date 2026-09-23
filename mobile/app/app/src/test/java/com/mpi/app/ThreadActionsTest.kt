package com.mpi.app

import com.mpi.app.data.RequestException
import com.mpi.app.data.SendMode
import com.mpi.app.data.ThreadActions
import com.mpi.app.protocol.RemotePermission
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * M2-3：写操作与写租约（纯单元测试）。
 *
 * 租约是最容易出错的地方：取早了浪费往返，取晚了被主机拒（WRITE_CLAIM_REQUIRED），
 * 而「别的设备持有」时又绝不能抢占。三种情况都在这里钉死。
 */
class ThreadActionsTest {

    private class FakeRequests {
        val calls = CopyOnWriteArrayList<Triple<String, JsonElement?, Long?>>()

        /** 按顺序消费的失败脚本：type → 抛出的错误码。 */
        val failures = mutableMapOf<String, MutableList<String>>()

        suspend fun request(type: String, payload: JsonElement?, threadId: String?, timeoutMs: Long?): JsonElement? {
            calls += Triple(type, payload, timeoutMs)
            val queue = failures[type]
            if (queue != null && queue.isNotEmpty()) {
                val code = queue.removeAt(0)
                throw RequestException("$type 失败：$code", RequestException.Kind.HostError, code = code)
            }
            return buildJsonObject { put("ok", true) }
        }

        fun types(): List<String> = calls.map { it.first }

        fun count(type: String): Int = types().count { it == type }

        fun payloadOf(type: String): JsonObject =
            calls.last { it.first == type }.second?.jsonObject ?: error("没有 $type 的调用")
    }

    private var now = 1_000_000L

    private fun actions(requests: FakeRequests, onClaim: () -> Unit = {}): ThreadActions = ThreadActions(
        threadId = "t-1",
        request = requests::request,
        clock = { now },
        onClaim = onClaim,
    )

    // ---- 发送模式 ----

    @Test
    fun `send uses the method that matches the mode`() = runBlocking {
        for (mode in SendMode.entries) {
            val requests = FakeRequests()
            actions(requests).send("你好", mode)
            assertEquals(1, requests.count("thread.claimWrite"))
            assertEquals("模式 ${mode.name} 应走 ${mode.method}", 1, requests.count("thread.${mode.method}"))
            assertEquals("你好", requests.payloadOf("thread.${mode.method}")["text"]?.jsonPrimitive?.content)
        }
    }

    @Test
    fun `blank text is rejected before touching the wire`() = runBlocking {
        val requests = FakeRequests()
        try {
            actions(requests).send("   ", SendMode.Prompt)
            fail("空消息应被拒绝")
        } catch (e: IllegalArgumentException) {
            assertTrue(requests.calls.isEmpty())
        }
    }

    @Test
    fun `text is trimmed`() = runBlocking {
        val requests = FakeRequests()
        actions(requests).send("  帮我看看  \n", SendMode.Prompt)
        assertEquals("帮我看看", requests.payloadOf("thread.prompt")["text"]?.jsonPrimitive?.content)
    }

    // ---- 写租约 ----

    @Test
    fun `the claim is taken once and reused within the lease`() = runBlocking {
        val requests = FakeRequests()
        val subject = actions(requests)
        subject.send("一", SendMode.Prompt)
        subject.send("二", SendMode.Prompt)
        assertEquals("租约内不应重复 claim", 1, requests.count("thread.claimWrite"))
    }

    @Test
    fun `the claim is refreshed proactively after 80 percent of the lease`() = runBlocking {
        val requests = FakeRequests()
        val subject = actions(requests)
        subject.send("一", SendMode.Prompt)
        assertEquals(1, requests.count("thread.claimWrite"))

        // 注意：不能中间再插一次成功写入 —— 那会把租期滑动，就不是在测这条了
        // （「滑动」本身由下一条用例单测）。
        now += ThreadActions.DEFAULT_LEASE_MS * 8 / 10 + 1
        subject.send("二", SendMode.Prompt)
        assertEquals("超过 80% 租期应主动续期（而不是等主机报错）", 2, requests.count("thread.claimWrite"))
    }

    @Test
    fun `a successful write slides the local lease`() = runBlocking {
        val requests = FakeRequests()
        val subject = actions(requests)
        subject.send("一", SendMode.Prompt)

        // 每次成功写入主机都会滑动续期，本地也要跟上：
        // 若本地不更新，就会在主机其实还有效时白白多取一次
        now += ThreadActions.DEFAULT_LEASE_MS / 2
        subject.send("二", SendMode.Prompt)
        now += ThreadActions.DEFAULT_LEASE_MS / 2
        subject.send("三", SendMode.Prompt)
        assertEquals(1, requests.count("thread.claimWrite"))
    }

    @Test
    fun `WRITE_CLAIM_REQUIRED triggers exactly one re-claim and a retry`() = runBlocking {
        val requests = FakeRequests()
        requests.failures["thread.prompt"] = mutableListOf("WRITE_CLAIM_REQUIRED")
        val claims = mutableListOf<Long>()
        val subject = actions(requests) { claims += now }

        subject.send("重试一次", SendMode.Prompt)

        assertEquals("应先取租约 → 被拒 → 强制重取 → 重试", 2, requests.count("thread.claimWrite"))
        assertEquals("写请求应发了两次", 2, requests.count("thread.prompt"))
        assertEquals(2, claims.size)
    }

    @Test
    fun `a second WRITE_CLAIM_REQUIRED is not retried forever`() = runBlocking {
        val requests = FakeRequests()
        requests.failures["thread.prompt"] = mutableListOf("WRITE_CLAIM_REQUIRED", "WRITE_CLAIM_REQUIRED")
        try {
            actions(requests).send("会连续失败", SendMode.Prompt)
            fail("第二次被拒应直接上抛，不能无限重试")
        } catch (e: RequestException) {
            assertEquals(ThreadActions.WRITE_CLAIM_REQUIRED, e.code)
        }
        assertEquals("只允许强制重取一次", 2, requests.count("thread.claimWrite"))
    }

    @Test
    fun `THREAD_BUSY is propagated without stealing the lease`() = runBlocking {
        val requests = FakeRequests()
        requests.failures["thread.steer"] = mutableListOf(ThreadActions.THREAD_BUSY)
        try {
            actions(requests).send("别的设备在写", SendMode.Steer)
            fail("THREAD_BUSY 应上抛给 UI")
        } catch (e: RequestException) {
            assertEquals(ThreadActions.THREAD_BUSY, e.code)
        }
        assertEquals("别的设备持有时不得抢占：只 claim 了一次", 1, requests.count("thread.claimWrite"))
    }

    // ---- 其它写操作 ----

    @Test
    fun `abort and configuration writes carry the right payloads`() = runBlocking {
        val requests = FakeRequests()
        val subject = actions(requests)

        subject.abort()
        assertEquals(1, requests.count("thread.abort"))

        subject.setPermission(RemotePermission.Full)
        assertEquals("full", requests.payloadOf("thread.setPermission")["permission"]?.jsonPrimitive?.content)

        subject.setPermission(RemotePermission.Sandbox)
        assertEquals("sandbox", requests.payloadOf("thread.setPermission")["permission"]?.jsonPrimitive?.content)

        subject.setModel("anthropic", "model-x")
        val model = requests.payloadOf("thread.setModel")
        assertEquals("anthropic", model["provider"]?.jsonPrimitive?.content)
        assertEquals("model-x", model["modelId"]?.jsonPrimitive?.content)

        subject.setMode("iterate")
        assertEquals("iterate", requests.payloadOf("thread.setMode")["modeId"]?.jsonPrimitive?.content)

        subject.setMode("") // 空串 = 清除模式
        assertEquals("", requests.payloadOf("thread.setMode")["modeId"]?.jsonPrimitive?.content)
    }

    @Test
    fun `respondUi sends the request id together with the response`() = runBlocking {
        val requests = FakeRequests()
        actions(requests).respondUi("ui-1", buildJsonObject { put("value", "允许本次") })

        val payload = requests.payloadOf("ui.respond")
        assertEquals("ui-1", payload["requestId"]?.jsonPrimitive?.content)
        assertEquals("允许本次", payload["response"]?.jsonObject?.get("value")?.jsonPrimitive?.content)
    }

    @Test
    fun `compact allows a much longer timeout than ordinary writes`() = runBlocking {
        val requests = FakeRequests()
        val subject = actions(requests)
        subject.send("普通请求", SendMode.Prompt)
        subject.compact()

        val sendTimeout = requests.calls.first { it.first == "thread.prompt" }.third
        val compactTimeout = requests.calls.first { it.first == "thread.compact" }.third
        assertEquals("普通写请求用默认超时", null, sendTimeout)
        assertEquals(ThreadActions.COMPACT_TIMEOUT_MS, compactTimeout)
    }

    @Test
    fun `every write goes through the claim first`() = runBlocking {
        val requests = FakeRequests()
        val subject = actions(requests)
        subject.abort()
        assertEquals(listOf("thread.claimWrite", "thread.abort"), requests.types())
    }
}
