package com.mpi.app

import com.mpi.app.data.MAX_RAW_BYTES
import com.mpi.app.data.nextQuality
import com.mpi.app.data.sampleSize
import org.junit.Assert.assertEquals
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
    fun `sample size halves only while staying above the target`() {
        assertEquals(1, sampleSize(1200, 900, 1200, 900))
        // /2 后 1200 < 1280，再降就低于目标了 → 不采样
        assertEquals(1, sampleSize(2400, 1800, 1280, 960))
        assertEquals(2, sampleSize(4800, 3600, 1280, 960))
        assertEquals(4, sampleSize(9600, 7200, 1280, 960))
        // 目标边长大于源图时不该放大采样
        assertEquals(1, sampleSize(400, 300, 1280, 960))
    }
}
