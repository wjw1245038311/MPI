package com.mpi.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import com.mpi.app.AppContainer
import com.mpi.app.data.Attachment
import com.mpi.app.data.AttachmentLoader
import com.mpi.app.data.HostRepository
import com.mpi.app.data.HostSession
import com.mpi.app.data.HostSnapshot
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
import com.mpi.app.data.ThreadActions
import com.mpi.app.data.ThreadSession
import com.mpi.app.data.ThreadView
import com.mpi.app.data.UpdateInfo
import com.mpi.app.data.Updater
import com.mpi.app.data.VoiceRecorder
import com.mpi.app.protocol.DeviceIdentity
import com.mpi.app.protocol.PairingLink
import com.mpi.app.protocol.PairingLinkException
import com.mpi.app.protocol.RemotePermission
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
    /** 打开的会话级配置底部 Sheet（null = 关闭）。 */
    val toolbarSheet: ToolbarSheet? = null,
    /** 会话配置写操作进行中（模型切换可能耗时）。 */
    val configBusy: Boolean = false,
    /** 会话配置写操作失败原因（Sheet 内与 chip 行下方都要显示）。 */
    val configError: String? = null,
    /** 运行中发送 → 本地暂存为「待处理后续」（null = 无）；回合结束后自动投递。 */
    val pendingFollowUp: String? = null,
    /** 发送 / 停止失败文案（贴输入框显示，不静默失败）。 */
    val sendError: String? = null,
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
    private val scope: CoroutineScope,
    private val deviceName: String,
    private val attachmentLoader: AttachmentLoader,
    private val voiceRecorder: VoiceRecorder,
    private val notifier: Notifier,
    private val updater: Updater,
) : ViewModel() {

    private val _ui = MutableStateFlow(AppUiState())
    val ui: StateFlow<AppUiState> = _ui.asStateFlow()

    private var identity: DeviceIdentity? = null
    private var session: HostSession? = null
    private var requester: Requester? = null
    private var repository: HostRepository? = null
    private var threadSession: ThreadSession? = null
    private var threadActions: ThreadActions? = null
    /** 按会话保存的草稿（内存；跨重启持久化留待需要时再说）。 */
    private val drafts = mutableMapOf<String, String>()
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
        attach(record)
    }

    fun removeHost(hostId: String) {
        scope.launch {
            keyStore.deletePairing(hostId)
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
        if (relay.isNullOrBlank() || _ui.value.updateChecking) return
        _ui.update { it.copy(updateChecking = true, updateError = null) }
        scope.launch {
            val info = updater.check(relay)
            _ui.update { state ->
                when {
                    info != null -> state.copy(updateChecking = false, updateInfo = info, updateError = null)
                    manual -> state.copy(
                        updateChecking = false,
                        updateInfo = null,
                        updateError = "已是最新版本（v${com.mpi.app.BuildConfig.VERSION_NAME}）",
                    )
                    else -> state.copy(updateChecking = false)
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
                .onSuccess { file ->
                    _ui.update { it.copy(updateDownloading = false) }
                    runCatching { updater.install(file) }.onFailure { error ->
                        _ui.update { it.copy(updateError = error.message ?: "无法调起安装器") }
                    }
                }
                .onFailure { error ->
                    _ui.update { it.copy(updateDownloading = false, updateError = error.message ?: "下载失败") }
                }
        }
    }

    fun dismissUpdateError() = _ui.update { it.copy(updateError = null) }

    /** UI 侧上报配对问题（扫码结果不是配对码 / 相机权限被拒）——不静默。 */
    fun reportPairingError(message: String) = _ui.update { it.copy(pairingError = message) }

    // ---- 会话 ----

    /** 打开一个会话：订阅快照并开始接收事件流。 */
    fun openThread(threadId: String) {
        val transport = session ?: return
        val requesterRef = requester ?: return
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
                if (wasRunning && !view.running) flushPendingFollowUp()
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
            runCatching { threadSessionLocal.subscribe() }.onFailure { error ->
                _ui.update {
                    it.copy(thread = it.thread?.copy(ready = true, errorBanner = error.message ?: "订阅失败"))
                }
            }
        }
    }

    fun closeThread() {
        _ui.value.openThreadId?.let { drafts[it] = _ui.value.draft }
        threadSession?.detach()
        threadSession = null
        threadActions = null
        _ui.update { it.copy(openThreadId = null, thread = null, draft = "", sending = false, responding = false, respondError = null, toolbarSheet = null, configBusy = false, configError = null, pendingFollowUp = null, sendError = null, attachments = emptyList(), attachmentBusy = false, attachmentError = null, recording = false, transcribing = false, voiceError = null) }
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

    fun openToolbarSheet(sheet: ToolbarSheet) =
        _ui.update { it.copy(toolbarSheet = sheet, configError = null) }

    fun closeToolbarSheet() = _ui.update { it.copy(toolbarSheet = null, configError = null) }

    fun dismissConfigError() = _ui.update { it.copy(configError = null) }

    fun setPermission(permission: RemotePermission) = configAction { it.setPermission(permission) }

    fun setModel(provider: String, modelId: String) = configAction { it.setModel(provider, modelId) }

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
                _ui.update { it.copy(configBusy = false, configError = null, toolbarSheet = null) }
            } catch (error: Exception) {
                _ui.update { it.copy(configBusy = false, configError = error.message ?: "设置失败") }
            }
        }
    }

    private fun send(text: String, mode: SendMode, clearDraft: Boolean = true) {
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
        val localId = session.echoUserMessage(text)
        if (clearDraft) {
            _ui.value.openThreadId?.let { drafts[it] = "" }
            _ui.update { it.copy(draft = "", sending = true, sendError = null) }
        } else {
            // choices 面板的发送不该清掉用户正在输入的草稿
            _ui.update { it.copy(sending = true, sendError = null) }
        }
        scope.launch {
            try {
                actions.send(text, mode, images, files)
                // 发送成功才清附件；失败要留在输入条上让用户重发，不能把附件吞掉
                _ui.update { it.copy(sending = false, attachments = emptyList()) }
            } catch (error: Exception) {
                session.markSendFailed(localId, error.message ?: "发送失败")
                val raw = error.message.orEmpty()
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

    /** 用户显式要求重置本地数据（存储损坏时给出这条路径）。 */
    fun resetLocalData() {
        scope.launch {
            detachSession()
            keyStore.reset()
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

    private fun attach(record: PairingRecord) {
        detachSession()
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
                // 重连后重新同步当前会话：断线期间的事件丢了，seq 接不上
                if (state is SessionState.Connected) {
                    // 已恢复连接——离线期间的提示已经过时，清掉免得号人
                    if (_ui.value.problems.isNotEmpty()) _ui.update { it.copy(problems = emptyList()) }
                    threadSession?.let { open ->
                        if (open.view.value.ready) scope.launch { runCatching { open.resync() } }
                    }
                }
            }
        }
        jobs += scope.launch {
            newRepository.snapshot.collect { snapshot -> _ui.update { it.copy(host = snapshot) } }
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
                        container.scope,
                        container.deviceName,
                        container.attachmentLoader,
                        container.voiceRecorder,
                        container.notifier,
                        container.updater,
                    ) as T
            }
    }
}
