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

    // ---- 超限截断（对齐桌面端/PWA：不再整块判非法） ----

    @Test
    fun `too many options are truncated with a note instead of rejected`() {
        val seven = """[{"title":"Q","options":["A","B","C","D","E","F","G"]}]"""
        val data = parseChoiceBlockData(seven)!!
        assertEquals(6, data.questions.first().options.size)
        assertEquals(1, data.clamped?.options)
        assertEquals(0, data.clamped?.questions)
    }

    @Test
    fun `too many questions are truncated with a note`() {
        val many = (0 until 7).joinToString(",") { """{"title":"Q$it","options":["A","B"]}""" }
        val data = parseChoiceBlockData("[$many]")!!
        assertEquals(6, data.questions.size)
        assertEquals(1, data.clamped?.questions)
    }

    @Test
    fun `a valid body carries no clamp info`() {
        assertNull(parseChoiceBlockData(body)?.clamped)
    }

    // ---- JSON 修复链（与桌面端/PWA 同一套） ----

    @Test
    fun `unescaped quotes inside strings are repaired`() {
        val raw = """[{"title":"选哪个？","options":[{"label":"把"类型 vs 路由"的分工写死"},{"label":"先不定"}]}]"""
        val aware = withChoiceSegments(parseSegments("```choices\n$raw\n```"), finalized = true)
        val choice = aware.single() as Segment.Choice
        assertTrue("应标为修复救回", choice.repaired)
        assertEquals(listOf("把\"类型 vs 路由\"的分工写死", "先不定"), choice.data.questions.first().options.map { it.label })
    }

    @Test
    fun `missing closing brackets are repaired`() {
        val raw = """[{"title":"用哪个改法","options":[{"label":"A"},{"label":"B"}]"""
        val aware = withChoiceSegments(parseSegments("前\n```choices\n$raw\n```\n后"), finalized = true)
        val choice = aware.filterIsInstance<Segment.Choice>().single()
        assertEquals(listOf("A", "B"), choice.data.questions.first().options.map { it.label })
    }

    @Test
    fun `bare label pairs inside options are repaired`() {
        val raw = """[{"title":"午饭","options":[{"label":"楼外楼","detail":"需订位"},"label":"沿途简餐","label":"自带干粮"]}]"""
        val aware = withChoiceSegments(parseSegments("```choices\n$raw\n```"), finalized = true)
        val choice = aware.single() as Segment.Choice
        assertEquals(listOf("楼外楼", "沿途简餐", "自带干粮"), choice.data.questions.first().options.map { it.label })
    }

    @Test
    fun `unrecoverable bodies degrade with a specific reason`() {
        val syntax = withChoiceSegments(parseSegments("```choices\n[{oops}]\n```"), finalized = true).single() as Segment.Code
        assertTrue(syntax.choiceWarn)
        assertEquals(com.mpi.app.ui.ChoiceFailure.SYNTAX, syntax.failReason)
        val shape = withChoiceSegments(parseSegments("""```choices
[{"title":"Q","options":["只有一个"]}]
```"""), finalized = true).single() as Segment.Code
        assertEquals(com.mpi.app.ui.ChoiceFailure.SHAPE, shape.failReason)
    }

    // ---- JSON 修复链·第二批（2026-11-06「漏符号」四类，与桌面端 / PWA 同语料）----

    /** 跑完整解析链路取面板（没有面板就报错失败）。 */
    private fun panelOf(raw: String): Segment.Choice =
        withChoiceSegments(parseSegments("```choices\n$raw\n```"), finalized = true)
            .filterIsInstance<Segment.Choice>().single()

    @Test
    fun `bare object keys get their quotes back`() {
        // ④ 历史真实坏法：键名只漏了开头那个引号（原文里剩下的那个是键名的收尾）
        val choice = panelOf("""[{"title":"走哪步？","options":[{"label":"甲"},{"label":"乙",detail":"一句说明"}]}]""")
        assertTrue("应标为修复救回", choice.repaired)
        assertEquals(listOf("甲", "乙"), choice.data.questions.first().options.map { it.label })
        // 两头都漏
        assertEquals(
            listOf("甲", "乙"),
            panelOf("""[{"title":"题","options":[{label:"甲"},{label:"乙"}]}]""").data.questions.first().options.map { it.label },
        )
    }

    @Test
    fun `a prematurely closed options array takes its element back`() {
        // ⑤A `],{` ——模型其实是想把选项对象当数组元素，一个选项都不能丢
        assertEquals(
            listOf("甲", "乙", "丙"),
            panelOf("""[{"title":"题","options":["甲","乙"],{"label":"丙","detail":"说明"}]}]""")
                .data.questions.first().options.map { it.label },
        )
    }

    @Test
    fun `a keyless member is dropped instead of sinking the block`() {
        // ⑤B 对象里真的多了一段：丢掉它，题目保留（丢内容比丢整个面板好）
        assertEquals(
            listOf("甲", "乙"),
            panelOf("""[{"title":"题",{"x":1},"options":["甲","乙"]}]""")
                .data.questions.first().options.map { it.label },
        )
    }

    @Test
    fun `missing top level array brackets are completed`() {
        // ⑥ 只写了一个问题对象 / 一串对象没包外层 / 还写到一半就断
        val single = panelOf("""{"title":"题","options":["甲","乙"]}""")
        assertTrue(single.repaired)
        assertEquals(listOf("甲", "乙"), single.data.questions.first().options.map { it.label })
        assertEquals(
            listOf("甲题", "乙题"),
            panelOf("""{"title":"甲题","options":["1","2"]},{"title":"乙题","options":["3","4"]}""")
                .data.questions.map { it.title },
        )
        assertEquals(
            listOf("甲", "乙"),
            panelOf("""{"title":"题","options":["甲","乙"]""").data.questions.first().options.map { it.label },
        )
    }

    @Test
    fun `one broken question no longer sinks the others`() {
        // ⑦ 逐题兜底：中间一题坏掉，其余照常出面版。
        // 已知两端差异（不是 bug，记在这里免得下次当回归改）：本端的
        // kotlinx Json.parseToJsonElement **允许值不加引号**（上面那题的 `"title":乙题` 能直接读出来），
        // 而浏览器/Node 的 JSON.parse 会报错 → 桌面的处理是「丢掉那题 + 计入截断」，本端能多留一题。
        // 共同不变量：面板必须出来、写坏了的那题不能拖死其它题。
        val choice = panelOf("""[{"title":"甲题","options":["1","2"]},{"title":乙题,"options":["3","4"]},{"title":"丙题","options":["5","6"]}]""")
        val titles = choice.data.questions.map { it.title }
        assertTrue(
            "必须保住写好那两题，实际=$titles",
            titles.containsAll(listOf("甲题", "丙题")),
        )
        assertTrue(titles.size in 2..3)
    }

    @Test
    fun `missing middle brackets and unclosed fences are repaired`() {
        // ⑧ 中间少一层 ]（真实坏法："options":["甲","乙"}）——只往末尾补是修不出来的
        val mid = panelOfFence("""[{"title":"题","options":["甲","乙"}]
```""")
        assertEquals(listOf("甲", "乙"), mid.data.questions.first().options.map { it.label })
        // ⑨ 整块没有闭合围栏（模型写到正文里就停了，stop_reason 仍是 stop）
        val unclosed = panelOfFence("""[{"title":"先走哪一步？","options":["只做第 1 步","两个一起跑","都不是，我另有安排"]""")
        assertTrue("未闭合也要画面板", unclosed.data.questions.first().options.size >= 2)
        // 散文不会被补成面板（未闭合那一档的保险）
        val prose = withChoiceSegments(parseSegments("```choices\n下面这段只是说明文字，不是 JSON。"), finalized = true)
        assertTrue("散文不能变面板", prose.none { it is Segment.Choice })
    }

    @Test
    fun `sloppy fence spellings still become a panel`() {
        val body = """[{"title":"题","options":["甲","乙"]}]"""
        // 标签带第二个词 / 浪加号闭合 / 写在列表项里 / 正文与围栏同行
        val yes = listOf(
            "```choices json\n$body\n```",
            "~~~choices\n$body\n~~~",
            "- ```choices\n$body\n  ```",
            "```choices $body",
        )
        for (text in yes) {
            assertTrue("该画面板：$text", withChoiceSegments(parseSegments(text), finalized = true).any { it is Segment.Choice })
        }
        // 保险丝：不含 choices 字样的 ```json / 无标签围栏一律不画面板（文档里的示例不算选择题）
        for (text in listOf("```json\n$body\n```", "```\n$body\n```")) {
            assertTrue("不该画面板：$text", withChoiceSegments(parseSegments(text), finalized = true).none { it is Segment.Choice })
        }
    }

    /** 包一层正常开围栏（测末尾/中间缺括号的正文时用）。 */
    private fun panelOfFence(body: String): Segment.Choice = panelOfFenceRaw("```choices\n$body")

    private fun panelOfFenceRaw(text: String): Segment.Choice =
        withChoiceSegments(parseSegments(text), finalized = true).filterIsInstance<Segment.Choice>().single()

    @Test
    fun `draft placeholders are not forced into a panel`() {
        // 反例：没有 title / options 的草稿不能因为「能补标点」就硬拼个面板
        val code = withChoiceSegments(
            parseSegments("```choices\n[{下一步怎么走…}, {推不推…}]\n```"),
            finalized = true,
        ).single() as Segment.Code
        assertTrue(code.choiceWarn)
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
        assertEquals(ChoiceAnswer.Option("A"), parsed?.answers?.get(0))
        assertEquals(ChoiceAnswer.Other("先不跑"), parsed?.answers?.get(1))
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

    @Test
    fun `skipped questions are omitted but still parse back`() {
        val data = parseChoiceBlockData(body)!!
        val reply = buildChoiceReplyText(
            data.questions,
            listOf(ChoiceAnswer.Option("A"), ChoiceAnswer.Skip()),
            "zh",
        )
        assertEquals("跳过的题不应输出行（header + 1 题）", 2, reply.lines().size)
        val parsed = parseChoiceReply(reply, data.questions)!!.answers
        assertEquals(ChoiceAnswer.Option("A"), parsed[0])
        assertEquals(ChoiceAnswer.Skip(), parsed[1])
    }

    @Test
    fun `skip with a note is sent without the question title`() {
        val data = parseChoiceBlockData(body)!!
        val reply = buildChoiceReplyText(
            data.questions,
            listOf(ChoiceAnswer.Option("A", "要兼容旧配置"), ChoiceAnswer.Skip("这题不适用")),
            "zh",
        )
        assertTrue(reply.contains("（补充：要兼容旧配置）"))
        assertTrue(Regex("^2\\. → 补充：这题不适用$", RegexOption.MULTILINE).containsMatchIn(reply))
        val parsed = parseChoiceReply(reply, data.questions)!!.answers
        assertEquals(ChoiceAnswer.Option("A", "要兼容旧配置"), parsed[0])
        assertEquals(ChoiceAnswer.Skip("这题不适用"), parsed[1])
    }

    @Test
    fun `all skipped leaves a placeholder line`() {
        val data = parseChoiceBlockData(body)!!
        val reply = buildChoiceReplyText(data.questions, listOf(ChoiceAnswer.Skip(), ChoiceAnswer.Skip()), "zh")
        assertTrue(reply.contains("（全部跳过）"))
        val parsed = parseChoiceReply(reply, data.questions)!!.answers
        assertEquals(ChoiceAnswer.Skip(), parsed[0])
        assertEquals(ChoiceAnswer.Skip(), parsed[1])
    }

    @Test
    fun `whole-set note goes after the last question`() {
        val data = parseChoiceBlockData(body)!!
        val reply = buildChoiceReplyText(
            data.questions,
            listOf(ChoiceAnswer.Option("A"), ChoiceAnswer.Skip()),
            "zh",
            "这组问题还缺一个维度",
        )
        assertTrue(reply.lines().last() == "补充：这组问题还缺一个维度")
        val parsed = parseChoiceReply(reply, data.questions)!!
        assertEquals("这组问题还缺一个维度", parsed.note)
        assertEquals(ChoiceAnswer.Option("A"), parsed.answers[0])
        assertEquals(ChoiceAnswer.Skip(), parsed.answers[1])
    }

    @Test
    fun `a title-less line that is not a note is rejected`() {
        val data = parseChoiceBlockData(body)!!
        assertNull(parseChoiceReply("我的选择：\n1. → 随便写点什么", data.questions))
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
        assertTrue(isChoiceAnswered(ChoiceAnswer.Skip()))
    }
}
