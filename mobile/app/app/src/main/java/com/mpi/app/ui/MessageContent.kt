package com.mpi.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mpi.app.protocol.ThreadMessage
import com.mpi.app.ui.theme.MpiTheme

/**
 * 文本块渲染（轻量 Markdown）。
 *
 * 本步只做对「看 agent 输出」最要紧的三件事：**围栏代码块**（等宽 + 底色 + 横向滚动）、
 * **行内代码**、以及保留换行的正文。粗体/斜体/链接等留待后续按需补——
 * 手机屏幕小，代码块的可读性远比字重重要。
 *
 * 解析结果按「块」缓存（[remember]），避免流式刷新时每帧重新切分整段文本。
 */
@Composable
fun MessageText(text: String, modifier: Modifier = Modifier, color: androidx.compose.ui.graphics.Color? = null) {
    val segments = remember(text) { parseSegments(text) }
    RenderSegments(segments, color ?: MaterialTheme.colorScheme.onSurface, modifier)
}

/** 渲染一组段（choices 段由 [ChoiceAwareText] 负责，这里跳过）。 */
@Composable
internal fun RenderSegments(
    segments: List<Segment>,
    bodyColor: androidx.compose.ui.graphics.Color,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxWidth()) {
        for (segment in segments) {
            when (segment) {
                is Segment.Code -> {
                    val scroll = rememberScrollState()
                    Text(
                        text = segment.text,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(8.dp))
                            .background(MpiTheme.colors.codeBg)
                            .horizontalScroll(scroll)
                            .padding(10.dp),
                        style = MaterialTheme.typography.bodySmall.copy(
                            fontFamily = FontFamily.Monospace,
                            fontSize = 13.sp,
                            lineHeight = 19.sp,
                        ),
                        color = bodyColor,
                    )
                    if (segment.choiceWarn) {
                        Text(
                            text = "choices 面板解析失败，按代码显示",
                            style = MaterialTheme.typography.labelSmall,
                            color = MpiTheme.colors.textFaint,
                        )
                    }
                }

                is Segment.Body -> if (segment.text.isNotBlank()) {
                    Text(
                        text = inlineStyled(segment.text, bodyColor, MpiTheme.colors.codeBg),
                        style = MaterialTheme.typography.bodyLarge,
                        color = bodyColor,
                    )
                }

                is Segment.Choice -> Unit
            }
        }
    }
}

internal sealed interface Segment {
    /**
     * 围栏代码块（去掉 ``` 行）。
     *
     * @param lang 围栏语言（如 `choices` / `ts`），无则 null。
     * @param closed 是否闭合；false = 流式中或模型漏写闭合围栏。
     * @param choiceWarn choices 围栏解析失败（降级为代码块，由调用方提示）。
     */
    data class Code(
        val text: String,
        val lang: String? = null,
        val closed: Boolean = true,
        val choiceWarn: Boolean = false,
    ) : Segment

    /** 普通正文（可能含行内代码）。 */
    data class Body(val text: String) : Segment

    /** 合法的 choices 围栏 → 交互面板（批 3）。 */
    data class Choice(val data: ChoiceBlockData) : Segment
}

/** 按 ``` 围栏切分；未闭合的围栏按正文处理（流式过程中很常见）。 */
internal fun parseSegments(text: String): List<Segment> {
    if (!text.contains("```")) return listOf(Segment.Body(text))
    val segments = mutableListOf<Segment>()
    val buffer = StringBuilder()
    var inCode = false
    var codeLang: String? = null
    val code = StringBuilder()

    for (line in text.split("\n")) {
        val trimmed = line.trimStart()
        val isFence = trimmed.startsWith("```")
        when {
            isFence && !inCode -> {
                if (buffer.isNotEmpty()) {
                    segments += Segment.Body(buffer.toString().trimEnd('\n'))
                    buffer.clear()
                }
                inCode = true
                codeLang = trimmed.removePrefix("```").trim().takeIf { it.isNotEmpty() }
            }

            isFence && inCode -> {
                segments += Segment.Code(code.toString().trimEnd('\n'), lang = codeLang, closed = true)
                code.clear()
                inCode = false
                codeLang = null
            }

            inCode -> code.append(line).append('\n')
            else -> buffer.append(line).append('\n')
        }
    }

    // 未闭合（流式中很常见）：保留为未闭合代码段——内容绝不消失，
    // 定稿后可被 withChoiceSegments 的容错接住。
    if (inCode) {
        segments += Segment.Code(code.toString().trimEnd('\n'), lang = codeLang, closed = false)
    }
    if (buffer.isNotEmpty()) segments += Segment.Body(buffer.toString().trimEnd('\n'))
    if (segments.isEmpty()) segments += Segment.Body(text)
    return segments
}

/** 行内切分结果：文本 + 是否代码 + 是否粗体。 */
internal data class InlineToken(val text: String, val code: Boolean = false, val bold: Boolean = false)

/**
 * 行内切分：`code` 与 `**粗体**`。
 *
 * 注意顺序：先按反引号切，**只有非代码段**再按 `**` 切——
 * 代码里的 `**` 不该被当成粗体标记。
 *
 * 抽成纯函数是刻意的：曾因为一个「无反引号就提前 return」的写法让粗体静默失效，
 * 而截图里很难一眼看出。现在可以单测。
 */
internal fun splitInline(text: String): List<InlineToken> {
    val tokens = mutableListOf<InlineToken>()
    text.split('`').forEachIndexed { index, part ->
        if (index % 2 == 1) {
            if (part.isNotEmpty()) tokens += InlineToken(part, code = true)
        } else {
            part.split("**").forEachIndexed { pieceIndex, piece ->
                if (piece.isNotEmpty()) tokens += InlineToken(piece, bold = pieceIndex % 2 == 1)
            }
        }
    }
    return tokens
}

private fun inlineStyled(
    text: String,
    baseColor: androidx.compose.ui.graphics.Color,
    codeBg: androidx.compose.ui.graphics.Color,
): AnnotatedString = buildAnnotatedString {
    for (token in splitInline(text)) {
        when {
            token.code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBg)) {
                append(token.text)
            }

            token.bold -> withStyle(SpanStyle(color = baseColor, fontWeight = FontWeight.Bold)) {
                append(token.text)
            }

            else -> withStyle(SpanStyle(color = baseColor)) { append(token.text) }
        }
    }
}

/**
 * 带 choices 面板的文本渲染（批 3）：合法的 ```choices 围栏升级为可点选面板。
 * 只有 assistant 的**定稿**消息才走这里（流式中间态仍按代码块显示）。
 */
@Composable
fun ChoiceAwareText(
    text: String,
    threadId: String,
    messageId: String,
    allMessages: List<ThreadMessage>,
    language: String,
    onSendChoice: (String) -> Unit,
    /** 未发送的勾选草稿（key = threadId|messageId|blockIndex|questionIndex）。 */
    drafts: Map<String, ChoiceAnswer>,
    onDraftChange: (String, ChoiceAnswer?) -> Unit,
    onClearDrafts: (String) -> Unit,
    modifier: Modifier = Modifier,
    color: androidx.compose.ui.graphics.Color? = null,
) {
    val segments = remember(text) { withChoiceSegments(parseSegments(text), finalized = true) }
    val bodyColor = color ?: MaterialTheme.colorScheme.onSurface
    Column(modifier.fillMaxWidth()) {
        segments.forEachIndexed { index, segment ->
            if (segment is Segment.Choice) {
                val prefix = "$threadId|$messageId|$index"
                ChoicePanel(
                    data = segment.data,
                    state = deriveChoicePanelState(allMessages, messageId, segment.data),
                    language = language,
                    onSend = onSendChoice,
                    draftFor = { questionIndex -> drafts["$prefix|$questionIndex"] },
                    onDraftChange = { questionIndex, answer -> onDraftChange("$prefix|$questionIndex", answer) },
                    onClearDrafts = { onClearDrafts(prefix) },
                )
            } else {
                RenderSegments(listOf(segment), bodyColor)
            }
        }
    }
}
