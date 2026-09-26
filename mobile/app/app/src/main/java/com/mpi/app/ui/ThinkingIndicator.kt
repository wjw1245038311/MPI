package com.mpi.app.ui

import com.mpi.app.data.ThreadView

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
    // assistant 消息已开始 → 由该条消息自己的渲染接管
    if (view.streaming != null) return false
    // 压缩进行中 → 输入条一侧已有自己的指示
    if (view.compacting) return false
    // 工具卡正在展示活动，不再叠加占位行
    return view.renderable.none { message -> message.blocks.any { it.running } }
}

/** 已等待秒数 → `59s` / `1m23s`（本地模型 prefill 到分钟级不罕见，纯秒数读着费劲）。 */
internal fun formatElapsed(seconds: Int): String {
    val total = seconds.coerceAtLeast(0)
    if (total < 60) return "${total}s"
    return "${total / 60}m${(total % 60).toString().padStart(2, '0')}s"
}
