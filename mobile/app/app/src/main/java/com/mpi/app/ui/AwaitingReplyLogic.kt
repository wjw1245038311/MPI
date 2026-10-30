package com.mpi.app.ui

import com.mpi.app.data.ThreadView
import com.mpi.app.protocol.BlockType

/**
 * 「回合停在等你回复」的判定（纯函数，可单测）。
 *
 * 与桌面端 `src/renderer/src/lib/awaiting-reply.ts`、PWA `mobile/pwa/src/lib/awaiting-reply.ts`
 * **同一判据**，改规则时三端同步（`test-awaiting-reply.mjs` 有 parity 断言）。
 *
 * 背景（2026-10-30，minibox 会话 `session-01a1885c`）：模型干完当轮活后，把需要用户拍板的事
 * 写成**正文提问**收尾，既没有 choices 围栏、也没有报错。会话文件完全干净
 * （`stopReason=stop`），界面与「任务已做完」一模一样，用户 7 小时后才发现任务停在等签字。
 *
 * 判据刻意保守（误显示只是多一条弱提示，漏显示只是回到旧行为）：
 *   1. 已经写了 choices 围栏 → 不提示（面板本身就是提示）；
 *   2. 尾部（最后 400 字）去掉装饰符后以 `?` / `？` 结尾 → 提示；
 *   3. 尾部出现明确的「等你 / 需要你 / 请确认 / let me know」类等待语 → 提示；
 *   4. 其它一律不提示（正常汇报、以代码块/表格收尾的都不算）。
 */

/** 明确的等待语（大小写不敏感）。 */
private val WAIT_PHRASES = listOf(
    "等你",
    "待你",
    "需要你",
    "请你确认",
    "请确认",
    "你决定后",
    "你确认后",
    "你来定",
    "awaiting your",
    "waiting for your",
    "let me know",
)

/** choices 围栏（行首三个以上反引号 + choices）。 */
private val CHOICE_FENCE = Regex("(?im)^[ \t]{0,3}`{3,}[ \t]*choices")

/** 尾部窗口：模型常在问句后跟一段收尾清单，400 字够覆盖，又不会把长文开头的问题算进来。 */
private const val TAIL_CHARS = 400

/** 尾部装饰符（把「（等你确认）」这种尾巴剥掉再判问号）。 */
private val TRAILING_DECOR = Regex("[\\s\"'”’）)】\\]。．.,，、…~～*_|]+$")

/** 去掉尾部装饰符后的最后一个实义字符是不是问号。 */
private fun endsWithQuestion(tail: String): Boolean =
    tail.replace(TRAILING_DECOR, "").endsWith("?") || tail.replace(TRAILING_DECOR, "").endsWith("？")

/**
 * 这段 assistant 文本是否在「等用户回复」。
 * 调用方负责再确认：它是本回合最后一条消息、且回合已经结束（没有流式、没有在跑的工具）。
 */
internal fun looksAwaitingReply(text: String): Boolean {
    val body = text.trim()
    if (body.isEmpty()) return false
    if (CHOICE_FENCE.containsMatchIn(body)) return false
    val tail = if (body.length > TAIL_CHARS) body.takeLast(TAIL_CHARS) else body
    if (endsWithQuestion(tail)) return true
    val lower = tail.lowercase()
    return WAIT_PHRASES.any { lower.contains(it.lowercase()) }
}

/**
 * 聊天区是否显示「等你回复」提示条。
 *
 * 只在**回合彻底停下**时判：running 为真、还有流式消息、有错误横幅、正在压缩——都不算
 * 「在等你」，那些情况界面已有各自的指示。
 */
internal fun shouldShowAwaitingReply(view: ThreadView): Boolean {
    if (view.running) return false
    if (view.streaming != null) return false
    if (!view.errorBanner.isNullOrEmpty()) return false
    if (view.compacting) return false
    val last = view.messages.lastOrNull() ?: return false
    if (last.role != "assistant") return false
    val text = last.blocks
        .filter { it.type == BlockType.Text }
        .joinToString("") { it.text.orEmpty() }
    return looksAwaitingReply(text)
}
