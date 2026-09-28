package com.mpi.app

import com.mpi.app.data.RequestException
import com.mpi.app.data.SendMode
import com.mpi.app.data.ThreadActions
import com.mpi.app.protocol.RemotePermission
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * M2-3：写操作与写租约（纯单元测试）。
 *
 * 租约是最容易出错的地方：取早了浪费往返，取晚了被主机拒（WRITE_CLAIM_REQUIRED），
 * 而「别的设备持有」时又绝不能抢占。三种情况都在这里钉死。
 */
class ThreadActionsTest {

    private class FakeRequests {
        val calls = CopyOnWriteArrayList<Triple<String, JsonElement?, Long?>>()

        /** 按顺序消费的失败脚本：type → 抛出的错误码。 */
        val failures = mutableMapOf<String, MutableList<String>>()

        suspend fun request(type: String, payload: JsonElement?, threadId: String?, timeoutMs: Long?): JsonElement? {
            calls += Triple(type, payload, timeoutMs)
            val queue = failures[type]
            if (queue != null && queue.isNotEmpty()) {
                val code = queue.removeAt(0)
                throw RequestException("$type 失败：$code", RequestException.Kind.HostError, code = code)
            }
            return buildJsonObject { put("ok", true) }
        }

        fun types(): List<String> = calls.map { it.first }

        fun count(type: String): Int = types().count { it == type }

        fun payloadOf(type: String): JsonObject =
            calls.last { it.first == type }.second?.jsonObject ?: error("没有 $type 的调用")
    }

    private var now = 1_000_000L

    private fun actions(requests: FakeRequests, onClaim: () -> Unit = {}): ThreadActions = ThreadActions(
        threadId = "t-1",
        request = requests::request,
        clock = { now },
        onClaim = onClaim,
    )

    // ---- 发送模式 ----

    @Test
    fun `send uses the method that matches the mode`() = runBlocking {
        for (mode in SendMode.entries) {
            val requests = FakeRequests()
            actions(requests).send("你好", mode)
            assertEquals(1, requests.count("thread.claimWrite"))
            assertEquals("模式 ${mode.name} 应走 ${mode.method}", 1, requests.count("thread.${mode.method}"))
            assertEquals("你好", requests.payloadOf("thread.${mode.method}")["text"]?.jsonPrimitive?.content)
        }
    }

    @Test
    fun `blank text is rejected before touching the wire`() = runBlocking {
        val requests = FakeRequests()
        try {
            actions(requests).send("   ", SendMode.Prompt)
            fail("空消息应被拒绝")
        } catch (e: IllegalArgumentException) {
            assertTrue(requests.calls.isEmpty())
        }
    }

    @Test
    fun `text is trimmed`() = runBlocking {
        val requests = FakeRequests()
        actions(requests).send("  帮我看看  \n", SendMode.Prompt)
        assertEquals("帮我看看", requests.payloadOf("thread.prompt")["text"]?.jsonPrimitive?.content)
    }

    // ---- 写租约 ----

    @Test
    fun `the claim is taken once and reused within the lease`() = runBlocking {
        val requests = FakeRequests()
        val subject = actions(requests)
        subject.send("一", SendMode.Prompt)
        subject.send("二", SendMode.Prompt)
        assertEquals("租约内不应重复 claim", 1, requests.count("thread.claimWrite"))
    }

    @Test
    fun `the claim is refreshed proactively after 80 percent of the lease`() = runBlocking {
        val requests = FakeRequests()
        val subject = actions(requests)
        subject.send("一", SendMode.Prompt)
        assertEquals(1, requests.count("thread.claimWrite"))

        // 注意：不能中间再插一次成功写入 —— 那会把租期滑动，就不是在测这条了
        // （「滑动」本身由下一条用例单测）。
        now += ThreadActions.DEFAULT_LEASE_MS * 8 / 10 + 1
        subject.send("二", SendMode.Prompt)
        assertEquals("超过 80% 租期应主动续期（而不是等主机报错）", 2, requests.count("thread.claimWrite"))
    }

    @Test
    fun `a successful write slides the local lease`() = runBlocking {
        val requests = FakeRequests()
        val subject = actions(requests)
        subject.send("一", SendMode.Prompt)

        // 每次成功写入主机都会滑动续期，本地也要跟上：
        // 若本地不更新，就会在主机其实还有效时白白多取一次
        now += ThreadActions.DEFAULT_LEASE_MS / 2
        subject.send("二", SendMode.Prompt)
        now += ThreadActions.DEFAULT_LEASE_MS / 2
        subject.send("三", SendMode.Prompt)
        assertEquals(1, requests.count("thread.claimWrite"))
    }

    @Test
    fun `WRITE_CLAIM_REQUIRED triggers exactly one re-claim and a retry`() = runBlocking {
        val requests = FakeRequests()
        requests.failures["thread.prompt"] = mutableListOf("WRITE_CLAIM_REQUIRED")
        val claims = mutableListOf<Long>()
        val subject = actions(requests) { claims += now }

        subject.send("重试一次", SendMode.Prompt)

        assertEquals("应先取租约 → 被拒 → 强制重取 → 重试", 2, requests.count("thread.claimWrite"))
        assertEquals("写请求应发了两次", 2, requests.count("thread.prompt"))
        assertEquals(2, claims.size)
    }

    @Test
    fun `a second WRITE_CLAIM_REQUIRED is not retried forever`() = runBlocking {
        val requests = FakeRequests()
        requests.failures["thread.prompt"] = mutableListOf("WRITE_CLAIM_REQUIRED", "WRITE_CLAIM_REQUIRED")
        try {
            actions(requests).send("会连续失败", SendMode.Prompt)
            fail("第二次被拒应直接上抛，不能无限重试")
        } catch (e: RequestException) {
            assertEquals(ThreadActions.WRITE_CLAIM_REQUIRED, e.code)
        }
        assertEquals("只允许强制重取一次", 2, requests.count("thread.claimWrite"))
    }

    @Test
    fun `THREAD_BUSY is propagated without stealing the lease`() = runBlocking {
        val requests = FakeRequests()
        requests.failures["thread.steer"] = mutableListOf(ThreadActions.THREAD_BUSY)
        try {
            actions(requests).send("别的设备在写", SendMode.Steer)
            fail("THREAD_BUSY 应上抛给 UI")
        } catch (e: RequestException) {
            assertEquals(ThreadActions.THREAD_BUSY, e.code)
        }
        assertEquals("别的设备持有时不得抢占：只 claim 了一次", 1, requests.count("thread.claimWrite"))
    }

    // ---- 其它写操作 ----

    @Test
    fun `abort and configuration writes carry the right payloads`() = runBlocking {
        val requests = FakeRequests()
        val subject = actions(requests)

        subject.abort()
        assertEquals(1, requests.count("thread.abort"))

        subject.setPermission(RemotePermission.Full)
        assertEquals("full", requests.payloadOf("thread.setPermission")["permission"]?.jsonPrimitive?.content)

        subject.setPermission(RemotePermission.Sandbox)
        assertEquals("sandbox", requests.payloadOf("thread.setPermission")["permission"]?.jsonPrimitive?.content)

        subject.setModel("anthropic", "model-x")
        val model = requests.payloadOf("thread.setModel")
        assertEquals("anthropic", model["provider"]?.jsonPrimitive?.content)
        assertEquals("model-x", model["modelId"]?.jsonPrimitive?.content)

        subject.setMode("iterate")
        assertEquals("iterate", requests.payloadOf("thread.setMode")["modeId"]?.jsonPrimitive?.content)

        subject.setMode("") // 空串 = 清除模式
        assertEquals("", requests.payloadOf("thread.setMode")["modeId"]?.jsonPrimitive?.content)
    }

    @Test
    fun `respondUi sends the request id together with the response`() = runBlocking {
        val requests = FakeRequests()
        actions(requests).respondUi("ui-1", buildJsonObject { put("value", "允许本次") })

        val payload = requests.payloadOf("ui.respond")
        assertEquals("ui-1", payload["requestId"]?.jsonPrimitive?.content)
        assertEquals("允许本次", payload["response"]?.jsonObject?.get("value")?.jsonPrimitive?.content)
    }

    @Test
    fun `compact allows a much longer timeout than ordinary writes`() = runBlocking {
        val requests = FakeRequests()
        val subject = actions(requests)
        subject.send("普通请求", SendMode.Prompt)
        subject.compact()

        val sendTimeout = requests.calls.first { it.first == "thread.prompt" }.third
        val compactTimeout = requests.calls.first { it.first == "thread.compact" }.third
        assertEquals("普通写请求用默认超时", null, sendTimeout)
        assertEquals(ThreadActions.COMPACT_TIMEOUT_MS, compactTimeout)
    }

    @Test
    fun `every write goes through the claim first`() = runBlocking {
        val requests = FakeRequests()
        val subject = actions(requests)
        subject.abort()
        assertEquals(listOf("thread.claimWrite", "thread.abort"), requests.types())
    }

    // ---- 附件按需取字节（attachment.fetch）------------------------------------

    /**
     * 分片循环是“视频能不能播”的全部逻辑：offset 不前进 / eof 判错 / 丢片，
     * 症状都是“播到一半卡住”，而日志上一切正常。这里用真文件比对来钉死。
     */
    private class FakeAttachments(private val source: ByteArray, private val chunkSize: Int = 1000) {
        val offsets = CopyOnWriteArrayList<Long>()
        val callTypes = CopyOnWriteArrayList<String>()
        val payloadKeys = CopyOnWriteArrayList<List<String>>()
        /** 强制覆盖 eof（测护栏用）。 */
        var forceEof: Boolean? = null
        /** 强制回空片（测“无进展”护栏用）。 */
        var emptyChunks = false
        /** 永远返回同一小片且不置 eof（测分片数上限护栏用：offset 在前进，但永远到不了头）。 */
        var infiniteChunks = false

        suspend fun request(type: String, payload: JsonElement?, threadId: String?, timeoutMs: Long?): JsonElement? {
            val body = payload?.jsonObject ?: error("payload 缺失")
            callTypes += type
            payloadKeys += body.keys.sorted()
            val offset = body["offset"]!!.jsonPrimitive.content.toInt()
            offsets += offset.toLong()
            val data = when {
                emptyChunks -> ByteArray(0)
                infiniteChunks -> byteArrayOf(7)
                else -> source.copyOfRange(offset, minOf(offset + chunkSize, source.size))
            }
            val eof = forceEof ?: (offset + data.size >= source.size)
            return buildJsonObject {
                put("chunk", buildJsonObject {
                    put("name", "clip.mp4")
                    put("size", source.size)
                    put("offset", offset)
                    put("length", data.size)
                    put("eof", eof)
                    put("data", java.util.Base64.getEncoder().encodeToString(data))
                })
            }
        }

        fun types() = offsets.size
    }

    @Test
    fun `fetchAttachmentTo assembles chunks, reports progress, and never claims a write lease`() = runBlocking {
        val source = ByteArray(2_500) { (it % 251).toByte() }
        val attachments = FakeAttachments(source, chunkSize = 1000)
        val actions = ThreadActions(threadId = "t-1", request = attachments::request)
        val target = File.createTempFile("mpi-attach", ".mp4").apply { delete() }
        val progress = mutableListOf<Pair<Long, Long>>()
        try {
            val written = actions.fetchAttachmentTo("a4f0-clip.mp4", target, { loaded, total -> progress += loaded to total })
            assertEquals("写入字节数必须等于原文件", source.size.toLong(), written)
            assertArrayEquals("落盘内容必须与原文件逐字节一致", source, target.readBytes())
            assertEquals("三片（1000 + 1000 + 500）", 3, attachments.types())
            assertEquals("最后一次进度必须是 已写=总大小（否则界面百分比永远到不了头）", source.size.toLong(), progress.last().first)
            assertEquals("总大小来自主机", source.size.toLong(), progress.last().second)
            assertTrue("拉字节不能取写租约（它是只读操作）", attachments.callTypes.none { it == "thread.claimWrite" })
            assertEquals("只发 attachment.fetch", listOf("attachment.fetch"), attachments.callTypes.distinct())
            assertTrue("payload 只带 name/offset（分片边界由服务端决定）", attachments.payloadKeys.all { it == listOf("name", "offset") })
        } finally {
            target.delete()
        }
    }

    @Test
    fun `fetchAttachmentTo rejects path components in the attachment name`() {
        val actions = ThreadActions(threadId = "t-1", request = { _, _, _, _ -> null })
        val target = File.createTempFile("mpi-attach", ".mp4")
        try {
            listOf("../secret.mp4", "a/b.mp4", "").forEach { bad ->
                try {
                    runBlocking { actions.fetchAttachmentTo(bad, target) }
                    fail("非法附件名应该被拒绝：$bad")
                } catch (_: IllegalArgumentException) {
                    // 预期
                }
            }
        } finally {
            target.delete()
        }
    }

    @Test
    fun `fetchAttachmentTo stops instead of looping forever when the host never finishes`() = runBlocking {
        val actions = ThreadActions(
            threadId = "t-1",
            request = FakeAttachments(ByteArray(500), chunkSize = 500)
                .also { it.forceEof = false; it.infiniteChunks = true }::request,
        )
        val target = File.createTempFile("mpi-attach", ".mp4").apply { delete() }
        try {
            try {
                actions.fetchAttachmentTo("clip.mp4", target)
                fail("主机一直不置 eof 时必须中止（否则无限请求／内存增长）")
            } catch (e: IllegalStateException) {
                assertTrue("错误要说明原因：${e.message}", e.message!!.contains("分片数量异常"))
            }
        } finally {
            target.delete()
        }
    }

    @Test
    fun `fetchAttachmentTo refuses an empty chunk that is not the end`() = runBlocking {
        val actions = ThreadActions(threadId = "t-1", request = FakeAttachments(ByteArray(500)).also { it.emptyChunks = true }::request)
        val target = File.createTempFile("mpi-attach", ".mp4").apply { delete() }
        try {
            try {
                actions.fetchAttachmentTo("clip.mp4", target)
                fail("空片且未结束 = 无进展，必须中止")
            } catch (e: IllegalStateException) {
                assertTrue("错误要说明原因：${e.message}", e.message!!.contains("无进展"))
            }
        } finally {
            target.delete()
        }
    }
}
