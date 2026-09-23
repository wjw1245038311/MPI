package com.mpi.app.ui

import com.mpi.app.protocol.UiRequest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * 审批卡的回答形状 —— 对齐桌面端 `ExtUiModal`（`thread-actions.ts` 的 `respondUi` 注释）：
 *
 * | method | 回答 |
 * | --- | --- |
 * | select | `{value: "选项文本"}` |
 * | confirm | `{confirmed: true/false}` |
 * | input / editor | `{value: "输入内容"}` |
 * | 任意方法被取消 | `{cancelled: true}` |
 *
 * 抽成纯函数是为了能单测：这个形状写错不会报错，只会让桌面端的弹窗一直卡着。
 */
internal fun approvalResponseFor(method: String, value: String? = null, confirmed: Boolean? = null): JsonObject =
    when {
        confirmed != null -> buildJsonObject { put("confirmed", confirmed) }
        value != null -> buildJsonObject { put("value", value) }
        else -> buildJsonObject { put("cancelled", true) }
    }

/** 取消（任何 method 通用）。 */
internal fun approvalCancel(): JsonObject = approvalResponseFor(method = "cancel")

/** 输入类请求是否允许提交空内容（对齐桌面端：不允许）。 */
internal fun canSubmitInput(request: UiRequest, input: String): Boolean =
    !request.isInput || input.trim().isNotEmpty()

// ---- diff 渲染 ----

internal enum class DiffLineKind { Added, Removed, Context, Header }

internal data class DiffLine(val kind: DiffLineKind, val text: String)

/**
 * 把 unified diff 文本切成行并分类（供 UI 上色）。
 *
 * 只认行首标记：`+` / `-` / `@@`。注意 `+++`/`---` 这两个文件头也要按 Header 处理，
 * 否则会被当成「加了一行 +++ b/foo」。
 */
internal fun parseDiffLines(hunks: String): List<DiffLine> = hunks.lineSequence()
    .filter { it.isNotEmpty() || true }
    .map { line ->
        val kind = when {
            line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") -> DiffLineKind.Header
            line.startsWith("+") -> DiffLineKind.Added
            line.startsWith("-") -> DiffLineKind.Removed
            else -> DiffLineKind.Context
        }
        DiffLine(kind, line)
    }
    .toList()
