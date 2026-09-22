package com.mpi.app

import com.mpi.app.data.RelayClient
import com.mpi.app.data.RelayState
import java.io.File
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test

/**
 * M0-6：OkHttp WebSocket 与**真实中继**的互通（docs/MOBILE-NATIVE-DESIGN.md §2.5 证伪项 2）。
 *
 * 做法：本地拉起 `mobile/relay/index.mjs`（临时端口、明文 ws），然后走一遍真实握手：
 *
 *   假 host：host.register → relay.ok
 *            pair.approved  → relay.ok        （模拟桌面端 uplink 批准配对）
 *   设备端：hello(正确 token) → relay.ok{role:"device"}   ← 本项验收点
 *           hello(错误 token) → 连接被关闭 4001
 *
 * 依赖：本机有 `node`、且 `mobile/relay/node_modules` 已安装。缺失时**跳过**而不是失败
 * （避免把环境问题算成代码问题）。
 */
class RelayHandshakeTest {

    private var relay: Process? = null
    private var port = 0

    private val json = Json { ignoreUnknownKeys = true }

    private val repoRoot: File? =
        System.getProperty("mpi.repoRoot")?.let { File(it) }?.takeIf { it.isDirectory }

    private val nodePath: String = System.getProperty("mpi.nodePath") ?: "node"

    private val relayDir: File? = repoRoot?.resolve("mobile/relay")?.takeIf { it.isDirectory }

    @Before
    fun startRelay() {
        val dir = relayDir
        assumeTrue("未找到 mobile/relay（缺 mpi.repoRoot？）", dir != null)
        assumeTrue(
            "mobile/relay/node_modules 未安装（先 cd mobile/relay && npm install）",
            dir!!.resolve("node_modules/ws").isDirectory,
        )
        assumeTrue("本机没有 node，跳过中继集成测试", nodeAvailable())

        val process = ProcessBuilder(nodePath, "index.mjs")
            .directory(dir)
            .redirectErrorStream(true)
            .apply {
                environment()["RELAY_PORT"] = "0" // 临时端口，避免与真实中继/其它测试冲突
                environment()["RELAY_HOST"] = "127.0.0.1"
            }
            .start()

        port = readReadyPort(process)
        relay = process
    }

    @After
    fun stopRelay() {
        relay?.destroy()
        relay?.let { if (!it.waitFor(5, TimeUnit.SECONDS)) it.destroyForcibly() }
        relay = null
    }

    // ---- 验收点：设备 hello 拿到 relay.ok ----

    @Test
    fun `device hello is acknowledged by a real relay and notified to the host`() {
        val hostId = "host-android-test"
        val deviceId = "device-android-test"
        val token = "token-android-test"

        val hostSocket = RecordingListener()
        val host = RelayClient(url(), hostSocket)
        assertTrue("host 应能发起连接", host.connect())
        awaitState(hostSocket, RelayState.Open::class.java)

        // 模拟桌面端 uplink：注册并批准该设备
        assertTrue(host.send("""{"type":"host.register","hostId":"$hostId"}"""))
        assertEquals("host.register 应被确认", "relay.ok", awaitFrame(hostSocket, "relay.ok")["type"]?.jsonPrimitive?.content)
        assertTrue(
            host.send("""{"type":"pair.approved","deviceId":"$deviceId","deviceToken":"$token"}"""),
        )
        assertEquals("pair.approved 应被确认", "relay.ok", awaitFrame(hostSocket, "relay.ok")["type"]?.jsonPrimitive?.content)

        // 被测对象：Android 侧客户端
        val deviceSocket = RecordingListener()
        val device = RelayClient(url(), deviceSocket)
        assertTrue("device 应能发起连接", device.connect())
        awaitState(deviceSocket, RelayState.Open::class.java)

        assertTrue(
            device.send("""{"type":"hello","deviceId":"$deviceId","deviceToken":"$token","hostId":"$hostId"}"""),
        )

        val ok = awaitFrame(deviceSocket, "relay.ok")
        assertEquals("role 应为 device", "device", ok["role"]?.jsonPrimitive?.content)
        assertEquals("hostId 应回带绑定的主机", hostId, ok["hostId"]?.jsonPrimitive?.content)

        // 中继还应通知 host uplink「设备上线」——M1 靠它重发握手挑战
        val online = awaitFrame(hostSocket, "device.online")
        assertEquals(deviceId, online["deviceId"]?.jsonPrimitive?.content)

        device.close()
        host.close()
    }

    // ---- 验收点：token 不对时被中继拒掉（关闭码 4001）----

    @Test
    fun `hello with a wrong token is closed by the relay`() {
        val hostSocket = RecordingListener()
        val host = RelayClient(url(), hostSocket)
        assertTrue(host.connect())
        awaitState(hostSocket, RelayState.Open::class.java)
        host.send("""{"type":"host.register","hostId":"host-android-test"}""")
        awaitFrame(hostSocket, "relay.ok")
        host.send("""{"type":"pair.approved","deviceId":"device-android-test","deviceToken":"right-token"}""")
        awaitFrame(hostSocket, "relay.ok")

        val deviceSocket = RecordingListener()
        val device = RelayClient(url(), deviceSocket)
        assertTrue(device.connect())
        awaitState(deviceSocket, RelayState.Open::class.java)
        device.send("""{"type":"hello","deviceId":"device-android-test","deviceToken":"wrong-token","hostId":"host-android-test"}""")

        val closed = awaitState(deviceSocket, RelayState.Closed::class.java)
        assertEquals("token 不匹配应被关闭 4001", RelayClient.CLOSE_AUTH_FAILED, closed.code)

        host.close()
    }

    // ---- 基础设施 ----

    private fun url(): String = "ws://127.0.0.1:$port/ws"

    private fun nodeAvailable(): Boolean = try {
        ProcessBuilder(nodePath, "--version").redirectErrorStream(true).start().waitFor(10, TimeUnit.SECONDS)
    } catch (_: Exception) {
        false
    }

    /** 从 relay 的启动输出里解析实际端口（RELAY_PORT=0 时会打印真实端口）。 */
    private fun readReadyPort(process: Process): Int {
        val lines = LinkedBlockingQueue<String>()
        Thread {
            try {
                process.inputStream.bufferedReader().forEachLine { lines.put(it) }
            } catch (_: Exception) {
                // 进程结束时读取会抛，忽略
            }
        }.apply { isDaemon = true; start() }

        val readyPattern = Regex("""ready ws://[^:]+:(\d+)/ws""")
        val deadline = System.currentTimeMillis() + READY_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            val line = lines.poll(500, TimeUnit.MILLISECONDS) ?: continue
            val match = readyPattern.find(line)
            if (match != null) return match.groupValues[1].toInt()
        }
        val tail = generateSequence { lines.poll() }.toList().takeLast(10)
        process.destroyForcibly()
        throw AssertionError("中继未在 ${READY_TIMEOUT_MS}ms 内就绪；输出尾部：$tail")
    }

    private class RecordingListener : RelayClient.Listener {
        val frames = LinkedBlockingQueue<JsonObject>()
        val states = LinkedBlockingQueue<RelayState>()

        override fun onState(state: RelayState) {
            states.put(state)
        }

        override fun onFrame(rawJson: String) {
            frames.put(Json.parseToJsonElement(rawJson) as? JsonObject ?: JsonObject(emptyMap()))
        }
    }

    /** 等到指定 type 的帧（跳过其它帧）；超时即失败。 */
    private fun awaitFrame(listener: RecordingListener, type: String): JsonObject {
        val deadline = System.currentTimeMillis() + FRAME_TIMEOUT_MS
        val skipped = mutableListOf<String>()
        while (System.currentTimeMillis() < deadline) {
            val frame = listener.frames.poll(500, TimeUnit.MILLISECONDS) ?: continue
            if (frame["type"]?.jsonPrimitive?.content == type) return frame
            skipped += frame.toString()
        }
        throw AssertionError("等不到 type=$type 的帧（已收到：$skipped）")
    }

    private fun <T : RelayState> awaitState(listener: RecordingListener, clazz: Class<T>): T {
        val deadline = System.currentTimeMillis() + FRAME_TIMEOUT_MS
        val seen = mutableListOf<String>()
        while (System.currentTimeMillis() < deadline) {
            val state = listener.states.poll(500, TimeUnit.MILLISECONDS) ?: continue
            if (clazz.isInstance(state)) return clazz.cast(state)
            seen += state.toString()
        }
        throw AssertionError("等不到状态 ${clazz.simpleName}（已见到：$seen）")
    }

    private companion object {
        const val READY_TIMEOUT_MS = 20_000L
        const val FRAME_TIMEOUT_MS = 10_000L
    }
}
