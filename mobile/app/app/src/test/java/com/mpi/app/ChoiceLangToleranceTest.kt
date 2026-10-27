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
    fun `同一条消息多个合法块只保留最后一个`() {
        val draft = """[{"title":"下一步怎么走","options":["现在开始","先看方案"]}]"""
        val final = """[{"title":"下一步怎么走","options":["现在开始","先看方案再定"]}]"""
        val out = withChoiceSegments(
            listOf(
                Segment.Body("正文"),
                Segment.Code(draft, lang = "choices>", closed = true),
                Segment.Code(final, lang = "choices", closed = true),
            ),
            finalized = true,
        )
        val panels = out.filterIsInstance<Segment.Choice>()
        // 2026-10-27 thinkbook16p：模型先写草稿块、又重写正式块 → 旧行为渲染两个面板。
        assertTrue("只保留最后一个面板", panels.size == 1)
        assertTrue("被折叠的块数记在 dropped 上", panels.single().dropped == 1)
        assertTrue("保留的是最后一块", panels.single().data.questions.single().options[1].label == "先看方案再定")
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
