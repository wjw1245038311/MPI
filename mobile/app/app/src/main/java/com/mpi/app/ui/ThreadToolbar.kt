package com.mpi.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mpi.app.data.ThreadView
import com.mpi.app.protocol.ContextUsage
import com.mpi.app.protocol.RemotePermission
import com.mpi.app.ui.theme.MpiTheme
import java.util.Locale
import kotlin.math.roundToInt

/**
 * 会话级配置（§4.4 chip 行）—— 对齐 PWA `ThreadView.tsx` 的 `.thread-toolbar` 与底部 Sheet。
 *
 * 数据早就在 [ThreadView] 里（模型 / 模式 / 权限 / 上下文用量），写操作也已在
 * `ThreadActions` 就绪；这里只补 UI。选择项不占消息区高度，一律走底部 Sheet。
 */
enum class ToolbarSheet { Permission, Mode, Model, Context }

// ---- 上下文用量口径（纯函数，与桌面端 ring / PWA `lib/context-usage.ts` 一致）----

/** 用量档位：决定颜色与「该不该压缩」的暗示。阈值 60 / 75 / 90。 */
enum class ContextBand { Low, Warn, Mid, Hi }

data class ContextReading(
    val hasValue: Boolean,
    val used: Long,
    val total: Long,
    val percent: Double,
    /** 数值来自压缩后的估算（pi 不再上报 tokens）——界面要加提示。 */
    val isEstimate: Boolean,
    val band: ContextBand,
)

fun bandOfPercent(percent: Double): ContextBand = when {
    percent >= 90 -> ContextBand.Hi
    percent >= 75 -> ContextBand.Mid
    percent >= 60 -> ContextBand.Warn
    else -> ContextBand.Low
}

/**
 * 读数规则（三条必须与桌面端一致）：
 * 1. 压缩后 pi 把 tokens 报成 null，此时用 estimatedTokens 回退，否则会错误显示 0%；
 * 2. percent 可用时优先用 pi 的值，否则 tokens / contextWindow 自算；
 * 3. 窗口未知、且两个 token 数都没有 → hasValue=false（界面显示「—」而不是 0%）。
 */
fun readContextUsage(usage: ContextUsage?): ContextReading {
    val total = usage?.contextWindow ?: 0L
    val isEstimate = usage != null && usage.tokens == null
    val used = usage?.tokens ?: usage?.estimatedTokens ?: 0L
    val hasValue = usage != null && total > 0 && (usage.tokens != null || usage.estimatedTokens != null)
    val percent = if (hasValue) {
        minOf(100.0, usage?.percent ?: (used.toDouble() / total.toDouble() * 100.0))
    } else {
        0.0
    }
    return ContextReading(hasValue, used, total, percent, isEstimate, bandOfPercent(percent))
}

/** 132400 → "132k"；4200 → "4.2k"；880 → "880"。 */
fun formatTokens(value: Long): String {
    if (value < 1000) return value.toString()
    val k = value / 1000.0
    return if (value >= 10_000) "${k.roundToInt()}k" else String.format(Locale.US, "%.1fk", k)
}

/** 模式 chip 文案：未设置 → 基线；找不到名称 → 回退 id。 */
fun taskModeChipLabel(view: ThreadView): String {
    val current = view.taskMode
    if (current.isNullOrEmpty()) return "基线"
    return view.availableModes.firstOrNull { it.id == current }?.name ?: current
}

/** 模型 chip 文案：短名（去掉 provider 前缀），超过 18 字符截断——与 PWA 一致。 */
fun modelChipLabel(view: ThreadView): String {
    val current = view.model ?: return "默认模型"
    val option = view.availableModels.firstOrNull { it.provider == current.provider && it.id == current.id }
    val short = (option?.name?.takeIf { it.isNotEmpty() } ?: option?.id ?: current.id).substringAfterLast("/")
    return if (short.length > 18) short.take(17) + "…" else short
}

// ---- chip 行 ----

private enum class ChipTone { Plain, Accent, Warn, Mid, Hi }

@Composable
fun ThreadToolbar(
    view: ThreadView,
    busy: Boolean,
    onOpen: (ToolbarSheet) -> Unit,
    modifier: Modifier = Modifier,
) {
    val summary = view.summary ?: return

    Row(
        modifier = modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(start = 12.dp, end = 12.dp, bottom = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ConfigChip(
            icon = IconLock,
            label = if (summary.permission == RemotePermission.Sandbox) "沙盒" else "完整权限",
            tone = if (summary.permission == RemotePermission.Sandbox) ChipTone.Accent else ChipTone.Plain,
            enabled = !busy,
            onClick = { onOpen(ToolbarSheet.Permission) },
        )
        ConfigChip(
            icon = IconSpark,
            label = taskModeChipLabel(view),
            enabled = !busy,
            onClick = { onOpen(ToolbarSheet.Mode) },
        )
    }
}

@Composable
private fun ConfigChip(
    icon: ImageVector,
    label: String,
    enabled: Boolean,
    onClick: () -> Unit,
    tone: ChipTone = ChipTone.Plain,
) {
    val colors = MpiTheme.colors
    val fg = when (tone) {
        ChipTone.Plain -> colors.textDim
        ChipTone.Accent -> MaterialTheme.colorScheme.primary
        ChipTone.Warn -> CtxWarnFg
        ChipTone.Mid -> CtxMidFg
        ChipTone.Hi -> CtxHiFg
    }
    val bg = when (tone) {
        ChipTone.Accent -> colors.accentSoft
        ChipTone.Warn -> CtxWarnFg.copy(alpha = 0.12f)
        ChipTone.Mid -> CtxMidFg.copy(alpha = 0.14f)
        ChipTone.Hi -> CtxHiFg.copy(alpha = 0.14f)
        ChipTone.Plain -> colors.control
    }

    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(bg)
            .border(1.dp, colors.border, RoundedCornerShape(999.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(icon, contentDescription = null, tint = fg, modifier = Modifier.size(13.dp))
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = fg,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

// ---- 底部 Sheet ----

// 用量档位配色沿用 PWA `.cfg-chip.ctx.*` 的硬编码值（PWA 侧也不分深浅两套）。
private val CtxWarnFg = Color(0xFF8A6D1F)
private val CtxMidFg = Color(0xFFA5531B)
private val CtxHiFg = Color(0xFFB3261E)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ThreadToolbarSheet(
    sheet: ToolbarSheet,
    view: ThreadView,
    busy: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onSetPermission: (RemotePermission) -> Unit,
    onSetModel: (String, String) -> Unit,
    onSetMode: (String) -> Unit,
    onCompact: () -> Unit,
    /** 重新拉主机快照（刷新当前模型与可选列表）。 */
    onRefresh: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MpiTheme.colors.bg,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(start = 18.dp, end = 18.dp, bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (error != null) {
                Text(
                    text = error,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            when (sheet) {
                ToolbarSheet.Permission -> PermissionSheet(view, busy, onSetPermission)
                ToolbarSheet.Mode -> ModeSheet(view, busy, onSetMode)
                ToolbarSheet.Model -> ModelSheet(view, busy, onSetModel, onRefresh)
                ToolbarSheet.Context -> ContextSheet(view, busy, onCompact)
            }
            Spacer(Modifier.height(4.dp))
        }
    }
}

@Composable
private fun SheetTitle(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.titleMedium,
        modifier = Modifier.padding(bottom = 2.dp),
    )
}

@Composable
private fun SheetNote(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodySmall,
        color = MpiTheme.colors.textFaint,
        modifier = Modifier.padding(bottom = 4.dp),
    )
}

@Composable
private fun SheetItem(
    label: String,
    note: String? = null,
    tag: String? = null,
    active: Boolean = false,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(if (active) MpiTheme.colors.accentSoft else Color.Transparent)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    text = label,
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (enabled) MaterialTheme.colorScheme.onSurface else MpiTheme.colors.textFaint,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (tag != null) {
                    Text(
                        text = tag,
                        style = MaterialTheme.typography.labelSmall,
                        color = MpiTheme.colors.textFaint,
                    )
                }
            }
            if (note != null) {
                Text(
                    text = note,
                    style = MaterialTheme.typography.labelSmall,
                    color = MpiTheme.colors.textFaint,
                )
            }
        }
        if (active) {
            Icon(
                IconCheck,
                contentDescription = "已选中",
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(16.dp),
            )
        }
    }
}

@Composable
private fun PermissionSheet(view: ThreadView, busy: Boolean, onSetPermission: (RemotePermission) -> Unit) {
    val sandbox = view.summary?.permission != RemotePermission.Full
    SheetTitle("权限级别")
    SheetNote("沙盒：写文件 / 执行命令前需要你批准；完整：不再逐条询问。")
    SheetItem("沙盒（逐条批准）", active = sandbox, enabled = !busy) { onSetPermission(RemotePermission.Sandbox) }
    SheetItem("完整权限（不询问）", active = !sandbox, enabled = !busy) { onSetPermission(RemotePermission.Full) }
}

@Composable
private fun ModeSheet(view: ThreadView, busy: Boolean, onSetMode: (String) -> Unit) {
    SheetTitle("任务模式")
    SheetNote("模式同时决定权限与思考等级，并可能注入行为指令（如迭代 / 调研）。")
    SheetItem(
        label = "基线",
        tag = "不注入",
        active = view.taskMode.isNullOrEmpty(),
        enabled = !busy,
    ) { onSetMode("") }
    if (view.availableModes.isEmpty()) {
        SheetNote("主机未上报可选模式列表。")
    } else {
        view.availableModes.forEach { option ->
            SheetItem(
                label = option.name,
                note = option.summary,
                tag = if (option.enforceReadonly) "只读" else null,
                active = view.taskMode == option.id,
                enabled = !busy,
            ) { onSetMode(option.id) }
        }
    }
}

@Composable
private fun ModelSheet(
    view: ThreadView,
    busy: Boolean,
    onSetModel: (String, String) -> Unit,
    onRefresh: () -> Unit,
) {
    SheetTitle("选择模型")
    // 桌面端改了模型/模型列表时，手机端不一定立刻收到——给一个手动同步入口
    SheetItem(
        label = "与桌面端同步（刷新）",
        note = "重新读取当前模型与可选列表",
        enabled = !busy,
    ) { onRefresh() }
    if (view.availableModels.isEmpty()) {
        SheetNote("主机未上报可选模型列表。")
        return
    }
    view.availableModels.forEach { option ->
        val active = view.model?.provider == option.provider && view.model?.id == option.id
        SheetItem(
            label = option.name?.takeIf { it.isNotEmpty() } ?: option.id,
            tag = if (option.reasoning) "思考" else null,
            active = active,
            enabled = !busy,
        ) { onSetModel(option.provider, option.id) }
    }
}

@Composable
private fun ContextSheet(view: ThreadView, busy: Boolean, onCompact: () -> Unit) {
    val ctx = readContextUsage(view.contextUsage)
    SheetTitle("上下文用量")
    if (ctx.hasValue) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(8.dp)
                .clip(RoundedCornerShape(999.dp))
                .background(MpiTheme.colors.control),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth(fraction = (maxOf(2.0, ctx.percent) / 100.0).toFloat().coerceIn(0f, 1f))
                    .height(8.dp)
                    .clip(RoundedCornerShape(999.dp))
                    .background(
                        when (ctx.band) {
                            ContextBand.Low -> MpiTheme.colors.ok
                            ContextBand.Warn -> Color(0xFFD6A419)
                            ContextBand.Mid -> Color(0xFFE07B39)
                            ContextBand.Hi -> Color(0xFFD93025)
                        },
                    ),
            )
        }
        Row(
            modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "${formatTokens(ctx.used)} / ${formatTokens(ctx.total)} tokens",
                style = MaterialTheme.typography.bodySmall,
                color = MpiTheme.colors.textDim,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = String.format(Locale.US, "%.1f%%", ctx.percent),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Bold,
                color = when (ctx.band) {
                    ContextBand.Low -> MaterialTheme.colorScheme.onSurface
                    ContextBand.Warn -> CtxWarnFg
                    ContextBand.Mid -> CtxMidFg
                    ContextBand.Hi -> CtxHiFg
                },
            )
        }
        if (ctx.isEstimate) {
            SheetNote("压缩后的估算值——下次回复后更新为实际值。")
        }
    } else {
        SheetNote("主机还没上报这个会话的上下文用量（模型未知或会话太新）。")
    }
    SheetNote("≥60% 就该压缩：把早期对话总结成摘要，腾出窗口又不丢关键信息。${if (view.compacting) "（正在压缩…）" else ""}")
    SheetItem(
        label = if (view.compacting) "压缩中…" else "压缩上下文",
        note = when {
            view.running -> "回合进行中"
            view.compacting -> "请稍候"
            else -> "压缩后自动刷新用量"
        },
        enabled = !busy && !view.compacting && !view.running,
    ) { onCompact() }
    if (view.compacting) {
        Row(
            modifier = Modifier.padding(start = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            CircularProgressIndicator(Modifier.size(13.dp), strokeWidth = 2.dp)
            Text("压缩中…", style = MaterialTheme.typography.labelSmall, color = MpiTheme.colors.textFaint)
        }
    }
    Spacer(Modifier.width(1.dp))
}
