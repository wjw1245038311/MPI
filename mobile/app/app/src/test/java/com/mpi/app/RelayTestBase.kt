package com.mpi.app

import com.mpi.app.data.RelayClient
import com.mpi.app.data.RelayState
import java.io.File
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assume.assumeTrue
import org.junit.Before

/**
 * 中继集成测试的共同基座：本地拉起 `mobile/relay/index.mjs`（临时端口、明文 ws）。
 *
 * 环境缺失（本机无 node / relay 未 `npm install`）时**跳过**而非失败——
 * 避免把环境问题算成代码问题。
 */
abstract class RelayTestBase {

    protected var port: Int = 0
        private set

    private var relay: Process? = null

    @Before
    fun startRelay() {
        val repoRoot = System.getProperty("mpi.repoRoot")?.let { File(it) }
        val relayDir = repoRoot?.resolve("mobile/relay")?.takeIf { it.isDirectory }
        assumeTrue("未找到 mobile/relay（缺 mpi.repoRoot？）", relayDir != null)
        assumeTrue(
            "mobile/relay/node_modules 未安装（先 cd mobile/relay && npm install）",
            relayDir!!.resolve("node_modules/ws").isDirectory,
        )
        assumeTrue("本机没有 node，跳过中继集成测试", nodeAvailable())

        val process = ProcessBuilder(nodePath(), "index.mjs")
            .directory(relayDir)
            .redirectErrorStream(true)
            .apply {
                environment()["RELAY_PORT"] = "0" // 临时端口：不与真实中继/其它测试抢端口
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

    protected fun url(): String = "ws://127.0.0.1:$port/ws"

    /** 订阅帧与状态并缓存，供断言取用。 */
    protected class Recording {
        val frames = LinkedBlockingQueue<JsonObject>()
        val states = LinkedBlockingQueue<RelayState>()

        fun attach(client: RelayClient): Recording {
            client.onState { states.put(it) }
            client.onFrame { raw ->
                frames.put(Json.parseToJsonElement(raw) as? JsonObject ?: JsonObject(emptyMap()))
            }
            return this
        }

        /** 等到指定 type 的帧（跳过其它帧）；超时即失败。 */
        fun awaitFrame(type: String, timeoutMs: Long = FRAME_TIMEOUT_MS): JsonObject {
            val deadline = System.currentTimeMillis() + timeoutMs
            val skipped = mutableListOf<String>()
            while (System.currentTimeMillis() < deadline) {
                val frame = frames.poll(500, TimeUnit.MILLISECONDS) ?: continue
                if (frame.str("type") == type) return frame
                skipped += frame.toString()
            }
            throw AssertionError("等不到 type=$type 的帧（已收到：$skipped）")
        }

        fun <T : RelayState> awaitState(clazz: Class<T>, timeoutMs: Long = FRAME_TIMEOUT_MS): T {
            val deadline = System.currentTimeMillis() + timeoutMs
            val seen = mutableListOf<String>()
            while (System.currentTimeMillis() < deadline) {
                val state = states.poll(500, TimeUnit.MILLISECONDS) ?: continue
                if (clazz.isInstance(state)) return clazz.cast(state)
                seen += state.toString()
            }
            throw AssertionError("等不到状态 ${clazz.simpleName}（已见到：$seen）")
        }
    }

    private fun nodePath(): String = System.getProperty("mpi.nodePath") ?: "node"

    private fun nodeAvailable(): Boolean = try {
        ProcessBuilder(nodePath(), "--version")
            .redirectErrorStream(true)
            .start()
            .waitFor(10, TimeUnit.SECONDS)
    } catch (_: Exception) {
        false
    }

    /** 从 relay 的启动输出解析实际端口（RELAY_PORT=0 时会打印真实端口）。 */
    private fun readReadyPort(process: Process): Int {
        val lines = LinkedBlockingQueue<String>()
        Thread {
            try {
                process.inputStream.bufferedReader().forEachLine { lines.put(it) }
            } catch (_: Exception) {
                // 进程退出时读取会抛，忽略
            }
        }.apply { isDaemon = true; start() }

        val readyPattern = Regex("""ready ws://[^:]+:(\d+)/ws""")
        val deadline = System.currentTimeMillis() + READY_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            val line = lines.poll(500, TimeUnit.MILLISECONDS) ?: continue
            readyPattern.find(line)?.let { return it.groupValues[1].toInt() }
        }
        val tail = generateSequence { lines.poll() }.toList().takeLast(10)
        process.destroyForcibly()
        throw AssertionError("中继未在 ${READY_TIMEOUT_MS}ms 内就绪；输出尾部：$tail")
    }

    protected companion object {
        const val READY_TIMEOUT_MS = 20_000L
        const val FRAME_TIMEOUT_MS = 10_000L
    }
}

/** 取 JSON 字段的字符串值（测试用的小工具）。 */
internal fun JsonObject.str(key: String): String? = this[key]?.jsonPrimitive?.contentOrNull
