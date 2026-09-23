package com.mpi.app

import com.mpi.app.data.RequestTransport
import com.mpi.app.data.ThreadSession
import com.mpi.app.protocol.Envelope
import com.mpi.app.protocol.RemoteEnvelope
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 复现联调时的真实事件序列（harness 的 `simulateEvents` 推的那一串）。
 *
 * 背景：模拟事件流里，**工具行渲染出来了，但流式文本与审批卡没出现**。
 * 这条测试把那一串事件原样重放，用来判断问题出在归约器还是传输/序列化。
 */
class ThreadEventReplayTest {

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    @After
    fun tearDown() {
        scope.cancel()
    }

    private class Transport : RequestTransport {
        private val listeners = CopyOnWriteArrayList<(RemoteEnvelope) -> Unit>()
        override fun sendEnvelope(envelope: RemoteEnvelope) = true
        override fun onEnvelope(listener: (RemoteEnvelope) -> Unit): () -> Unit {
            listeners += listener
            return { listeners -= listener }
        }

        override fun isOpen() = true
        fun deliver(envelope: RemoteEnvelope) = listeners.toList().forEach { it(envelope) }
    }

    private class Requests(private val snapshot: String) {
        suspend fun request(type: String, payload: JsonElement?, threadId: String?): JsonElement? =
            Envelope.json.parseToJsonElement(snapshot)
    }

    @Test
    fun `the harness event sequence produces streaming text and an approval card`() = runBlocking {
        val transport = Transport()
        val session = ThreadSession(
            threadId = "t-running",
            transport = transport,
            request = Requests(SNAPSHOT)::request,
            scope = scope,
        )
        session.subscribe()

        var seq = 0
        fun push(kind: String, data: kotlinx.serialization.json.JsonObject?) {
            seq += 1
            val payload = buildJsonObject {
                put("kind", kind)
                put("data", data ?: buildJsonObject { })
            }
            transport.deliver(
                RemoteEnvelope(
                    v = 1,
                    type = "thread.event",
                    sessionId = "sess-harness",
                    sentAt = 0,
                    threadId = "t-running",
                    seq = seq.toLong(),
                    payload = payload,
                ),
            )
        }

        push("agent_start", null)
        push("message_start", buildJsonObject { put("event", buildJsonObject { put("message", buildJsonObject { put("role", "assistant") }) }) })
        for (i in 0 until 40) {
            push(
                "message_update",
                buildJsonObject {
                    put(
                        "event",
                        buildJsonObject {
                            put(
                                "assistantMessageEvent",
                                buildJsonObject {
                                    put("type", "text_delta")
                                    put("delta", "流式输出片段 ")
                                },
                            )
                        },
                    )
                },
            )
        }
        push(
            "message_update",
            buildJsonObject {
                put(
                    "event",
                    buildJsonObject {
                        put(
                            "assistantMessageEvent",
                            buildJsonObject {
                                put("type", "toolcall_start")
                                put("toolCall", buildJsonObject { put("id", "call-demo"); put("name", "read") })
                            },
                        )
                    },
                )
            },
        )
        push(
            "tool_execution_end",
            buildJsonObject {
                put(
                    "event",
                    buildJsonObject {
                        put("toolCallId", "call-demo")
                        put("result", buildJsonObject { put("content", "已读取 42 行") })
                    },
                )
            },
        )
        push(
            "ui.request",
            buildJsonObject {
                put(
                    "request",
                    buildJsonObject {
                        put("id", "ui-demo-1")
                        put("method", "select")
                        put("title", "写入 src/auth/session.ts")
                        put("options", buildJsonArray { add("仅允许本次"); add("拒绝") })
                    },
                )
            },
        )

        delay(300) // 让节流窗口的缓冲冲刷

        val view = session.view.value
        val streamingText = view.streaming?.blocks
            ?.filter { it.type == com.mpi.app.protocol.BlockType.Text }
            ?.joinToString("") { it.text.orEmpty() }
            .orEmpty()
        assertTrue("流式文本应已合并提交，实际：$streamingText", streamingText.contains("流式输出片段"))
        assertTrue(
            "工具块应在同一个流式消息里",
            view.streaming?.blocks?.any { it.type == com.mpi.app.protocol.BlockType.Tool } == true,
        )
        assertNotNull("审批卡应已弹出", view.pendingUi)
        assertEquals("ui-demo-1", view.pendingUi?.id)
        session.detach()
    }

    private companion object {
        val SNAPSHOT = """
            {"snapshot":{
              "id":"t-running","projectId":"proj-mpi","title":"修复登录 bug","preview":"p","updatedAt":100,
              "messageCount":1,"state":"idle","permission":"sandbox",
              "model":null,"availableModels":[],"thinkingLevel":"","taskMode":null,"availableModes":[],
              "contextUsage":null,
              "messages":[{"id":"m1","role":"user","blocks":[{"type":"text","text":"历史"}]}],
              "nextSeq":0
            }}
        """.trimIndent()
    }
}
