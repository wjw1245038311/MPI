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
 * 所以解析走「严格 → 截第一个完整 JSON → JSON 修复链」三级降级，
 * [withChoiceSegments] 再补围栏级容错。修复链与桌面端/PWA 同一套，现共九类
 * （前八类只补标点，最后一类只丢真读不出的那一题）：
 *   ① 串里未转义的英文双引号；② 结尾少括号；③ options 丢 `{}` 包裹的裸 `"label":…` 对；
 *   ④ 键名漏了开头的 `"`；⑤ 对象里冒出无键成员；⑥ 顶层漏了 `[]`；⑦ 逐题兜底；
 *   ⑧ **中间**漏一层闭合括号（`"options":["甲","乙"}`）→ completeBrackets 按层补；
 *   ⑨ 整块**没有闭合围栏** → 允许走修复链（仅当正文以 [ / { 开头且真修好了才接管）。
 * 围栏本身还宽忍三种写法（均以「标签含 choices」为前提）：`choices json`、浪加号闭合、
 * 列表项前缀（见 MessageContent.parseSegments）、正文与围栏同行。
 * ⚠️ 改动必须同步桌面端 src/renderer/src/lib/choice-block.ts 与 mobile/pwa（
 *    TS 侧有逐字对账测试 `npm run test:choiceretry`）；本端用例在 ChoiceLogicTest.kt。
 *
 * 一处抹不平的运行时差异（已知，不用当 bug 改）：kotlinx 的 Json.parseToJsonElement
 * 允许「值不加引号」（`{"title":乙题}` 在这边能读出来），V8 的 JSON.parse 不行。
 * 所以同一段坏正文：桌面会丢掉那一题并计入「已截断 N 题」，本端会把它一同留下。
 * 两端共同的要求只有一条：面板必须出得来、一题写坏不能拖死其它题（用例钉的是这条）。
 *
 * 一处**抹不平的运行时差异**（已知，别当 bug 改）：kotlinx 的 Json.parseToJsonElement
 * 对「值不加引号」比 V8 宽松（`{"title":乙题}` 在这边能直接读出来），所以同一段坏正文：
 * 桌面会丢掉那一题并计入「已截断 N 题」，本端会把它连同其它题一起留下。
 * 两端共同的要求只有一条：面板必须出得来、一题写坏不能拖死其它题（用例钉的是这条）。
 */
data class ChoiceOptionView(val label: String, val detail: String? = null)

data class ChoiceBlockQuestion(val title: String, val options: List<ChoiceOptionView>)

/** 超出上限被截断的计数（>0 时面板下方给一行说明，对齐桌面端/PWA）。 */
data class ChoiceClampInfo(val questions: Int, val options: Int)

/** choices 围栏正文解析失败的原因（精确降级提示用）。 */
enum class ChoiceFailure { SYNTAX, SHAPE }

data class ChoiceBlockData(val questions: List<ChoiceBlockQuestion>, val clamped: ChoiceClampInfo? = null)

/**
 * 一题的一个答案（与桌面端/PWA 同一契约）。
 * - [Option] 预设选项；[Other] 自定义文本；[Skip] 跳过这题。
 * - note：可选「补充说明」（≤200 字），与答案并存。
 *   跳过的题默认不回传给模型；写了补充才回传一行「2. → 补充：…」。
 */
sealed interface ChoiceAnswer {
    val note: String?

    data class Option(val label: String, override val note: String? = null) : ChoiceAnswer
    data class Other(val text: String, override val note: String? = null) : ChoiceAnswer
    data class Skip(override val note: String? = null) : ChoiceAnswer
}

/** 补充说明的长度上限（输入与回传双层截断）。 */
const val CHOICE_NOTE_MAX = 200

sealed interface ChoicePanelState {
    /** 还没回答（该 assistant 消息之后没有 user 消息）。 */
    data object Pending : ChoicePanelState

    /** 已被本条组合回复回答（note = 整组补充说明）。 */
    data class Answered(val answers: Map<Int, ChoiceAnswer>, val note: String? = null) : ChoicePanelState

    /** 后面跟了一条 user 消息，但不是我们的组合回复格式（面板作废）。 */
    data object Superseded : ChoicePanelState
}

/** 解析结果：逐题答案 + 整组的补充说明。 */
data class ChoiceReply(val answers: Map<Int, ChoiceAnswer>, val note: String? = null)

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
    return choiceDataFromJson(raw)
}

/**
 * 结构校验 + 超限截断（不做 JSON 解析——修复链会对同一份数据反复调用它）。
 * 超限不再整块判非法（对齐桌面端/PWA）：截断渲染 + clamped 计数。
 */
private fun choiceDataFromJson(raw: JsonElement): ChoiceBlockData? {
    val list: JsonArray = when (raw) {
        is JsonArray -> raw
        is JsonObject -> raw["questions"] as? JsonArray ?: return null
        else -> return null
    }
    if (list.isEmpty()) return null

    var droppedQuestions = maxOf(0, list.size - MAX_QUESTIONS)
    var droppedOptions = 0
    val questions = mutableListOf<ChoiceBlockQuestion>()
    for (item in list.take(MAX_QUESTIONS)) {
        val o = item as? JsonObject
        if (o == null) {
            droppedQuestions++
            continue
        }
        val title = normalizeSpace(o["title"]?.jsonPrimitive?.contentOrNull ?: "").take(TITLE_MAX)
        if (title.isEmpty()) {
            droppedQuestions++
            continue
        }
        var options = choiceOptions(o["options"])
        if (options.size > MAX_OPTIONS) {
            droppedOptions += options.size - MAX_OPTIONS
            options = options.take(MAX_OPTIONS)
        }
        if (options.size < MIN_OPTIONS) {
            droppedQuestions++
            continue
        }
        questions += ChoiceBlockQuestion(title, options)
    }
    if (questions.isEmpty()) return null
    val clamped = if (droppedQuestions > 0 || droppedOptions > 0) ChoiceClampInfo(droppedQuestions, droppedOptions) else null
    return ChoiceBlockData(questions, clamped)
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

/** 围栏正文解析结果（failure 仅在真的没救时给出）。 */
internal data class ChoiceBodyParse(
    val data: ChoiceBlockData?,
    val failure: ChoiceFailure? = null,
    val repaired: Boolean = false,
)

/**
 * JSON 修复链（与桌面端/PWA 逐字对齐）：
 * ① 字符串里未转义的英文双引号；② 结尾少括号；③ options 里丢了 `{}` 包裹的裸 `"label"` 对。
 * 仅在严格解析失败后启用，结果必须能过 [choiceDataFromJson] 的结构校验才采纳。
 */
private fun escapeStrayQuotes(src: String): String {
    val out = StringBuilder(src.length + 16)
    var inStr = false
    var esc = false
    var i = 0
    while (i < src.length) {
        val ch = src[i]
        if (inStr) {
            when {
                esc -> {
                    out.append(ch)
                    esc = false
                }
                ch == '\\' -> {
                    out.append(ch)
                    esc = true
                }
                ch == '"' -> {
                    var j = i + 1
                    while (j < src.length && src[j].isWhitespace()) j++
                    val nxt = src.getOrNull(j)
                    if (nxt == null || nxt == ',' || nxt == ':' || nxt == '}' || nxt == ']') {
                        out.append(ch)
                        inStr = false
                    } else {
                        out.append("\\\"")
                    }
                }
                else -> out.append(ch)
            }
        } else {
            if (ch == '"') inStr = true
            out.append(ch)
        }
        i++
    }
    return out.toString()
}

/** 能补的括号上限：再多就不是「漏了一两个符号」，而是整段乱写了，直接不修。 */
private const val MAX_REPAIR_BRACKETS = 24

/** 补漏掉的闭合括号——**中间和末尾都补**（与桌面端 completeBrackets 同算法）。
 * 旧版只往末尾追加，可真实会话里见过 `"options":["甲","乙"}` ——少的是**中间那一层的 `]`**，
 * 末尾补多少都修不好。现在维护「应该出现哪个闭符号」的栈：遇到类型不符的先按层补齐，
 * 栈里没这一层（多敲的）就丢掉，走完还剩没关的按内→外补全。 */
private fun completeBrackets(src: String): String {
    val out = StringBuilder(src.length + 16)
    val stack = ArrayDeque<Char>()
    var inStr = false
    var esc = false
    var inserted = 0
    for (ch in src) {
        if (inStr) {
            out.append(ch)
            when {
                esc -> esc = false
                ch == '\\' -> esc = true
                ch == '"' -> inStr = false
            }
            continue
        }
        if (ch == '"') {
            inStr = true
            out.append(ch)
            continue
        }
        if (ch == '{') {
            stack.addLast('}')
            out.append(ch)
            continue
        }
        if (ch == '[') {
            stack.addLast(']')
            out.append(ch)
            continue
        }
        if (ch == '}' || ch == ']') {
            // 正常情形：类型对得上，弹栈收下。
            if (stack.lastOrNull() == ch) {
                stack.removeLast()
                out.append(ch)
                continue
            }
            // 栈里根本没这一层 → 模型多敲了一个，丢掉（末尾多出的 `]` 就是这么来的）。
            if (!stack.contains(ch)) continue
            // 有这一层，但它上面还压着没关的 → 那一层忘了闭合：先补上再收下。
            while (stack.isNotEmpty() && stack.last() != ch) {
                out.append(stack.removeLast())
                if (++inserted > MAX_REPAIR_BRACKETS) return src
            }
            stack.removeLast()
            out.append(ch)
            continue
        }
        out.append(ch)
    }
    if (inStr) out.append('"')
    if (stack.size > MAX_REPAIR_BRACKETS) return src
    while (stack.isNotEmpty()) out.append(stack.removeLast())
    return out.toString()
}

private val TRAILING_COMMA_RE = Regex(""",(\s*[}\]])""")

private fun dropTrailingCommas(src: String): String = TRAILING_COMMA_RE.replace(src, "$1")

/** 读一个 JSON 字符串键：返回 key 或 null（key 后须跟 `:`）。 */
private fun peekKey(src: String, i: Int): String? {
    if (src.getOrNull(i) != '"') return null
    val key = StringBuilder()
    var j = i + 1
    var esc = false
    while (j < src.length) {
        val c = src[j]
        if (esc) {
            key.append(c)
            esc = false
        } else if (c == '\\') {
            esc = true
        } else if (c == '"') {
            break
        } else {
            key.append(c)
        }
        j++
    }
    if (j >= src.length) return null
    var k = j + 1
    while (k < src.length && src[k].isWhitespace()) k++
    return if (src.getOrNull(k) == ':') key.toString() else null
}

/** ③ 裸 `"label":…` 对（options 里丢了 `{}` 包裹）→ 自动补 `{}`。 */
private fun wrapBareLabelPairs(src: String): String {
    val out = StringBuilder(src.length + 16)
    val stack = ArrayDeque<Char>()
    var inStr = false
    var esc = false
    var wrapDepth = -1
    var prevSig = '\u0000'
    var i = 0
    while (i < src.length) {
        val ch = src[i]
        if (inStr) {
            out.append(ch)
            when {
                esc -> esc = false
                ch == '\\' -> esc = true
                ch == '"' -> {
                    inStr = false
                    prevSig = '"'
                }
            }
            i++
            continue
        }
        when (ch) {
            '"' -> {
                val elementPos = stack.isNotEmpty() && stack.last() == ']' && (prevSig == '[' || prevSig == ',')
                if (elementPos && wrapDepth < 0 && peekKey(src, i) == "label") {
                    out.append('{')
                    wrapDepth = stack.size
                }
                inStr = true
                out.append(ch)
            }
            '[' -> {
                stack.addLast(']')
                out.append(ch)
                prevSig = '['
            }
            '{' -> {
                stack.addLast('}')
                out.append(ch)
                prevSig = '{'
            }
            ']', '}' -> {
                if (wrapDepth == stack.size) {
                    out.append('}')
                    wrapDepth = -1
                }
                stack.removeLastOrNull()
                out.append(ch)
                prevSig = ch
            }
            ',' -> {
                if (wrapDepth >= 0 && wrapDepth == stack.size && peekKey(src, i + 1) == "label") {
                    out.append("},")
                    out.append('{')
                    prevSig = '{'
                } else {
                    out.append(ch)
                    prevSig = ','
                }
            }
            else -> {
                if (!ch.isWhitespace()) prevSig = ch
                out.append(ch)
            }
        }
        i++
    }
    if (wrapDepth >= 0) out.append('}')
    return out.toString()
}

/**
 * ---- 下面五段与桌面端 choice-block.ts 同一套算法（2026-11-06 新增的四类「漏符号」修复）----
 * ⚠️ 拷贝件：改这里必须同步 src/renderer/src/lib/choice-block.ts、
 *    src/main/mpi-choice-retry-ext.ts 与 mobile/pwa/src/lib/choice-block.ts。
 */

/** 跳过一个以 start（'[' 或 '{'）开头的配平片段，返回其后的下标；不配平返回 -1。 */
private fun skipBalanced(src: String, start: Int): Int {
    val stack = ArrayDeque<Char>()
    var inStr = false
    var esc = false
    for (i in start until src.length) {
        val ch = src[i]
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
                if (stack.removeLastOrNull() != ch) return -1
                if (stack.isEmpty()) return i + 1
            }
        }
    }
    return -1
}

/** 裸键名的形状（漏了引号之后剩下的就是它）。 */
private val BARE_KEY_RE = Regex("[A-Za-z_\$][A-Za-z0-9_\$]*")

private fun isBareKeyStart(c: Char): Boolean = c in 'a'..'z' || c in 'A'..'Z' || c == '_' || c == '\$'

/** ④ 键名漏了开头的英文双引号 → 补引号。
 * 实测两种写法：`,detail":"说明"}`（只漏开头，原文里那个引号是键名的收尾）和
 * `{label:"甲"}`（两头都漏）。判定只看结构：不在字符串里、前一个有效字符是
 * `{` 或 `,`、裸标识符后面（可跳空白）确实跟着 `:`。值位置一概不碰。 */
private fun quoteBareKeys(src: String): String {
    val out = StringBuilder(src.length + 16)
    var inStr = false
    var esc = false
    var prevSig = '\u0000'
    var i = 0
    while (i < src.length) {
        val ch = src[i]
        if (inStr) {
            out.append(ch)
            when {
                esc -> esc = false
                ch == '\\' -> esc = true
                ch == '"' -> inStr = false
            }
            i++
            continue
        }
        if (ch.isWhitespace()) {
            out.append(ch)
            i++
            continue
        }
        if (ch == '"') {
            inStr = true
            out.append(ch)
            prevSig = '"'
            i++
            continue
        }
        if ((prevSig == '{' || prevSig == ',') && isBareKeyStart(ch)) {
            val key = BARE_KEY_RE.find(src, i)?.value.orEmpty()
            if (key.isNotEmpty()) {
                var j = i + key.length
                while (j < src.length && src[j].isWhitespace()) j++
                if (src.getOrNull(j) == ':') {
                    // label: → "label":
                    out.append('"').append(key).append('"')
                    i += key.length
                    prevSig = '"'
                    continue
                }
                if (src.getOrNull(j) == '"') {
                    var k = j + 1
                    while (k < src.length && src[k].isWhitespace()) k++
                    if (src.getOrNull(k) == ':') {
                        // detail": → "detail":（原文里那个引号本就是键名的收尾）
                        out.append('"').append(src, i, j + 1)
                        i = j + 1
                        prevSig = '"'
                        continue
                    }
                }
            }
        }
        out.append(ch)
        prevSig = ch
        i++
    }
    return out.toString()
}

/** ⑤ 对象里冒出「没有键名」的成员——JSON 的键必须是字符串，这个位置出现 `[`/`{`
 * 只能是漏了键。两种坏法分开处理（与桌面端逐字对齐）：
 *   A. `"options":["甲","乙"],{"label":"丙"}]}` ——数组刚收尾就被逗号接上一个对象：
 *      模型其实想把它当数组元素，多吃了一个 `]`。吃掉那个过早的 `]` 把数组重新
 *      打开（后面的 `]` 正好收尾），**选项一个不丢**；
 *   B. 其它形态（真的多了一个成员）→ 整段丢掉，剩下的照常渲染。
 * 动手条件很窄：当前容器是**对象**、位置该放键名（前一个有效字符是 `{` 或 `,`）。 */
private fun repairStrayMembers(src: String): String {
    val out = StringBuilder(src.length + 16)
    val stack = ArrayDeque<Char>()
    var inStr = false
    var esc = false
    var prevSig = '\u0000'
    var i = 0
    while (i < src.length) {
        val ch = src[i]
        if (inStr) {
            out.append(ch)
            when {
                esc -> esc = false
                ch == '\\' -> esc = true
                ch == '"' -> inStr = false
            }
            i++
            continue
        }
        if (ch.isWhitespace()) {
            out.append(ch)
            i++
            continue
        }
        if (ch == '"') {
            inStr = true
            out.append(ch)
            prevSig = '"'
            i++
            continue
        }
        if ((ch == '[' || ch == '{') && stack.lastOrNull() == '}' && (prevSig == '{' || prevSig == ',')) {
            // A. 紧跟在 `],` 后面：数组被提前关掉了，这个对象本该是它的元素。
            if (prevSig == ',' && dropPrematureArrayClose(out)) {
                stack.addLast(']') // 那个 `]` 被吃掉了，容器还在里层
                continue // 不推进 i：当前括号按正常入栈处理（此时顶层已是数组）
            }
            // B. 真的多了一个成员：整段跳过（带它前面的逗号）。
            val end = skipBalanced(src, i)
            if (end > i) {
                if (prevSig == ',') dropTrailingComma(out)
                i = end
                continue
            }
        }
        when (ch) {
            '[' -> stack.addLast(']')
            '{' -> stack.addLast('}')
            ']', '}' -> stack.removeLastOrNull()
        }
        out.append(ch)
        prevSig = ch
        i++
    }
    return out.toString()
}

/** 把缓冲区末尾的「],」改成「,」（吃掉数组那个过早的收尾）。能改返回 true。 */
private fun dropPrematureArrayClose(out: StringBuilder): Boolean {
    var i = out.length - 1
    while (i >= 0 && out[i].isWhitespace()) i--
    if (i < 0 || out[i] != ',') return false
    var j = i - 1
    while (j >= 0 && out[j].isWhitespace()) j--
    if (j < 0 || out[j] != ']') return false
    out.deleteCharAt(j)
    return true
}

/** 吃掉缓冲区末尾那个逗号（丢掉无键成员后不能留下空逗号）。 */
private fun dropTrailingComma(out: StringBuilder) {
    var i = out.length - 1
    while (i >= 0 && out[i].isWhitespace()) i--
    if (i >= 0 && out[i] == ',') out.deleteCharAt(i)
}

/** ⑦ 「一道题」的起点：`{` 后面（可跳空白）就是 title 键。
 * 用 title 当锚点而不是按括号配平切项——模型漏一个引号就会让后面所有引号成对
 * 错位，跟着的括号计数一起乱；而结构校验本来也只认带 title 的对象。 */
private val QUESTION_START_RE = Regex("""\{\s*"?\s*title\s*"?\s*:""", RegexOption.IGNORE_CASE)

private fun questionStarts(src: String): List<Int> {
    val out = mutableListOf<Int>()
    for (m in QUESTION_START_RE.findAll(src)) {
        out += m.range.first
        if (out.size >= 12) break
    }
    return out
}

/** ⑦ 按锚点切成「一题一段」。段尾剪到最后一个右花括号（把逗号、外层数组的
 * 右方括号这类尾巴剪掉）；本来就没写完的段落保留原样，交给 completeBrackets 收尾。 */
private fun splitQuestionChunks(src: String): List<String> {
    val starts = questionStarts(src)
    // 少于两段就没有「逐题兜底」的必要（整块的候选已经把它试过一遍了）。
    if (starts.size < 2) return emptyList()
    val out = mutableListOf<String>()
    for (k in starts.indices) {
        val to = if (k + 1 < starts.size) starts[k + 1] else src.length
        var piece = src.substring(starts[k], to)
        val close = piece.lastIndexOf('}')
        if (close > 0) piece = piece.substring(0, close + 1)
        piece = piece.trim()
        if (piece.isNotEmpty()) out += piece
    }
    return out
}

/** 解析不出的段落用这个空题占位：让结构校验计成「被截断的题」（面板下方有说明），绝不悄悄消失。 */
private val EMPTY_QUESTION: JsonElement = Json.parseToJsonElement("""{"title":"","options":[]}""")

/** 剪尾巴与原样两种都试：截到的右花括号可能属于内层对象，不是这一题的收尾。 */
private fun chunkVariants(chunk: String): List<String> {
    val cut = chunk.replace(Regex("""\}\s*$"""), "")
    return listOf(chunk, repairChain(chunk), cut, repairChain(cut))
}

/** ⑦ 逐题兜底：整块修不好时一段一段各自解析，只保留救得回来的题。
 * 一题写坏不该让其它题一起降级成代码块（与桌面端同）。 */
private fun salvageQuestions(body: String): ChoiceBlockData? {
    val chunks = splitQuestionChunks(body)
    if (chunks.isEmpty()) return null
    val kept = MutableList(chunks.size) { EMPTY_QUESTION }
    chunks.forEachIndexed { idx, chunk ->
        for (candidate in chunkVariants(chunk)) {
            val parsed = runCatching { Json.parseToJsonElement(candidate) }.getOrNull() ?: continue
            kept[idx] = parsed
            break
        }
    }
    return choiceDataFromJson(JsonArray(kept))
}

/** 修复组合。顺序有讲究：**先补键名漏掉的引号**（不先把键名补正，后面所有引号的成对
 * 判定会跟着错位，裸引号修复会把好文本改坏）→ 转义串内裸引号 → 修无键成员 →
 * 给裸 `"label":` 对补 `{}` 包裹 → 补结尾括号 → 去尾逗号。（与桌面端同序）*/
private fun repairChain(src: String): String =
    dropTrailingCommas(
        completeBrackets(wrapBareLabelPairs(repairStrayMembers(escapeStrayQuotes(quoteBareKeys(src))))),
    )

private fun repairCandidates(body: String): List<String> {
    val trimmed = body.trim()
    val sliced = sliceFirstJson(trimmed)
    val out = mutableListOf<String>()
    if (sliced != null) out += sliced
    out += repairChain(trimmed)
    if (sliced != null) out += repairChain(sliced)
    // ⑥ 顶层漏了数组包裹：只写了一个对象，或 `{` 前面那个 `[` 被吐掉。
    //    只补开头的 `[`——结尾交给链上的 completeBrackets 按实际层级补；
    //    已以 `[` 开头的不试（包一层反而把合法正文弄坏）。
    if (trimmed.isNotEmpty() && !trimmed.startsWith("[")) {
        out += "[$trimmed]"
        out += "[$trimmed"
        out += repairChain("[$trimmed")
    }
    return out.filter { it.isNotEmpty() }
}

/** 解析围栏正文（容错版）：严格 parse → 截出第一个完整 JSON → 修复链 → 逐题兜底。 */
internal fun parseChoiceBodyEx(body: String): ChoiceBodyParse {
    parseChoiceBlockData(body.trim())?.let { return ChoiceBodyParse(it) }

    var sawJson = false
    for (candidate in repairCandidates(body)) {
        val parsed = runCatching { Json.parseToJsonElement(candidate) }.getOrNull() ?: continue
        sawJson = true
        val data = choiceDataFromJson(parsed) ?: continue
        return ChoiceBodyParse(data, repaired = true)
    }
    // 最后一道：逐题兜底（一块里有好几题时，只丢真读不出来的那题）。
    salvageQuestions(body)?.let { return ChoiceBodyParse(it, repaired = true) }
    return ChoiceBodyParse(null, if (sawJson) ChoiceFailure.SHAPE else ChoiceFailure.SYNTAX)
}

/** 截第一个 JSON 的容错入口（保留原签名，测试用）。 */
internal fun parseChoiceBodyLoose(body: String): ChoiceBlockData? = parseChoiceBodyEx(body).data

/** 仅用于「忘了写闭合围栏」时的边界判定：必须严格能解析才认，不开修复链。 */
private fun parseChoiceBodyBoundary(body: String): ChoiceBlockData? {
    parseChoiceBlockData(body.trim())?.let { return it }
    val sliced = sliceFirstJson(body) ?: return null
    return parseChoiceBlockData(sliced)
}

// ---- 与 parseSegments 的集成 -------------------------------------------------

/** 行尾挂着 ≥3 个反引号的行（模型把闭合围栏粘在正文末尾时）；捕获反引号之前的正文。 */
private val GLUED_CLOSE_RE = Regex("^(.*?)(?:`{3,}|~{3,})\\s*$")

/** 正文与开围栏写在同一行（` ```choices [{…}] `）：只有以 [ 或 { 开头才算正文，
 * 否则那是第二个语言标签（`choices json` 里的 json）。与桌面端 inlineBodyHead 同规则。 */
private val INLINE_HEAD_RE = Regex("^\\S+[ \\t]+((\\[|\\{).*)$")

/** 标准 choices info string：**以 choices 这个词开头**就行（后面不紧跟字母/数字），再往后的噪声
 * 一律忍（`choices>` / `choices json` / 与围栏同行的正文）——与桌面端 `CHOICES_INFO_RE` /
 * PWA `CHOICES_LANG_RE` 同一规则（2026-11-06 放宽；不含 choices 字样的 ```json 仍不算）。 */
private val CHOICES_INFO_RE = Regex("^choices(?![a-z0-9])", RegexOption.IGNORE_CASE)

/** 以 choices 开头的写歪标签（`choicesjson` 等）：只有正文严格解析通过才升级。 */
private val CHOICES_LIKE_RE = Regex("^choices", RegexOption.IGNORE_CASE)

/**
 * 代码段的 lang 是否应视为 choices 围栏（大小写不敏感，容忍 `choices>` 这类尾随噪声）。
 *
 * 2026-10-19 真机：**同一段回复桌面/PWA 出面板、安卓只显示代码块** —— 安卓这里原先是
 * `code.lang != "choices"` 的精确比较，模型写成 `choices>` / `Choices` 就直接不认了。
 */
internal fun isChoicesLang(lang: String?): Boolean = CHOICES_INFO_RE.containsMatchIn((lang ?: "").trim())

private fun isChoicesLikeLang(lang: String?): Boolean = CHOICES_LIKE_RE.containsMatchIn((lang ?: "").trim())

/**
 * 把 [parseSegments] 的输出转成可渲染段：合法的 choices 围栏升级成面板。
 *
 * - finalized=false（流式中）：原样返回——围栏保持代码块，定稿后才变面板；
 * - finalized=true：对 lang 以 choices 开头的代码段做四级容错：
 *   1) 正常闭合（含尾部垃圾）→ 面板；2) 未闭合但某行粘了闭合围栏 → 面板 + 剩余还原为正文；
 *   3) 整块没有闭合围栏 → 正文以 [ / { 开头时允许走修复链，且只在真修好了才接管；
 *   4) 都不成 → 保持代码块（调用方可提示解析失败）。
 */
internal fun withChoiceSegments(segments: List<Segment>, finalized: Boolean): List<Segment> {
    if (!finalized) return segments

    val out = mutableListOf<Segment>()
    for (seg in segments) {
        val code = seg as? Segment.Code
        if (code == null) {
            out += seg
            continue
        }
        val exact = isChoicesLang(code.lang)
        // 写歪的标签（`choicesjson` 等）：只有正文严格解析通过才升级——不吞正文。
        val like = !exact && isChoicesLikeLang(code.lang)
        if (!exact && !like) {
            out += seg
            continue
        }

        // 正文与开围栏写在同一行时（```choices [{…}]），parseSegments 把它当成了语言标记，
        // 这里把它拼回正文首行（与桌面端 / PWA 同规则）。
        val inlineHead = INLINE_HEAD_RE.find((code.lang ?: "").trim())?.groupValues?.get(1)?.trim().orEmpty()
        val body = if (inlineHead.isEmpty()) code.text else "$inlineHead\n${code.text}"

        // 正文空白的 choices 围栏（如 ```choices> 后面没内容）：静默丢弃，
        // 不出空代码块 / 不给「格式不合法」警告（与桌面端/PWA 同一规则，2026-10-27 实证）。
        if (body.isBlank()) continue

        // 1) 已闭合：整体容错解析（严格 → 截第一个 JSON → 修复链）。
        if (code.closed) {
            if (like) {
                val strict = parseChoiceBodyBoundary(body)
                out += if (strict != null) Segment.Choice(strict) else code
                continue
            }
            val r = parseChoiceBodyEx(body)
            out += if (r.data != null) {
                Segment.Choice(r.data, r.repaired)
            } else {
                code.copy(choiceWarn = true, failReason = r.failure)
            }
            continue
        }

        // 2) 定稿了仍未闭合：粘行闭合扇描（只接受正文能解析成合法 JSON 的边界）。
        val lines = body.split("\n")
        var glued = false
        for (k in lines.indices) {
            val m = GLUED_CLOSE_RE.matchEntire(lines[k]) ?: continue
            val r = parseChoiceBodyEx((lines.take(k) + m.groupValues[1]).joinToString("\n"))
            val data = r.data ?: continue
            out += Segment.Choice(data, r.repaired)
            val rest = lines.drop(k + 1).joinToString("\n")
            if (rest.isNotBlank()) out += Segment.Body(rest)
            glued = true
            break
        }
        if (glued) continue

        // 3) 漏写闭合围栏（模型写到正文里就停了——真实会话里很常见）。
        //    与桌面端同规则：正文以 [ 或 { 开头才走修复链（这种形状不可能是散文），
        //    且**只在真修好了才接管**；其余正文仍只允许严格解析，绝不把普通文字读成面板。
        val tailText = body.replace(Regex("(?:`{3,}|~{3,})\\s*$"), "")
        if (Regex("^\\s*(\\[|\\{)").containsMatchIn(tailText)) {
            val r = parseChoiceBodyEx(tailText)
            if (r.data != null) {
                out += Segment.Choice(r.data, r.repaired)
                continue
            }
        }
        val data = parseChoiceBodyBoundary(tailText)
        out += when {
            data != null -> Segment.Choice(data)
            like -> code
            else -> code.copy(choiceWarn = true)
        }
    }

    // 同一条回复里的多个块：只折叠**内容等价**的（模型重写），内容不同的全部保留
    // ——一条回复里问多组不同的问题是合法的，不能静默丢题（与桌面端/PWA 同一规则）。
    val choiceAt = out.indices.filter { out[it] is Segment.Choice }
    if (choiceAt.size > 1) {
        val lastBySign = mutableMapOf<String, Int>()
        val countBySign = mutableMapOf<String, Int>()
        for (k in choiceAt) {
            val seg = out[k] as Segment.Choice
            val sign = choiceSignature(seg.data)
            lastBySign[sign] = k
            countBySign[sign] = (countBySign[sign] ?: 0) + 1
        }
        val collapsed = mutableSetOf<Int>()
        for (k in choiceAt) {
            val seg = out[k] as Segment.Choice
            val sign = choiceSignature(seg.data)
            if (lastBySign[sign] != k) {
                collapsed += k
                continue
            }
            val dupes = (countBySign[sign] ?: 1) - 1
            if (dupes > 0) out[k] = seg.copy(dropped = dupes)
        }
        if (collapsed.isNotEmpty()) return out.filterIndexed { index, _ -> index !in collapsed }
    }
    return out
}

/** 判重签名：题目 + 每题选项 label（忽略 detail 与空白差异），与桌面端/PWA 同一规则。 */
internal fun choiceSignature(data: ChoiceBlockData): String =
    data.questions.joinToString(";") { q ->
        q.title.replace(Regex("\\s+"), "") + "|" +
            q.options.joinToString(",") { o -> o.label.replace(Regex("\\s+"), "") }
    }

// ---- 回复构造 + 解析（与桌面端同一契约） -------------------------------------
// 跳过的题默认整行省略（前题选项与后题无关时，「题目都不用给了」）；写了补充说明
// 才回传一行 `2. → 补充：…`（不带标题）。全部跳过时留一行 `（全部跳过）`。

/** 全部题目都有答案时发出的组合消息。 */
fun buildChoiceReplyText(
    questions: List<ChoiceBlockQuestion>,
    answers: List<ChoiceAnswer?>,
    language: String,
    panelNote: String? = null,
): String {
    val zh = language == "zh"
    val lines = mutableListOf(if (zh) "我的选择：" else "My choices:")
    var emitted = 0
    questions.forEachIndexed { index, question ->
        val answer = answers.getOrNull(index)
        val note = answer?.note?.take(CHOICE_NOTE_MAX)?.trim().orEmpty()
        if (answer is ChoiceAnswer.Skip) {
            if (note.isNotEmpty()) {
                lines += "${index + 1}. → " + (if (zh) "补充：" else "Note: ") + note
                emitted++
            }
            return@forEachIndexed
        }
        val text = when {
            answer == null -> if (zh) "（未选）" else "(none)"
            answer is ChoiceAnswer.Option -> answer.label
            answer is ChoiceAnswer.Other -> (if (zh) OTHER_PREFIX_ZH else OTHER_PREFIX_EN) + answer.text
            else -> ""
        }
        val suffix = if (note.isEmpty()) "" else if (zh) "（补充：$note）" else " (note: $note)"
        lines += "${index + 1}. ${question.title} → $text$suffix"
        emitted++
    }
    if (emitted == 0) lines += if (zh) "（全部跳过）" else "(all skipped)"
    // 整组补充：写在最后一题之后（不是每题一个）。
    val whole = panelNote?.take(CHOICE_NOTE_MAX)?.trim().orEmpty()
    if (whole.isNotEmpty()) lines += (if (zh) "补充：$whole" else "Note: $whole")
    return lines.joinToString("\n")
}

private val REPLY_HEADER_RE = Regex("^(我的选择|My choices)\\s*[:：]$", RegexOption.IGNORE_CASE)
/** 标题允许为空：跳过 + 补充的行是 `2. → 补充：…`。 */
private val REPLY_LINE_RE = Regex("^(\\d+)\\s*[.、)]\\s*(.*?)\\s*(?:→|->)\\s*(.+)$")
private val OTHER_ANSWER_RE = Regex("^(其它|Other)\\s*[:：]\\s*(\\S.*)$", RegexOption.IGNORE_CASE)
private val SKIP_ANSWER_RE = Regex("^(已跳过|跳过|skipped)$", RegexOption.IGNORE_CASE)
private val ALL_SKIP_RE = Regex("^(（全部跳过）|\\(all skipped\\))$")
private val NOTE_SUFFIX_ZH_RE = Regex("（补充[：:]\\s*([\\s\\S]*?)）\\s*$")
private val NOTE_SUFFIX_EN_RE = Regex("\\(note\\s*[:：]\\s*([\\s\\S]*?)\\)\\s*$", RegexOption.IGNORE_CASE)
private val NOTE_ONLY_RE = Regex("^(补充|Note)\\s*[:：]\\s*([\\s\\S]*)$", RegexOption.IGNORE_CASE)
/** 整组补充那一行：没有题号。 */
private val PANEL_NOTE_RE = Regex("^(补充|Note)\\s*[:：]\\s*(.+)$", RegexOption.IGNORE_CASE)

/** 拆出答案尾部的补充说明；没有则原样返回。 */
private fun splitAnswerNote(text: String): Pair<String, String> {
    NOTE_SUFFIX_ZH_RE.find(text)?.let { m ->
        return text.substring(0, m.range.first).trim() to m.groupValues[1].trim()
    }
    NOTE_SUFFIX_EN_RE.find(text)?.let { m ->
        return text.substring(0, m.range.first).trim() to m.groupValues[1].trim()
    }
    return text.trim() to ""
}

/**
 * 把一条 user 消息解析回逐题答案——仅当它匹配组合回复格式且逐行与
 * [questions] 的题号 / 标题对得上；否则返回 null（调用方视为「面板被取代」）。
 * 没出现的题 = 「跳过」（build 侧省略了它们）。
 */
fun parseChoiceReply(rawText: String?, questions: List<ChoiceBlockQuestion>): ChoiceReply? {
    if (rawText == null) return null
    val lines = rawText.split(Regex("\\r?\\n")).map { it.trim() }.filter { it.isNotEmpty() }
    if (lines.isEmpty() || !REPLY_HEADER_RE.matches(lines[0])) return null

    val out = mutableMapOf<Int, ChoiceAnswer>()
    var panelNote: String? = null
    for (k in 1 until lines.size) {
        if (ALL_SKIP_RE.matches(lines[k])) {
            questions.indices.forEach { out[it] = ChoiceAnswer.Skip() }
            continue
        }
        // 整组补充：没有题号的一行（带题号的走下面的 REPLY_LINE_RE）。
        val whole = PANEL_NOTE_RE.matchEntire(lines[k])
        if (whole != null) {
            panelNote = whole.groupValues[2].trim().take(CHOICE_NOTE_MAX).ifEmpty { null }
            continue
        }
        val m = REPLY_LINE_RE.matchEntire(lines[k]) ?: return null
        val idx = m.groupValues[1].toIntOrNull()?.minus(1) ?: return null
        val question = questions.getOrNull(idx) ?: return null
        val title = m.groupValues[2].trim()
        val (main, note) = splitAnswerNote(m.groupValues[3].trim())
        val noteOrNull = note.ifEmpty { null }

        if (title.isEmpty()) {
            // 省略标题：只接受 `2. → 补充：…`（跳过 + 一句原因）。
            val only = NOTE_ONLY_RE.matchEntire(main) ?: return null
            val reason = only.groupValues[2].trim()
            if (reason.isEmpty()) return null
            out[idx] = ChoiceAnswer.Skip(reason.take(CHOICE_NOTE_MAX))
            continue
        }
        if (normalizeSpace(title) != normalizeSpace(question.title)) return null

        val option = question.options.firstOrNull { it.label == main }
        if (option != null) {
            out[idx] = ChoiceAnswer.Option(option.label, noteOrNull)
            continue
        }
        if (SKIP_ANSWER_RE.matches(main)) {
            out[idx] = ChoiceAnswer.Skip(noteOrNull)
            continue
        }
        val other = OTHER_ANSWER_RE.matchEntire(main)
        if (other != null) {
            out[idx] = ChoiceAnswer.Other(other.groupValues[2].trim(), noteOrNull)
            continue
        }
        return null
    }
    for (i in questions.indices) if (i !in out) out[i] = ChoiceAnswer.Skip()
    return ChoiceReply(out, panelNote)
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
    val reply = parseChoiceReply(transcriptText(nextUser), data.questions)
    return if (reply != null) ChoicePanelState.Answered(reply.answers, reply.note) else ChoicePanelState.Superseded
}
