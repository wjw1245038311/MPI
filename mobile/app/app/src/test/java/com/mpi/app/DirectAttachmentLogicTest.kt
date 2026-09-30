package com.mpi.app

import com.mpi.app.data.AttachmentCrypto
import com.mpi.app.data.DIRECT_DOWNLOAD_CHUNK_BYTES
import com.mpi.app.data.DIRECT_DOWNLOAD_CONCURRENCY
import com.mpi.app.data.DIRECT_UPLOAD_CHUNK_BYTES
import com.mpi.app.data.DIRECT_UPLOAD_CONCURRENCY
import com.mpi.app.data.contentRangeHeader
import com.mpi.app.data.directChunkBounds
import com.mpi.app.data.directUploadPlan
import com.mpi.app.data.downloadOffsets
import com.mpi.app.data.mimeTypeFromName
import com.mpi.app.data.parseDirectTarget
import com.mpi.app.data.sha256OfStream
import com.mpi.app.ui.VideoUpload
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * P2（安卓端附件直连）：分片边界 / Content-Range / 令牌回包解析。
 *
 * 这三处都是「写错了现场很难归因」的地方：分片边界错 → 传到 99% 被主机拒；
 * 声明格式错 → 400；回包解析太严 → 直连明明可用却走回落（用户看到的是「怎么还是慢」）。
 */
class DirectAttachmentLogicTest {

    // ---- 分片边界 ----

    @Test
    fun `chunks cover the whole file without gaps or overlap`() {
        val total = DIRECT_UPLOAD_CHUNK_BYTES * 2L + 123L
        val bounds = directChunkBounds(total)
        assertEquals(3, bounds.size)
        assertEquals(0L, bounds[0].first)
        assertEquals(DIRECT_UPLOAD_CHUNK_BYTES.toLong() - 1, bounds[0].second)
        assertEquals(DIRECT_UPLOAD_CHUNK_BYTES.toLong(), bounds[1].first)
        // 最后一片：到 total-1 结束，长度是余数
        assertEquals(total - 1, bounds.last().second)
        assertEquals(123L, bounds.last().second - bounds.last().first + 1)
        // 无缝隙：每片起点 = 上一片终点 + 1
        bounds.zipWithNext().forEach { (a, b) -> assertEquals(a.second + 1, b.first) }
    }

    @Test
    fun `an exact multiple ends precisely at the last byte`() {
        val bounds = directChunkBounds(DIRECT_UPLOAD_CHUNK_BYTES.toLong() * 3)
        assertEquals(3, bounds.size)
        assertEquals(DIRECT_UPLOAD_CHUNK_BYTES.toLong() * 3 - 1, bounds.last().second)
    }

    @Test
    fun `a single small chunk is one range starting at zero`() {
        val bounds = directChunkBounds(1024)
        assertEquals(listOf(0L to 1023L), bounds)
    }

    /**
     * 空文件/非法长度不该产生分片：主机侧 `size` 缺失时 `total` 只来自声明，
     * 多传一片空数据会让「收齐判定」永远不成立（上传卡住）。
     */
    @Test
    fun `zero or negative sizes produce no chunks`() {
        assertEquals(emptyList<Pair<Long, Long>>(), directChunkBounds(0))
        assertEquals(emptyList<Pair<Long, Long>>(), directChunkBounds(-5))
    }

    @Test
    fun `a custom chunk size is honoured`() {
        assertEquals(listOf(0L to 1L, 2L to 3L, 4L to 4L), directChunkBounds(5, chunk = 2))
    }

    // ---- 并发上传计划（客户端屏障） ----

    /**
     * 最后一片必须单独拿出来屏障——否则乱序并发下，最高偏移那片提前到达会让主机
     * （收齐判据 = 临时文件大小）**误判定稿**，剩下的片就写上了一个已经被改名的成品之外。
     */
    @Test
    fun `the last chunk is held back for the barrier`() {
        val total = DIRECT_UPLOAD_CHUNK_BYTES * 3L
        val plan = directUploadPlan(total)
        assertEquals(2, plan.parallel.size)
        assertEquals(0L, plan.parallel.first().first)
        assertEquals(DIRECT_UPLOAD_CHUNK_BYTES * 2L - 1, plan.parallel.last().second)
        assertEquals(DIRECT_UPLOAD_CHUNK_BYTES * 2L, plan.last!!.first)
        assertEquals(total - 1, plan.last!!.second)
    }

    @Test
    fun `a single chunk is only the barrier chunk`() {
        val plan = directUploadPlan(1024)
        assertEquals(emptyList<Pair<Long, Long>>(), plan.parallel)
        assertEquals(0L to 1023L, plan.last)
    }

    @Test
    fun `an empty upload has no plan`() {
        assertEquals(emptyList<Pair<Long, Long>>(), directUploadPlan(0).parallel)
        assertNull(directUploadPlan(0).last)
    }

    @Test
    fun `parallel chunks plus the barrier chunk still cover everything exactly once`() {
        val total = DIRECT_UPLOAD_CHUNK_BYTES * 4L + 7L
        val plan = directUploadPlan(total)
        val ordered = plan.parallel + listOfNotNull(plan.last)
        assertEquals(directChunkBounds(total), ordered)
    }

    /** 并发度太小等于串行，太大则手机内存里同时叠好几十 MB——写成单测防手滑调大。 */
    @Test
    fun `upload concurrency stays in a sane range`() {
        assertTrue("至少要真的并发", DIRECT_UPLOAD_CONCURRENCY >= 2)
        assertTrue("同时驻留的分片内存别超 32MB", DIRECT_UPLOAD_CONCURRENCY <= 8)
    }

    // ---- Content-Range ----

    @Test
    fun `content range declares offset, inclusive end and total`() {
        // 主机侧 parseUploadOffset 的正式要求：`bytes <start>-<end>/<total>`，end 含端点
        assertEquals("bytes 0-4194303/8388608", contentRangeHeader(0, 4_194_303, 8_388_608))
        assertEquals("bytes 4194304-8388607/8388608", contentRangeHeader(4_194_304, 8_388_607, 8_388_608))
    }

    // ---- 令牌回包 ----

    @Test
    fun `a well formed direct payload is parsed`() {
        val payload = buildJsonObject {
            put("direct", buildJsonObject {
                put("url", "https://workstation.tail38d5a.ts.net:8443/att/tok")
                put("token", "tok")
                put("name", "uuid-clip.mp4")
                put("expiresAt", 1_790_000_000_000L)
            })
        }
        val target = parseDirectTarget(payload)
        assertEquals("https://workstation.tail38d5a.ts.net:8443/att/tok", target?.url)
        assertEquals("uuid-clip.mp4", target?.name)
        assertEquals(1_790_000_000_000L, target?.expiresAt)
    }

    /** 形状不对一律 null（调用方走回落），不能抛——直连失败不是错误，是预期内的一条路。 */
    @Test
    fun `malformed payloads fall back instead of throwing`() {
        assertNull("缺 direct", parseDirectTarget(buildJsonObject { put("ok", true) }))
        assertNull("URL 空", parseDirectTarget(buildJsonObject { put("direct", buildJsonObject { put("url", ""); put("name", "a") }) }))
        assertNull("名字缺失", parseDirectTarget(buildJsonObject { put("direct", buildJsonObject { put("url", "https://h/att/t") }) }))
        assertNull("direct 不是对象", parseDirectTarget(buildJsonObject { put("direct", "nope") }))
        assertNull("payload 为 null", parseDirectTarget(null))
    }

    // ---- 内容寻址（P1）：deduped / key / label ----

    @Test
    fun `a deduped payload has no url but is still usable`() {
        val key = "a".repeat(64)
        val payload = buildJsonObject {
            put("direct", buildJsonObject {
                put("url", "")
                put("token", "")
                put("name", key)
                put("key", "sha256:$key")
                put("label", "clip.mp4")
                put("deduped", true)
            })
        }
        val target = parseDirectTarget(payload)
        assertEquals("去重命中也要能用（消息里带的就是 name）", key, target?.name)
        assertEquals(true, target?.deduped)
        assertEquals("sha256:$key", target?.key)
        assertEquals("clip.mp4", target?.label)
    }

    @Test
    fun `a key based upload target carries sha256 fields`() {
        val key = "b".repeat(64)
        val payload = buildJsonObject {
            put("direct", buildJsonObject {
                put("url", "http://47.97.28.110:10444/att/tok")
                put("token", "tok")
                put("name", key)
                put("key", "sha256:$key")
                put("deduped", false)
            })
        }
        val target = parseDirectTarget(payload)
        assertEquals(key, target?.name)
        assertEquals(false, target?.deduped)
        // 老主机（无 key/deduped 字段）：仍必须解析出可用目标，照旧走上传。
        assertNull("老主机没有 deduped", parseDirectTarget(buildJsonObject { put("direct", buildJsonObject { put("url", "https://h/att/t"); put("name", "uuid-x.mp4") }) })?.deduped)
    }

    // ---- 「降落到工作区」（P3-S2）：大文件给 agent 读的那条路 ----

    @Test
    fun `a workspace payload exposes the materialized path`() {
        val key = "e".repeat(64)
        val payload = buildJsonObject {
            put("direct", buildJsonObject {
                put("url", "")
                put("token", "")
                put("name", key)
                put("deduped", true)
                put("workspacePath", "C:\\ws\\mpi-inbox\\报表.xlsx")
                put("workspaceName", "报表.xlsx")
            })
        }
        val target = parseDirectTarget(payload)
        assertEquals("去重命中时主机在 mint 阶段就把文件放进工作区了", "C:\\ws\\mpi-inbox\\报表.xlsx", target?.workspacePath)
        assertEquals("报表.xlsx", target?.workspaceName)
    }

    @Test
    fun `submission result picks the file name out of a windows path`() {
        val outcome = com.mpi.app.data.DirectAttachments.PutOutcome(null, "{}", "C:\\ws\\mpi-inbox\\data.bin")
        assertEquals("C:\\ws\\mpi-inbox\\data.bin", outcome.workspacePath)
        assertEquals("从末片回执的绝对路径里取文件名（POSIX 与 Windows 都要能取）", "data.bin", outcome.workspaceName)
        assertNull(com.mpi.app.data.DirectAttachments.PutOutcome(null, "{}", null).workspacePath)
    }

    @Test
    fun `sha256 of a stream matches the known vector`() {
        // 钉死的向量："hello world\n" 的 SHA-256（避免哈希实现悄悄改口径）。
        val bytes = "hello world\n".toByteArray(Charsets.UTF_8)
        assertEquals(
            "a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447",
            sha256OfStream { java.io.ByteArrayInputStream(bytes) },
        )
        // 大一点、跨读块边界（1MB 块）：内容相同 → 结果与一次性算的一致
        val big = ByteArray(1024 * 1024 * 2 + 7) { (it % 251).toByte() }
        val expected = java.security.MessageDigest.getInstance("SHA-256").digest(big)
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
        assertEquals(expected, sha256OfStream { java.io.ByteArrayInputStream(big) })
        // 读不出来 → null（调用方据此报「无法读取视频」，而不是传一份算不出 key 的字节）
        assertNull(sha256OfStream { throw java.io.IOException("boom") })
    }

    @Test
    fun `a token without expiresAt still parses`() {
        val payload = buildJsonObject {
            put("direct", buildJsonObject {
                put("url", "https://h/att/t")
                put("name", "n")
            })
        }
        assertEquals(0L, parseDirectTarget(payload)?.expiresAt)
    }

    // ---- 入口分流 / 进度 ----

    @Test
    fun `mime fallback maps the extensions the host also treats as video`() {
        assertEquals("video/mp4", mimeTypeFromName("clip.mp4"))
        assertEquals("video/mp4", mimeTypeFromName("CLIP.MP4"))
        assertEquals("video/quicktime", mimeTypeFromName("a.mov"))
        assertEquals("video/x-matroska", mimeTypeFromName("a.mkv"))
        assertNull("图片不该被当成视频", mimeTypeFromName("a.jpg"))
        assertNull("没有扩展名", mimeTypeFromName("noext"))
    }

    @Test
    fun `upload percent never reaches 100 before the last chunk`() {
        assertEquals(0, VideoUpload("a", 0, 100).percent)
        assertEquals(99, VideoUpload("a", 99, 100).percent)
        // 主机报的 total 可能大于已传字节（尚未收齐）→ 仍显示 99，别显示 100
        assertEquals(99, VideoUpload("a", 100, 100).percent)
        assertNull("总长未知 → 不定进度", VideoUpload("a", 0, 0).percent)
    }

    // ---- 应用层加密：与主机（Node）逐字节对齐 ----

    /**
     * **跨端测试向量**：同一组固定输入，主机侧（`src/main/remote/attachment-crypto.ts`）派生出
     * `82873c46…`；安卓这边必须一模一样——不一致的表现是「加密上传全部 400」，而现场很难看出根因。
     * （生成命令见提交信息；与 `scripts/test-e2e-crypto.mjs` 的跨端钉法同一套路。）
     */
    @Test
    fun `attachment key derivation matches the host byte for byte`() {
        val sessionKey = ByteArray(32) { 0x5a.toByte() }
        val key = AttachmentCrypto.deriveKey(sessionKey, "tok-1", AttachmentCrypto.UP, "clip.mp4")
        assertEquals(
            "82873c461956178b1807e11c1d0b90b77e2a194e7c38d8629e844bf0344ddc53",
            key.joinToString("") { "%02x".format(it) },
        )
        assertEquals("mpi-attachment-v1|up|clip.mp4", AttachmentCrypto.infoString(AttachmentCrypto.UP, "clip.mp4"))
        assertEquals("v1|up|clip.mp4|4194304|5", AttachmentCrypto.aad(AttachmentCrypto.UP, "clip.mp4", 4_194_304, 5))
    }

    @Test
    fun `attachment frame round trips and rejects tampering`() {
        val sessionKey = ByteArray(32) { 0x5a.toByte() }
        val key = AttachmentCrypto.deriveKey(sessionKey, "tok-1", AttachmentCrypto.DOWN, "clip.mp4")
        val plain = "一份不该被别人看到的视频字节".toByteArray(Charsets.UTF_8)
        val aad = AttachmentCrypto.aad(AttachmentCrypto.DOWN, "clip.mp4", 1024, plain.size)
        val frame = AttachmentCrypto.encrypt(key, plain, aad)

        assertEquals("帧 = nonce(12) + 密文 + tag(16)", plain.size + AttachmentCrypto.OVERHEAD, frame.size)
        assertArrayEquals(plain, AttachmentCrypto.decrypt(key, frame, aad))

        val tampered = frame.copyOf()
        tampered[tampered.size - 1] = (tampered[tampered.size - 1] + 1).toByte()
        try {
            AttachmentCrypto.decrypt(key, tampered, aad)
            org.junit.Assert.fail("改一个 bit 就必须解不开")
        } catch (_: Exception) {
            // 预期
        }
        try {
            AttachmentCrypto.decrypt(key, frame, AttachmentCrypto.aad(AttachmentCrypto.UP, "clip.mp4", 1024, plain.size))
            org.junit.Assert.fail("方向写进 AAD，换方向必须解不开")
        } catch (_: Exception) {
            // 预期
        }
    }

    // ---- 下行并发（18MB 音频：串行 19s → 并发 3s 级）---------------------------

    /** 分片必须刚好铺满 [0, total) 一次：漏一片尾部就短一截，重叠一片就多跑一趟。 */
    @Test
    fun `download offsets tile the whole file exactly once`() {
        val total = 18_135_572L
        val chunk = DIRECT_DOWNLOAD_CHUNK_BYTES.toLong()
        val offsets = downloadOffsets(total, chunk, chunk)
        assertEquals("18MB / 2MB = 第一片 + 8 片", 8, offsets.size)
        var covered = chunk
        for (offset in offsets) {
            assertEquals("每片必须接在上一片之后（无缝）", covered, offset)
            covered += chunk
        }
        assertTrue("最后一片覆盖到文件尾", covered >= total)
    }

    /** 这几类边界错了不会报错，只会「白跑一趟」或「永远循环」。 */
    @Test
    fun `download offsets stay empty when the first chunk already holds everything`() {
        assertEquals(emptyList<Long>(), downloadOffsets(100, 100, 64))
        assertEquals("第一片超出 total（服务端 clamp 前）不再排片", emptyList<Long>(), downloadOffsets(100, 150, 64))
        assertEquals("total 未知 → 保守走单片路径", emptyList<Long>(), downloadOffsets(0, 64, 64))
        assertEquals("分片为 0 会死循环，必须排空", emptyList<Long>(), downloadOffsets(100, 32, 0))
    }

    @Test
    fun `downlink uses the tuned chunk size and concurrency`() {
        assertTrue("并发太小没提速、太大打满内存与连接池", DIRECT_DOWNLOAD_CONCURRENCY in 2..8)
        assertEquals(2L * 1024 * 1024, DIRECT_DOWNLOAD_CHUNK_BYTES.toLong())
        assertTrue("比旧的 512KB 大（Range 往返次数少 4 倍）", DIRECT_DOWNLOAD_CHUNK_BYTES > 512 * 1024)
    }
}
