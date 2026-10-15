package com.mpi.app

import com.mpi.app.protocol.BlockType
import com.mpi.app.ui.safeFileName
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 「agent 递交的普通文件」附件块（`mpi_attach_file`，2026-10-15）在本端的两处逻辑。
 *
 * 快照 → 块的字段映射是通用的（name/label/size/mimeType/key 一律照搬），所以这里只钉两件
 * 真正属于本功能的事：线格式的类型名必须认得，以及落盘名必须是人话。
 */
class FileAttachmentTest {

    @Test
    fun `主机下发的 file 类型必须落到 File 块而不是当文本`() {
        assertEquals(BlockType.File, BlockType.fromWire("file"))
        // 顺带钉住既有语义：未知类型仍按文本兜底（宁可让人看到内容，也不能整块消失）。
        assertEquals(BlockType.Text, BlockType.fromWire("sound"))
    }

    @Test
    fun `落盘名去掉跨平台非法字符并保留扩展名`() {
        // 卡片标题常带路径式或书名号式的名字，交给系统「另存为」前必须清干净。
        assertEquals("季度报告-2026-Q3.pdf", safeFileName("季度报告:2026/Q3.pdf"))
        assertEquals("a-b-c-d-e-f-g-h-i-j.bin", safeFileName("""a\b/c:d*e?f"g<h>i|j.bin"""))
        assertEquals("附件", safeFileName("   "))
        // 控制字符同样换掉（文件名里出现它们会让部分文件系统直接拒收）。
        assertEquals("a-", safeFileName("a\u0001").ifBlank { "附件" })
        // 结尾的点与空白会被 Windows 悄悄吃掉 → 直接去掉，别留下打不开的文件。
        assertEquals("note.txt", safeFileName("note.txt..."))
    }

    @Test
    fun `过长的名字截断到 160 字符以内`() {
        val long = "x".repeat(400) + ".md"
        assertEquals(160, safeFileName(long).length)
    }
}
