package com.mpi.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import com.mpi.app.AppContainer
import com.mpi.app.AppVisibility
import com.mpi.app.data.Attachment
import com.mpi.app.data.AttachmentLoader
import com.mpi.app.data.HostRepository
import com.mpi.app.data.HostSession
import com.mpi.app.data.HostSnapshot
import com.mpi.app.data.HomeCache
import com.mpi.app.data.KeyStore
import com.mpi.app.data.Notifier
import com.mpi.app.data.KeyStoreCorruptException
import com.mpi.app.data.Pairing
import com.mpi.app.data.PairingRecord
import com.mpi.app.data.PairingStage
import com.mpi.app.data.RelayClient
import com.mpi.app.data.Requester
import com.mpi.app.data.SessionState
import com.mpi.app.data.SendMode
import com.mpi.app.data.SettingsStore
import com.mpi.app.data.Speaker
import com.mpi.app.data.ThreadActions
import com.mpi.app.data.ThreadCache
import com.mpi.app.data.ThreadSession
import com.mpi.app.data.ThreadView
import com.mpi.app.data.UpdateInfo
import com.mpi.app.data.UpdateCheckResult
import com.mpi.app.data.Updater
import com.mpi.app.data.VoiceRecorder
import com.mpi.app.protocol.DeviceIdentity
import com.mpi.app.protocol.PairingLink
import com.mpi.app.protocol.PairingLinkException
import com.mpi.app.protocol.RemotePermission
import com.mpi.app.protocol.BlockType
import com.mpi.app.protocol.MessageBlock
import com.mpi.app.protocol.RemoteThreadState
import com.mpi.app.protocol.createDeviceIdentity
import com.mpi.app.protocol.randomSeedB64u
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** 配对进行中的状态（null = 没在配对）。 */
data class PairingUi(
    val stage: PairingStage = PairingStage.Connecting,
)

/**
 * 主机把本条**回退成 followUp 排队**时的提示（纯函数，可单测）。
 *
 * 手机端的 running 状态滞后于主机：裸 prompt 撞上运行中的回合会被 pi 拒绝，
 * 主机自动回退 followUp 并把 `queuedAs: "followUp"` 随响应带回。不提示的话，
 * 气泡会一直停在「发送中…」，看上去像卡死了（真机反馈）。
 */
internal fun queuedNoteOf(response: kotlinx.serialization.json.JsonElement?): String? =
    if ((response as? JsonObject)?.get("queuedAs")?.jsonPrimitive?.contentOrNull == "followUp") {
        "当前任务还在跑，这条已排队，跑完自动发送"
    } else {
        null
    }

data class AppUiState(
    val initializing: Boolean = true,
    val pairings: List<PairingRecord> = emptyList(),
    val activeHostId: String? = null,
    val session: SessionState = SessionState.Disconnected,
    val host: HostSnapshot = HostSnapshot(),
    val pairing: PairingUi? = null,
    val pairingError: String? = null,
    /** 用户主动点了「添加设备」，此时强制显示配对页。 */
    val addingHost: Boolean = false,
    /** 本地存储损坏：需要用户显式决定是否重置（绝不静默清空）。 */
    val storeError: String? = null,
    /** 非致命问题的最近若干条（解密失败等），可关闭。 */
    val problems: List<String> = emptyList(),
    /**
     * 最近一次「对话完成」通知的判定结果（诊断页展示）。
     * 例如「已通知 + 语音」/「跳过：App 在前台」——「设了却没收到」一类问题不用猜。
     */
    val lastTurnNotify: String? = null,
    /** 当前打开的会话（null = 在首屏）。 */
    val openThreadId: String? = null,
    val thread: ThreadView? = null,
    /** 输入框草稿（按会话保存）。 */
    val draft: String = "",
    /** 正在发送（避免重复点发送）。 */
    val sending: Boolean = false,
    /** 正在提交审批回应。 */
    val responding: Boolean = false,
    /** 审批回应失败的原因（卡片不消失，显示在卡片内）。 */
    val respondError: String? = null,
    /** 会话配置面板是否打开（模型/用量/模式/权限都在里面）。 */
    val configSheetOpen: Boolean = false,
    /** 会话配置写操作进行中（模型切换可能耗时）。 */
    val configBusy: Boolean = false,
    /** 会话配置写操作失败原因（Sheet 内与 chip 行下方都要显示）。 */
    val configError: String? = null,
    /** 运行中发送 → 本地暂存为「待处理后续」（null = 无）；回合结束后自动投递。 */
    val pendingFollowUp: String? = null,
    /** 发送 / 停止失败文案（贴输入框显示，不静默失败）。 */
    val sendError: String? = null,
    /** 主机把本条回退成 followUp 排队时的说明（非错误，只是告知为什么气泡还在发送中）。 */
    val sendNote: String? = null,
    /** 正在新建会话的项目 id（非 null = 进行中，用于禁用重复点击）。 */
    val creatingThread: String? = null,
    /** 待发送的附件（最多 3 个，图片已压缩）。 */
    val attachments: List<Attachment> = emptyList(),
    /** 正在读取/压缩附件。 */
    val attachmentBusy: Boolean = false,
    /** 附件读取失败原因（可关闭）。 */
    val attachmentError: String? = null,
    /** 正在录音（原生 AudioRecord）。 */
    val recording: Boolean = false,
    /** 正在把录音送去识别。 */
    val transcribing: Boolean = false,
    /** 语音输入失败原因（可关闭）。 */
    val voiceError: String? = null,
    /** 有可用新版本（null = 已是最新或未检查）。 */
    val updateInfo: UpdateInfo? = null,
    val updateChecking: Boolean = false,
    val updateDownloading: Boolean = false,
    /** 检查/下载/安装失败或提示（可关闭）。 */
    val updateError: String? = null,
    /** 成功走增量时的提示。 */
    val updateNote: String? = null,
    /** 会话元数据操作（重命名 / 置顶 / 删除）进行中。 */
    val threadActionBusy: Boolean = false,
    /**
     * choices 面板的未发送草稿（key = "threadId|messageId|blockIndex|questionIndex"）。
     * 提升到 ViewModel：切走会话再回来时不丢勾选（PWA 用 localStorage，比这里更久）。
     */
    val choiceDrafts: Map<String, ChoiceAnswer> = emptyMap(),
) {
    val activeHost: PairingRecord?
        get() = pairings.firstOrNull { it.hostId == activeHostId }

    val showPairing: Boolean
        get() = pairings.isEmpty() || addingHost
}

/**
 * 应用级状态机（M1-5）：持有设备身份、配对记录、主机会话与数据仓库，
 * 对 UI 只暴露一个 [AppUiState]。
 *
 * 生命周期：会话/仓库由本类创建与销毁（[onCleared]），它们都挂在传入的 [scope] 上。
 */
class AppViewModel(
    private val keyStore: KeyStore,
    private val settingsStore: SettingsStore,
    private val scope: CoroutineScope,
    private val deviceName: String,
    private val attachmentLoader: AttachmentLoader,
    private val voiceRecorder: VoiceRecorder,
    private val notifier: Notifier,
    private val speaker: Speaker,
    private val updater: Updater,
    private val threadCache: ThreadCache,
    private val homeCache: HomeCache,
    /** 通知深链待打开的会话；非空时不要抢自动打开。 */
    private val pendingThreadOpen: StateFlow<String?>,
) : ViewModel() {

    private val _ui = MutableStateFlow(AppUiState())
    val ui: StateFlow<AppUiState> = _ui.asStateFlow()

    private var identity: DeviceIdentity? = null
    private var session: HostSession? = null
    private var requester: Requester? = null
    private var repository: HostRepository? = null
    private var threadSession: ThreadSession? = null
    private var threadActions: ThreadActions? = null
    /**
     * 本回合是**手机自己发起**的吗？发送成功后置起，回合结束时消费掉。
     * 「对话完成」通知只对手机发起的回合发——桌面发起的没必要响（见 [notifyTurnComplete]）。
     */
    private var phoneTurnStarted = false
    /** 重连后的会话重同步 Job（合并多次 Connected 回调，避免重复拉全量快照）。 */
    private var reconnectSyncJob: Job? = null
    /** 按会话保存的草稿（内存；跨重启持久化留待需要时再说）。 */
    private val drafts = mutableMapOf<String, String>()
    /**
     * 「对话即主页」：每次 attach 只自动开一次会话；
     * 用户自己开过（或通知深链开过）就不再掠。
     */
    private var autoOpenedThread = false
    private var unsubscribeProblems: (() -> Unit)? = null
    private val jobs = mutableListOf<Job>()

    init {
        scope.launch { initialize() }
    }

    // ---- 启动 ----

    private suspend fun initialize() {
        try {
            val stored = keyStore.getDevice()
                ?: com.mpi.app.data.DeviceRecord(seedB64url = randomSeedB64u(), name = deviceName)
                    .also { keyStore.saveDevice(it) }
            identity = createDeviceIdentity(stored.seedB64url)

            val pairings = keyStore.listPairings().sortedByDescending { it.sortKey }
            _ui.update { it.copy(initializing = false, pairings = pairings, storeError = null) }

            // 自动重连最近用过的那台主机
            pairings.firstOrNull()?.let { attach(it) }
        } catch (e: KeyStoreCorruptException) {
            _ui.update { it.copy(initializing = false, storeError = e.message ?: "本地数据无法解密") }
        } catch (e: Exception) {
            // 本地存储读写失败：把上下文说清楚（原始异常消息往往是英文平台文案）
            _ui.update {
                it.copy(
                    initializing = false,
                    pairingError = "本地数据读写失败：${e.message ?: e::class.java.simpleName}",
                )
            }
        }
    }

    // ---- 配对 ----

    fun pairWithLink(link: String) {
        scope.launch {
            _ui.update { it.copy(pairing = PairingUi(PairingStage.Connecting), pairingError = null) }
            var pairingClient: RelayClient? = null
            try {
                val payload = PairingLink.parse(link)
                val relayUrl = payload.relayUrl?.takeIf { it.isNotBlank() }
                    ?: throw PairingLinkException("配对码里没有中继地址，请用桌面端生成的二维码/链接")
                if (payload.isExpired()) {
                    throw PairingLinkException("配对码已过期，请在桌面端重新生成")
                }
                val deviceIdentity = identity ?: throw PairingLinkException("设备身份尚未就绪，请稍后重试")

                val client = RelayClient(relayUrl)
                pairingClient = client
                val result = Pairing.run(
                    client = client,
                    hostId = payload.hostId,
                    ticket = payload.ticket,
                    identity = deviceIdentity,
                    deviceName = deviceName,
                    onStage = { stage ->
                        _ui.update { state -> state.copy(pairing = PairingUi(stage)) }
                    },
                )

                val now = System.currentTimeMillis()
                val record = PairingRecord(
                    hostId = payload.hostId,
                    relayUrl = relayUrl,
                    deviceId = deviceIdentity.deviceId,
                    deviceToken = result.deviceToken,
                    hostX25519PubB64u = result.hostX25519PubB64u,
                    pairedAt = now,
                    hostName = payload.hostName,
                    lastSeenAt = now,
                )
                keyStore.savePairing(record)
                val pairings = keyStore.listPairings().sortedByDescending { it.sortKey }
                _ui.update { it.copy(pairing = null, pairings = pairings, addingHost = false, pairingError = null) }
                attach(record)
            } catch (e: Exception) {
                _ui.update { it.copy(pairing = null, pairingError = e.message ?: "配对失败") }
            } finally {
                // 配对用的这条连接随之关闭；正式会话由 attach() 另建一条
                pairingClient?.close()
            }
        }
    }

    // ---- 主机管理 ----

    fun switchHost(hostId: String) {
        val record = _ui.value.pairings.firstOrNull { it.hostId == hostId } ?: return
        // attach 会读首页缓存（磁盘 IO），放后台线程，别卡主线程
        scope.launch { attach(record) }
    }

    fun removeHost(hostId: String) {
        scope.launch {
            keyStore.deletePairing(hostId)
            // 配对凭证没了，本地缓存也不该留着（重新配对后看到旧内容会很困惑）
            threadCache.deleteHost(hostId)
            homeCache.deleteHost(hostId)
            val pairings = keyStore.listPairings().sortedByDescending { it.sortKey }
            _ui.update { it.copy(pairings = pairings) }
            if (_ui.value.activeHostId == hostId) {
                detachSession()
                _ui.update { it.copy(activeHostId = null, session = SessionState.Disconnected, host = HostSnapshot()) }
                pairings.firstOrNull()?.let { attach(it) }
            }
        }
    }

    fun renameHost(hostId: String, displayName: String) {
        scope.launch {
            // 从存储读最新记录再改，避免用 UI 快照覆盖掉期间更新的字段（如 lastSeenAt）
            val current = keyStore.getPairing(hostId) ?: return@launch
            keyStore.savePairing(current.copy(displayName = displayName.trim().ifEmpty { null }))
            _ui.update { it.copy(pairings = keyStore.listPairings().sortedByDescending { r -> r.sortKey }) }
        }
    }

    fun startAddHost() = _ui.update { it.copy(addingHost = true, pairingError = null) }

    fun cancelAddHost() = _ui.update { it.copy(addingHost = false, pairingError = null) }

    fun clearPairingError() = _ui.update { it.copy(pairingError = null) }

    fun dismissProblems() = _ui.update { it.copy(problems = emptyList()) }

    // ---- 自更新（M6）----

    /**
     * 检查更新。manual=true 时失败了要说清楚（用户主动点的）；
     * 自动检查静默——没更新就是没更新，不该弹任何东西。
     */
    fun checkUpdate(manual: Boolean) {
        val relay = _ui.value.activeHost?.relayUrl
        if (relay.isNullOrBlank()) {
            // 用户主动点的：没连上电脑也要说一声，不能点了没反应
            if (manual) _ui.update { it.copy(updateError = "还没有连接电脑，先配对再检查更新") }
            return
        }
        if (_ui.value.updateChecking) return
        _ui.update { it.copy(updateChecking = true, updateError = null) }
        scope.launch {
            when (val result = updater.check(relay)) {
                is UpdateCheckResult.Available ->
                    _ui.update { it.copy(updateChecking = false, updateInfo = result.info, updateError = null) }

                UpdateCheckResult.UpToDate ->
                    _ui.update {
                        it.copy(
                            updateChecking = false,
                            updateInfo = null,
                            updateError = if (manual) {
                                "已是最新版本（v${com.mpi.app.BuildConfig.VERSION_NAME}）"
                            } else {
                                null
                            },
                        )
                    }

                is UpdateCheckResult.Failed ->
                    _ui.update {
                        it.copy(
                            updateChecking = false,
                            updateError = if (manual) "检查更新失败：${result.reason}" else null,
                        )
                    }
            }
        }
    }

    /** 下载并调起系统安装器。 */
    fun downloadAndInstallUpdate() {
        val info = _ui.value.updateInfo ?: return
        if (_ui.value.updateDownloading) return
        _ui.update { it.copy(updateDownloading = true, updateError = null) }
        scope.launch {
            updater.download(info)
                .onSuccess { result ->
                    _ui.update {
                        it.copy(
                            updateDownloading = false,
                            updateNote = if (result.viaPatch) "已用增量包（省流量）" else null,
                        )
                    }
                    runCatching { updater.install(result.file) }.onFailure { error ->
                        _ui.update { it.copy(updateError = error.message ?: "无法调起安装器") }
                    }
                }
                .onFailure { error ->
                    _ui.update { it.copy(updateDownloading = false, updateError = error.message ?: "下载失败") }
                }
        }
    }

    fun dismissUpdateError() = _ui.update { it.copy(updateError = null, updateNote = null) }

    // ---- 会话元数据操作（长按菜单）----

    /** 重命名会话。主机要求写租约，所以先 claim 再发。 */
    fun renameThread(threadId: String, name: String) {
        val trimmed = name.trim()
        if (trimmed.isEmpty() || _ui.value.threadActionBusy) return
        runThreadAction(
            claim = threadId,
            type = "thread.rename",
            payload = kotlinx.serialization.json.buildJsonObject { put("name", trimmed) },
            threadId = threadId,
            failure = "重命名失败",
        )
    }

    /** 置顶 / 取消置顶（不需要写租约）。 */
    fun setThreadPinned(threadId: String, pinned: Boolean) {
        if (_ui.value.threadActionBusy) return
        _ui.update { it.copy(threadActionBusy = true) }
        scope.launch {
            runCatching {
                requester?.request(
                    "thread.setPinned",
                    kotlinx.serialization.json.buildJsonObject { put("pinned", pinned) },
                    threadId = threadId,
                )
            }.onSuccess {
                // 置顶态由主机在列表里如实返回，本地不再维护影子状态
                _ui.update { it.copy(threadActionBusy = false) }
                repository?.refresh()
            }.onFailure { error ->
                val message = error.message ?: "置顶失败"
                // 复用首页的问题横幅：手机端没有 toast，静默失败是硬规矩禁止的
                _ui.update { it.copy(threadActionBusy = false, problems = (it.problems + message).takeLast(MAX_PROBLEMS)) }
            }
        }
    }

    /** 删除会话（主机移入回收站；正在看这个会话就先关掉）。 */
    fun deleteThread(threadId: String) {
        if (_ui.value.threadActionBusy) return
        runThreadAction(
            claim = threadId,
            type = "thread.delete",
            payload = kotlinx.serialization.json.buildJsonObject { },
            threadId = threadId,
            failure = "删除失败",
            onSuccess = { if (_ui.value.openThreadId == threadId) closeThread() },
        )
    }

    // ---- choices 面板草稿 ----

    fun setChoiceDraft(key: String, answer: ChoiceAnswer?) {
        _ui.update { state ->
            val next = state.choiceDrafts.toMutableMap()
            if (answer == null) next.remove(key) else next[key] = answer
            state.copy(choiceDrafts = next)
        }
    }

    /** 发送成功后清掉该面板的草稿（前缀 = threadId|messageId|blockIndex）。 */
    fun clearChoiceDrafts(prefix: String) {
        _ui.update { state ->
            state.copy(choiceDrafts = state.choiceDrafts.filterKeys { !it.startsWith(prefix) })
        }
    }

    /** 元数据写操作的公共外壳：可选先拿写租约 → 发请求 → 刷新列表。 */
    private fun runThreadAction(
        claim: String?,
        type: String,
        payload: kotlinx.serialization.json.JsonObject,
        threadId: String,
        failure: String,
        onSuccess: () -> Unit = {},
    ) {
        val requesterRef = requester ?: return
        _ui.update { it.copy(threadActionBusy = true) }
        scope.launch {
            runCatching {
                if (claim != null) {
                    requesterRef.request("thread.claimWrite", kotlinx.serialization.json.buildJsonObject { }, threadId = claim)
                }
                requesterRef.request(type, payload, threadId = threadId)
            }.onSuccess {
                _ui.update { it.copy(threadActionBusy = false) }
                onSuccess()
                repository?.refresh()
            }.onFailure { error ->
                val message = error.message ?: failure
                _ui.update { it.copy(threadActionBusy = false, problems = (it.problems + message).takeLast(MAX_PROBLEMS)) }
            }
        }
    }

    /** 知道了：收起「已排队」提示。 */
    fun dismissSendNote() = _ui.update { it.copy(sendNote = null) }

    /** UI 侧上报配对问题（扫码结果不是配对码 / 相机权限被拒）——不静默。 */
    fun reportPairingError(message: String) = _ui.update { it.copy(pairingError = message) }

    // ---- 会话 ----

    /** 打开一个会话：订阅快照并开始接收事件流。 */
    fun openThread(threadId: String) {
        val transport = session ?: return
        val requesterRef = requester ?: return
        // 用户/自动已经进过会话 —— 不再自动打开别的
        autoOpenedThread = true
        closeThread()

        val threadSessionLocal = ThreadSession(
            threadId = threadId,
            transport = transport,
            request = { type, payload, tid -> requesterRef.request(type, payload, threadId = tid) },
            scope = scope,
            onProblem = { problem ->
                _ui.update { state ->
                    state.copy(problems = (state.problems.filterNot { it == problem } + problem).takeLast(MAX_PROBLEMS))
                }
            },
            // 每次拿到实时快照就写本地缓存：下次打开先用它秒开（断网也能看）
            onSnapshot = { payload ->
                val hostId = _ui.value.activeHostId
                if (hostId != null) threadCache.write(hostId, threadId, payload)
            },
        )
        threadSession = threadSessionLocal
        threadActions = ThreadActions(
            threadId = threadId,
            request = { type, payload, tid, timeoutMs -> requesterRef.request(type, payload, threadId = tid, timeoutMs = timeoutMs) },
        )
        _ui.update {
            it.copy(
                openThreadId = threadId,
                thread = ThreadView(threadId),
                draft = drafts[threadId].orEmpty(),
            )
        }

        jobs += scope.launch {
            var lastPendingId: String? = null
            threadSessionLocal.view.collect { view ->
                val wasRunning = _ui.value.thread?.running == true
                _ui.update { it.copy(thread = view) }
                // 回合结束（running true→false）：投递暂存的「待处理后续」（与 PWA 同语义）
                if (wasRunning && !view.running) {
                    // 顺序不能反：先判定通知（它会消费 phoneTurnStarted），
                    // 再 flushPendingFollowUp()——后者内部的 send() 会把标记重新置起。
                    notifyTurnComplete(threadId, view)
                    flushPendingFollowUp()
                }
                // 审批提醒（M5）：请求出现就通知，消失就撤销
                val pendingId = view.pendingUi?.id
                if (pendingId != null && pendingId != lastPendingId) {
                    notifier.notifyApproval(threadId, view.summary?.title)
                } else if (pendingId == null && lastPendingId != null) {
                    notifier.cancelApproval()
                }
                lastPendingId = pendingId
            }
        }
        jobs += scope.launch {
            // 先用本地缓存预热：立刻上屏（秒开），断网时也看得到上次的内容；
            // 紧接着 subscribe() 拿实时快照替换（成功即 cachedAt 清空）
            val hostId = _ui.value.activeHostId
            if (hostId != null) {
                threadCache.read(hostId, threadId)?.let { cached ->
                    threadSessionLocal.prime(cached.payload, cached.savedAt)
                }
            }
            runCatching { threadSessionLocal.subscribe() }.onFailure { error ->
                _ui.update {
                    it.copy(thread = it.thread?.copy(ready = true, errorBanner = error.message ?: "订阅失败"))
                }
            }
        }
    }

    fun closeThread() {
        _ui.value.openThreadId?.let { drafts[it] = _ui.value.draft }
        reconnectSyncJob?.cancel()
        reconnectSyncJob = null
        threadSession?.detach()
        threadSession = null
        threadActions = null
        _ui.update { it.copy(openThreadId = null, thread = null, draft = "", sending = false, responding = false, respondError = null, configSheetOpen = false, configBusy = false, configError = null, pendingFollowUp = null, sendError = null, attachments = emptyList(), attachmentBusy = false, attachmentError = null, recording = false, transcribing = false, voiceError = null) }
    }

    /** 手动重新同步（错误横幅上的按钮）。 */
    fun resyncThread() {
        scope.launch { runCatching { threadSession?.resync() } }
    }

    // ---- 发送控制 ----

    fun updateDraft(text: String) {
        _ui.value.openThreadId?.let { drafts[it] = text }
        _ui.update { it.copy(draft = text, sendError = null) }
    }

    /**
     * 发送草稿（对齐 PWA 语义）：
     * - 空闲 → prompt（立即开回合）
     * - 运行中且无暂存 → 存为「待处理后续」，回合结束自动投递
     * - 运行中且已有暂存 → 本条 followUp 进 pi 队列（再排一条）
     */
    fun sendDraft() {
        val text = _ui.value.draft.trim()
        val hasAttachments = _ui.value.attachments.isNotEmpty()
        if ((text.isEmpty() && !hasAttachments) || _ui.value.sending) return
        _ui.update { it.copy(sendError = null) }
        if (_ui.value.thread?.running == true) {
            // 暂存只支持文本；带附件时直接排队（避免附件在暂存态里丢失）
            if (_ui.value.pendingFollowUp == null && !hasAttachments) {
                _ui.value.openThreadId?.let { drafts[it] = "" }
                _ui.update { it.copy(pendingFollowUp = text, draft = "") }
                return
            }
            send(text, SendMode.FollowUp)
            return
        }
        send(text, SendMode.Prompt)
    }

    /** ⚡「立即插入」：把暂存的后续打断当前回合马上发（steer）。 */
    fun steerPendingFollowUp() {
        val text = _ui.value.pendingFollowUp ?: return
        _ui.update { it.copy(pendingFollowUp = null) }
        send(text, SendMode.Steer)
    }

    /** ✎ 取回输入框重新编辑。 */
    fun reEditPendingFollowUp() {
        val text = _ui.value.pendingFollowUp ?: return
        _ui.value.openThreadId?.let { drafts[it] = text }
        _ui.update { it.copy(pendingFollowUp = null, draft = text) }
    }

    fun dismissSendError() = _ui.update { it.copy(sendError = null) }

    /**
     * 提交 choices 面板的选择（已是完整的组合消息）。
     * 路由与桌面端 sendPrompt 一致：运行中 → followUp（排队）；空闲 → prompt。
     * 不清输入框草稿（用户可能正写着别的内容）。
     */
    fun sendChoice(text: String) {
        val trimmed = text.trim()
        if (trimmed.isEmpty() || _ui.value.sending) return
        val mode = if (_ui.value.thread?.running == true) SendMode.FollowUp else SendMode.Prompt
        send(trimmed, mode, clearDraft = false)
    }

    // ---- 附件（M4 原生能力）----

    /** 相册/相机选到的图片：压缩后加入待发送附件。 */
    fun addImageAttachment(uri: android.net.Uri) = loadAttachment { attachmentLoader.loadImage(uri) }

    /** 文件选择器选到的文件：原样读入（≤6MB）。 */
    fun addFileAttachment(uri: android.net.Uri) = loadAttachment { attachmentLoader.loadFile(uri) }

    fun removeAttachment(index: Int) {
        _ui.update { state ->
            if (index !in state.attachments.indices) {
                state
            } else {
                state.copy(attachments = state.attachments.filterIndexed { i, _ -> i != index })
            }
        }
    }

    fun dismissAttachmentError() = _ui.update { it.copy(attachmentError = null) }

    /** UI 侧上报附件问题（拍照权限被拒等）——复用同一条错误展示。 */
    fun reportAttachmentError(message: String) = _ui.update { it.copy(attachmentError = message) }

    // ---- 语音输入（M4 原生能力）----

    /** 开始录音（调用方保证已拿到 RECORD_AUDIO 权限）。 */
    fun startRecording() {
        if (_ui.value.recording) return
        voiceRecorder.start()
            .onSuccess { _ui.update { it.copy(recording = true, voiceError = null) } }
            .onFailure { error ->
                _ui.update { it.copy(recording = false, voiceError = error.message ?: "无法启动录音") }
            }
    }

    /** 结束录音 → 送 STT → 识别文本追加到输入框。 */
    fun stopRecording() {
        if (!_ui.value.recording) return
        _ui.update { it.copy(recording = false, transcribing = true, voiceError = null) }
        scope.launch {
            val audioB64 = voiceRecorder.stop().getOrElse { error ->
                _ui.update { it.copy(transcribing = false, voiceError = error.message ?: "录音失败") }
                return@launch
            }
            val requesterRef = requester
            if (requesterRef == null) {
                _ui.update { it.copy(transcribing = false, voiceError = "连接已断开") }
                return@launch
            }
            try {
                val response = requesterRef.request(
                    "stt.transcribe",
                    kotlinx.serialization.json.buildJsonObject {
                        put("audioB64", audioB64)
                        put("sampleRate", VoiceRecorder.SAMPLE_RATE)
                    },
                )
                val text = (response as? JsonObject)
                    ?.get("text")?.jsonPrimitive?.contentOrNull.orEmpty().trim()
                if (text.isEmpty()) {
                    _ui.update { it.copy(transcribing = false, voiceError = "没有识别到内容") }
                } else {
                    _ui.update { state ->
                        val merged = if (state.draft.isBlank()) text else state.draft.trimEnd() + " " + text
                        state.openThreadId?.let { drafts[it] = merged }
                        state.copy(draft = merged, transcribing = false, voiceError = null)
                    }
                }
            } catch (error: Exception) {
                _ui.update { it.copy(transcribing = false, voiceError = error.message ?: "语音识别失败") }
            }
        }
    }

    fun cancelRecording() {
        _ui.update { it.copy(recording = false) }
        voiceRecorder.cancel()
    }

    fun dismissVoiceError() = _ui.update { it.copy(voiceError = null) }

    /** UI 侧发现问题（如麦克风权限被拒）时上报——统一走同一条错误展示。 */
    fun reportVoiceError(message: String) = _ui.update { it.copy(voiceError = message) }
    private fun loadAttachment(block: () -> Result<Attachment>) {
        if (_ui.value.attachmentBusy) return
        if (_ui.value.attachments.size >= MAX_ATTACHMENTS) {
            _ui.update { it.copy(attachmentError = "最多 $MAX_ATTACHMENTS 个附件") }
            return
        }
        _ui.update { it.copy(attachmentBusy = true, attachmentError = null) }
        scope.launch {
            block()
                .onSuccess { attachment ->
                    // 连续点选时可能撞上限，这里再兜一次
                    _ui.update { state ->
                        if (state.attachments.size >= MAX_ATTACHMENTS) {
                            state.copy(attachmentBusy = false, attachmentError = "最多 $MAX_ATTACHMENTS 个附件")
                        } else {
                            state.copy(attachmentBusy = false, attachments = state.attachments + attachment)
                        }
                    }
                }
                .onFailure { error ->
                    _ui.update { it.copy(attachmentBusy = false, attachmentError = error.message ?: "添加附件失败") }
                }
        }
    }

    /** 回合结束（running true→false）：自动投递暂存的「待处理后续」。 */
    private fun flushPendingFollowUp() {
        val text = _ui.value.pendingFollowUp ?: return
        _ui.update { it.copy(pendingFollowUp = null) }
        send(text, SendMode.Prompt)
    }

    /**
     * 手机发起的回合在后台跑完 → 系统通知（点它直达该会话）+ 可选语音播报。
     *
     * 三个条件缺一不发（纯函数判定见 [Notifier.shouldNotifyTurnComplete]）：设置开着、
     * **不在前台**（盯着屏幕看时不打扰）、本回合是**手机发起**的（桌面发起的不响）。
     * 不管发不发，标记都在这里消费掉，避免下一个回合误报；判定结果写进诊断页。
     */
    private fun notifyTurnComplete(threadId: String, view: ThreadView) {
        val phoneInitiated = phoneTurnStarted
        phoneTurnStarted = false
        val settings = settingsStore.settings.value
        val notify = Notifier.shouldNotifyTurnComplete(
            enabled = settings.notifyOnTurnComplete,
            foreground = AppVisibility.foreground,
            phoneInitiated = phoneInitiated,
        )
        val spoke = notify && settings.speakTurnComplete
        _ui.update {
            it.copy(
                lastTurnNotify = Notifier.turnNotifyReason(
                    enabled = settings.notifyOnTurnComplete,
                    foreground = AppVisibility.foreground,
                    phoneInitiated = phoneInitiated,
                    spoke = spoke,
                ),
            )
        }
        if (!notify) return
        val title = view.summary?.title
        // 回复摘要优先（与桌面端完成卡片同源）；出错时 [Notifier.turnCompleteText] 改用错误文案
        val reply = view.messages.lastOrNull { it.role == "assistant" }?.let { messageTextOf(it) }
        notifier.notifyTurnComplete(threadId, title, Notifier.turnCompleteText(reply, view.errorBanner))
        if (spoke) speaker.speak(Notifier.turnCompleteSpeech(settings.voiceSpeechContent, title, reply))
    }

    /** 重试一条发送失败的消息（保留原位，不重复上屏）。 */
    fun retrySend(localId: String) {
        val text = threadSession?.prepareRetry(localId) ?: return
        val mode = if (_ui.value.thread?.running == true) SendMode.FollowUp else SendMode.Prompt
        send(text, mode)
    }

    fun abortThread() {
        val actions = threadActions ?: return
        scope.launch {
            runCatching { actions.abort() }.onFailure { error ->
                val raw = error.message.orEmpty()
                _ui.update {
                    it.copy(
                        sendError = if (raw.startsWith(ThreadActions.THREAD_BUSY)) {
                            "该会话正被其他设备操作，无法停止。"
                        } else {
                            "停止失败：$raw"
                        },
                    )
                }
            }
        }
    }

    /**
     * 提交审批回应。失败时**不收起卡片**——回应没送到就等于 agent 还停着，
     * 这时候把卡片收掉会让人以为已经批准了。
     */
    fun respondUi(requestId: String, response: kotlinx.serialization.json.JsonObject) {
        val actions = threadActions ?: return
        val session = threadSession ?: return
        if (_ui.value.responding) return
        _ui.update { it.copy(responding = true, respondError = null) }
        scope.launch {
            try {
                actions.respondUi(requestId, response)
                session.markUiResponded(requestId)
                _ui.update { it.copy(responding = false, respondError = null) }
            } catch (error: Exception) {
                _ui.update { it.copy(responding = false, respondError = error.message ?: "回应发送失败") }
            }
        }
    }

    // ---- 会话级配置（§4.4 chip 行）----

    fun openConfigSheet() = _ui.update { it.copy(configSheetOpen = true, configError = null) }

    fun closeConfigSheet() = _ui.update { it.copy(configSheetOpen = false, configError = null) }

    fun dismissConfigError() = _ui.update { it.copy(configError = null) }

    fun setPermission(permission: RemotePermission) = configAction { it.setPermission(permission) }

    fun setModel(provider: String, modelId: String) = configAction {
        // 失败会抛出 → 走 configError 显示（不静默），所以下面这行只在确实成功后执行。
        it.setModel(provider, modelId)
        // 本地先更新 chip：不等主机 config_changed 事件往返（主机也会广播，事件到达是同值覆盖）。
        // 2026-09-25 真机：「切了个已从配置删掉的模型，好像没反应也没提示」——
        // 实际原因是切换当时客户端不消费响应快照，而主机又不广播，chip 就一直没动。
        threadSession?.noteLocalModel(provider, modelId)
    }

    fun setThinking(level: String) = configAction { it.setThinking(level) }

    fun setMode(modeId: String) = configAction { it.setMode(modeId) }

    /**
     * 压缩上下文：要读整个会话再调一次 LLM，可能十几秒。界面上的「压缩中」由
     * compaction_start/end 事件驱动（ThreadView.compacting），这里只负责发请求。
     */
    fun compactContext() = configAction { it.compact() }

    /**
     * 会话级配置写操作的公共外壳：串行化、busy 标记、失败原因留给 UI。
     * 失败时**不关 Sheet**，这样错误就显示在用户刚点的那个面板里。
     */
    private fun configAction(block: suspend (ThreadActions) -> Unit) {
        val actions = threadActions ?: return
        if (_ui.value.configBusy) return
        _ui.update { it.copy(configBusy = true, configError = null) }
        scope.launch {
            try {
                block(actions)
                _ui.update { it.copy(configBusy = false, configError = null, configSheetOpen = false) }
            } catch (error: Exception) {
                _ui.update { it.copy(configBusy = false, configError = error.message ?: "设置失败") }
            }
        }
    }

    private fun send(text: String, mode: SendMode, clearDraft: Boolean = true, retried: Boolean = false) {
        val session = threadSession ?: return
        val actions = threadActions ?: return
        // 附件：图片与文件分别按协议形状打包（主机端会逐项校验）
        val pending = _ui.value.attachments
        val images = pending.filterIsInstance<Attachment.Image>().map { image ->
            kotlinx.serialization.json.buildJsonObject {
                put("type", "image")
                put("data", image.bytesB64)
                put("mimeType", image.mimeType)
            }
        }
        val files = pending.filterIsInstance<Attachment.File>().map { file ->
            kotlinx.serialization.json.buildJsonObject {
                put("name", file.name)
                put("data", file.bytesB64)
                if (file.mimeType != null) put("mimeType", file.mimeType)
            }
        }
        // 先乐观上屏（§1.1：点击到视觉反馈 < 100ms），失败再标红留在原位
        // 图片用**本地字节**上屏：事件通道会把大 base64 截断（会变成「图片无法显示」），
        // 主机那份完整的图由随后的快照替换。
        val localImageBlocks = pending.filterIsInstance<Attachment.Image>().map { image ->
            MessageBlock(type = BlockType.Image, data = image.bytesB64, mimeType = image.mimeType)
        }
        val localId = session.echoUserMessage(text, localImageBlocks)
        if (clearDraft) {
            _ui.value.openThreadId?.let { drafts[it] = "" }
            _ui.update { it.copy(draft = "", sending = true, sendError = null, sendNote = null) }
        } else {
            // choices 面板的发送不该清掉用户正在输入的草稿
            _ui.update { it.copy(sending = true, sendError = null, sendNote = null) }
        }
        scope.launch {
            // 兜底：正在对话时保证订阅在（重连后漏订阅会让主机把事件全丢）。
            // 已订阅时是纯本地判断，零往返。
            runCatching { session.ensureSubscribed() }
            try {
                val result = actions.send(text, mode, images, files)
                // 手机发起的回合：跑完时（且不在前台）给一条完成通知——见 notifyTurnComplete()
                phoneTurnStarted = true
                // 发送成功才清附件；失败要留在输入条上让用户重发，不能把附件吞掉
                _ui.update {
                    it.copy(sending = false, attachments = emptyList(), sendNote = queuedNoteOf(result))
                }
            } catch (error: Exception) {
                val raw = error.message.orEmpty()
                // 主机正忙（agent 在跑，或状态滞后让 prompt 撞上忙）：回退成 followUp 排队，
                // 而不是报「发送失败」——PWA 修过同一个问题（a22bd2b）。
                if (!retried && mode != SendMode.FollowUp && isBusyError(raw)) {
                    session.prepareRetry(localId)
                    _ui.update { it.copy(sending = false) }
                    send(text, SendMode.FollowUp, clearDraft = false, retried = true)
                    return@launch
                }
                session.markSendFailed(localId, error.message ?: "发送失败")
                _ui.update {
                    it.copy(
                        sending = false,
                        sendError = if (raw.startsWith(ThreadActions.THREAD_BUSY)) {
                            "该会话正被其他设备操作，请稍后再试。"
                        } else {
                            "发送失败：$raw"
                        },
                    )
                }
            }
        }
    }

    /** 主机忙（写租约被占 / pi 在跑）——发送可回退为排队。 */
    private fun isBusyError(message: String): Boolean {
        val lower = message.lowercase()
        return lower.contains("busy") || message.contains(ThreadActions.THREAD_BUSY)
    }

    /** 用户显式要求重置本地数据（存储损坏时给出这条路径）。 */
    fun resetLocalData() {
        scope.launch {
            detachSession()
            keyStore.reset()
            threadCache.clear()
            homeCache.clear()
            _ui.value = AppUiState()
            initialize()
        }
    }

    // ---- 数据 ----

    /**
     * 新建会话（`thread.create`）→ 刷新列表并直接进入该会话。
     * 主机返回的是新会话快照，取其 id 即可打开（列表刷新失败也不影响进入）。
     */
    fun createThread(projectId: String) {
        val requesterRef = requester ?: return
        if (_ui.value.creatingThread != null) return
        _ui.update { it.copy(creatingThread = projectId) }
        scope.launch {
            try {
                val result = requesterRef.request(
                    "thread.create",
                    kotlinx.serialization.json.buildJsonObject {
                        put("projectId", projectId)
                    },
                )
                repository?.refresh()
                val snapshot = (result as? kotlinx.serialization.json.JsonObject)
                    ?.get("snapshot") as? kotlinx.serialization.json.JsonObject
                val id = (snapshot?.get("id") as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull
                _ui.update { it.copy(creatingThread = null) }
                if (!id.isNullOrEmpty()) openThread(id)
            } catch (error: Exception) {
                _ui.update {
                    it.copy(
                        creatingThread = null,
                        problems = (it.problems + (error.message ?: "新建会话失败")).takeLast(MAX_PROBLEMS),
                    )
                }
            }
        }
    }

    fun refresh() {
        scope.launch { repository?.refresh() }
    }

    fun reconnect() {
        session?.reauthenticate()
    }

    // ---- 内部 ----

    /**
     * 「对话即主页」：连上并拿到列表后，自动进**运行中**优先、否则最近更新的那个会话。
     * 没有首屏会话列表了，所以这一步不能省——否则连上后只看到一片引导。
     * 只在每次 attach 后做一次；用户自己开/关过会话后不再打扰。
     */
    private fun maybeAutoOpenThread(snapshot: HostSnapshot) {
        if (autoOpenedThread || _ui.value.openThreadId != null) return
        if (pendingThreadOpen.value != null) return // 通知深链优先
        if (session == null || requester == null) return
        val threads = snapshot.allThreads
        if (threads.isEmpty()) return
        val target = threads.firstOrNull { it.state == RemoteThreadState.Running } ?: threads.first()
        openThread(target.id)
    }

    private fun attach(record: PairingRecord) {
        detachSession()
        autoOpenedThread = false
        val deviceIdentity = identity ?: return

        val client = RelayClient(record.relayUrl)
        val newSession = HostSession(client, record, deviceIdentity, deviceName, scope)
        val newRequester = Requester(
            transport = newSession,
            // 请求超时但连接还在 → 主机 uplink 可能静默掉线，重握手一次
            onStaleConnection = { newSession.reauthenticate() },
        )
        val newRepository = HostRepository(
            scope = scope,
            request = { type, payload -> newRequester.request(type, payload) },
            sessionState = newSession.state,
            hostId = record.hostId,
            cache = homeCache,
        )

        session = newSession
        repository = newRepository
        requester = newRequester
        unsubscribeProblems = newSession.onProblem { problem ->
            _ui.update { state ->
                // 同一条问题不重复堆叠（重连循环会把同一句刷好几遍）
                state.copy(problems = (state.problems.filterNot { it == problem } + problem).takeLast(MAX_PROBLEMS))
            }
        }

        jobs += scope.launch {
            var autoCheckedUpdate = false
            newSession.state.collect { state ->
                _ui.update { it.copy(session = state) }
                // 连上后自动检查一次更新（静默；M6）
                if (state is SessionState.Connected && !autoCheckedUpdate) {
                    autoCheckedUpdate = true
                    checkUpdate(manual = false)
                }
                // 重连后重新同步当前会话：断线期间的事件丢了，seq 接不上。
                // **必须重注册订阅**：主机按 connectionId 记订阅，连接断开时已经清掉，
                // 只 resync（拉快照）会让之后所有实时事件被主机静默丢弃——真机表现为
                // 「气泡卡发送中 / 整条消息包括回复一起晚到」（diag 里 `remote-pub … subs=0`）。
                if (state is SessionState.Connected) {
                    // 已恢复连接——离线期间的提示已经过时，清掉免得号人
                    if (_ui.value.problems.isNotEmpty()) _ui.update { it.copy(problems = emptyList()) }
                    threadSession?.let { open ->
                        open.invalidateSubscription()
                        // 重连回调可能连着多次（日志里见过 3 次），合并成一次，别重复拉全量快照
                        if (reconnectSyncJob?.isActive != true) {
                            reconnectSyncJob = scope.launch { runCatching { open.resync() } }
                        }
                    }
                }
            }
        }
        jobs += scope.launch {
            newRepository.snapshot.collect { snapshot ->
                _ui.update { it.copy(host = snapshot) }
                maybeAutoOpenThread(snapshot)
            }
        }

        _ui.update { it.copy(activeHostId = record.hostId, problems = emptyList()) }
        newRepository.start()
        newSession.connect()
        // M5：起前台服务保活——进程活着，连接与审批提醒才收得到
        notifier.startLinkService()

        // 记住「最近用过」，下次启动自动重连这台
        scope.launch { keyStore.savePairing(record.copy(lastSeenAt = System.currentTimeMillis())) }
    }

    private fun detachSession() {
        _ui.value.openThreadId?.let { drafts[it] = _ui.value.draft }
        threadSession?.detach()
        threadSession = null
        threadActions = null
        _ui.update { it.copy(openThreadId = null, thread = null) }
        unsubscribeProblems?.invoke()
        unsubscribeProblems = null
        jobs.forEach { it.cancel() }
        jobs.clear()
        repository?.stop()
        session?.stop()
        repository = null
        session = null
        requester = null
    }

    override fun onCleared() {
        detachSession()
        // 进程级保活随之结束：ViewModel 没了，连接也不在（见 MpiLinkService 的局限说明）
        notifier.stopLinkService()
        super.onCleared()
    }

    companion object {
        private const val MAX_PROBLEMS = 5
        private const val MAX_ATTACHMENTS = 3

        fun factory(container: AppContainer): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    AppViewModel(
                        container.keyStore,
                        container.settingsStore,
                        container.scope,
                        container.deviceName,
                        container.attachmentLoader,
                        container.voiceRecorder,
                        container.notifier,
                        container.speaker,
                        container.updater,
                        container.threadCache,
                        container.homeCache,
                        container.pendingThreadOpen,
                    ) as T
            }
    }
}
