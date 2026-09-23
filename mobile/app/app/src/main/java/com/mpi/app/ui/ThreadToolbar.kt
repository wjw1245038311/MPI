package com.mpi.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.mpi.app.data.ThreadView
import com.mpi.app.protocol.ContextUsage
import com.mpi.app.protocol.RemotePermission
import com.mpi.app.ui.theme.MpiTheme
import java.util.Locale
import kotlin.math.roundToInt

/**
 * 会话配置面板：模型 / 用量 / 任务模式 / 权限**全部在这里**。
 *
 * 入口只有一个——输入框按钮行里那个圆钮（显示用量百分比）。所以这个面板必须**短**：
 * 每项都是一行「标签 + 横向滚动的选项 chip」，不再纵向铺成长列表。
 */
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

// ---- 面板 ----

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConfigSheet(
    view: ThreadView,
    busy: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onSetPermission: (RemotePermission) -> Unit,
    onSetModel: (String, String) -> Unit,
    onSetMode: (String) -> Unit,
    onCompact: () -> Unit,
    onRefresh: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val ctx = readContextUsage(view.contextUsage)
    val permission = view.summary?.permission ?: RemotePermission.Sandbox

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MpiTheme.colors.bg,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 18.dp)
                .padding(bottom = 26.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (error != null) {
                Text(
                    text = error,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            // 用量：一行搞定（百分比 + 进度 + 压缩入口）
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "上下文",
                    style = MaterialTheme.typography.labelSmall,
                    color = MpiTheme.colors.textFaint,
                    modifier = Modifier.width(78.dp),
                )
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .height(6.dp)
                        .clip(RoundedCornerShape(999.dp))
                        .background(MpiTheme.colors.control),
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth(fraction = (maxOf(2.0, ctx.percent) / 100.0).toFloat().coerceIn(0f, 1f))
                            .height(6.dp)
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
                Text(
                    text = if (ctx.hasValue) "${ctx.percent.roundToInt()}%" else "—",
                    style = MaterialTheme.typography.labelSmall,
                    color = MpiTheme.colors.textDim,
                    modifier = Modifier.padding(start = 8.dp).width(34.dp),
                )
                TextButton(
                    onClick = onCompact,
                    enabled = !busy && !view.compacting && !view.running,
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp, vertical = 0.dp),
                ) {
                    Text(if (view.compacting) "压缩中…" else "压缩", style = MaterialTheme.typography.labelSmall)
                }
            }

            // 权限
            ConfigRow("权限") {
                OptionChip("沙盒", selected = permission == RemotePermission.Sandbox, enabled = !busy) {
                    onSetPermission(RemotePermission.Sandbox)
                }
                OptionChip("完整权限", selected = permission == RemotePermission.Full, enabled = !busy) {
                    onSetPermission(RemotePermission.Full)
                }
            }

            // 任务模式
            ConfigRow("模式") {
                OptionChip("基线", selected = view.taskMode.isNullOrEmpty(), enabled = !busy) { onSetMode("") }
                view.availableModes.forEach { option ->
                    OptionChip(
                        label = option.name,
                        selected = view.taskMode == option.id,
                        enabled = !busy,
                    ) { onSetMode(option.id) }
                }
            }

            // 模型：下拉（模型多了横向划不方便）
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "模型",
                    style = MaterialTheme.typography.labelSmall,
                    color = MpiTheme.colors.textFaint,
                    modifier = Modifier.width(78.dp),
                )
                var modelMenuOpen by remember { mutableStateOf(false) }
                Box {
                    Row(
                        modifier = Modifier
                            .clip(RoundedCornerShape(999.dp))
                            .background(MpiTheme.colors.control)
                            .clickable(enabled = !busy) { modelMenuOpen = true }
                            .padding(horizontal = 10.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = modelChipLabel(view),
                            style = MaterialTheme.typography.labelSmall,
                            color = MpiTheme.colors.textDim,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.widthIn(max = 170.dp),
                        )
                        Spacer(Modifier.width(4.dp))
                        Icon(
                            imageVector = IconChevronDown,
                            contentDescription = null,
                            tint = MpiTheme.colors.textFaint,
                            modifier = Modifier.size(13.dp),
                        )
                    }
                    DropdownMenu(expanded = modelMenuOpen, onDismissRequest = { modelMenuOpen = false }) {
                        if (view.availableModels.isEmpty()) {
                            DropdownMenuItem(
                                text = { Text("主机未上报可选模型") },
                                onClick = { modelMenuOpen = false },
                            )
                        } else {
                            view.availableModels.forEach { option ->
                                val selected = view.model?.provider == option.provider && view.model?.id == option.id
                                DropdownMenuItem(
                                    text = {
                                        Row(verticalAlignment = Alignment.CenterVertically) {
                                            Text(
                                                text = option.name?.takeIf { it.isNotEmpty() } ?: option.id,
                                                style = MaterialTheme.typography.bodyMedium,
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis,
                                                modifier = Modifier.widthIn(max = 210.dp),
                                            )
                                            if (selected) {
                                                Spacer(Modifier.width(6.dp))
                                                Icon(
                                                    imageVector = IconCheck,
                                                    contentDescription = null,
                                                    tint = MaterialTheme.colorScheme.primary,
                                                    modifier = Modifier.size(14.dp),
                                                )
                                            }
                                        }
                                    },
                                    onClick = {
                                        modelMenuOpen = false
                                        onSetModel(option.provider, option.id)
                                    },
                                )
                            }
                        }
                    }
                }
            }

            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(
                    onClick = onRefresh,
                    enabled = !busy,
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 0.dp, vertical = 0.dp),
                ) {
                    Text("与桌面端同步（刷新）", style = MaterialTheme.typography.labelSmall)
                }
                Spacer(Modifier.width(4.dp))
                if (ctx.isEstimate) {
                    Text(
                        text = "用量为压缩后估算",
                        style = MaterialTheme.typography.labelSmall,
                        color = MpiTheme.colors.textFaint,
                    )
                }
            }
        }
    }
}

/** 一行配置：固定宽标签 + 可横向滚动的选项 chip。 */
@Composable
private fun ConfigRow(label: String, content: @Composable RowScope.() -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MpiTheme.colors.textFaint,
            modifier = Modifier.width(78.dp),
        )
        Row(
            modifier = Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
            content = content,
        )
    }
}

@Composable
private fun OptionChip(
    label: String,
    selected: Boolean,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(if (selected) MpiTheme.colors.accentSoft else MpiTheme.colors.control)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = if (selected) MaterialTheme.colorScheme.primary else MpiTheme.colors.textDim,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
