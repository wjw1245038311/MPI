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
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.mpi.app.AppVisibility
import com.mpi.app.BuildConfig
import com.mpi.app.data.AppSettings
import com.mpi.app.data.Appearance
import com.mpi.app.data.FontSize
import com.mpi.app.data.HomeCache
import com.mpi.app.data.KeepAliveGuide
import com.mpi.app.data.Notifier
import com.mpi.app.data.SessionState
import com.mpi.app.data.ThreadCache
import com.mpi.app.data.UpdateInfo
import com.mpi.app.data.VoiceSpeechContent
import com.mpi.app.ui.theme.MpiTheme
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

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

/** 播报内容的显示名。 */
internal fun voiceContentLabel(content: VoiceSpeechContent): String = when (content) {
    VoiceSpeechContent.Fixed -> "固定语"
    VoiceSpeechContent.Reply -> "回复摘要"
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
    appForeground: Boolean,
    onAppearance: (Appearance) -> Unit,
    onFontSize: (FontSize) -> Unit,
    onNotifyOnTurnComplete: (Boolean) -> Unit,
    onSpeakTurnComplete: (Boolean) -> Unit,
    onVoiceContent: (VoiceSpeechContent) -> Unit,
    onVoiceFixedPhrase: (String) -> Unit,
    onSpeakDuringCall: (Boolean) -> Unit,
    onSpeakInBackground: (Boolean) -> Unit,
    onShowToolCalls: (Boolean) -> Unit,
    onShowThinking: (Boolean) -> Unit,
    onOpenDiagnostics: () -> Unit,
    onRemoveDevice: () -> Unit,
    updateInfo: UpdateInfo?,
    updateChecking: Boolean,
    updateDownloading: Boolean,
    updateError: String?,
    updateNote: String?,
    onCheckUpdate: () -> Unit,
    onInstallUpdate: () -> Unit,
    onDismissUpdateError: () -> Unit,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    var appearancePicker by remember { mutableStateOf(false) }
    var fontPicker by remember { mutableStateOf(false) }
    var voiceContentPicker by remember { mutableStateOf(false) }
    var fixedPhraseDialog by remember { mutableStateOf(false) }
    var keepAliveDialog by remember { mutableStateOf(false) }
    var confirmingRemove by remember { mutableStateOf(false) }
    var cacheNote by remember { mutableStateOf<String?>(null) }

    // 电池优化白名单是**系统状态**，不在 SettingsStore 里。从系统设置页回来时要重算，
    // 否则条目上永远显示离开前的旧值。
    var batteryWhitelisted by remember {
        mutableStateOf(KeepAliveGuide.isIgnoringBatteryOptimizations(context))
    }
    LaunchedEffect(appForeground) {
        if (appForeground) batteryWhitelisted = KeepAliveGuide.isIgnoringBatteryOptimizations(context)
    }

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
                // 「对话完成」提醒：只在**后台/锁屏**且回合是**手机自己发起**时发。
                // 前台盯着屏幕看回复时不打扰；桌面发起的回合也不响（用户确认的口径）。
                SettingsItem(
                    icon = IconCheck,
                    title = "对话完成后通知",
                    trailing = if (settings.notifyOnTurnComplete) "开（仅后台）" else "关",
                    onClick = { onNotifyOnTurnComplete(!settings.notifyOnTurnComplete) },
                )
                // 完成后出声念一句：固定语或回复摘要（见下一条）；
                // 引擎/中文语音包缺失时静默降级为「只发通知」。
                SettingsItem(
                    icon = IconMic,
                    title = "完成后语音播报",
                    trailing = if (settings.speakTurnComplete) "念一句" else "关",
                    onClick = { onSpeakTurnComplete(!settings.speakTurnComplete) },
                )
                // 念什么：固定语最不打扰；回复摘要信息多，但会先去代码围栏、压平空白再截短。
                SettingsItem(
                    icon = null,
                    title = "播报内容",
                    trailing = voiceContentLabel(settings.voiceSpeechContent),
                    onClick = { voiceContentPicker = true },
                )
                // 固定语是模板：{title} 替换为会话标题（截40字）；不写就不念标题。
                SettingsItem(
                    icon = null,
                    title = "固定语内容",
                    trailing = settings.voiceFixedPhrase,
                    onClick = { fixedPhraseDialog = true },
                )
                // 通话中（含微信语音）系统会把 TTS 压掉；开着就是「照样试一把」，不保证出声。
                SettingsItem(
                    icon = null,
                    title = "通话中也播报",
                    trailing = if (settings.speakDuringCall) "开（可能听不到）" else "关",
                    onClick = { onSpeakDuringCall(!settings.speakDuringCall) },
                )
                // 后台/锁屏保活：回合在跑时持 wakelock，防 CPU 睡 / Doze 把播报拖到重连才念。
                SettingsItem(
                    icon = null,
                    title = "后台/锁屏播报",
                    trailing = if (settings.speakInBackground) "开（保持连接）" else "关",
                    onClick = { onSpeakInBackground(!settings.speakInBackground) },
                )
                // 系统白名单：Doze/App Standby 会在后台推迟网络（连 wakelock 也不豁免），
                // 只靠前台服务不够——这是「后台断连、回前台才补播报」的治本项。
                SettingsItem(
                    icon = null,
                    title = "后台保活（推荐开启）",
                    trailing = if (batteryWhitelisted) "已允许电池优化" else "去设置",
                    onClick = { keepAliveDialog = true },
                )
                // 「语言」条目已删：原生端全量中文硬编码，没有任何可选项，
                // 放着只会是个点了没反应的箭头（用户反馈）。要真做 zh/en 得先把
                // 所有界面文案外置，属大改动，需要时再开。
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
                    showDivider = false,
                    onClick = { fontPicker = true },
                )
            }

            // ---- 对话分栏（会话区显示内容）----
            SettingsGroup("对话分栏") {
                // 与会话顶栏的终端图标是同一个设置（都读写 SettingsStore，天然同步）。
                SettingsItem(
                    icon = IconTerminal,
                    title = "显示工具调用",
                    trailing = if (settings.showToolCalls) "开" else "关",
                    onClick = { onShowToolCalls(!settings.showToolCalls) },
                )
                // 隐藏后思考块不渲染；模型正在思考时整条消息暂时不可见，活动指示靠输入条停止钮。
                SettingsItem(
                    icon = null,
                    title = "显示思考过程",
                    trailing = if (settings.showThinking) "开" else "关",
                    showDivider = false,
                    onClick = { onShowThinking(!settings.showThinking) },
                )
            }

            // ---- 缓存 ----
            SettingsGroup("缓存") {
                SettingsItem(
                    icon = IconTrash,
                    title = "清理缓存",
                    trailing = cacheNote,
                    showArrow = false,
                    showDivider = false,
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
                        trailing = downloadTrailing(updateInfo),
                        showDivider = false,
                        onClick = if (updateDownloading) null else onInstallUpdate,
                    )
                }
                if (updateNote != null) {
                    SettingsItem(
                        icon = null,
                        title = updateNote,
                        showArrow = false,
                        showDivider = false,
                        onClick = onDismissUpdateError,
                    )
                }
                if (updateError != null) {
                    SettingsItem(
                        icon = null,
                        title = updateError,
                        showArrow = false,
                        showDivider = false,
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
                    showDivider = false,
                    onClick = { confirmingRemove = true },
                )
            }

            Spacer(Modifier.height(28.dp))
        }
    }

    if (voiceContentPicker) {
        AlertDialog(
            onDismissRequest = { voiceContentPicker = false },
            title = { Text("播报内容") },
            text = {
                Column {
                    VoiceSpeechContent.entries.forEach { content ->
                        TextButton(
                            onClick = {
                                onVoiceContent(content)
                                voiceContentPicker = false
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(
                                text = if (settings.voiceSpeechContent == content) {
                                    "✓ ${voiceContentLabel(content)}"
                                } else {
                                    voiceContentLabel(content)
                                },
                            )
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { voiceContentPicker = false }) { Text("关闭") } },
        )
    }

    if (keepAliveDialog) {
        val vendor = KeepAliveGuide.currentVendor()
        AlertDialog(
            onDismissRequest = { keepAliveDialog = false },
            title = { Text("后台保活设置") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        "系统会在后台限制网络，连接被掉后回复完成的播报要等你打开 App 才补上。" +
                            "请手动放行本应用：",
                    )
                    Text(
                        KeepAliveGuide.vendorHint(vendor),
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        "菜单名随 ROM 版本略有不同。「忽略电池优化」只防 Doze（长时间锁屏），" +
                            "对切后台就断这种情况无效，可以先不做。",
                        color = MpiTheme.colors.textFaint,
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    keepAliveDialog = false
                    // 先试厂商「自启动 / 应用启动管理」页，打不开就回落应用详情页
                    // （自启动 / 后台运行 / 省电策略都在那里）。
                    if (!KeepAliveGuide.openVendorSettings(context)) {
                        runCatching { context.startActivity(KeepAliveGuide.appDetailsSettings(context)) }
                    }
                }) { Text("去放行") }
            },
            dismissButton = {
                TextButton(onClick = {
                    keepAliveDialog = false
                    val intent = if (batteryWhitelisted) {
                        KeepAliveGuide.batteryOptimizationSettings()
                    } else {
                        KeepAliveGuide.requestIgnoreBatteryOptimization(context)
                    }
                    runCatching { context.startActivity(intent) }
                }) { Text("电池优化") }
            },
        )
    }

    if (fixedPhraseDialog) {
        // 每次打开都从当前设置重新起稿（对话框关闭即离开组合，remember 会重置）。
        var draft by remember { mutableStateOf(TextFieldValue(settings.voiceFixedPhrase)) }
        AlertDialog(
            onDismissRequest = { fixedPhraseDialog = false },
            title = { Text("固定语内容") },
            text = {
                Column {
                    OutlinedTextField(
                        value = draft,
                        onValueChange = { draft = it },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        placeholder = { Text(Notifier.DEFAULT_FIXED_PHRASE) },
                    )
                    // 点一下在光标处插入标题占位符（有选区则替换），不用手敲 {title}。
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Surface(
                            onClick = {
                                val chip = "{title}"
                                val start = draft.selection.min
                                val end = draft.selection.max
                                draft = draft.copy(
                                    text = draft.text.substring(0, start) + chip + draft.text.substring(end),
                                    selection = TextRange(start + chip.length),
                                )
                            },
                            shape = RoundedCornerShape(6.dp),
                            color = MaterialTheme.colorScheme.primaryContainer,
                        ) {
                            Text(
                                text = "{title}",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onPrimaryContainer,
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                            )
                        }
                        Text("插入标题占位符", style = MaterialTheme.typography.bodySmall, color = MpiTheme.colors.textFaint)
                    }
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = "支持 {title} 占位符（替换为会话标题，截40字）；没标题时自动去掉——不想要标题就别写它。模板超 ${Notifier.SPEECH_MAX} 字只念前面部分。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MpiTheme.colors.textFaint,
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        onVoiceFixedPhrase(draft.text)
                        fixedPhraseDialog = false
                    },
                    enabled = draft.text.isNotBlank(),
                ) { Text("保存") }
            },
            dismissButton = { TextButton(onClick = { fixedPhraseDialog = false }) { Text("取消") } },
        )
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

/** 设置分组卡片（标题可点击折叠）。 */
@Composable
private fun SettingsGroup(
    title: String?,
    content: @Composable ColumnScope.() -> Unit,
) {
    var expanded by rememberSaveable(title) { mutableStateOf(true) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
        if (title != null) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { expanded = !expanded }
                    .padding(start = 6.dp, end = 6.dp, top = 18.dp, bottom = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.labelSmall,
                    color = MpiTheme.colors.textFaint,
                    modifier = Modifier.weight(1f),
                )
                Icon(
                    imageVector = if (expanded) IconChevronDown else IconChevronRight,
                    contentDescription = if (expanded) "折叠" else "展开",
                    tint = MpiTheme.colors.textFaint,
                    modifier = Modifier.size(14.dp),
                )
            }
        } else {
            Spacer(Modifier.height(18.dp))
        }
        if (expanded) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .background(MpiTheme.colors.surfaceMuted),
                content = content,
            )
        }
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
    /** 底部细分线（分组内最后一项传 false）。 */
    showDivider: Boolean = true,
    onClick: (() -> Unit)?,
) {
    Column(Modifier.fillMaxWidth()) {
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
        if (showDivider) {
            HorizontalDivider(
                color = MpiTheme.colors.border,
                modifier = Modifier.padding(start = 45.dp),
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

/** 「下载并安装」右侧提示：能走增量时显示「增量 x（全量 y）」。 */
internal fun downloadTrailing(info: UpdateInfo, currentVersion: String = BuildConfig.VERSION_NAME): String =
    if (info.patchUsable(currentVersion)) {
        "增量 ${formatBytes(info.patch!!.size)}（全量 ${formatBytes(info.size)}）"
    } else {
        formatBytes(info.size)
    }

/**
 * 存储明细：把「应用数据到底被什么占了」摊开。
 *
 * 起因（2026-09-26）：用户发现应用数据 1.4GB 却看不到明细——系统设置页只给总数。
 * 这里列出各缓存目录与更新残留（后者曾是主要浪费：一版一个 27MB 的 APK）。
 */
private fun buildStorageSummary(context: Context): String {
    fun sizeOf(dir: File?): Long =
        if (dir == null || !dir.exists()) 0L else dir.walkTopDown().filter { it.isFile }.sumOf { it.length() }

    val filesDir = context.filesDir
    val cacheDir = context.cacheDir
    val artifacts = cacheDir.listFiles { file ->
        file.isFile && (file.name.startsWith("update-") || file.name.startsWith("patch-"))
    } ?: emptyArray()
    return buildString {
        appendLine("应用数据 ${formatBytes(sizeOf(filesDir))}")
        appendLine("　会话缓存 ${formatBytes(sizeOf(File(filesDir, ThreadCache.DIR_NAME)))}")
        appendLine("　首页缓存 ${formatBytes(sizeOf(File(filesDir, HomeCache.DIR_NAME)))}")
        append("缓存目录 ${formatBytes(sizeOf(cacheDir))}")
        if (artifacts.isNotEmpty()) {
            append("（更新残留 ${formatBytes(artifacts.sumOf { it.length() })} / ${artifacts.size} 个）")
        }
    }
}

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
    /** 「对话完成」通知的可用性（系统开关 + 渠道）——由调用方查好后传入。 */
    notificationStatus: String,
    onTestNotification: () -> Unit,
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
                "完成通知",
                state.lastTurnNotify ?: "还没判定过（回合结束时才有）",
            )
            DiagRow("通知通道", notificationStatus)
            // 存储明细：系统设置页只给一个总数，看不到是谁占的（真机反馈：1.4GB 不知从哪来）。
            // 递归算目录在 IO 线程，免得堵住首帧。
            val storageContext = LocalContext.current
            val storageSummary by produceState(initialValue = "计算中…") {
                value = withContext(Dispatchers.IO) { buildStorageSummary(storageContext) }
            }
            DiagRow("存储", storageSummary, monospace = true)
            // 测试通知：延时发，用户才有时间切后台/熄屏——测的就是真实场景
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 2.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
            ) {
                Text(
                    text = "测试通知",
                    style = MaterialTheme.typography.labelSmall,
                    color = MpiTheme.colors.textFaint,
                )
                TextButton(onClick = onTestNotification) { Text("12 秒后弹一条") }
            }
            DiagRow(
                "前后台标记",
                "${if (AppVisibility.isForegroundNow()) "现在算前台（会跳过通知）" else "现在算后台（会发通知）"}（" +
                    "${AppVisibility.detail()} · ${AppVisibility.lastChange}）",
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
