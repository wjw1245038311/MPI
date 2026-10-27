package com.mpi.app

import com.mpi.app.ui.Segment
import com.mpi.app.ui.isChoicesLang
import com.mpi.app.ui.withChoiceSegments
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * choices 围栏标签容错（2026-10-19 真机：同一段回复桌面/PWA 出面板、安卓只显示代码块）。
 *
 * 根因：安卓用 `code.lang != "choices"` 精确比较，模型写 `choices>` / `Choices` 就不认；
 * 桌面与 PWA 一直用大小写不敏感 + 容忍尾随噪声的规则。这里钉住三端一致的三条规则：
 *   1. `choices` / `Choices` / `choices>` → 面板（走容错解析）；
 *   2. `choicesjson` 这类写歪标签 → 只有正文严格合法才升级，否则维持代码块；
 *   3. 未定稿（流式中）一律不变，等定稿后由上层再转。
 */
class ChoiceLangToleranceTest {

    private val body = """[{"title":"用哪个方案","options":[{"label":"A 方案","detail":"快"},{"label":"B 方案","detail":"稳"}]}]"""

    @Test
    fun `标准与笔误标签都算 choices`() {
        assertTrue(isChoicesLang("choices"))
        assertTrue(isChoicesLang("Choices"))
        assertTrue(isChoicesLang(" CHOICES "))
        assertTrue(isChoicesLang("choices>"))
        assertFalse(isChoicesLang("choicesjson"))
        assertFalse(isChoicesLang("json"))
        assertFalse(isChoicesLang(null))
    }

    @Test
    fun `笔误标签 choices 加尖括号也能升级成面板`() {
        val out = withChoiceSegments(listOf(Segment.Code(body, lang = "choices>", closed = true)), finalized = true)
        assertTrue(out.single() is Segment.Choice)
    }

    @Test
    fun `写歪标签且正文非法时保持代码块`() {
        val out = withChoiceSegments(listOf(Segment.Code("{not json", lang = "choicesjson", closed = true)), finalized = true)
        assertTrue(out.single() is Segment.Code)
    }

    @Test
    fun `写歪标签但正文严格合法也升级`() {
        val out = withChoiceSegments(listOf(Segment.Code(body, lang = "choicesjson", closed = true)), finalized = true)
        assertTrue(out.single() is Segment.Choice)
    }

    @Test
    fun `未定稿不升级`() {
        val out = withChoiceSegments(listOf(Segment.Code(body, lang = "choices", closed = true)), finalized = false)
        assertTrue(out.single() is Segment.Code)
    }

    @Test
    fun `同一条消息里内容相同的块只保留最后一个`() {
        val same = """[{"title":"下一步怎么走","options":["现在开始","先看方案"]}]"""
        val out = withChoiceSegments(
            listOf(
                Segment.Body("正文"),
                Segment.Code(same, lang = "choices>", closed = true),
                Segment.Code(same, lang = "choices", closed = true),
            ),
            finalized = true,
        )
        val panels = out.filterIsInstance<Segment.Choice>()
        assertTrue("同签名的重复块只保留一个面板", panels.size == 1)
        assertTrue("被折叠的块数记在 dropped 上", panels.single().dropped == 1)
    }

    @Test
    fun `内容不同的多个块全部保留`() {
        val a = """[{"title":"第一条做哪个桶","options":["A","B"]}]"""
        val b = """[{"title":"落位走哪条路线","options":["甲","乙"]}]"""
        val out = withChoiceSegments(
            listOf(
                Segment.Code(a, lang = "choices", closed = true),
                Segment.Code(b, lang = "choices", closed = true),
            ),
            finalized = true,
        )
        val panels = out.filterIsInstance<Segment.Choice>()
        assertTrue("不同问题都渲染（不得静默丢题）", panels.size == 2)
        assertTrue("不同内容不标 dropped", panels.all { it.dropped == 0 })
    }

    @Test
    fun `正文空白的 choices 围栏静默丢弃`() {
        val out = withChoiceSegments(
            listOf(
                Segment.Code("   \n", lang = "choices>", closed = true),
                Segment.Code(body, lang = "choices", closed = true),
            ),
            finalized = true,
        )
        assertTrue("空块不能降级成代码块或警告", out.none { it is Segment.Code })
        assertTrue("正常块不受影响", out.single() is Segment.Choice)
    }

    @Test
    fun `坏块不参与重复折叠`() {
        val out = withChoiceSegments(
            listOf(
                Segment.Code("{oops", lang = "choices", closed = true),
                Segment.Code(body, lang = "choices", closed = true),
            ),
            finalized = true,
        )
        assertTrue("坏块仍按代码块显示", out.count { it is Segment.Code } == 1)
        assertTrue("合法块只有一个就无需折叠", out.filterIsInstance<Segment.Choice>().single().dropped == 0)
    }
}
