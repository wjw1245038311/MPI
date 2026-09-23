package com.mpi.app

import com.mpi.app.data.RequestException
import com.mpi.app.data.Requester
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * M1-3 集成：请求/响应**真的过了中继与 E2E 加密**（不是只在单测里假装）。
 *
 * 这条链路的每一环都可能悄悄坏掉：requestId 被加密层吃掉、`.result` 后缀不对、
 * 主机的错误 envelope 没传回来——所以必须走一遍真通道。
 */
class RequesterIntegrationTest : SessionTestBase() {

    @Test
    fun `request and response round trip through the encrypted channel`() = runBlocking {
        val fixture = setUpSession()
        try {
            connectAndAuthenticate(fixture)
            val requester = Requester(fixture.session, sessionId = "sess-android-test")

            // 假 host：收到请求后按 requestId 回一条 .result
            // （FakeHost.received 是缓冲队列，所以这里不存在抢跑）
            val responder = launch(Dispatchers.IO) {
                val request = fixture.fakeHost.nextReceived()
                assertEquals("请求应带 requestId", true, !request.requestId.isNullOrEmpty())
                fixture.fakeHost.sendEncrypted(
                    type = "${request.type}.result",
                    requestId = request.requestId,
                    payload = buildJsonObject { put("projects", 3) },
                )
            }

            val payload = requester.request("projects.list")
            assertEquals("3", payload?.jsonObject?.get("projects")?.jsonPrimitive?.content)
            responder.join()
        } finally {
            fixture.destroy()
        }
    }

    @Test
    fun `host error propagates with its code through the encrypted channel`() = runBlocking {
        val fixture = setUpSession()
        try {
            connectAndAuthenticate(fixture)
            val requester = Requester(fixture.session, sessionId = "sess-android-test")

            val responder = launch(Dispatchers.IO) {
                val request = fixture.fakeHost.nextReceived()
                fixture.fakeHost.sendErrorResult(request, code = "HOST_OFFLINE", message = "主机不在线")
            }

            try {
                requester.request("threads.list")
                fail("主机返回错误 envelope 时应报错")
            } catch (e: RequestException) {
                assertEquals(RequestException.Kind.HostError, e.kind)
                assertEquals("错误码应过中继与加密完整传回", "HOST_OFFLINE", e.code)
                assertTrue("错误文案应带上主机给的原因", e.message!!.contains("主机不在线"))
            }
            responder.join()
        } finally {
            fixture.destroy()
        }
    }

    @Test
    fun `no answer leads to a timeout rather than a hang`() = runBlocking {
        val fixture = setUpSession()
        try {
            connectAndAuthenticate(fixture)
            val requester = Requester(fixture.session, sessionId = "sess-android-test", defaultTimeoutMs = 400)

            try {
                requester.request("threads.list")
                fail("主机不回应时应超时")
            } catch (e: RequestException) {
                assertEquals(RequestException.Kind.Timeout, e.kind)
            }
            assertTrue("超时后通道应仍然可用", fixture.session.isAuthenticated)
        } finally {
            fixture.destroy()
        }
    }
}
