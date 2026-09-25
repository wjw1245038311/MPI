package com.mpi.app

import com.mpi.app.data.RelayClient
import com.mpi.app.data.RelayState
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * RelayClient 的世代隔离（2026-09-26 真机事故的回归测试）。
 *
 * 事故链：`kick()` 里 close + 立刻 connect → 新旧两条 socket 短暂并存 → 中继把旧的一条判为
 * `replaced`；旧 socket 的迟到回调（onClosed / 中继发来的 replaced 帧）又打在同一会话上 →
 * 被当成终止性 [com.mpi.app.data.SessionFailure.Replaced] → 永久停死。真机表现在界面上的就是
 * 「连接中断（1000）」+「本设备已在另一处连接」；中继日志指纹是同一 deviceId 每几秒一轮
 * `hello ok` / `REPLACED previous connection` / `gone (code=1000)`。
 *
 * 这里锁死两条最小不变量：
 * ① 主动 close 广播 `expected = true` 的 Closed（上层据此不当成故障、不做误导性文案）；
 * ② 旧 socket 之后的一切事件都不得影响替代它的新连接。
 */
class RelayClientIdentityTest : RelayTestBase() {

    @Test
    fun `closing a socket cannot disturb the connection that replaces it`() {
        val client = RelayClient(url())
        val recording = Recording().attach(client)
        try {
            client.connect()
            recording.awaitState(RelayState.Open::class.java)

            client.close()
            val first = recording.awaitState(RelayState.Closed::class.java)
            assertTrue("主动关闭应标记为 expected", first.expected)

            // 立刻建新 socket（kick 的真实时序）：旧 socket 的 onClosed 随后才到——
            // 它必须被世代机制丢掉，绝不能把新连接的状态改成「非预期关闭」。
            assertTrue("close 之后应能立刻重连", client.connect())
            recording.awaitState(RelayState.Open::class.java)

            val deadline = System.currentTimeMillis() + 1_500
            while (System.currentTimeMillis() < deadline) {
                val state = recording.states.poll(200, TimeUnit.MILLISECONDS) ?: continue
                if (state is RelayState.Closed) {
                    assertFalse("旧 socket 的关闭事件不得污染新连接：$state", !state.expected)
                }
            }
            assertTrue("重连后通道应可用", client.isOpen())
        } finally {
            client.close()
        }
    }
}
