package com.mpi.app.ui

import com.mpi.app.data.ThreadView
import com.mpi.app.protocol.BlockType
import com.mpi.app.protocol.ThreadMessage

/**
 * 聊天区是否显示「思考中」占位行（prefill 等待指示器）。
 *
 * 与桌面端 `lib/thinking-indicator.ts` 同一套语义。背景：pi 只在 LLM 响应头到达后
 * 才发 assistant 消息，而本地模型 prefill 可达数十秒——这期间 `running` 为真、
 * `streaming` 为空、也没有工具卡在跑，聊天区一片空白，看着像卡死。
 * 覆盖两个窗口：发送后 → 响应头到达；工具跑完 → 下一轮 prefill。
 */
internal fun shouldShowThinkingPlaceholder(view: ThreadView): Boolean {
    if (!view.running) return false
    // 压缩进行中 → 输入条一侧已有自己的指示
    if (view.compacting) return false
    // 工具卡正在展示活动，不再叠加占位行
    if (view.renderable.any { message -> message.blocks.any { it.running } }) return false
    // 判据是「还没有任何可见内容」，而不是「assistant 消息还没开始」：
    // pi 在 **HTTP 响应头到达**时就发 message_start，而本地模型（llama-server 等）的
    // 响应头通常早于 prefill 完成——那时 streaming 已非空却一个块都没有
    //（2026-09-26 真机：本地模型 prefill 期间一直等不到占位行，就是因为这条判早了）。
    return !hasVisibleContent(view.streaming)
}

/** 流式消息里是否已有用户看得见的东西（正文 / 思考 / 图片 / 工具）。 */
internal fun hasVisibleContent(message: ThreadMessage?): Boolean {
    if (message == null) return false
    return message.blocks.any { block ->
        when (block.type) {
            BlockType.Tool -> true
            BlockType.Image -> !block.data.isNullOrEmpty()
            else -> !block.text.isNullOrEmpty()
        }
    }
}

/** 已等待秒数 → `59s` / `1m23s`（本地模型 prefill 到分钟级不罕见，纯秒数读着费劲）。 */
internal fun formatElapsed(seconds: Int): String {
    val total = seconds.coerceAtLeast(0)
    if (total < 60) return "${total}s"
    return "${total / 60}m${(total % 60).toString().padStart(2, '0')}s"
}
