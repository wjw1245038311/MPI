package com.mpi.app

import com.mpi.app.data.RequestTransport
import com.mpi.app.data.ThreadSession
import com.mpi.app.protocol.Envelope
import com.mpi.app.protocol.RemoteEnvelope
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 重同步不再自激 + 主机补发时保住流式内容。
 *
 * 现场（2026-10-28）：桌面已经写出好几段，手机端停在旧内容不动。主机 diag 的指纹是
 * **同一条健康连接上 4.4 秒内 5 次 `thread.resync`，每次回 1.6MB 全量快照**。成因在
 * 客户端：快照传输/解析要几百毫秒到数秒，这段时间到达的实时增量仍按**旧 seq 基线**
 * 判缺口 → 又发一次 resync → 又传 1.6MB……而每次 `applySnapshot` 都会把正在流式的
 * 气泡清掉，于是用户看到的就是「一直不刷新」。
 *
 * 这里钉三件事：
 *  1. 同步期间到达的帧只缓冲，**不会再触发**第二次 resync；
 *  2. 缺口照旧被发现并触发一次 resync（不能因为加缓冲就把丢帧掩盖掉）；
 *  3. 主机回 `{replayed:true, snapshot:null}` 时**不应用快照**，正在流式的文本保住。
 */
class ThreadSyncReplayTest {

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

    private class Requests(private val handler: suspend (type: String) -> JsonElement?) {
        val calls = CopyOnWriteArrayList<String>()
        /** 每次请求的 payload 原文（断言增量锚点用）。 */
        val payloads = CopyOnWriteArrayList<Pair<String, String?>>()
        suspend fun request(type: String, payload: JsonElement?, threadId: String?, timeoutMs: Long?): JsonElement? {
            calls += type
            payloads += type to payload?.toString()
            return handler(type)
        }
    }

    private fun ThreadSession.push(transport: Transport, seq: Int, kind: String, data: String? = null) {
        val payload = if (data == null) {
            buildJsonObject { put("kind", kind) }
        } else {
            Envelope.json.parseToJsonElement("""{"kind":"$kind","data":$data}""")
        }
        transport.deliver(
            RemoteEnvelope(
                v = 1,
                type = "thread.event",
                sessionId = "sess-sync",
                sentAt = 0,
                threadId = "t-sync",
                seq = seq.toLong(),
                payload = payload,
            ),
        )
    }

    @Test
    fun `events arriving during an in-flight resync do not trigger a second one`() = runBlocking {
        val transport = Transport()
        val resyncCalls = AtomicInteger()
        val requests = Requests { type ->
            when (type) {
                "thread.subscribe" -> Envelope.json.parseToJsonElement(SNAPSHOT)
                "thread.resync" -> {
                    resyncCalls.incrementAndGet()
                    // 模拟「快照要传 1.6MB」：这 400ms 里实时事件照常到达
                    delay(400)
                    Envelope.json.parseToJsonElement(SNAPSHOT)
                }
                else -> null
            }
        }
        val session = ThreadSession(
            threadId = "t-sync",
            transport = transport,
            request = requests::request,
            scope = scope,
        )
        session.subscribe()

        session.push(transport, 1, "agent_start")
        // 缺 2、3、4 —— 一帧跨到 5，必须触发一次重同步
        session.push(transport, 5, "message_update", """{"event":{"assistantMessageEvent":{"type":"text_delta","delta":"A"}}}""")
        // 重同步在飞的这段时间里继续来帧：它们只该被缓冲
        session.push(transport, 6, "message_update", """{"event":{"assistantMessageEvent":{"type":"text_delta","delta":"B"}}}""")
        session.push(transport, 7, "message_update", """{"event":{"assistantMessageEvent":{"type":"text_delta","delta":"C"}}}""")

        delay(900) // 等重同步跑完 + 节流窗口冲刷

        assertEquals(
            "同步期间到达的帧只缓冲，不该再触发第二次 resync（自激循环的根源）",
            1,
            resyncCalls.get(),
        )
        assertEquals("thread.subscribe 只该发生一次", 1, requests.calls.count { it == "thread.subscribe" })
        session.detach()
    }

    @Test
    fun `a replayed ack keeps the streaming text instead of applying a snapshot`() = runBlocking {
        val transport = Transport()
        val subscribeCalls = AtomicInteger()
        val requests = Requests { type ->
            when (type) {
                "thread.subscribe" -> {
                    // 第一次订阅给快照；之后的重订阅模拟主机「断线期间的事件已补发」
                    if (subscribeCalls.incrementAndGet() == 1) {
                        Envelope.json.parseToJsonElement(RUNNING_SNAPSHOT)
                    } else {
                        // 真实主机在这个响应之前已经同步把补发事件推过来了
                        transport.deliver(
                            RemoteEnvelope(
                                v = 1,
                                type = "thread.event",
                                sessionId = "sess-sync",
                                sentAt = 0,
                                threadId = "t-sync",
                                seq = 3L,
                                payload = Envelope.json.parseToJsonElement(
                                    """{"kind":"message_update","data":{"event":{"assistantMessageEvent":{"type":"text_delta","delta":"断线期间写的字"}}}}""",
                                ),
                            ),
                        )
                        Envelope.json.parseToJsonElement("""{"replayed":true,"snapshot":null,"replayFrom":3,"replayTo":3}""")
                    }
                }
                else -> null
            }
        }
        val session = ThreadSession(
            threadId = "t-sync",
            transport = transport,
            request = requests::request,
            scope = scope,
        )
        session.subscribe()
        session.push(transport, 1, "agent_start")
        session.push(transport, 2, "message_update", """{"event":{"assistantMessageEvent":{"type":"text_delta","delta":"已经显示的一段"}}}""")
        delay(200) // 让节流窗口提交

        val before = session.view.value.streaming?.blocks?.joinToString("") { it.text.orEmpty() }.orEmpty()
        assertTrue("先有流式内容，实际：$before", before.contains("已经显示的一段"))

        // 断线重连：新连接在主机侧没有订阅 → resync 走 subscribe
        session.invalidateSubscription()
        session.resync()
        delay(400)

        val view = session.view.value
        val streaming = view.streaming?.blocks?.joinToString("") { it.text.orEmpty() }.orEmpty()
        assertTrue(
            "主机回 replayed 时**不该应用快照**（否则正在流式的气泡会被清空）：实际 streaming=$streaming",
            streaming.contains("已经显示的一段"),
        )
        assertTrue("补发的事件应按序接上：实际 streaming=$streaming", streaming.contains("断线期间写的字"))
        assertTrue("补发不该把历史消息换掉", view.messages.isNotEmpty())
        session.detach()
    }


    @Test
    fun `a phone-sent message adopts the host id so the next subscribe carries a real anchor`() = runBlocking {
        // 手机发的消息：先乐观回显（local-N / u-local-N），随后收到 message_start(user)。
        // 必须把 id 改成主机那串（user-<timestamp>），否则下一次订阅带上去的就是个
        // 主机不认识的 id → 增量永远 miss → 每次重进会话都重下整段历史。
        val transport = Transport()
        val requests = Requests { type ->
            if (type == "thread.subscribe") Envelope.json.parseToJsonElement(SNAPSHOT) else null
        }
        val session = ThreadSession(
            threadId = "t-sync",
            transport = transport,
            request = requests::request,
            scope = scope,
        )
        session.subscribe()
        session.echoUserMessage("在验证下")
        // 与真机一致：pi 的 user message 带 timestamp（session 文件里那条是 1793232049109）
        session.push(
            transport,
            1,
            "message_start",
            """{"event":{"message":{"role":"user","timestamp":1793232049109,"content":[{"type":"text","text":"在验证下"}]}}}""",
        )
        delay(120)

        assertEquals(
            "回显转正后应改用主机 id",
            "user-1793232049109",
            session.view.value.messages.last().id,
        )

        // 重进/重连：带上这个锚点
        session.invalidateSubscription()
        session.resync()
        delay(120)
        val subscribePayload = requests.payloads.last { it.first == "thread.subscribe" }.second.orEmpty()
        assertTrue(
            "订阅应带主机锚点，实际 payload：$subscribePayload",
            subscribePayload.contains("\"haveMessageId\":\"user-1793232049109\""),
        )
        session.detach()
    }

    private companion object {
        val SNAPSHOT = """
            {"snapshot":{
              "id":"t-sync","projectId":"proj-mpi","title":"测试","preview":"p","updatedAt":100,
              "messageCount":1,"state":"idle","permission":"sandbox",
              "model":null,"availableModels":[],"thinkingLevel":"","taskMode":null,"availableModes":[],
              "contextUsage":null,
              "messages":[{"id":"m1","role":"user","blocks":[{"type":"text","text":"历史"}]}],
              "nextSeq":0
            }}
        """.trimIndent()

        val RUNNING_SNAPSHOT = SNAPSHOT.replace("\"state\":\"idle\"", "\"state\":\"running\"")
    }
}
