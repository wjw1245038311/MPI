package com.mpi.app

import com.mpi.app.data.RequestException
import com.mpi.app.data.RequestTransport
import com.mpi.app.data.Requester
import com.mpi.app.protocol.RemoteEnvelope
import com.mpi.app.protocol.RemoteErrorPayload
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * M1-3：请求/响应配对（纯单元测试，不需要中继）。
 *
 * 这里刻意覆盖的都是「静默卡死」类故障：超时、回应丢失、requestId 串台、
 * 发送失败——这些在真机上表现为「界面一直转圈」，最难排查，所以要在这里钉死。
 */
class RequesterUnitTest {

    private class FakeTransport : RequestTransport {
        private val listeners = CopyOnWriteArrayList<(RemoteEnvelope) -> Unit>()
        val sent = CopyOnWriteArrayList<RemoteEnvelope>()

        @Volatile
        var open = true

        @Volatile
        var acceptSend = true

        override fun sendEnvelope(envelope: RemoteEnvelope): Boolean {
            if (!acceptSend) return false
            sent += envelope
            return true
        }

        override fun onEnvelope(listener: (RemoteEnvelope) -> Unit): () -> Unit {
            listeners += listener
            return { listeners -= listener }
        }

        override fun isOpen(): Boolean = open

        /** 模拟主机返回 `<type>.result`。 */
        fun respond(
            request: RemoteEnvelope,
            payload: JsonElement? = null,
            code: String? = null,
            message: String? = null,
            requestId: String? = request.requestId,
        ) {
            listeners.toList().forEach {
                it(
                    RemoteEnvelope(
                        v = 1,
                        type = "${request.type}.result",
                        sessionId = request.sessionId,
                        sentAt = 0,
                        requestId = requestId,
                        payload = payload,
                        error = code?.let { c -> RemoteErrorPayload(c, message.orEmpty()) },
                    ),
                )
            }
        }
    }

    @Test
    fun `resolves with the payload and puts a requestId on the wire`() = runBlocking {
        val transport = FakeTransport()
        val requester = Requester(transport, sessionId = "sess-test")

        val deferred = async {
            requester.request("projects.list", payload = buildJsonObject { put("limit", 5) })
        }
        val request = awaitSent(transport)
        assertTrue("请求必须带 requestId（主机靠它配对回应）", !request.requestId.isNullOrEmpty())
        assertEquals("sess-test", request.sessionId)
        assertEquals("limit", (request.payload as? kotlinx.serialization.json.JsonObject)?.keys?.first())

        transport.respond(request, payload = buildJsonObject { put("count", 3) })
        val result = deferred.await()
        assertEquals("3", result?.jsonObject?.get("count")?.jsonPrimitive?.content)
    }

    @Test
    fun `host error envelope becomes a HostError carrying the code`() = runBlocking {
        val transport = FakeTransport()
        val requester = Requester(transport, sessionId = "sess-test")

        // async 体内的异常会连带取消父作用域（try/catch 包 await() 拦不住），
        // 所以先把结果包成值取回，再断言。
        val deferred = async { runCatching { requester.request("thread.prompt") } }
        val request = awaitSent(transport)
        transport.respond(request, code = "HOST_OFFLINE", message = "主机不在线")

        val failure = deferred.await().exceptionOrNull()
        assertTrue("主机错误应抛 RequestException，实际：$failure", failure is RequestException)
        val error = failure as RequestException
        assertEquals(RequestException.Kind.HostError, error.kind)
        assertEquals("HOST_OFFLINE", error.code)
        assertTrue("文案应带主机给的原因", error.message!!.contains("主机不在线"))
    }

    @Test
    fun `no response times out with an actionable message`() = runBlocking {
        val transport = FakeTransport()
        val requester = Requester(transport, sessionId = "sess-test", defaultTimeoutMs = 200)

        try {
            requester.request("threads.list")
            fail("无回应应超时")
        } catch (e: RequestException) {
            assertEquals(RequestException.Kind.Timeout, e.kind)
            assertTrue(e.message!!.contains("超时"))
        }
    }

    @Test
    fun `send failure is reported as NotReady instead of hanging`() = runBlocking {
        val transport = FakeTransport().apply { acceptSend = false }
        val requester = Requester(transport, sessionId = "sess-test", defaultTimeoutMs = 5_000)

        try {
            requester.request("projects.list")
            fail("发送失败应立刻报错，而不是等到超时")
        } catch (e: RequestException) {
            assertEquals(RequestException.Kind.NotReady, e.kind)
        }
    }

    @Test
    fun `a response for a different requestId is ignored`() = runBlocking {
        val transport = FakeTransport()
        val requester = Requester(transport, sessionId = "sess-test", defaultTimeoutMs = 300)

        val deferred = async {
            try {
                requester.request("projects.list")
                fail("串台的回应不应被采纳")
            } catch (e: RequestException) {
                assertEquals(RequestException.Kind.Timeout, e.kind)
            }
        }
        val request = awaitSent(transport)
        transport.respond(request, requestId = "req-someone-else")
        deferred.await()
    }

    @Test
    fun `concurrent requests are matched to their own responses even out of order`() = runBlocking {
        val transport = FakeTransport()
        val requester = Requester(transport, sessionId = "sess-test", defaultTimeoutMs = 5_000)

        val first = async { requester.request("a.first") }
        val second = async { requester.request("b.second") }
        withTimeout(3_000) { while (transport.sent.size < 2) delay(10) }

        val requestA = transport.sent.first { it.type == "a.first" }
        val requestB = transport.sent.first { it.type == "b.second" }

        // 反序回应：先回 B 再回 A
        transport.respond(requestB, payload = buildJsonObject { put("who", "B") })
        transport.respond(requestA, payload = buildJsonObject { put("who", "A") })

        assertEquals("A", first.await()?.jsonObject?.get("who")?.jsonPrimitive?.content)
        assertEquals("B", second.await()?.jsonObject?.get("who")?.jsonPrimitive?.content)
    }

    @Test
    fun `stale connection callback fires on timeout only while the socket is open`() = runBlocking {
        val stale = AtomicInteger()
        val openTransport = FakeTransport()
        Requester(openTransport, sessionId = "s", defaultTimeoutMs = 150, onStaleConnection = { stale.incrementAndGet() })
            .let { requester ->
                runCatching { requester.request("x") }
            }
        assertEquals("连接还开着却没回应 → 应回调（主机可能掉线）", 1, stale.get())

        val closedTransport = FakeTransport().apply { open = false }
        Requester(closedTransport, sessionId = "s", defaultTimeoutMs = 150, onStaleConnection = { stale.incrementAndGet() })
            .let { requester ->
                runCatching { requester.request("x") }
            }
        assertEquals("连接已断时不回调（免得触发无意义的重握手）", 1, stale.get())
    }

    @Test
    fun `threadId is attached for per-thread requests`() = runBlocking {
        val transport = FakeTransport()
        val requester = Requester(transport, sessionId = "sess-test")

        val deferred = async { requester.request("thread.get", threadId = "thread-42") }
        val request = awaitSent(transport)
        assertEquals("主机从 envelope 读 threadId（不是 payload）", "thread-42", request.threadId)

        transport.respond(request, payload = buildJsonObject { put("ok", true) })
        val payload = deferred.await()
        assertEquals("true", payload?.jsonObject?.get("ok")?.jsonPrimitive?.content)
    }

    private suspend fun awaitSent(transport: FakeTransport): RemoteEnvelope =
        withTimeout(3_000) {
            var found: RemoteEnvelope? = null
            while (found == null) {
                found = transport.sent.firstOrNull()
                if (found == null) delay(10)
            }
            found!!
        }
}
