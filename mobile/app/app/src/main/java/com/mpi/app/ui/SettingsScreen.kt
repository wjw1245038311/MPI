package com.mpi.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.mpi.app.BuildConfig
import com.mpi.app.data.AppSettings
import com.mpi.app.data.Appearance
import com.mpi.app.data.FontSize
import com.mpi.app.data.UpdateInfo
import com.mpi.app.ui.theme.MpiTheme

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
 * 设置页（设计文档 §6）：外观 / 字号 / 诊断入口 / 关于。
 *
 * 只放**已经能起作用**的项——语音、通知、检查更新分别属 M4/M5/M6，放上去点了没反应
 * 违反 §1.1，所以这里不放。
 */
@Composable
fun SettingsScreen(
    settings: AppSettings,
    onAppearance: (Appearance) -> Unit,
    onFontSize: (FontSize) -> Unit,
    onOpenDiagnostics: () -> Unit,
    updateInfo: UpdateInfo?,
    updateChecking: Boolean,
    updateDownloading: Boolean,
    updateError: String?,
    onCheckUpdate: () -> Unit,
    onInstallUpdate: () -> Unit,
    onDismissUpdateError: () -> Unit,
    onClose: () -> Unit,
) {
    BackHandler(enabled = true) { onClose() }
    Surface(color = MpiTheme.colors.bg, modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            ScreenHeader(title = "设置", onBack = onClose)
            HorizontalDivider(color = MpiTheme.colors.border)

            SectionTitle("外观")
            Appearance.values().forEach { mode ->
                SettingsRow(
                    label = appearanceLabel(mode),
                    active = settings.appearance == mode,
                    onClick = { onAppearance(mode) },
                )
            }

            SectionTitle("字号")
            FontSize.values().forEach { size ->
                SettingsRow(
                    label = fontSizeLabel(size),
                    active = settings.fontSize == size,
                    onClick = { onFontSize(size) },
                )
            }

            SectionTitle("诊断")
            SettingsRow(
                label = "连接状态与版本",
                note = "出问题时把这里的内容给我或 AI 看",
                onClick = onOpenDiagnostics,
            )

            SectionTitle("关于")
            SettingsRow(label = "MPI 手机端", note = "版本 ${BuildConfig.VERSION_NAME}", onClick = null)
            SettingsRow(
                label = if (updateChecking) "检查更新中…" else "检查更新",
                note = updateInfo?.let { "发现新版本 v${it.version}" },
                onClick = if (updateChecking) null else onCheckUpdate,
            )
            if (updateInfo != null) {
                SettingsRow(
                    label = if (updateDownloading) "下载中…" else "下载并安装 v${updateInfo.version}",
                    note = "安装时系统会询问是否允许安装未知应用",
                    onClick = if (updateDownloading) null else onInstallUpdate,
                )
            }
            if (updateError != null) {
                SettingsRow(
                    label = updateError,
                    onClick = onDismissUpdateError,
                )
            }
            Spacer(Modifier.size(24.dp))
        }
    }
}

/**
 * 诊断页（设计文档 §6）：用户向 AI 反馈问题的主要凭据。
 *
 * 不做 `?dbg=1` 那种 URL 开关——直接是设置页里的独立页面，随时可开。
 */
@Composable
fun DiagnosticsScreen(
    state: AppUiState,
    deviceName: String,
    onClose: () -> Unit,
) {
    BackHandler(enabled = true) { onClose() }
    Surface(color = MpiTheme.colors.bg, modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            ScreenHeader(title = "诊断", onBack = onClose)
            HorizontalDivider(color = MpiTheme.colors.border)

            val session = state.session
            DiagRow("App 版本", BuildConfig.VERSION_NAME)
            DiagRow("本机设备名", deviceName)
            DiagRow("连接状态", if (session is com.mpi.app.data.SessionState.Connected) "已连接" else session.label())
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
private fun SectionTitle(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelSmall,
        color = MpiTheme.colors.textFaint,
        modifier = Modifier.padding(start = 18.dp, end = 18.dp, top = 16.dp, bottom = 4.dp),
    )
}

@Composable
private fun SettingsRow(
    label: String,
    note: String? = null,
    active: Boolean = false,
    onClick: (() -> Unit)?,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 1.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(if (active) MpiTheme.colors.accentSoft else androidx.compose.ui.graphics.Color.Transparent)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 12.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyMedium)
            if (note != null) {
                Text(note, style = MaterialTheme.typography.labelSmall, color = MpiTheme.colors.textFaint)
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
                MaterialTheme.typography.bodySmall.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace)
            } else {
                MaterialTheme.typography.bodySmall
            },
            color = MaterialTheme.colorScheme.onSurface,
            fontWeight = FontWeight.Normal,
            modifier = Modifier.weight(1f),
        )
    }
}
