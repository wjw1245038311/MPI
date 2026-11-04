package com.mpi.app

import com.mpi.app.body.proto.Box
import com.mpi.app.body.proto.ScreenInput
import com.mpi.app.body.proto.ScreenText
import com.mpi.app.body.proto.ScrollBits
import com.mpi.app.body.proto.UiNode
import com.mpi.app.body.proto.UiWindow
import com.mpi.app.body.proto.WindowKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 屏文本格式（身体层最核心的资产）。这些断言就是「模型看到的样子」的合同：
 * 编号、分区、列表缩进、行内文字聚合、字符预算、打码、敏感词标记。
 */
class ScreenTextTest {

    private fun node(
        text: String? = null,
        bounds: Box,
        clickable: Boolean = false,
        editable: Boolean = false,
        scrollable: Boolean = false,
        password: Boolean = false,
        desc: String? = null,
        children: List<UiNode> = emptyList(),
    ) = UiNode(
        text = text,
        desc = desc,
        bounds = bounds,
        clickable = clickable,
        editable = editable,
        scrollable = scrollable,
        password = password,
        scroll = if (scrollable) ScrollBits.FORWARD or ScrollBits.BACKWARD else 0,
        children = children,
    )

    private fun format(root: UiNode, previous: Set<String>? = null, budget: Int = 3000) = ScreenText.format(
        ScreenInput(
            screenId = "s1",
            appLabel = "测试应用",
            packageName = "com.example",
            width = 1080,
            height = 1920,
            keyboardShown = false,
            windows = listOf(UiWindow(0, WindowKind.APP, "com.example", "主窗口", Box(0, 0, 1080, 1920), root)),
            previousKeys = previous,
            charBudget = budget,
        ),
    )

    @Test
    fun `numbered lines, zones and list indentation`() {
        val root = node(
            bounds = Box(0, 0, 1080, 1920),
            children = listOf(
                node("返回", Box(0, 0, 120, 120), clickable = true),
                node(
                    bounds = Box(0, 700, 1080, 1300),
                    scrollable = true,
                    children = listOf(
                        node("第一条", Box(0, 700, 1080, 800)),
                        node("第二条", Box(0, 800, 1080, 900)),
                    ),
                ),
                node("发送", Box(900, 1800, 1080, 1900), clickable = true),
            ),
        )
        val out = format(root)
        assertTrue(out.text.startsWith("屏幕 s1 · 测试应用 · 竖屏 · 键盘收起 · 共 "))
        assertTrue(out.text.contains("[1] 按钮 返回"))
        assertTrue(out.text.contains("列表"))
        // 列表里的元素缩进一级
        assertTrue(out.text.contains("  [3] 文本 第一条"))
        assertTrue(out.text.contains("顶部"))
        assertTrue(out.text.contains("底部"))
        assertEquals(5, out.elements.size)
    }

    @Test
    fun `clickable row aggregates its plain text children instead of listing them`() {
        val root = node(
            bounds = Box(0, 0, 1080, 1920),
            children = listOf(
                node(
                    bounds = Box(0, 600, 1080, 700),
                    clickable = true,
                    children = listOf(
                        node("张三", Box(0, 600, 400, 700)),
                        node("晚点回你", Box(400, 600, 1080, 700)),
                    ),
                ),
            ),
        )
        val out = format(root)
        assertTrue(out.text.contains("张三 · 晚点回你"))
        // 子节点不再各自占一行
        assertEquals(1, out.elements.size)
    }

    @Test
    fun `password fields never render their content`() {
        val root = node(
            bounds = Box(0, 0, 1080, 1920),
            children = listOf(
                node(
                    text = "hunter2",
                    bounds = Box(0, 400, 1080, 500),
                    editable = true,
                    password = true,
                ),
            ),
        )
        val out = format(root)
        assertFalse(out.text.contains("hunter2"))
        assertTrue(out.text.contains("密码框"))
    }

    @Test
    fun `long digit strings are masked before reaching the model`() {
        val root = node(
            bounds = Box(0, 0, 1080, 1920),
            children = listOf(node("卡号 6222 0212 3456 7890 123", Box(0, 400, 1080, 500))),
        )
        val out = format(root)
        assertFalse(out.text.contains("3456 7890"))
        assertTrue(out.text.contains("••••"))
    }

    @Test
    fun `sensitive words are flagged and marked in the text`() {
        val root = node(
            bounds = Box(0, 0, 1080, 1920),
            children = listOf(node("确认支付", Box(0, 900, 1080, 1000), clickable = true)),
        )
        val out = format(root)
        val el = out.elements.first()
        assertNotNull(el.sensitiveWord)
        assertTrue(out.text.contains("⚠"))
    }

    @Test
    fun `elements missing from the previous snapshot are marked new`() {
        val child = node("新消息", Box(0, 100, 1080, 200))
        val root = node(bounds = Box(0, 0, 1080, 1920), children = listOf(child))
        val first = format(root)
        val second = format(root, previous = emptySet())
        assertFalse(first.text.contains(" +"))
        assertTrue(second.text.contains(" +"))
    }

    @Test
    fun `character budget stops rendering and reports the remainder`() {
        val children = (0 until 200).map { i ->
            node("第 $i 条比较长的内容用来撑爆字符预算", Box(0, (i * 10) % 1900, 1080, (i * 10) % 1900 + 9))
        }
        val out = format(node(bounds = Box(0, 0, 1080, 1920), children = children), budget = 200)
        assertTrue(out.hidden > 0)
        assertTrue(out.text.contains("…另有 ${out.hidden} 项"))
        assertTrue(out.text.length < 600)
    }

    @Test
    fun `fingerprint covers window, bounds, role and label`() {
        val a = ScreenText.fingerprintOf(0, Box(1, 2, 3, 4), "按钮", "发送")
        val b = ScreenText.fingerprintOf(0, Box(1, 2, 3, 5), "按钮", "发送")
        assertEquals(a, ScreenText.fingerprintOf(0, Box(1, 2, 3, 4), "按钮", "发送"))
        assertFalse(a == b)
    }
}
