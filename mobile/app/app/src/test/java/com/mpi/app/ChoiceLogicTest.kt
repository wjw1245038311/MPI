package com.mpi.app

import com.mpi.app.protocol.BlockType
import com.mpi.app.protocol.MessageBlock
import com.mpi.app.protocol.ThreadMessage
import com.mpi.app.ui.ChoiceAnswer
import com.mpi.app.ui.ChoicePanelState
import com.mpi.app.ui.Segment
import com.mpi.app.ui.buildChoiceReplyText
import com.mpi.app.ui.deriveChoicePanelState
import com.mpi.app.ui.isChoiceAnswered
import com.mpi.app.ui.parseChoiceBlockData
import com.mpi.app.ui.parseChoiceBodyLoose
import com.mpi.app.ui.parseChoiceReply
import com.mpi.app.ui.parseSegments
import com.mpi.app.ui.withChoiceSegments
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 批 3：choices 围栏的解析 / 回复构造 / 状态推导（纯函数）。
 *
 * 与桌面端同一契约——回复文本格式写错的话，面板状态会永远停在 pending。
 */
class ChoiceLogicTest {

    private val body = """[{"title":"改哪个","options":["A","B"]},{"title":"要不要跑测试","options":["要","不要"]}]"""

    // ---- 解析 ----

    @Test
    fun `valid fence body parses into questions`() {
        val data = parseChoiceBlockData(body)
        assertEquals(2, data?.questions?.size)
        assertEquals("改哪个", data?.questions?.get(0)?.title)
        assertEquals(listOf("A", "B"), data?.questions?.get(0)?.options?.map { it.label })
    }

    @Test
    fun `questions wrapper object is accepted`() {
        val data = parseChoiceBlockData("""{"questions":[{"title":"t","options":["a","b"]}]}""")
        assertEquals(1, data?.questions?.size)
    }

    @Test
    fun `option with detail keeps it`() {
        val data = parseChoiceBlockData("""[{"title":"t","options":[{"label":"a","detail":"说明"},{"label":"b"}]}]""")
        assertEquals("说明", data?.questions?.first()?.options?.first()?.detail)
    }

    @Test
    fun `invalid bodies are rejected`() {
        assertNull(parseChoiceBlockData("not json"))
        assertNull(parseChoiceBlockData("""[{"title":"t","options":["只有一个"]}]"""))
        assertNull(parseChoiceBlockData("""[{"options":["a","b"]}]"""))
    }

    @Test
    fun `trailing garbage after json is tolerated by the loose parser`() {
        // 严格解析只做整体 JSON.parse；尾部垃圾靠容错解析器截第一个完整 JSON
        val data = parseChoiceBodyLoose("$body\n一些说明")
        assertEquals(2, data?.questions?.size)
    }

    // ---- 围栏容错 ----

    @Test
    fun `a valid choices fence becomes a panel segment`() {
        val segments = parseSegments("前言\n```choices\n$body\n```\n后记")
        val aware = withChoiceSegments(segments, finalized = true)
        assertEquals(3, aware.size)
        assertTrue(aware[1] is Segment.Choice)
    }

    @Test
    fun `streaming keeps the fence as code`() {
        val segments = parseSegments("```choices\n$body\n```")
        val aware = withChoiceSegments(segments, finalized = false)
        assertTrue(aware.single() is Segment.Code)
    }

    @Test
    fun `a glued closing fence is still recognized`() {
        // deepseek 系常把闭合围栏粘在 JSON 行尾
        val segments = parseSegments("```choices\n$body```\n后面的正文")
        val aware = withChoiceSegments(segments, finalized = true)
        assertTrue("应升级为面板", aware.any { it is Segment.Choice })
        assertTrue("围栏后的正文要保留", aware.any { it is Segment.Body && it.text.contains("后面的正文") })
    }

    @Test
    fun `a missing closing fence is tolerated`() {
        val segments = parseSegments("```choices\n$body")
        val aware = withChoiceSegments(segments, finalized = true)
        assertTrue(aware.any { it is Segment.Choice })
    }

    @Test
    fun `an unparseable choices fence stays code with a warning`() {
        val segments = parseSegments("```choices\nnot json\n```")
        val aware = withChoiceSegments(segments, finalized = true)
        val code = aware.single() as Segment.Code
        assertTrue(code.choiceWarn)
    }

    // ---- 回复往返 ----

    @Test
    fun `reply text round-trips back into answers`() {
        val data = parseChoiceBlockData(body)!!
        val answers = listOf<ChoiceAnswer?>(
            ChoiceAnswer.Option("A"),
            ChoiceAnswer.Other("先不跑"),
        )
        val reply = buildChoiceReplyText(data.questions, answers, "zh")
        assertTrue(reply.startsWith("我的选择："))

        val parsed = parseChoiceReply(reply, data.questions)
        assertEquals(ChoiceAnswer.Option("A"), parsed?.get(0))
        assertEquals(ChoiceAnswer.Other("先不跑"), parsed?.get(1))
    }

    @Test
    fun `a plain user message does not parse as a reply`() {
        val data = parseChoiceBlockData(body)!!
        assertNull(parseChoiceReply("我自己说点什么", data.questions))
    }

    @Test
    fun `a reply with a mismatched question title is rejected`() {
        val data = parseChoiceBlockData(body)!!
        val wrong = "我的选择：\n1. 另一个问题 → A\n2. 要不要跑测试 → 要"
        assertNull(parseChoiceReply(wrong, data.questions))
    }

    // ---- 状态推导 ----

    private fun assistant(id: String, text: String) =
        ThreadMessage(id = id, role = "assistant", blocks = listOf(MessageBlock(type = BlockType.Text, text = text)))

    private fun user(id: String, text: String) =
        ThreadMessage(id = id, role = "user", blocks = listOf(MessageBlock(type = BlockType.Text, text = text)))

    @Test
    fun `panel stays pending until a user message follows`() {
        val data = parseChoiceBlockData(body)!!
        val messages = listOf(assistant("a1", "x"))
        assertEquals(ChoicePanelState.Pending, deriveChoicePanelState(messages, "a1", data))
    }

    @Test
    fun `a matching reply marks the panel answered`() {
        val data = parseChoiceBlockData(body)!!
        val reply = buildChoiceReplyText(
            data.questions,
            listOf(ChoiceAnswer.Option("A"), ChoiceAnswer.Option("要")),
            "zh",
        )
        val messages = listOf(assistant("a1", "x"), user("u1", reply))
        val state = deriveChoicePanelState(messages, "a1", data)
        assertTrue(state is ChoicePanelState.Answered)
    }

    @Test
    fun `a plain follow-up supersedes the panel`() {
        val data = parseChoiceBlockData(body)!!
        val messages = listOf(assistant("a1", "x"), user("u1", "算了，按你说的来"))
        assertEquals(ChoicePanelState.Superseded, deriveChoicePanelState(messages, "a1", data))
    }

    @Test
    fun `answered check requires non-blank content`() {
        assertTrue(isChoiceAnswered(ChoiceAnswer.Option("A")))
        assertTrue(isChoiceAnswered(ChoiceAnswer.Other("x")))
        assertTrue(!isChoiceAnswered(ChoiceAnswer.Other("   ")))
        assertTrue(!isChoiceAnswered(null))
    }
}
