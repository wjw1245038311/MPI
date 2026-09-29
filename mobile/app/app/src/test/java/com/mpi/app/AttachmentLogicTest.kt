package com.mpi.app

import com.mpi.app.data.Attachment
import com.mpi.app.data.MAX_RAW_BYTES
import com.mpi.app.data.THUMB_MAX_BYTES
import com.mpi.app.data.imagePayloads
import com.mpi.app.data.looksLikeVideo
import com.mpi.app.data.nextQuality
import com.mpi.app.data.sampleSize
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** M4：图片附件的压缩决策（纯函数，与 PWA `lib/image-attach.ts` 同一口径）。 */
class AttachmentLogicTest {

    @Test
    fun `a small enough image stops immediately`() {
        val (done, quality) = nextQuality(MAX_RAW_BYTES - 1, 0.8)
        assertTrue(done)
        assertEquals(0.8, quality, 0.0001)
    }

    @Test
    fun `an oversized image steps quality down by 0_1`() {
        val (done, quality) = nextQuality(MAX_RAW_BYTES * 4, 0.8)
        assertTrue(!done)
        assertEquals(0.7, quality, 0.0001)
    }

    @Test
    fun `the loop never goes below the floor quality`() {
        val (done, quality) = nextQuality(MAX_RAW_BYTES * 100, 0.5)
        assertTrue("到下限必须停，不能无限压", done)
        assertEquals(0.5, quality, 0.0001)
    }

    @Test
    fun `sample size halves only while staying above the target`() {        assertEquals(1, sampleSize(1200, 900, 1200, 900))
        // /2 后 1200 < 1280，再降就低于目标了 → 不采样
        assertEquals(1, sampleSize(2400, 1800, 1280, 960))
        assertEquals(2, sampleSize(4800, 3600, 1280, 960))
        assertEquals(4, sampleSize(9600, 7200, 1280, 960))
        // 目标边长大于源图时不该放大采样
        assertEquals(1, sampleSize(400, 300, 1280, 960))
    }

    // ---- 视频：要不要抽首帧封面（2026-09-29 阶段2）----------------------------

    /**
     * 抽封面的前提是能认出这是视频。在错的时候多抽（抽不出东西，白耗一次解码）无害，
     * 在错的时候少抽就有害了——手机上发的视频在别人那里会永远是一块黑。
     */
    @Test
    fun `video detection covers mime extensions and plain files`() {
        assertTrue("带 video mime 就算视频", looksLikeVideo("clip", "video/mp4"))
        assertTrue("mime 缺失时看扩展名（安卓 contentResolver 常给不出 mime）", looksLikeVideo("CLIP.MP4", null))
        assertTrue(looksLikeVideo("a.mov", null))
        assertTrue(looksLikeVideo("a.mkv", null))
        assertTrue(looksLikeVideo("a.webm", null))
        assertTrue(looksLikeVideo("a.avi", null))
        assertFalse("图片不是视频（图片走自己的压缩链路）", looksLikeVideo("a.jpg", "image/jpeg"))
        assertFalse("普通文件不是视频", looksLikeVideo("report.pdf", "application/pdf"))
        assertFalse("没有扩展名又没有 mime → 不当视频处理", looksLikeVideo("README", null))
        assertFalse("扩展名只是包含 mp4 不算（避免 .mp4.txt 误判）", looksLikeVideo("a.mp4.txt", null))
    }

    // ---- P3：图片的两种载荷形状（直连 keyed / 内联回落）----

    @Test
    fun `keyed images send a key plus thumbnail instead of the original bytes`() {
        val key = "a".repeat(64)
        val payloads = imagePayloads(
            listOf(
                Attachment.ImageKeyed(key = key, thumbB64 = "THUMB", mimeType = "image/png", size = 5_000_000),
                Attachment.Image(bytesB64 = "ORIGINAL", mimeType = "image/jpeg"),
                // 非图片附件不该混进 images[]
                Attachment.WorkspaceFile(name = "x.bin", path = "/ws/mpi-inbox/x.bin", size = 1),
            ),
        )
        assertEquals("只有图片进 images[]", 2, payloads.size)
        val keyed = payloads[0]
        assertEquals("原图不再内联（主机从对象库读）", "", keyed["data"]?.jsonPrimitive?.content)
        assertEquals(key, keyed["key"]?.jsonPrimitive?.content)
        assertEquals("THUMB", keyed["thumbnail"]?.jsonPrimitive?.content)
        assertEquals("image/jpeg", keyed["thumbnailMimeType"]?.jsonPrimitive?.content)
        assertEquals("内联回落保持老形状", "ORIGINAL", payloads[1]["data"]?.jsonPrimitive?.content)
        assertEquals("image/jpeg", payloads[1]["mimeType"]?.jsonPrimitive?.content)
    }

    @Test
    fun `the thumbnail budget is tighter than the inline budget`() {
        assertTrue(THUMB_MAX_BYTES < MAX_RAW_BYTES)
        assertTrue(nextQuality(THUMB_MAX_BYTES - 1, 0.8, THUMB_MAX_BYTES).first)
        assertFalse(nextQuality(THUMB_MAX_BYTES * 3, 0.8, THUMB_MAX_BYTES).first)
        // 未显式给上限时仍是老口径（内联 ≤280KB），不能因为加了缩略图而改掉老路径
        assertTrue(nextQuality(MAX_RAW_BYTES - 1, 0.8).first)
        assertFalse(nextQuality(MAX_RAW_BYTES * 2, 0.8).first)
    }
}
