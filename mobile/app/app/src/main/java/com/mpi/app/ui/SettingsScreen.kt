package com.mpi.app.ui

import android.content.Context
import android.content.Intent
import android.provider.Settings as AndroidSettings
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.mpi.app.BuildConfig
import com.mpi.app.data.AppSettings
import com.mpi.app.data.Appearance
import com.mpi.app.data.FontSize
import com.mpi.app.data.SessionState
import com.mpi.app.data.UpdateInfo
import com.mpi.app.ui.theme.MpiTheme
import java.io.File

/** 外观模式的显示名。 */
internal fun appearanceLabel(mode: Appearance): String = when (mode) {
    Appearance.System -> "跟随系统"
    Appearance.Light -> "浅色"
    Appearance.Dark -> "深色"
}

/** 字号档位的显示名。 */
internal fun fontSizeLabel(size: FontSize): String = when (size) {
    FontSize.Small -> "小"
    FontSize.Normal -> "标准"
    FontSize.Large -> "大"
}

/**
 * 设置页（对齐 Qoder 的分组卡片风格）：左侧图标 + 标题 + 右侧「当前值 / 箭头」。
 *
 * 只放**已经能起作用**的项——语音、反馈、账号与安全在本工程里没有对应能力，
 * 就不放（§1.1：禁止点了没反应）。
 */
@Composable
fun SettingsScreen(
    settings: AppSettings,
    onAppearance: (Appearance) -> Unit,
    onFontSize: (FontSize) -> Unit,
    onOpenDiagnostics: () -> Unit,
    onRemoveDevice: () -> Unit,
    updateInfo: UpdateInfo?,
    updateChecking: Boolean,
    updateDownloading: Boolean,
    updateError: String?,
    onCheckUpdate: () -> Unit,
    onInstallUpdate: () -> Unit,
    onDismissUpdateError: () -> Unit,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    var appearancePicker by remember { mutableStateOf(false) }
    var fontPicker by remember { mutableStateOf(false) }
    var confirmingRemove by remember { mutableStateOf(false) }
    var cacheNote by remember { mutableStateOf<String?>(null) }

    BackHandler(enabled = true) { onClose() }

    Surface(color = MpiTheme.colors.bg, modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState())) {
            ScreenHeader(title = "设置", onBack = onClose)

            // ---- 账号 ----
            SettingsGroup("账号") {
                SettingsItem(
                    icon = IconBell,
                    title = "通知",
                    trailing = "在系统设置里管理",
                    onClick = { openAppNotificationSettings(context) },
                )
                SettingsItem(icon = IconGlobe, title = "语言", trailing = "中文", onClick = null)
                SettingsItem(
                    icon = IconSun,
                    title = "外观",
                    trailing = appearanceLabel(settings.appearance),
                    onClick = { appearancePicker = true },
                )
                SettingsItem(
                    icon = null,
                    title = "字号",
                    trailing = fontSizeLabel(settings.fontSize),
                    onClick = { fontPicker = true },
                )
            }

            // ---- 缓存 ----
            SettingsGroup("缓存") {
                SettingsItem(
                    icon = IconTrash,
                    title = "清理缓存",
                    trailing = cacheNote,
                    showArrow = false,
                    onClick = {
                        val freed = clearAppCache(context)
                        cacheNote = if (freed >= 0) "已清理 ${formatBytes(freed)}" else "清理失败"
                    },
                )
            }

            // ---- 隐私与更新 ----
            SettingsGroup("隐私与更新") {
                SettingsItem(
                    icon = IconShield,
                    title = "诊断",
                    trailing = "连接状态与版本",
                    onClick = onOpenDiagnostics,
                )
                SettingsItem(
                    icon = IconInfo,
                    title = "关于 MPI",
                    trailing = "v${BuildConfig.VERSION_NAME}",
                    showArrow = false,
                    onClick = null,
                )
                SettingsItem(
                    icon = IconRefresh,
                    title = if (updateChecking) "检查更新中…" else "检查更新",
                    trailing = updateInfo?.let { "发现 v${it.version}" } ?: "v${BuildConfig.VERSION_NAME}",
                    onClick = if (updateChecking) null else onCheckUpdate,
                )
                if (updateInfo != null) {
                    SettingsItem(
                        icon = null,
                        title = if (updateDownloading) "下载中…" else "下载并安装 v${updateInfo.version}",
                        trailing = formatBytes(updateInfo.size),
                        onClick = if (updateDownloading) null else onInstallUpdate,
                    )
                }
                if (updateError != null) {
                    SettingsItem(
                        icon = null,
                        title = updateError,
                        showArrow = false,
                        onClick = onDismissUpdateError,
                    )
                }
            }

            // ---- 危险操作 ----
            SettingsGroup(null) {
                SettingsItem(
                    icon = IconLogout,
                    title = "断开并移除本设备",
                    danger = true,
                    showArrow = false,
                    onClick = { confirmingRemove = true },
                )
            }

            Spacer(Modifier.height(28.dp))
        }
    }

    if (appearancePicker) {
        AlertDialog(
            onDismissRequest = { appearancePicker = false },
            title = { Text("外观") },
            text = {
                Column {
                    Appearance.values().forEach { mode ->
                        TextButton(
                            onClick = {
                                onAppearance(mode)
                                appearancePicker = false
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(
                                text = if (settings.appearance == mode) "✓ ${appearanceLabel(mode)}" else appearanceLabel(mode),
                            )
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { appearancePicker = false }) { Text("关闭") } },
        )
    }

    if (fontPicker) {
        AlertDialog(
            onDismissRequest = { fontPicker = false },
            title = { Text("字号") },
            text = {
                Column {
                    FontSize.values().forEach { size ->
                        TextButton(
                            onClick = {
                                onFontSize(size)
                                fontPicker = false
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(text = if (settings.fontSize == size) "✓ ${fontSizeLabel(size)}" else fontSizeLabel(size))
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { fontPicker = false }) { Text("关闭") } },
        )
    }

    if (confirmingRemove) {
        AlertDialog(
            onDismissRequest = { confirmingRemove = false },
            title = { Text("断开并移除本设备？") },
            text = { Text("会断开与这台电脑的连接，并删除本机保存的配对信息；下次需要重新扫码或粘贴配对链接。电脑端的授权不受影响。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmingRemove = false
                        onRemoveDevice()
                    },
                ) {
                    Text("确认移除", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { confirmingRemove = false }) { Text("取消") } },
        )
    }
}

/** 设置分组卡片（标题可空）。 */
@Composable
private fun SettingsGroup(title: String?, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
        if (title != null) {
            Text(
                text = title,
                style = MaterialTheme.typography.labelSmall,
                color = MpiTheme.colors.textFaint,
                modifier = Modifier.padding(start = 6.dp, top = 18.dp, bottom = 6.dp),
            )
        } else {
            Spacer(Modifier.height(18.dp))
        }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(MpiTheme.colors.surfaceMuted),
            content = content,
        )
    }
}

/** 单个设置项：左侧图标 + 标题 + 右侧当前值/箭头。 */
@Composable
private fun SettingsItem(
    icon: ImageVector?,
    title: String,
    trailing: String? = null,
    danger: Boolean = false,
    showArrow: Boolean = true,
    onClick: (() -> Unit)?,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = onClick != null) { onClick?.invoke() }
            .padding(horizontal = 14.dp, vertical = 15.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (icon != null) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = if (danger) MpiTheme.colors.err else MpiTheme.colors.textDim,
                modifier = Modifier.size(19.dp),
            )
        } else {
            Spacer(Modifier.size(19.dp))
        }
        Text(
            text = title,
            style = MaterialTheme.typography.bodyMedium,
            color = if (danger) MpiTheme.colors.err else MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f),
        )
        if (trailing != null) {
            Text(
                text = trailing,
                style = MaterialTheme.typography.bodySmall,
                color = MpiTheme.colors.textFaint,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(end = 2.dp),
            )
        }
        if (showArrow) {
            Icon(
                imageVector = IconChevronRight,
                contentDescription = null,
                tint = MpiTheme.colors.textFaint,
                modifier = Modifier.size(15.dp),
            )
        }
    }
}

/** 跳到本应用的通知设置页（Android 8+）。 */
private fun openAppNotificationSettings(context: Context) {
    val intent = Intent(AndroidSettings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
        putExtra(AndroidSettings.EXTRA_APP_PACKAGE, context.packageName)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    runCatching { context.startActivity(intent) }
}

/** 清空缓存目录（含照片临时文件与已下载的更新包）；返回释放的字节数，-1 表示失败。 */
private fun clearAppCache(context: Context): Long {
    val dir: File = context.cacheDir
    var freed = 0L
    val entries = dir.listFiles() ?: return 0L
    for (entry in entries) {
        freed += entry.sizeSafe()
        runCatching {
            if (entry.isDirectory) entry.deleteRecursively() else entry.delete()
        }
    }
    return freed
}

private fun File.sizeSafe(): Long = runCatching {
    if (isDirectory) walkBottomUp().filter { it.isFile }.sumOf { it.length() } else length()
}.getOrDefault(0L)

/** 1.5 MB / 820 KB / 512 B。 */
internal fun formatBytes(bytes: Long): String {
    if (bytes <= 0) return "0 B"
    val kb = bytes / 1024.0
    if (kb < 1) return "$bytes B"
    val mb = kb / 1024.0
    return if (mb < 1) "${kb.toInt()} KB" else String.format(java.util.Locale.US, "%.1f MB", mb)
}

/**
 * 诊断页（设计文档 §6）：用户向 AI 反馈问题的主要凭据。
 */
@Composable
fun DiagnosticsScreen(
    state: AppUiState,
    deviceName: String,
    onClose: () -> Unit,
) {
    BackHandler(enabled = true) { onClose() }
    Surface(color = MpiTheme.colors.bg, modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState())) {
            ScreenHeader(title = "诊断", onBack = onClose)
            HorizontalDivider(color = MpiTheme.colors.border)

            val session = state.session
            DiagRow("App 版本", BuildConfig.VERSION_NAME)
            DiagRow("本机设备名", deviceName)
            DiagRow("连接状态", if (session is SessionState.Connected) "已连接" else session.label())
            DiagRow("当前电脑", state.activeHost?.shownName ?: "未选择")
            DiagRow("已配对电脑", "${state.pairings.size} 台")
            DiagRow("项目", state.host.projects.size.toString())
            DiagRow("会话", state.host.allThreads.size.toString())
            DiagRow(
                "当前会话",
                state.thread?.let {
                    "${it.messages.size} 条消息 · ${if (it.ready) "已就绪" else "载入中"}" +
                        (it.summary?.state?.let { s -> " · ${s.label()}" } ?: "")
                } ?: "未打开",
            )
            DiagRow(
                "最近问题",
                if (state.problems.isEmpty()) "无" else state.problems.joinToString("\n"),
                monospace = state.problems.isNotEmpty(),
            )
            Spacer(Modifier.size(24.dp))
        }
    }
}

@Composable
private fun ScreenHeader(title: String, onBack: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(start = 2.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onBack) {
            Icon(IconArrowLeft, contentDescription = "返回", tint = MaterialTheme.colorScheme.onSurface)
        }
        Text(title, style = MaterialTheme.typography.titleMedium)
    }
}

@Composable
private fun DiagRow(label: String, value: String, monospace: Boolean = false) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 7.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MpiTheme.colors.textFaint,
            modifier = Modifier.padding(top = 2.dp),
        )
        Text(
            text = value,
            style = if (monospace) {
                MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)
            } else {
                MaterialTheme.typography.bodySmall
            },
            color = MaterialTheme.colorScheme.onSurface,
            fontWeight = FontWeight.Normal,
            modifier = Modifier.weight(1f),
        )
    }
}
