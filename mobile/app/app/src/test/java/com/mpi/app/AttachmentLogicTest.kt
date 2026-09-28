package com.mpi.app

import com.mpi.app.data.MAX_RAW_BYTES
import com.mpi.app.data.looksLikeVideo
import com.mpi.app.data.nextQuality
import com.mpi.app.data.sampleSize
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
}
