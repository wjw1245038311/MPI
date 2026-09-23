package com.mpi.app

import com.mpi.app.data.HostSession
import com.mpi.app.data.PairingRecord
import com.mpi.app.data.RelayClient
import com.mpi.app.data.SessionState
import com.mpi.app.protocol.createDeviceIdentity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout

/**
 * 会话类集成测试的共同基座：一个真中继 + 一个假桌面端 + 一个被测 HostSession。
 *
 * 拆出来是给 HostSession 与 Requester 的集成测试共用，避免两处各写一遍握手夹具。
 */
abstract class SessionTestBase : RelayTestBase() {

    protected val hostId = "host-session-test"
    protected val deviceToken = "session-device-token"

    protected fun newScope(): CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    protected class Fixture(
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

    /**
     * 起一套「已配对过」的环境：假桌面端注册并预先批准设备，然后让 HostSession 去重认证。
     * @param token null = 模拟令牌丢失（应快速失败并提示重新配对）
     */
    protected suspend fun setUpSession(
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

    protected suspend fun awaitState(
        session: HostSession,
        timeoutMs: Long = 10_000,
        predicate: (SessionState) -> Boolean,
    ): SessionState = withTimeout(timeoutMs) { session.state.first(predicate) }

    /** 连上并等到认证完成。 */
    protected suspend fun connectAndAuthenticate(fixture: Fixture) {
        fixture.session.connect()
        awaitState(fixture.session) { it is SessionState.Connected }
    }
}
