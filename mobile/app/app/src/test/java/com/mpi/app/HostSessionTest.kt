package com.mpi.app

import com.mpi.app.data.SessionFailure
import com.mpi.app.data.SessionState
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M1-2：主机会话 —— 对真实中继验证「重认证 → 加密收发 → 断线处置」。
 *
 * 重点不是「能连上」，而是**失败路径是否给出正确且可操作的信号**：
 * 令牌失效 / 被撤销 / 被顶替都必须是终止性失败（不自动重连、不无限重试掩盖问题）。
 */
class HostSessionTest : SessionTestBase() {

    @Test
    fun `authenticates then exchanges encrypted frames in both directions`() = runBlocking {
        val fixture = setUpSession()
        try {
            connectAndAuthenticate(fixture)
            assertEquals(hostId, (fixture.session.state.value as SessionState.Connected).hostId)
            assertTrue("重认证应通过验签", fixture.fakeHost.signatureChecks.all { it })

            // 设备 → 主机
            assertTrue(
                "已建立通道后应能发送",
                fixture.session.sendEnvelope(
                    type = "projects.list",
                    requestId = "req-1",
                    payload = buildJsonObject { put("limit", 10) },
                ),
            )
            val received = fixture.fakeHost.awaitReceived("projects.list")
            assertEquals("req-1", received.requestId)
            assertTrue("payload 应原样送达", received.payload?.jsonObject?.containsKey("limit") == true)

            // 主机 → 设备。onEnvelope 是同步注册，所以「先注册再发帧」不存在竞态。
            val inbox = Channel<com.mpi.app.protocol.RemoteEnvelope>(Channel.UNLIMITED)
            fixture.session.onEnvelope { inbox.trySend(it) }

            assertTrue(
                fixture.fakeHost.sendEncrypted(
                    type = "projects.list.result",
                    payload = buildJsonObject { put("ok", true) },
                ),
            )
            val response = withTimeout(10_000) {
                var found: com.mpi.app.protocol.RemoteEnvelope? = null
                while (found == null) {
                    val envelope = inbox.receive()
                    if (envelope.type == "projects.list.result") found = envelope
                }
                found!!
            }
            assertTrue(
                "设备应能解密主机发来的帧",
                response.payload?.jsonObject?.get("ok")?.jsonPrimitive?.content == "true",
            )
        } finally {
            fixture.destroy()
        }
    }

    @Test
    fun `revoked device is reported as a terminal failure and does not reconnect`() = runBlocking {
        val fixture = setUpSession()
        try {
            connectAndAuthenticate(fixture)

            fixture.fakeHost.revoke(fixture.fakeHost.deviceId!!)

            val failed = awaitState(fixture.session) {
                it is SessionState.Failed &&
                    (it.reason == SessionFailure.Revoked || it.reason == SessionFailure.AuthFailed)
            } as SessionState.Failed
            assertEquals("被撤销应报 Revoked", SessionFailure.Revoked, failed.reason)
            assertTrue("Revoked 必须是终止性失败", failed.reason.isTerminal)

            // 等超过第一档退避（1s），确认没有偷偷重连
            delay(1_800)
            assertTrue("终止性失败后不应自动重连", fixture.session.state.value is SessionState.Failed)
        } finally {
            fixture.destroy()
        }
    }

    @Test
    fun `a second connection replaces the first and is reported as terminal`() = runBlocking {
        val fixture = setUpSession()
        try {
            connectAndAuthenticate(fixture)

            // 另一处用同一身份/令牌 hello → 中继顶掉第一条连接
            val other = com.mpi.app.data.RelayClient(url())
            val recording = Recording().attach(other)
            other.connect()
            recording.awaitState(com.mpi.app.data.RelayState.Open::class.java)
            other.send(
                """{"type":"hello","deviceId":"${fixture.fakeHost.deviceId}","deviceToken":"$deviceToken","hostId":"$hostId"}""",
            )

            val failed = awaitState(fixture.session) {
                it is SessionState.Failed && it.reason == SessionFailure.Replaced
            } as SessionState.Failed
            assertTrue("被顶替必须是终止性失败", failed.reason.isTerminal)

            delay(1_500)
            assertTrue("被顶替后不应自动重连", fixture.session.state.value is SessionState.Failed)
            other.close()
        } finally {
            fixture.destroy()
        }
    }

    @Test
    fun `missing device token fails fast with an actionable reason`() = runBlocking {
        val fixture = setUpSession(token = null, preApprove = false)
        try {
            fixture.session.connect()
            val failed = awaitState(fixture.session, timeoutMs = 6_000) {
                it is SessionState.Failed
            } as SessionState.Failed
            assertEquals(SessionFailure.AuthFailed, failed.reason)
            assertTrue("文案应指向重新配对", failed.detail.contains("重新配对"))
            assertTrue(failed.reason.isTerminal)
        } finally {
            fixture.destroy()
        }
    }
}
