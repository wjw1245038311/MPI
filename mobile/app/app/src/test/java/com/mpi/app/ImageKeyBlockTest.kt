package com.mpi.app

import com.mpi.app.protocol.BlockType
import com.mpi.app.protocol.ThreadModels
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 图片块的元数据形态（2026-11-06，docs/MOBILE-IMAGE-KEY.md）。
 *
 * 主机在客户端声明 `imageKeys:true` 后不再内联图片 base64，只给
 * `key / thumb / lqip / width / height / bytes / omitted`。这几个字段丢了任何一个，
 * 手机端就会表现为「图片一直在加载」或「永远拉不到原图」——所以逐字段钉住。
 */
class ImageKeyBlockTest {

    private fun snapshotWithBlock(blockJson: String) = ThreadModels.decodeSnapshot(
        Json.parseToJsonElement(
            """{"snapshot":{"id":"t1","projectId":"p1","title":"t","preview":"","updatedAt":1,"messageCount":1,"state":"idle","permission":"sandbox","messages":[{"id":"m1","role":"assistant","blocks":[$blockJson]}]}}""",
        ),
    )

    private fun firstBlock(blockJson: String) = snapshotWithBlock(blockJson).messages.first().blocks.first()

    @Test
    fun `image metadata survives decoding`() {
        val block = firstBlock(
            """{"type":"image","key":"abc123","thumb":"abc123.thumb.jpg","lqip":"LQIP","width":1600,"height":900,"bytes":123456,"mimeType":"image/png","omitted":true}""",
        )
        assertEquals(BlockType.Image, block.type)
        assertEquals("abc123", block.mediaName) // 点开看原图靠它
        assertEquals("abc123.thumb.jpg", block.thumb) // 气泡里的缩略图靠它
        assertEquals("LQIP", block.lqip) // 拉字节期间的模糊占位
        assertEquals(1600, block.width)
        assertEquals(900, block.height)
        assertEquals(123456L, block.bytes)
        assertEquals("image/png", block.mimeType)
        assertTrue("omitted 必须解出来：它表示本体没下发，不是坏的块", block.omitted)
        assertNull("新形态不带内联字节", block.data)
    }

    @Test
    fun `old inline blocks still decode`() {
        // 旧主机 / 未声明 imageKeys 的请求：行为必须一条不变。
        val block = firstBlock("""{"type":"image","data":"AAAA","mimeType":"image/jpeg"}""")
        assertEquals(BlockType.Image, block.type)
        assertEquals("AAAA", block.data)
        assertNull(block.thumb)
        assertNull(block.mediaName)
    }

    @Test
    fun `block without either data or key is a real placeholder`() {
        // 附件被清理 / 历史遗留：客户端据此显示「未随本次同步下发」，不能静默消失。
        val block = firstBlock("""{"type":"image","omitted":true}""")
        assertNull(block.data)
        assertNull(block.mediaName)
        assertNull(block.thumb)
        assertTrue(block.omitted)
    }
}
