package com.mpi.app.ui

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * 「撤回已插入、尚未执行的插话」的纯逻辑（对照 PWA 的 `lib/queue-retract.ts`）。
 *
 * 背景：`thread.steer` 只是把消息塞进 pi 的待投递队列，直到下一个 LLM 调用边界才注入上下文。
 * 这段窗口里可以用 `thread.clearQueue` 整队撤回——但 pi **只返回文本、且只能整队清**，
 * 所以客户端必须把文本回填给用户（「待处理后续」卡片），不能静默丢弃。
 */

private fun stringsOf(value: JsonElement?): List<String> =
    (value as? JsonArray)
        // 只认字符串：队列里不可能有数字/布尔，混进来一律当脏数据丢弃。
        ?.mapNotNull { (it as? JsonPrimitive)?.takeIf { prim -> prim.isString }?.contentOrNull }
        ?.filter { it.isNotBlank() }
        .orEmpty()

/** `thread.clearQueue` 响应 → 待回填文本（steering 在前，保持 pi 的投递顺序）。 */
internal fun queueTextsOf(cleared: JsonElement?): List<String> {
    val obj = cleared as? JsonObject ?: return emptyList()
    return stringsOf(obj["steering"]) + stringsOf(obj["followUp"])
}

/**
 * 撤回后的回填文本：已有暂存内容在前，再拼上撤回的若干条（空串一律不参与拼接）。
 * 全部为空 → 返回 null（不凭空造一张空卡片）。
 */
internal fun mergeRetractedText(pending: String?, cleared: List<String>): String? {
    val parts = buildList {
        pending?.trim()?.takeIf { it.isNotEmpty() }?.let { add(it) }
        cleared.forEach { item -> item.trim().takeIf { it.isNotEmpty() }?.let { add(it) } }
    }
    return parts.takeIf { it.isNotEmpty() }?.joinToString("\n\n")
}
