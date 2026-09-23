package com.mpi.app

import com.mpi.app.protocol.UiRequest
import com.mpi.app.ui.DiffLineKind
import com.mpi.app.ui.approvalCancel
import com.mpi.app.ui.approvalResponseFor
import com.mpi.app.ui.canSubmitInput
import com.mpi.app.ui.parseDiffLines
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M2-4：审批卡的回答形状与 diff 解析（纯函数）。
 *
 * 回答形状写错**不会报错**——只会让桌面端的弹窗一直卡着等一个永远不来的回答。
 * 所以这里把四种 method 的形状逐个钉死。
 */
class ApprovalLogicTest {

    @Test
    fun `select answers with the chosen option text`() {
        val response = approvalResponseFor("select", value = "仅允许本次")
        assertEquals("仅允许本次", response["value"]?.jsonPrimitive?.content)
    }

    @Test
    fun `confirm answers with a boolean`() {
        assertEquals("true", approvalResponseFor("confirm", confirmed = true)["confirmed"]?.jsonPrimitive?.content)
        assertEquals("false", approvalResponseFor("confirm", confirmed = false)["confirmed"]?.jsonPrimitive?.content)
    }

    @Test
    fun `input answers with the typed value`() {
        assertEquals("任意文本", approvalResponseFor("input", value = "任意文本")["value"]?.jsonPrimitive?.content)
        assertEquals("多行\n内容", approvalResponseFor("editor", value = "多行\n内容")["value"]?.jsonPrimitive?.content)
    }

    @Test
    fun `cancel is a distinct shape usable for every method`() {
        val cancelled = approvalCancel()
        assertEquals("true", cancelled["cancelled"]?.jsonPrimitive?.content)
        // 取消不带 value / confirmed，避免桌面端误判成「有回答」
        assertFalse(cancelled.containsKey("value"))
        assertFalse(cancelled.containsKey("confirmed"))
    }

    @Test
    fun `empty input cannot be submitted`() {
        val request = UiRequest(id = "ui-1", method = "input")
        assertFalse(canSubmitInput(request, ""))
        assertFalse(canSubmitInput(request, "   "))
        assertTrue(canSubmitInput(request, "有内容"))
    }

    // ---- diff 解析 ----

    private val sample = """
        --- a/src/login.ts
        +++ b/src/login.ts
        @@ -1,3 +1,4 @@
         const a = 1;
        -const b = 2;
        +const b = 3;
        +const c = 4;
         return a;
    """.trimIndent()

    @Test
    fun `diff lines are classified by their marker`() {
        val lines = parseDiffLines(sample)
        assertEquals(8, lines.size)
        assertEquals(DiffLineKind.Header, lines[0].kind) // --- a/...
        assertEquals(DiffLineKind.Header, lines[1].kind) // +++ b/...
        assertEquals(DiffLineKind.Header, lines[2].kind) // @@
        assertEquals(DiffLineKind.Context, lines[3].kind)
        assertEquals(DiffLineKind.Removed, lines[4].kind)
        assertEquals(DiffLineKind.Added, lines[5].kind)
        assertEquals(DiffLineKind.Added, lines[6].kind)
        assertEquals(DiffLineKind.Context, lines[7].kind)
    }

    @Test
    fun `file headers are not mistaken for added or removed lines`() {
        // `+++` / `---` 若按首字符判，会显示成「加了一行 +++ b/…」，很迷惑
        val lines = parseDiffLines("+++ b/x\n--- a/x")
        assertTrue(lines.all { it.kind == DiffLineKind.Header })
    }

    @Test
    fun `empty lines are preserved so the diff keeps its shape`() {
        val lines = parseDiffLines("a\n\n+b")
        assertEquals(3, lines.size)
        assertEquals("", lines[1].text)
        assertEquals(DiffLineKind.Context, lines[1].kind)
    }

    @Test
    fun `added and removed counts come from the host not from parsing`() {
        // 只在行首标了 + / −，界面上的 +N −M 直接用主机给的统计（避免截断后算错）
        val lines = parseDiffLines("+a\n-b\n c")
        assertEquals(1, lines.count { it.kind == DiffLineKind.Added })
        assertEquals(1, lines.count { it.kind == DiffLineKind.Removed })
    }
}
