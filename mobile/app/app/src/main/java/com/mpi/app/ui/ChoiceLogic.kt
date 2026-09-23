package com.mpi.app.ui

import com.mpi.app.protocol.BlockType
import com.mpi.app.protocol.ThreadMessage
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * 批 3：agent 回复里的 ```choices 围栏 → 可点选面板（PWA `lib/choice-block.ts` 的移植）。
 *
 * 与桌面端同一份契约：
 * - 围栏正文是 JSON 数组 `[{title, options:[...]}]`（或 `{questions:[...]}`）；
 * - 点选后以一条组合消息发出（[buildChoiceReplyText]）：`我的选择：\n1. 题 → 选项`；
 * - 面板状态**完全从会话记录推导**（[deriveChoicePanelState]），不额外存储。
 *
 * 容错：模型常把闭合围栏粘在 JSON 行尾或干脆漏写（deepseek 系尤甚），
 * 所以解析走「严格 → 截第一个完整 JSON」两级降级，[withChoiceSegments] 再补围栏级容错。
 */
data class ChoiceOptionView(val label: String, val detail: String? = null)

data class ChoiceBlockQuestion(val title: String, val options: List<ChoiceOptionView>)

data class ChoiceBlockData(val questions: List<ChoiceBlockQuestion>)

/** 一题的一个答案：预设选项或「其它」自由文本。 */
sealed interface ChoiceAnswer {
    data class Option(val label: String) : ChoiceAnswer
    data class Other(val text: String) : ChoiceAnswer
}

sealed interface ChoicePanelState {
    /** 还没回答（该 assistant 消息之后没有 user 消息）。 */
    data object Pending : ChoicePanelState

    /** 已被本条组合回复回答。 */
    data class Answered(val answers: Map<Int, ChoiceAnswer>) : ChoicePanelState

    /** 后面跟了一条 user 消息，但不是我们的组合回复格式（面板作废）。 */
    data object Superseded : ChoicePanelState
}

private const val MAX_QUESTIONS = 6
private const val MIN_OPTIONS = 2
private const val MAX_OPTIONS = 6
private const val TITLE_MAX = 200

private val SPACE_RE = Regex("\\s+")
private val OTHER_PREFIX_ZH = "其它："
private val OTHER_PREFIX_EN = "Other: "

private fun normalizeSpace(value: String): String = value.replace(SPACE_RE, " ").trim()

// ---- 围栏正文解析（严格 + 容错） --------------------------------------------

/** 解析 + 校验 choices 围栏的 JSON 正文；不合法返回 null。 */
fun parseChoiceBlockData(body: String): ChoiceBlockData? {
    val raw = runCatching { Json.parseToJsonElement(body) }.getOrNull() ?: return null
    val list: JsonArray = when (raw) {
        is JsonArray -> raw
        is JsonObject -> raw["questions"] as? JsonArray ?: return null
        else -> return null
    }
    if (list.isEmpty() || list.size > MAX_QUESTIONS) return null

    val questions = mutableListOf<ChoiceBlockQuestion>()
    for (item in list) {
        val o = item as? JsonObject ?: return null
        val title = normalizeSpace(o["title"]?.jsonPrimitive?.contentOrNull ?: "").take(TITLE_MAX)
        if (title.isEmpty()) return null
        val options = choiceOptions(o["options"])
        if (options.size < MIN_OPTIONS || options.size > MAX_OPTIONS) return null
        questions += ChoiceBlockQuestion(title, options)
    }
    return ChoiceBlockData(questions)
}

private fun choiceOptions(raw: JsonElement?): List<ChoiceOptionView> {
    val arr = raw as? JsonArray ?: return emptyList()
    val out = mutableListOf<ChoiceOptionView>()
    for (item in arr) {
        val option = choiceOption(item) ?: continue
        if (out.none { it.label == option.label }) out += option
    }
    return out
}

private fun choiceOption(raw: JsonElement): ChoiceOptionView? = when (raw) {
    is JsonPrimitive -> {
        val label = normalizeSpace(raw.contentOrNull ?: "")
        if (label.isEmpty()) null else ChoiceOptionView(label)
    }

    is JsonObject -> {
        val label = normalizeSpace(raw["label"]?.jsonPrimitive?.contentOrNull ?: "")
        if (label.isEmpty()) {
            null
        } else {
            val detail = (raw["detail"] as? JsonPrimitive)?.contentOrNull?.trim().orEmpty()
            ChoiceOptionView(label, detail.ifEmpty { null })
        }
    }

    else -> null
}

/** 截出正文里第一个括号配对的 JSON 值（跳过字符串内的括号与转义）。 */
private fun sliceFirstJson(text: String): String? {
    val start = text.indexOfFirst { it == '[' || it == '{' }
    if (start < 0) return null
    val stack = ArrayDeque<Char>()
    var inStr = false
    var esc = false
    for (i in start until text.length) {
        val ch = text[i]
        if (inStr) {
            when {
                esc -> esc = false
                ch == '\\' -> esc = true
                ch == '"' -> inStr = false
            }
            continue
        }
        when (ch) {
            '"' -> inStr = true
            '[' -> stack.addLast(']')
            '{' -> stack.addLast('}')
            ']', '}' -> {
                if (stack.removeLastOrNull() != ch) return null
                if (stack.isEmpty()) return text.substring(start, i + 1)
            }
        }
    }
    return null
}

/** 解析围栏正文（容错版）：先整体 parse；失败则截出第一个完整 JSON 再试。 */
internal fun parseChoiceBodyLoose(body: String): ChoiceBlockData? {
    parseChoiceBlockData(body.trim())?.let { return it }
    val sliced = sliceFirstJson(body) ?: return null
    return parseChoiceBlockData(sliced)
}

// ---- 与 parseSegments 的集成 -------------------------------------------------

/** 行尾挂着 ≥3 个反引号的行（模型把闭合围栏粘在正文末尾时）；捕获反引号之前的正文。 */
private val GLUED_CLOSE_RE = Regex("^(.*?)`{3,}\\s*$")

/**
 * 把 [parseSegments] 的输出转成可渲染段：合法的 choices 围栏升级成面板。
 *
 * - finalized=false（流式中）：原样返回——围栏保持代码块，定稿后才变面板；
 * - finalized=true：对 lang=="choices" 的代码段做三级容错：
 *   1) 正常闭合（含尾部垃圾）→ 面板；2) 未闭合但某行粘了闭合围栏 → 面板 + 剩余还原为正文；
 *   3) 漏写闭合围栏 → 整体当正文；4) 都不成 → 保持代码块（调用方可提示解析失败）。
 */
internal fun withChoiceSegments(segments: List<Segment>, finalized: Boolean): List<Segment> {
    if (!finalized) return segments

    val out = mutableListOf<Segment>()
    for (seg in segments) {
        val code = seg as? Segment.Code
        if (code == null || code.lang != "choices") {
            out += seg
            continue
        }

        // 1) 已闭合：整体容错解析。
        if (code.closed) {
            val data = parseChoiceBodyLoose(code.text)
            out += if (data != null) Segment.Choice(data) else code.copy(choiceWarn = true)
            continue
        }

        // 2) 定稿了仍未闭合：粘行闭合扫描（只接受正文能解析成合法 JSON 的边界）。
        val lines = code.text.split("\n")
        var glued = false
        for (k in lines.indices) {
            val m = GLUED_CLOSE_RE.matchEntire(lines[k]) ?: continue
            val data = parseChoiceBodyLoose((lines.take(k) + m.groupValues[1]).joinToString("\n")) ?: continue
            out += Segment.Choice(data)
            val rest = lines.drop(k + 1).joinToString("\n")
            if (rest.isNotBlank()) out += Segment.Body(rest)
            glued = true
            break
        }
        if (glued) continue

        // 3) 漏写闭合围栏：整体当正文（剥掉可能的行尾反引号）。
        val data = parseChoiceBodyLoose(code.text.replace(Regex("`{3,}\\s*$"), ""))
        out += if (data != null) Segment.Choice(data) else code.copy(choiceWarn = true)
    }
    return out
}

// ---- 回复构造 + 解析（与桌面端同一契约） -------------------------------------

/** 全部题目都有答案时发出的组合消息。 */
fun buildChoiceReplyText(
    questions: List<ChoiceBlockQuestion>,
    answers: List<ChoiceAnswer?>,
    language: String,
): String {
    val zh = language == "zh"
    val lines = mutableListOf(if (zh) "我的选择：" else "My choices:")
    questions.forEachIndexed { index, question ->
        val answer = answers.getOrNull(index)
        val text = when {
            answer == null -> if (zh) "（未选）" else "(none)"
            answer is ChoiceAnswer.Option -> answer.label
            answer is ChoiceAnswer.Other -> (if (zh) OTHER_PREFIX_ZH else OTHER_PREFIX_EN) + answer.text
            else -> ""
        }
        lines += "${index + 1}. ${question.title} → $text"
    }
    return lines.joinToString("\n")
}

private val REPLY_HEADER_RE = Regex("^(我的选择|My choices)\\s*[:：]$", RegexOption.IGNORE_CASE)
private val REPLY_LINE_RE = Regex("^(\\d+)\\s*[.、)]\\s*(.+?)\\s*(?:→|->)\\s*(.+)$")
private val OTHER_ANSWER_RE = Regex("^(其它|Other)\\s*[:：]\\s*(\\S.*)$", RegexOption.IGNORE_CASE)

/**
 * 把一条 user 消息解析回逐题答案——仅当它匹配组合回复格式**且**逐行与
 * [questions] 的题号 / 标题对得上；否则返回 null（调用方视为「面板被取代」）。
 */
fun parseChoiceReply(rawText: String?, questions: List<ChoiceBlockQuestion>): Map<Int, ChoiceAnswer>? {
    if (rawText == null) return null
    val lines = rawText.split(Regex("\\r?\\n")).map { it.trim() }.filter { it.isNotEmpty() }
    if (lines.isEmpty() || !REPLY_HEADER_RE.matches(lines[0])) return null

    val out = mutableMapOf<Int, ChoiceAnswer>()
    for (k in 1 until lines.size) {
        val m = REPLY_LINE_RE.matchEntire(lines[k]) ?: return null
        val idx = m.groupValues[1].toIntOrNull()?.minus(1) ?: return null
        val question = questions.getOrNull(idx) ?: return null
        if (normalizeSpace(m.groupValues[2]) != normalizeSpace(question.title)) return null

        val answerText = m.groupValues[3].trim()
        val option = question.options.firstOrNull { it.label == answerText }
        if (option != null) {
            out[idx] = ChoiceAnswer.Option(option.label)
            continue
        }
        val other = OTHER_ANSWER_RE.matchEntire(answerText)
        if (other != null) {
            out[idx] = ChoiceAnswer.Other(other.groupValues[2].trim())
            continue
        }
        return null
    }
    return if (out.size == questions.size) out else null
}

// ---- 面板状态推导（从会话记录，无额外存储） -----------------------------------

private fun transcriptText(message: ThreadMessage): String = messageTextOf(message)

/**
 * 从会话记录推导面板状态：该 assistant 消息之后的第一条 user 消息能解析成
 * 组合回复 → answered；解析不了 → superseded；没有 user 消息 → pending。
 */
fun deriveChoicePanelState(
    messages: List<ThreadMessage>?,
    messageId: String,
    data: ChoiceBlockData,
): ChoicePanelState {
    if (messages.isNullOrEmpty()) return ChoicePanelState.Pending
    val idx = messages.indexOfFirst { it.id == messageId }
    if (idx < 0) return ChoicePanelState.Pending
    val nextUser = messages.drop(idx + 1).firstOrNull { it.role == "user" } ?: return ChoicePanelState.Pending
    val answers = parseChoiceReply(transcriptText(nextUser), data.questions)
    return if (answers != null) ChoicePanelState.Answered(answers) else ChoicePanelState.Superseded
}
