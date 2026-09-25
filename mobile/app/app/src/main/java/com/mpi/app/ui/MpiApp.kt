package com.mpi.app.ui

import android.os.Build
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.viewmodel.compose.viewModel
import com.mpi.app.AppContainer
import com.mpi.app.data.Appearance
import com.mpi.app.data.PairingRecord
import com.mpi.app.data.SessionState
import com.mpi.app.ui.theme.MpiTheme
import kotlinx.coroutines.launch

/**
 * 应用根组件：按状态在「初始化 / 存储损坏 / 配对 / 首页」之间切换。
 *
 * 存储损坏时**不自动重置**——清用户数据必须是显式且二次确认的动作。
 */
/**
 * 根组件：读本地设置（外观 / 字号）并注入主题，再交给 [MpiApp]。
 * 主题三选与字号三档都在这里生效——设置页只负责改值。
 */
@Composable
fun MpiAppRoot(container: AppContainer) {
    val settings by container.settingsStore.settings.collectAsState()
    val dark = when (settings.appearance) {
        Appearance.System -> isSystemInDarkTheme()
        Appearance.Light -> false
        Appearance.Dark -> true
    }
    MpiTheme(darkTheme = dark, fontScale = settings.fontSize.scale) {
        MpiApp(container)
    }
}

@Composable
fun MpiApp(container: AppContainer) {
    val viewModel: AppViewModel = viewModel(factory = AppViewModel.factory(container))
    val state by viewModel.ui.collectAsState()
    var hostsOpen by remember { mutableStateOf(false) }
    val settings by container.settingsStore.settings.collectAsState()
    // 回到前台就踢一次重连：长时间后台后连接已死，而自动重连按退避走（最长 30s）——
    // 不等退避就能恢复，用户也就不会再觉得「必须把 App 完全关掉才连得上」。
    val appForeground by container.foreground.collectAsState()
    LaunchedEffect(appForeground) {
        if (appForeground) viewModel.kickConnection()
    }
    var settingsOpen by remember { mutableStateOf(false) }
    var diagnosticsOpen by remember { mutableStateOf(false) }
    var scanOpen by remember { mutableStateOf(false) }
    var searchOpen by remember { mutableStateOf(false) }
    // 从会话返回时自动展开会话列表（抽屉）——「对话即主页」下它就是会话列表
    var drawerSignal by remember { mutableStateOf(0) }
    // 没有会话可开时自动弹一次抽屉（否则只剩空白）；只弹一次，避免关不掉
    var emptyListPrompted by remember { mutableStateOf(false) }
    LaunchedEffect(state.openThreadId, state.host.loading, state.host.projects.size, state.host.allThreads.size) {
        if (emptyListPrompted) return@LaunchedEffect
        val nothingToOpen = state.openThreadId == null && !state.host.loading &&
            state.host.projects.isNotEmpty() && state.host.allThreads.isEmpty()
        if (nothingToOpen) {
            emptyListPrompted = true
            drawerSignal += 1
        }
    }

    // M5：Android 13+ 需要运行时申请通知权限（拒绝也不影响其它功能）
    val notificationPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { }
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    // 通知点击的深链：等连接就绪后打开目标会话，再清掉待打开标记
    val pendingThread by container.pendingThreadOpen.collectAsState()
    LaunchedEffect(pendingThread, state.session) {
        val target = pendingThread ?: return@LaunchedEffect
        if (state.session is SessionState.Connected) {
            container.pendingThreadOpen.value = null
            viewModel.openThread(target)
        }
    }
    // 已授权时 RequestPermission 会立即回调 true
    val cameraPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) scanOpen = true else viewModel.reportPairingError("没有相机权限，无法扫码")
    }

    Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize()) {
        when {
            state.initializing -> LoadingScreen()

            state.storeError != null -> StoreErrorScreen(
                message = state.storeError!!,
                onReset = viewModel::resetLocalData,
            )

            state.showPairing -> {
                // 「添加设备」是二级页：返回键应回到首屏，而不是退出应用（§4.4 逐级回退）
                val cancelAdd = if (state.pairings.isEmpty()) null else viewModel::cancelAddHost
                if (cancelAdd != null) {
                    BackHandler(enabled = true) { cancelAdd() }
                }
                PairingScreen(
                    state = state,
                    onPair = viewModel::pairWithLink,
                    onClearError = viewModel::clearPairingError,
                    onCancel = cancelAdd,
                    onScan = { cameraPermission.launch(android.Manifest.permission.CAMERA) },
                )
            }

            else -> {
                // 侧栏（会话列表）覆盖整个「对话即主页」界面：会话开着时也用它切换，
                // 所以返回键只是打开侧栏、不退出会话（关掉侧栏还在原会话里）；
                // 从会话切到别的会话也走同一条侧栏，不再有中间那个空列表页。
                DrawerHost(
                    state = state,
                    viewModel = viewModel,
                    openDrawerSignal = drawerSignal,
                    onOpenHosts = { hostsOpen = true },
                    onOpenSettings = { settingsOpen = true },
                ) { openDrawer, drawerOpen ->
                    val openThread = state.thread
                    if (state.openThreadId != null && openThread != null) {
                        BackHandler(enabled = !drawerOpen) {
                            if (state.configSheetOpen) viewModel.closeConfigSheet() else openDrawer()
                        }
                        ThreadScreen(
                            view = openThread,
                            projectName = state.host.projects
                                .firstOrNull { it.id == openThread.summary?.projectId }?.name,
                            draft = state.draft,
                            sending = state.sending,
                            responding = state.responding,
                            respondError = state.respondError,
                            onBack = openDrawer,
                            onResync = viewModel::resyncThread,
                            onDraftChange = viewModel::updateDraft,
                            onSend = viewModel::sendDraft,
                            onAbort = viewModel::abortThread,
                            onRetry = viewModel::retrySend,
                            onRespond = { response ->
                                openThread.pendingUi?.let { request ->
                                    viewModel.respondUi(request.id, response)
                                }
                            },
                            onSendChoice = viewModel::sendChoice,
                            onOpenSettings = { settingsOpen = true },
                            onOpenSearch = { searchOpen = true },
                            showToolCalls = settings.showToolCalls,
                            onToggleToolCalls = {
                                container.settingsStore.setShowToolCalls(!settings.showToolCalls)
                            },
                            choiceDrafts = state.choiceDrafts,
                            onChoiceDraftChange = viewModel::setChoiceDraft,
                            onClearChoiceDrafts = viewModel::clearChoiceDrafts,
                            attachments = state.attachments,
                            attachmentBusy = state.attachmentBusy,
                            attachmentError = state.attachmentError,
                            onPickImage = viewModel::addImageAttachment,
                            onPickFile = viewModel::addFileAttachment,
                            onAttachmentPermissionDenied = {
                                viewModel.reportAttachmentError("没有相机权限，无法拍照")
                            },
                            onRemoveAttachment = viewModel::removeAttachment,
                            onDismissAttachmentError = viewModel::dismissAttachmentError,
                            recording = state.recording,
                            transcribing = state.transcribing,
                            voiceError = state.voiceError,
                            onStartVoice = viewModel::startRecording,
                            onStopVoice = viewModel::stopRecording,
                            onCancelVoice = viewModel::cancelRecording,
                            onStartVoiceChat = viewModel::startVoiceChat,
                            onVoicePermissionDenied = {
                                viewModel.reportVoiceError("没有麦克风权限，无法语音输入")
                            },
                            onDismissVoiceError = viewModel::dismissVoiceError,
                            voiceChat = state.voiceChat,
                            voiceChatText = state.voiceChatText,
                            onStopVoiceChat = viewModel::stopVoiceChat,
                            swipeNodePanel = settings.swipeNodePanel,
                            pendingFollowUp = state.pendingFollowUp,
                            sendError = state.sendError,
                            sendNote = state.sendNote,
                            onDismissSendNote = viewModel::dismissSendNote,
                            onSteerPending = viewModel::steerPendingFollowUp,
                            onReEditPending = viewModel::reEditPendingFollowUp,
                            onDismissSendError = viewModel::dismissSendError,
                            configSheetOpen = state.configSheetOpen,
                            configBusy = state.configBusy,
                            configError = state.configError,
                            onOpenConfigSheet = viewModel::openConfigSheet,
                            onDismissConfigSheet = viewModel::closeConfigSheet,
                            onDismissConfigError = viewModel::dismissConfigError,
                            onSetPermission = viewModel::setPermission,
                            onSetModel = viewModel::setModel,
                            onSetThinking = viewModel::setThinking,
                            onSetMode = viewModel::setMode,
                            onCompact = viewModel::compactContext,
                        )
                    } else {
                        HomeScreen(
                            state = state,
                            onOpenDrawer = openDrawer,
                            onRefresh = viewModel::refresh,
                            onReconnect = viewModel::reconnect,
                            onOpenHosts = { hostsOpen = true },
                            onDismissProblems = viewModel::dismissProblems,
                        )
                    }
                }
            }
        }

            // 全屏覆盖层（设置 / 诊断）——不占抽屉，返回键逐级关闭
            if (settingsOpen) {
                SettingsScreen(
                    settings = settings,
                    onAppearance = container.settingsStore::setAppearance,
                    onFontSize = container.settingsStore::setFontSize,
                    onNotifyOnTurnComplete = container.settingsStore::setNotifyOnTurnComplete,
                    onSpeakTurnComplete = container.settingsStore::setSpeakTurnComplete,
                    onVoiceContent = container.settingsStore::setVoiceSpeechContent,
                    onSpeakDuringCall = container.settingsStore::setSpeakDuringCall,
                    onSwipeNodePanel = container.settingsStore::setSwipeNodePanel,
                    onOpenDiagnostics = { diagnosticsOpen = true },
                    onRemoveDevice = {
                        settingsOpen = false
                        state.activeHostId?.let { hostId -> viewModel.removeHost(hostId) }
                    },
                    updateInfo = state.updateInfo,
                    updateChecking = state.updateChecking,
                    updateDownloading = state.updateDownloading,
                    updateError = state.updateError,
                    updateNote = state.updateNote,
                    onCheckUpdate = { viewModel.checkUpdate(manual = true) },
                    onInstallUpdate = viewModel::downloadAndInstallUpdate,
                    onDismissUpdateError = viewModel::dismissUpdateError,
                    onClose = { settingsOpen = false },
                )
            }
            if (diagnosticsOpen) {
                DiagnosticsScreen(
                    state = state,
                    deviceName = container.deviceName,
                    onClose = { diagnosticsOpen = false },
                )
            }
            if (searchOpen) {
                SearchScreen(
                    threads = state.host.allThreads,
                    projectNameOf = { projectId ->
                        state.host.projects.firstOrNull { it.id == projectId }?.name
                    },
                    onOpenThread = { threadId -> viewModel.openThread(threadId) },
                    onClose = { searchOpen = false },
                )
            }
            if (scanOpen) {
                ScanScreen(
                    onResult = { raw ->
                        scanOpen = false
                        val link = normalizePairLink(raw)
                        if (link != null) viewModel.pairWithLink(link)
                        else viewModel.reportPairingError("这不是配对二维码")
                    },
                    onCancel = { scanOpen = false },
                )
            }
        }
    }

    if (hostsOpen) {
        HostsDialog(
            state = state,
            onDismiss = { hostsOpen = false },
            onSwitch = { hostId ->
                viewModel.switchHost(hostId)
                hostsOpen = false
            },
            onRemove = viewModel::removeHost,
            onRename = viewModel::renameHost,
            onAdd = {
                hostsOpen = false
                viewModel.startAddHost()
            },
        )
    }
}

@Composable
private fun DrawerHost(
    state: AppUiState,
    viewModel: AppViewModel,
    openDrawerSignal: Int,
    onOpenHosts: () -> Unit,
    onOpenSettings: () -> Unit,
    content: @Composable (openDrawer: () -> Unit, drawerOpen: Boolean) -> Unit,
) {
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()

    // 打开侧栏（会话列表）：会话页返回键、主页菜单、「从会话回来」都走它
    val openDrawer: () -> Unit = { scope.launch { drawerState.open() } }

    // openDrawerSignal > 0 时自动展开（从会话返回 / 没有会话可开）
    LaunchedEffect(openDrawerSignal) {
        if (openDrawerSignal > 0) drawerState.open()
    }

    // 侧栏开着时返回键先关侧栏（§4.4 返回键语义：逐级回退，不直接退出）
    BackHandler(enabled = drawerState.isOpen) {
        scope.launch { drawerState.close() }
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            // 抽屉宽度：手机上一手能回到对话（用户要求最多占屏宽 2/3）
            ModalDrawerSheet(
                modifier = Modifier.fillMaxWidth(2f / 3f),
                drawerContainerColor = MpiTheme.colors.bg,
            ) {
                AppDrawerContent(
                    state = state,
                    onOpenHosts = onOpenHosts,
                    onRefresh = viewModel::refresh,
                    onOpenThread = { threadId ->
                        scope.launch { drawerState.close() }
                        viewModel.openThread(threadId)
                    },
                    onNewThread = { projectId ->
                        scope.launch { drawerState.close() }
                        viewModel.createThread(projectId)
                    },
                    onRename = viewModel::renameThread,
                    onTogglePin = viewModel::setThreadPinned,
                    onDelete = viewModel::deleteThread,
                )
            }
        },
    ) {
        content(openDrawer, drawerState.isOpen)
    }
}

@Composable
private fun LoadingScreen() {
    Column(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
        Spacer(Modifier.height(12.dp))
        Text("正在加载本地数据…", style = MaterialTheme.typography.bodySmall, color = MpiTheme.colors.textDim)
    }
}

@Composable
private fun StoreErrorScreen(message: String, onReset: () -> Unit) {
    var confirming by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier.fillMaxSize().padding(28.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("本地数据无法读取", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(8.dp))
        Text(
            text = message,
            style = MaterialTheme.typography.bodySmall,
            color = MpiTheme.colors.textDim,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(10.dp))
        Text(
            text = "重置后需要重新配对，电脑端的授权会保留。",
            style = MaterialTheme.typography.bodySmall,
            color = MpiTheme.colors.textFaint,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(18.dp))
        TextButton(onClick = { confirming = true }) {
            Text("重置本地数据", color = MaterialTheme.colorScheme.error, fontWeight = FontWeight.Medium)
        }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("确认重置？") },
            text = { Text("将删除本机保存的全部配对信息与设备身份，且无法撤销。") },
            confirmButton = {
                TextButton(onClick = {
                    confirming = false
                    onReset()
                }) {
                    Text("确认重置", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("取消") } },
        )
    }
}

/** 主机列表（多设备切换 / 移除 / 添加）——M1-5b 会把视觉做细，逻辑先定下来。 */
@Composable
private fun HostsDialog(
    state: AppUiState,
    onDismiss: () -> Unit,
    onSwitch: (String) -> Unit,
    onRemove: (String) -> Unit,
    onRename: (String, String) -> Unit,
    onAdd: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("电脑") },
        text = {
            LazyColumn(modifier = Modifier.fillMaxWidth()) {
                items(state.pairings, key = { it.hostId }) { record ->
                    HostRow(
                        record = record,
                        active = record.hostId == state.activeHostId,
                        onSwitch = { onSwitch(record.hostId) },
                        onRemove = { onRemove(record.hostId) },
                        onRename = { name -> onRename(record.hostId, name) },
                    )
                }
            }
        },
        confirmButton = { TextButton(onClick = onAdd) { Text("添加设备") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
    )
}

@Composable
private fun HostRow(
    record: PairingRecord,
    active: Boolean,
    onSwitch: () -> Unit,
    onRemove: () -> Unit,
    onRename: (String) -> Unit,
) {
    var editing by remember(record.hostId) { mutableStateOf(false) }
    var draftName by remember(record.hostId) { mutableStateOf(record.shownName) }

    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (editing) {
            OutlinedTextField(
                value = draftName,
                onValueChange = { draftName = it },
                modifier = Modifier.weight(1f),
                singleLine = true,
                placeholder = { Text("设备显示名", style = MaterialTheme.typography.bodySmall) },
            )
            TextButton(
                onClick = {
                    editing = false
                    onRename(draftName.trim())
                },
                enabled = draftName.isNotBlank(),
            ) { Text("保存") }
            TextButton(
                onClick = {
                    editing = false
                    draftName = record.shownName
                },
            ) { Text("取消") }
        } else {
            Column(
                modifier = Modifier.weight(1f).clickable(onClick = onSwitch),
            ) {
                Text(
                    text = record.shownName + if (active) "（当前）" else "",
                    style = MaterialTheme.typography.bodyLarge,
                    color = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = record.lastSeenAt?.let { "最近 ${relTime(it)}" } ?: "未连接过",
                    style = MaterialTheme.typography.labelSmall,
                    color = MpiTheme.colors.textFaint,
                )
            }
            TextButton(onClick = { editing = true }) { Text("改名") }
            TextButton(onClick = onRemove) { Text("移除") }
        }
    }
}
