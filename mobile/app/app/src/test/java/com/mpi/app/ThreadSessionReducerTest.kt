package com.mpi.app

import com.mpi.app.data.RequestTransport
import com.mpi.app.data.ThreadSession
import com.mpi.app.data.ThreadView
import com.mpi.app.protocol.BlockType
import com.mpi.app.protocol.Envelope
import com.mpi.app.protocol.RemoteEnvelope
import com.mpi.app.protocol.RemotePermission
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M2-1：会话视图归约器（纯单元测试，不需要中继）。
 *
 * 这里钉死的都是 PWA 真机上踩过的坑：快照前的事件丢失、seq 缺口、
 * 同一用户消息上屏两次、每个 token 更新一次状态（卡顿）、审批卡重复弹出。
 */
class ThreadSessionReducerTest {

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    @After
    fun tearDown() {
        scope.cancel()
    }

    private class FakeTransport : RequestTransport {
        private val listeners = CopyOnWriteArrayList<(RemoteEnvelope) -> Unit>()

        override fun sendEnvelope(envelope: RemoteEnvelope): Boolean = true

        override fun onEnvelope(listener: (RemoteEnvelope) -> Unit): () -> Unit {
            listeners += listener
            return { listeners -= listener }
        }

        override fun isOpen(): Boolean = true

        fun deliver(envelope: RemoteEnvelope) {
            listeners.toList().forEach { it(envelope) }
        }
    }

    private class FakeRequests(private val snapshotJson: String) {
        val calls = CopyOnWriteArrayList<String>()

        suspend fun request(type: String, payload: JsonElement?, threadId: String?): JsonElement? {
            calls += type
            return Envelope.json.parseToJsonElement(snapshotJson)
        }
    }

    private fun newSession(
        transport: FakeTransport = FakeTransport(),
        requests: FakeRequests = FakeRequests(SNAPSHOT),
        onSnapshot: (JsonElement) -> Unit = {},
    ): ThreadSession = ThreadSession(
        threadId = THREAD_ID,
        transport = transport,
        request = requests::request,
        scope = scope,
        onSnapshot = onSnapshot,
    )

    // ---- 快照 ----

    @Test
    fun `subscribe applies the snapshot`() = runBlocking {
        val session = newSession()
        session.subscribe()

        val view = session.view.value
        assertTrue(view.ready)
        assertEquals("修复登录 bug", view.summary?.title)
        assertEquals(RemotePermission.Full, view.summary?.permission)
        assertEquals(2, view.messages.size)
        assertEquals("第一条", view.messages[0].blocks.single().text)
        assertEquals("model-x", view.model?.id)
        assertEquals(1, view.availableModels.size)
        assertEquals("沙盒 · 低思考", view.availableModes.single().summary)
        session.detach()
    }

    @Test
    fun `tool blocks in history read their result as the body`() = runBlocking {
        val session = newSession()
        session.subscribe()
        // PWA 踩过：工具块正文取错字段（b.text）导致展开后一片空白
        val tool = session.view.value.messages[1].blocks.single()
        assertEquals(BlockType.Tool, tool.type)
        assertEquals("工具输出内容", tool.text)
        assertEquals("bash", tool.name)
        session.detach()
    }

    // ---- 本地缓存（本地缓存 A 方案）----

    @Test
    fun `prime renders the cached snapshot immediately`() = runBlocking {
        val session = newSession()
        session.prime(Envelope.json.parseToJsonElement(SNAPSHOT), savedAt = 123L)

        val view = session.view.value
        assertTrue(view.ready)
        assertTrue(view.showingCached)
        assertEquals(123L, view.cachedAt)
        assertEquals(2, view.messages.size)
        assertEquals("修复登录 bug", view.summary?.title)
        session.detach()
    }

    @Test
    fun `live snapshot clears the cached flag`() = runBlocking {
        val session = newSession()
        session.prime(Envelope.json.parseToJsonElement(SNAPSHOT), savedAt = 123L)
        session.subscribe()

        // 实时快照到达后不得再提示「显示本地缓存」
        assertNull(session.view.value.cachedAt)
        session.detach()
    }

    @Test
    fun `live snapshot is handed to the cache callback but prime is not`() = runBlocking {
        val captured = CopyOnWriteArrayList<String>()
        val session = newSession(onSnapshot = { captured += it.toString() })

        session.prime(Envelope.json.parseToJsonElement(SNAPSHOT), savedAt = 1L)
        assertEquals(0, captured.size) // 预热不写缓存

        session.subscribe()
        assertEquals(1, captured.size)
        assertTrue(captured[0].contains("\"snapshot\""))
        session.detach()
    }

    // ---- 事件缓冲与 seq ----

    @Test
    fun `events arriving before the snapshot are buffered and replayed`() = runBlocking {
        val transport = FakeTransport()
        val session = newSession(transport)

        // 快照还没到，先来一条事件 —— 必须缓冲而不是丢弃
        transport.deliver(event(seq = 10, kind = "agent_start"))
        assertTrue("快照前不应渲染", !session.view.value.ready)

        session.subscribe()
        assertTrue("缓冲的事件应在快照后重放", session.view.value.running)
        session.detach()
    }

    @Test
    fun `a seq gap triggers a resync instead of rendering with a hole`() = runBlocking {
        val transport = FakeTransport()
        val requests = FakeRequests(SNAPSHOT)
        val session = newSession(transport, requests)
        session.subscribe()

        transport.deliver(event(seq = 5, kind = "agent_start")) // 建立基线：期望 6
        val before = requests.calls.count { it == "thread.resync" }

        transport.deliver(event(seq = 7, kind = "message_start")) // 缺 6 → 应 resync
        withTimeout(3_000) {
            while (requests.calls.count { it == "thread.resync" } <= before) delay(10)
        }
        session.detach()
    }

    @Test
    fun `duplicate or stale seq is ignored`() = runBlocking {
        val transport = FakeTransport()
        val session = newSession(transport)
        session.subscribe()

        transport.deliver(event(seq = 5, kind = "agent_start"))
        transport.deliver(event(seq = 5, kind = "agent_settled")) // 重复，应被忽略
        assertTrue("重复 seq 不应生效", session.view.value.running)
        session.detach()
    }

    // ---- 流式与节流 ----

    @Test
    fun `text deltas are batched instead of updating state per token`() = runBlocking {
        val transport = FakeTransport()
        val session = newSession(transport)
        session.subscribe()

        transport.deliver(event(seq = 1, kind = "agent_start"))
        transport.deliver(event(seq = 2, kind = "message_start", event = messageEvent("assistant")))
        // 每个事件有各自递增的 seq（主机侧是单调计数器）；用同一个 seq 会被当成重复丢弃
        listOf("你", "好", "，", "世", "界").forEachIndexed { index, delta ->
            transport.deliver(textDelta(seq = 3 + index, delta = delta))
        }

        // 节流窗口内不应看到中间态（§1.5 预算 #3）
        assertEquals(
            "增量未提交前不应出现在视图里",
            "",
            session.view.value.streaming?.blocks?.firstOrNull()?.text.orEmpty(),
        )

        delay(ThreadSession.FLUSH_INTERVAL_MS * 3)
        assertEquals("你好，世界", session.view.value.streaming?.blocks?.firstOrNull()?.text)
        session.detach()
    }

    @Test
    fun `a non-delta event flushes buffered deltas first to keep ordering`() = runBlocking {
        val transport = FakeTransport()
        val session = newSession(transport)
        session.subscribe()

        transport.deliver(event(seq = 1, kind = "message_start", event = messageEvent("assistant")))
        transport.deliver(textDelta(seq = 2, delta = "先写一半"))
        // agent_settled 是非增量事件：它之前必须先冲刷，否则文本会晚于状态落地
        transport.deliver(event(seq = 3, kind = "agent_settled"))

        assertEquals("先写一半", session.view.value.streaming?.blocks?.firstOrNull()?.text)
        session.detach()
    }

    @Test
    fun `message_end finalizes the streaming message into history`() = runBlocking {
        val transport = FakeTransport()
        val session = newSession(transport)
        session.subscribe()
        val historyCount = session.view.value.messages.size

        transport.deliver(event(seq = 1, kind = "message_start", event = messageEvent("assistant")))
        transport.deliver(textDelta(seq = 2, delta = "做完了"))
        transport.deliver(
            event(
                seq = 3,
                kind = "message_end",
                event = buildJsonObject {
                    put("message", buildJsonObject { put("role", "assistant"); put("stopReason", "stop") })
                },
            ),
        )

        val view = session.view.value
        assertNull("结束后不再有流式消息", view.streaming)
        assertEquals(historyCount + 1, view.messages.size)
        assertEquals("做完了", view.messages.last().blocks.single().text)
        assertEquals("stop", view.messages.last().stopReason)
        session.detach()
    }

    // ---- 乐观回显 ----

    @Test
    fun `an optimistic user message is promoted instead of shown twice`() = runBlocking {
        val transport = FakeTransport()
        val session = newSession(transport)
        session.subscribe()
        val historyCount = session.view.value.messages.size

        val localId = session.echoUserMessage("帮我看下登录")
        assertTrue(session.view.value.messages.last().pending)

        transport.deliver(
            event(
                seq = 1,
                kind = "message_start",
                event = buildJsonObject {
                    put("message", buildJsonObject { put("role", "user"); put("content", "帮我看下登录") })
                },
            ),
        )

        val messages = session.view.value.messages
        assertEquals("同一条消息不能上屏两次", historyCount + 1, messages.size)
        assertEquals(localId, messages.last().id)
        assertTrue("回执后应转正", !messages.last().pending)
        session.detach()
    }

    @Test
    fun `a snapshot discards leftover optimistic messages`() = runBlocking {
        val transport = FakeTransport()
        val session = newSession(transport)
        session.subscribe()
        session.echoUserMessage("这条不会有回执")
        assertEquals(3, session.view.value.messages.size)

        session.resync() // 快照是权威历史
        assertEquals("快照后乐观占位应被丢弃", 2, session.view.value.messages.size)
        session.detach()
    }

    @Test
    fun `a failed send keeps the message in place with a reason`() = runBlocking {
        val session = newSession()
        session.subscribe()
        val id = session.echoUserMessage("发不出去的消息")
        session.markSendFailed(id, "连接未就绪")

        val message = session.view.value.messages.last()
        assertEquals("失败的消息必须留在原位（便于重试）", id, message.id)
        assertEquals("send_failed", message.stopReason)
        assertEquals("连接未就绪", message.errorMessage)
        session.detach()
    }

    // ---- 工具块 ----

    @Test
    fun `tool calls are upserted and updated by toolCallId`() = runBlocking {
        val transport = FakeTransport()
        val session = newSession(transport)
        session.subscribe()

        transport.deliver(event(seq = 1, kind = "message_start", event = messageEvent("assistant")))
        transport.deliver(toolCallStart(seq = 2, id = "call-1", name = "bash"))
        transport.deliver(event(seq = 3, kind = "tool_execution_start", event = buildJsonObject { put("toolCallId", "call-1") }))
        transport.deliver(
            event(
                seq = 4,
                kind = "tool_execution_end",
                event = buildJsonObject {
                    put("toolCallId", "call-1")
                    put("isError", false)
                    put("result", buildJsonObject { put("content", "执行结果") })
                },
            ),
        )

        val tool = session.view.value.streaming!!.blocks.single()
        assertEquals(BlockType.Tool, tool.type)
        assertEquals("bash", tool.name)
        assertEquals("执行结果", tool.text)
        assertTrue("结束后不应还在运行", !tool.running)
        session.detach()
    }

    // ---- 审批卡 ----

    @Test
    fun `ui request shows a card and duplicates do not re-push it`() = runBlocking {
        val transport = FakeTransport()
        val session = newSession(transport)
        session.subscribe()

        transport.deliver(uiRequest(seq = 1, id = "ui-1", option = "仅允许本次"))
        assertEquals("ui-1", session.view.value.pendingUi?.id)
        assertEquals(listOf("仅允许本次", "拒绝"), session.view.value.pendingUi?.options)

        // 同一条重复推送（主机重连后会重发）不应再弹
        transport.deliver(uiRequest(seq = 2, id = "ui-1", option = "仅允许本次"))
        assertEquals("ui-1", session.view.value.pendingUi?.id)

        session.markUiResponded("ui-1")
        assertNull(session.view.value.pendingUi)
        session.detach()
    }

    @Test
    fun `a pending approval survives a resync`() = runBlocking {
        val transport = FakeTransport()
        val session = newSession(transport)
        session.subscribe()
        transport.deliver(uiRequest(seq = 1, id = "ui-9", option = "允许"))

        session.resync()
        assertEquals("主机还等着回应，卡片不能消失", "ui-9", session.view.value.pendingUi?.id)
        session.detach()
    }

    @Test
    fun `an already answered approval is not re-shown by a late duplicate`() = runBlocking {
        val transport = FakeTransport()
        val session = newSession(transport)
        session.subscribe()
        session.markUiResponded("ui-7")
        transport.deliver(uiRequest(seq = 1, id = "ui-7", option = "允许"))
        assertNull(session.view.value.pendingUi)
        session.detach()
    }

    @Test
    fun `diff is decoded from an approval request`() = runBlocking {
        val transport = FakeTransport()
        val session = newSession(transport)
        session.subscribe()
        transport.deliver(
            event(
                seq = 1,
                kind = "ui.request",
                data = buildJsonObject {
                    put(
                        "request",
                        buildJsonObject {
                            put("id", "ui-diff")
                            put("method", "select")
                            put("title", "写入 src/login.ts")
                            put(
                                "diff",
                                buildJsonObject {
                                    put("path", "src/login.ts")
                                    put("added", 28)
                                    put("removed", 13)
                                    put("hunks", "@@ -1,3 +1,4 @@")
                                },
                            )
                        },
                    )
                },
            ),
        )
        val diff = session.view.value.pendingUi?.diff
        assertNotNull(diff)
        assertEquals("src/login.ts", diff!!.path)
        assertEquals(28, diff.added)
        assertEquals(13, diff.removed)
        session.detach()
    }

    // ---- 配置同步 ----

    @Test
    fun `context usage updates both usage and the current model`() = runBlocking {
        val transport = FakeTransport()
        val session = newSession(transport)
        session.subscribe()

        // 新会话的 JSONL 没有 model_change 条目，主机靠这条补推当前模型
        transport.deliver(
            event(
                seq = 1,
                kind = "context_usage",
                data = buildJsonObject {
                    put("tokens", 1234)
                    put("contextWindow", 200000)
                    put("percent", 0.6)
                    put("model", buildJsonObject { put("provider", "anthropic"); put("id", "model-y") })
                },
            ),
        )

        assertEquals(1234L, session.view.value.contextUsage?.tokens)
        assertEquals(200000L, session.view.value.contextUsage?.contextWindow)
        assertEquals("model-y", session.view.value.model?.id)
        session.detach()
    }

    @Test
    fun `config changed updates permission model and task mode`() = runBlocking {
        val transport = FakeTransport()
        val session = newSession(transport)
        session.subscribe()

        transport.deliver(
            event(
                seq = 1,
                kind = "config_changed",
                data = buildJsonObject {
                    put("permission", "sandbox")
                    put("taskMode", "iterate")
                    put("model", buildJsonObject { put("provider", "p"); put("id", "model-z") })
                },
            ),
        )

        assertEquals(RemotePermission.Sandbox, session.view.value.summary?.permission)
        assertEquals("iterate", session.view.value.taskMode)
        assertEquals("model-z", session.view.value.model?.id)
        session.detach()
    }

    @Test
    fun `other threads' events are ignored`() = runBlocking {
        val transport = FakeTransport()
        val session = newSession(transport)
        session.subscribe()

        transport.deliver(
            RemoteEnvelope(v = 1, type = "thread.event", sessionId = "s", sentAt = 0, threadId = "other", payload = buildJsonObject { put("kind", "agent_start") }),
        )
        assertTrue("别的会话的事件不应影响本会话", !session.view.value.running)
        session.detach()
    }

    // ---- 构造工具 ----

    private fun event(seq: Int, kind: String, event: JsonObject? = null, data: JsonObject? = null): RemoteEnvelope {
        val payload = buildJsonObject {
            put("kind", kind)
            put(
                "data",
                buildJsonObject {
                    if (event != null) put("event", event)
                    data?.forEach { (key, value) -> put(key, value) }
                },
            )
        }
        return RemoteEnvelope(
            v = 1,
            type = "thread.event",
            sessionId = "sess-test",
            sentAt = 0,
            threadId = THREAD_ID,
            seq = seq.toLong(),
            payload = payload,
        )
    }

    private fun messageEvent(role: String) = buildJsonObject {
        put("message", buildJsonObject { put("role", role) })
    }

    private fun textDelta(seq: Int, delta: String) = event(
        seq = seq,
        kind = "message_update",
        event = buildJsonObject {
            put(
                "assistantMessageEvent",
                buildJsonObject {
                    put("type", "text_delta")
                    put("delta", delta)
                },
            )
        },
    )

    private fun toolCallStart(seq: Int, id: String, name: String) = event(
        seq = seq,
        kind = "message_update",
        event = buildJsonObject {
            put(
                "assistantMessageEvent",
                buildJsonObject {
                    put("type", "toolcall_start")
                    put("toolCall", buildJsonObject { put("id", id); put("name", name) })
                },
            )
        },
    )

    private fun uiRequest(seq: Int, id: String, option: String) = event(
        seq = seq,
        kind = "ui.request",
        data = buildJsonObject {
            put(
                "request",
                buildJsonObject {
                    put("id", id)
                    put("method", "select")
                    put("title", "需要批准")
                    put("options", buildJsonArray { add(option); add("拒绝") })
                },
            )
        },
    )

    private companion object {
        const val THREAD_ID = "t-1"

        /** 两条历史消息：一条用户文本 + 一条工具（工具块正文在 result 字段）。 */
        val SNAPSHOT = """
            {"snapshot":{
              "id":"t-1","projectId":"p1","title":"修复登录 bug","preview":"p","updatedAt":100,
              "messageCount":2,"state":"idle","permission":"full","cwdName":"MPI",
              "model":{"provider":"anthropic","id":"model-x"},
              "availableModels":[{"provider":"anthropic","id":"model-x","name":"Model X"}],
              "thinkingLevel":"low","taskMode":null,
              "availableModes":[{"id":"iterate","name":"迭代","summary":"沙盒 · 低思考"}],
              "contextUsage":{"tokens":10,"contextWindow":100,"percent":10},
              "messages":[
                {"id":"m1","role":"user","blocks":[{"type":"text","text":"第一条"}]},
                {"id":"m2","role":"assistant","blocks":[{"type":"tool","name":"bash","result":"工具输出内容"}]}
              ],
              "nextSeq":0
            }}
        """.trimIndent()
    }
}
