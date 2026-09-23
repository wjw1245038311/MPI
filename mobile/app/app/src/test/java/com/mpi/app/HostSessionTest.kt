package com.mpi.app

import com.mpi.app.data.HostSession
import com.mpi.app.data.PairingRecord
import com.mpi.app.data.RelayClient
import com.mpi.app.data.SessionFailure
import com.mpi.app.data.SessionState
import com.mpi.app.protocol.createDeviceIdentity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
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
class HostSessionTest : RelayTestBase() {

    private val hostId = "host-session-test"
    private val deviceToken = "session-device-token"

    private fun newScope() = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private class Fixture(
        val scope: CoroutineScope,
        val hostClient: RelayClient,
        val fakeHost: FakeHost,
        val sessionClient: RelayClient,
        val session: HostSession,
    ) {
        fun destroy() {
            session.stop()
            scope.cancel()
        }
    }

    private suspend fun setUpSession(
        token: String? = deviceToken,
        preApprove: Boolean = true,
    ): Fixture {
        val scope = newScope()
        val hostClient = RelayClient(url())
        val fakeHost = FakeHost(hostClient, hostId, deviceToken, scope)
        fakeHost.start()
        fakeHost.launch()

        val identity = createDeviceIdentity()
        if (preApprove) fakeHost.approve(identity.deviceId)

        val record = PairingRecord(
            hostId = hostId,
            relayUrl = url(),
            deviceId = identity.deviceId,
            deviceToken = token,
            hostX25519PubB64u = fakeHost.x25519PubB64u,
            pairedAt = System.currentTimeMillis(),
            hostName = "测试工作站",
        )

        val sessionClient = RelayClient(url())
        val session = HostSession(sessionClient, record, identity, "测试手机", scope)
        return Fixture(scope, hostClient, fakeHost, sessionClient, session)
    }

    private suspend fun awaitState(
        session: HostSession,
        timeoutMs: Long = 10_000,
        predicate: (SessionState) -> Boolean,
    ): SessionState = withTimeout(timeoutMs) { session.state.first(predicate) }

    @Test
    fun `authenticates then exchanges encrypted frames in both directions`() = runBlocking {
        val fixture = setUpSession()
        try {
            fixture.session.connect()
            val connected = awaitState(fixture.session) { it is SessionState.Connected }
            assertEquals(hostId, (connected as SessionState.Connected).hostId)
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
            assertTrue(
                "payload 应原样送达",
                received.payload?.jsonObject?.containsKey("limit") == true,
            )

            // 主机 → 设备（M1-2 只验证加密通道本身；请求/响应配对是 M1-3）
            // ⚠️ HostSession.incoming 无 replay：必须先订阅再发帧，否则会丢
            val inboundAwait = async {
                withTimeout(10_000) { fixture.session.incoming.first { it.type == "projects.list.result" } }
            }
            delay(150)
            assertTrue(
                fixture.fakeHost.sendEncrypted(
                    type = "projects.list.result",
                    payload = buildJsonObject { put("ok", true) },
                ),
            )
            val inbound = inboundAwait.await()
            assertTrue("设备应能解密主机发来的帧", inbound.payload?.jsonObject?.get("ok")?.jsonPrimitive?.content == "true")
        } finally {
            fixture.destroy()
        }
    }

    @Test
    fun `revoked device is reported as a terminal failure and does not reconnect`() = runBlocking {
        val fixture = setUpSession()
        try {
            fixture.session.connect()
            awaitState(fixture.session) { it is SessionState.Connected }

            fixture.fakeHost.revoke(fixture.fakeHost.deviceId!!)

            val failed = awaitState(fixture.session) {
                it is SessionState.Failed && (it.reason == SessionFailure.Revoked || it.reason == SessionFailure.AuthFailed)
            } as SessionState.Failed
            assertEquals("被撤销应报 Revoked", SessionFailure.Revoked, failed.reason)
            assertTrue("Revoked 必须是终止性失败", failed.reason.isTerminal)

            // 等超过第一档退避（1s），确认没有偷偷重连
            delay(1_800)
            assertTrue(
                "终止性失败后不应自动重连",
                fixture.session.state.value is SessionState.Failed,
            )
        } finally {
            fixture.destroy()
        }
    }

    @Test
    fun `a second connection replaces the first and is reported as terminal`() = runBlocking {
        val fixture = setUpSession()
        try {
            fixture.session.connect()
            awaitState(fixture.session) { it is SessionState.Connected }

            // 另一处用同一身份/令牌 hello → 中继顶掉第一条连接
            val other = RelayClient(url())
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
