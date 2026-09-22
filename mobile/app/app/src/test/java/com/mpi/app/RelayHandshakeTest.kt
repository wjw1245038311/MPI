package com.mpi.app

import com.mpi.app.data.RelayClient
import com.mpi.app.data.RelayState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M0-6：OkHttp WebSocket 与**真实中继**的互通（docs/MOBILE-NATIVE-DESIGN.md §2.5 证伪项 2）。
 *
 *   假 host：host.register → relay.ok
 *            pair.approved  → relay.ok        （模拟桌面端 uplink 批准配对）
 *   设备端：hello(正确 token) → relay.ok{role:"device"}   ← 本项验收点
 *           hello(错误 token) → 连接被关闭 4001
 */
class RelayHandshakeTest : RelayTestBase() {

    private val hostId = "host-android-test"
    private val deviceId = "device-android-test"

    @Test
    fun `device hello is acknowledged by a real relay and notified to the host`() {
        val token = "token-android-test"

        val hostRecording = Recording()
        val host = RelayClient(url()).also { hostRecording.attach(it) }
        assertTrue("host 应能发起连接", host.connect())
        hostRecording.awaitState(RelayState.Open::class.java)

        // 模拟桌面端 uplink：注册并批准该设备
        assertTrue(host.send(EnvelopeSource.hostRegister(hostId)))
        assertEquals("host.register 应被确认", "relay.ok", hostRecording.awaitFrame("relay.ok").str("type"))
        assertTrue(host.send(EnvelopeSource.pairApproved(deviceId, token)))
        assertEquals("pair.approved 应被确认", "relay.ok", hostRecording.awaitFrame("relay.ok").str("type"))

        // 被测对象：Android 侧客户端
        val deviceRecording = Recording()
        val device = RelayClient(url()).also { deviceRecording.attach(it) }
        assertTrue("device 应能发起连接", device.connect())
        deviceRecording.awaitState(RelayState.Open::class.java)

        assertTrue(device.send(EnvelopeSource.hello(deviceId, token, hostId)))

        val ok = deviceRecording.awaitFrame("relay.ok")
        assertEquals("role 应为 device", "device", ok.str("role"))
        assertEquals("hostId 应回带绑定的主机", hostId, ok.str("hostId"))

        // 中继还应通知 host uplink「设备上线」——M1 靠它重发握手挑战
        assertEquals(deviceId, hostRecording.awaitFrame("device.online").str("deviceId"))

        device.close()
        host.close()
    }

    @Test
    fun `hello with a wrong token is closed by the relay`() {
        val hostRecording = Recording()
        val host = RelayClient(url()).also { hostRecording.attach(it) }
        assertTrue(host.connect())
        hostRecording.awaitState(RelayState.Open::class.java)
        host.send(EnvelopeSource.hostRegister(hostId))
        hostRecording.awaitFrame("relay.ok")
        host.send(EnvelopeSource.pairApproved(deviceId, "right-token"))
        hostRecording.awaitFrame("relay.ok")

        val deviceRecording = Recording()
        val device = RelayClient(url()).also { deviceRecording.attach(it) }
        assertTrue(device.connect())
        deviceRecording.awaitState(RelayState.Open::class.java)
        device.send(EnvelopeSource.hello(deviceId, "wrong-token", hostId))

        val closed = deviceRecording.awaitState(RelayState.Closed::class.java)
        assertEquals("token 不匹配应被关闭 4001", RelayClient.CLOSE_AUTH_FAILED, closed.code)

        host.close()
    }
}

/** 测试里用到的中继控制帧（设备端的两条在 ControlFrames 里，另有生产实现）。 */
internal object EnvelopeSource {
    fun hostRegister(hostId: String) = """{"type":"host.register","hostId":"$hostId"}"""

    fun pairApproved(deviceId: String, deviceToken: String) =
        """{"type":"pair.approved","deviceId":"$deviceId","deviceToken":"$deviceToken"}"""

    fun ticketRegister(ticket: String) =
        """{"type":"ticket.register","ticket":"$ticket"}"""

    fun hello(deviceId: String, deviceToken: String, hostId: String) =
        """{"type":"hello","deviceId":"$deviceId","deviceToken":"$deviceToken","hostId":"$hostId"}"""
}
