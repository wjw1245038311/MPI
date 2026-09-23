package com.mpi.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
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
import androidx.lifecycle.viewmodel.compose.viewModel
import com.mpi.app.AppContainer
import com.mpi.app.data.PairingRecord
import com.mpi.app.ui.theme.MpiTheme
import kotlinx.coroutines.launch

/**
 * 应用根组件：按状态在「初始化 / 存储损坏 / 配对 / 首页」之间切换。
 *
 * 存储损坏时**不自动重置**——清用户数据必须是显式且二次确认的动作。
 */
@Composable
fun MpiApp(container: AppContainer) {
    val viewModel: AppViewModel = viewModel(factory = AppViewModel.factory(container))
    val state by viewModel.ui.collectAsState()
    var hostsOpen by remember { mutableStateOf(false) }

    Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize()) {
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
                )
            }

            else -> {
                val openThread = state.thread
                if (state.openThreadId != null && openThread != null) {
                    // 会话页返回键回到首屏（§4.4 逐级回退）
                    BackHandler(enabled = true) { viewModel.closeThread() }
                    ThreadScreen(
                        view = openThread,
                        projectName = state.host.projects
                            .firstOrNull { it.id == openThread.summary?.projectId }?.name,
                        draft = state.draft,
                        sending = state.sending,
                        responding = state.responding,
                        respondError = state.respondError,
                        onBack = viewModel::closeThread,
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
                    )
                } else {
                    HomeWithDrawer(
                        state = state,
                        viewModel = viewModel,
                        onOpenHosts = { hostsOpen = true },
                    )
                }
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
            onAdd = {
                hostsOpen = false
                viewModel.startAddHost()
            },
        )
    }
}

@Composable
private fun HomeWithDrawer(
    state: AppUiState,
    viewModel: AppViewModel,
    onOpenHosts: () -> Unit,
) {
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()

    // 抽屉开着时返回键先关抽屉（§4.4 返回键语义：逐级回退，不直接退出）
    BackHandler(enabled = drawerState.isOpen) {
        scope.launch { drawerState.close() }
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            ModalDrawerSheet(drawerContainerColor = MpiTheme.colors.bg) {
                AppDrawerContent(
                    state = state,
                    onOpenHosts = onOpenHosts,
                    onAddHost = {
                        scope.launch { drawerState.close() }
                        viewModel.startAddHost()
                    },
                    onRefresh = viewModel::refresh,
                    onOpenThread = { threadId ->
                        scope.launch { drawerState.close() }
                        viewModel.openThread(threadId)
                    },
                )
            }
        },
    ) {
        HomeScreen(
            state = state,
            onOpenDrawer = { scope.launch { drawerState.open() } },
            onRefresh = viewModel::refresh,
            onReconnect = viewModel::reconnect,
            onOpenHosts = onOpenHosts,
            onAddHost = viewModel::startAddHost,
            onDismissProblems = viewModel::dismissProblems,
            onOpenThread = { threadId ->
                viewModel.openThread(threadId)
                scope.launch { drawerState.close() }
            },
        )
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
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
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
        TextButton(onClick = onRemove) { Text("移除") }
    }
}
