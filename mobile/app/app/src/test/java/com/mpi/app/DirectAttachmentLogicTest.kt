package com.mpi.app

import com.mpi.app.data.DIRECT_UPLOAD_CHUNK_BYTES
import com.mpi.app.data.DIRECT_UPLOAD_CONCURRENCY
import com.mpi.app.data.contentRangeHeader
import com.mpi.app.data.directChunkBounds
import com.mpi.app.data.directUploadPlan
import com.mpi.app.data.mimeTypeFromName
import com.mpi.app.data.parseDirectTarget
import com.mpi.app.ui.VideoUpload
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
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
}
