package com.mpi.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import android.os.SystemClock
import com.mpi.app.AppContainer
import com.mpi.app.AppVisibility
import com.mpi.app.data.Attachment
import com.mpi.app.data.AttachmentLoader
import com.mpi.app.data.AttachmentCrypto
import com.mpi.app.data.DirectAttachments
import com.mpi.app.data.DirectUploadException
import com.mpi.app.data.MAX_FILE_BYTES
import com.mpi.app.data.imagePayloads
import com.mpi.app.data.looksLikeAudio
import com.mpi.app.data.looksLikeVideo
import com.mpi.app.data.mediaPayloads

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
import com.mpi.app.data.LastThreadStore
import com.mpi.app.data.NetworkWatcher
import com.mpi.app.data.RelayClient
import com.mpi.app.data.Requester
import com.mpi.app.data.SessionState
import com.mpi.app.data.SendMode
import com.mpi.app.data.SettingsStore
import com.mpi.app.data.Speaker
import com.mpi.app.data.ThreadActions
import java.io.File
import com.mpi.app.data.ThreadCache
import com.mpi.app.data.ThreadSession
import com.mpi.app.data.ThreadView
import com.mpi.app.data.TurnWakeLock
import com.mpi.app.data.UpdateInfo
import com.mpi.app.data.UpdateCheckResult
import com.mpi.app.data.Updater
import com.mpi.app.data.VoiceActivityGate
import com.mpi.app.data.VoiceGateDecision
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
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.coroutineContext
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

/**
 * 语音对话模式的状态（浮层据此显示进度）。
 *
 * 阶段 1 是**半双工**：听 → 转写 → 等回复 → 播报 → 再听；播报时不停录，
 * 所以不做打断（打断需要回声消除，留阶段 2）。
 */
enum class VoiceChatState { Listening, Transcribing, Thinking, Speaking }

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
    /**
     * 语音对话模式（null = 未开启）。开启时长按麦克风 3 秒进入。
     */
    val voiceChat: VoiceChatState? = null,
    /** 语音模式下最近一句识别到的文本（浮层显示，让你确认「它听懂了吗」）。 */
    val voiceChatText: String? = null,
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
    /**
     * 正在直连上传的视频（null = 没有）。带进度供输入条显示「正在上传视频 N%」——
     * 几十 MB 的上传要几分钟，没有反馈的形态最容易被当成卡死。
     */
    val videoUpload: VideoUpload? = null,
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
    /** 正在直连上传的视频（null = 没有）；有值时输入条显示「正在上传视频 N%」。 */
    val showPairing: Boolean
        get() = pairings.isEmpty() || addingHost
}

/** 直连上传的进度状态（只用于 UI 显示与取消）。 */
data class VideoUpload(val name: String, val loaded: Long, val total: Long) {
    /** 0–99 的整百分比；总长未知时返回 null（显示成不定进度）。 */
    val percent: Int?
        get() = if (total > 0) ((loaded * 100) / total).toInt().coerceIn(0, 99) else null
}

/** 人类可读大小（与 ThreadScreen.formatVideoMeta 同一口径：MB/KB）。 */
private fun formatMb(bytes: Long): String =
    if (bytes >= 1_000_000) String.format("%.1fMB", bytes / 1_000_000.0) else "${(bytes + 1023) / 1024}KB"

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
    /** 后台/锁屏播报保活 wakelock（见 [TurnWakeLock]）。 */
    private val turnWakeLock: TurnWakeLock,
    /** 网络恢复监听（快恢复，见 [NetworkWatcher]）。 */
    private val networkWatcher: NetworkWatcher,
    /** 上一次打开的会话（重启后优先回到它，见 [LastThreadStore]）。 */
    private val lastThread: LastThreadStore,
) : ViewModel() {

    private val _ui = MutableStateFlow(AppUiState())
    val ui: StateFlow<AppUiState> = _ui.asStateFlow()

    private var identity: DeviceIdentity? = null
    private var session: HostSession? = null
    private var requester: Requester? = null
    private var repository: HostRepository? = null
    private var threadSession: ThreadSession? = null
    private var threadActions: ThreadActions? = null
    /** 附件直连（P2）：上行分片 PUT / 下行换读 URL。与 [threadActions] 同生命周期。 */
    private var directAttachments: DirectAttachments? = null
    /** 正在跑的上传作业（点「取消上传」/ 关会话时取消）。 */
    private var videoUploadJob: Job? = null
    /**
     * 本回合是**手机自己发起**的吗？发送成功后置起，回合结束时消费掉。
     * 「对话完成」通知只对手机发起的回合发——桌面发起的没必要响（见 [notifyTurnComplete]）。
     */
    /** 手机发起的回合（只给语音播报用：电脑端发起的回合不念）。 */
    private var phoneTurnStarted = false

    /** 上一轮各会话的状态：用来发现「刚跑完」的会话（见 [notifyFinishedTurns]）。 */
    private var lastThreadStates: Map<String, RemoteThreadState> = emptyMap()
    /** 语音对话模式的循环 Job（null = 未运行）。 */
    private var voiceChatJob: Job? = null
    /** 语音模式里「回合结束」的握手：视图收集器 settle 时唤醒它。 */
    private var voiceSettle: CompletableDeferred<Unit>? = null
    /** 重连后的会话重同步 Job（合并多次 Connected 回调，避免重复拉全量快照）。 */
    private var reconnectSyncJob: Job? = null
    /** 按会话保存的草稿（内存；跨重启持久化留待需要时再说）。 */
    private val drafts = mutableMapOf<String, String>()
    /**
     * 「对话即主页」：每次 attach 只自动开一次会话；
     * 用户自己开过（或通知深链开过）就不再掠。
     */
    private var autoOpenedThread = false
    /**
     * 切会话串行化：用户/新建的打开与「自动打开」不能互相插队。
     *
     * 用户报的「运行中会话在跑时，新建会话会莫名跳回运行中那条」：
     * autoOpen 先判 openThreadId==null、再 openThread（check-then-act，中间可被插入）。
     */
    private val openLock = Any()
    private var unsubscribeProblems: (() -> Unit)? = null
    private val jobs = mutableListOf<Job>()

    init {
        // 快恢复：系统恢复网络（Doze 维护窗口 / 回 Wi-Fi）时立刻重连，不等退避。
        // 与 MpiApp 的前后台 kick 并列；已连上时 HostSession.kick 自己短路。
        networkWatcher.start()
        networkWatcher.addListener { session?.kick() }
        // 清掉历史更新包（一版一个 27MB 堆在 cacheDir，老用户装上新版后得主动释放）。
        scope.launch { withContext(kotlinx.coroutines.Dispatchers.IO) { runCatching { updater.pruneDownloadArtifacts() } } }
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
            // 改的就是当前打开的会话：顶栏标题就地更新（列表已由 refresh() 刷新）。
            onSuccess = { if (_ui.value.openThreadId == threadId) threadSession?.applyRenamedTitle(trimmed) },
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
    /** 切会话统一入口：与「自动打开」串行化，避免两者并发时界面被抢回运行中的会话。 */
    fun openThread(threadId: String) {
        synchronized(openLock) { openThreadLocked(threadId) }
    }

    private fun openThreadLocked(threadId: String) {
        val transport = session ?: return
        val requesterRef = requester ?: return
        // 用户/自动已经进过会话 —— 不再自动打开别的
        autoOpenedThread = true
        // 进到这条会话了，它的「回复完成」通知就完成使命（其它会话的通知不碰）
        notifier.cancelTurnComplete(threadId)
        closeThread()

        val threadSessionLocal = ThreadSession(
            threadId = threadId,
            transport = transport,
            request = { type, payload, tid, timeoutMs -> requesterRef.request(type, payload, threadId = tid, timeoutMs = timeoutMs) },
            scope = scope,
            onProblem = { problem ->
                _ui.update { state ->
                    state.copy(problems = (state.problems.filterNot { it == problem } + problem).takeLast(MAX_PROBLEMS))
                }
            },
            // 每次拿到快照就写本地缓存：下次打开先用它秒开（断网也能看）。
            // 增量按锚点合并（否则缓存停在最早那份全量 → 「刷新后不能保存」）。
            onSnapshot = { payload, incremental ->
                val hostId = _ui.value.activeHostId
                if (hostId != null) {
                    if (incremental) threadCache.mergeIncremental(hostId, threadId, payload)
                    else threadCache.write(hostId, threadId, payload)
                }
            },
        )
        threadSession = threadSessionLocal
        threadActions = ThreadActions(
            threadId = threadId,
            request = { type, payload, tid, timeoutMs -> requesterRef.request(type, payload, threadId = tid, timeoutMs = timeoutMs) },
        )
        // 附件直连：与写操作共用同一条请求通道（令牌只能由主机签发，见 DirectAttachments 注释）。
        directAttachments = DirectAttachments(
            request = { type, payload, tid, timeoutMs -> requesterRef.request(type, payload, threadId = tid, timeoutMs = timeoutMs) },
        )
        _ui.update {
            it.copy(
                openThreadId = threadId,
                thread = ThreadView(threadId),
                draft = drafts[threadId].orEmpty(),
            )
        }
        // 记住这条：重启 App 后优先回到它（见 LastThreadStore）。
        lastThread.threadId = threadId

        jobs += scope.launch {
            var lastPendingId: String? = null
            threadSessionLocal.view.collect { view ->
                // ⚠️ 陈旧会话不得回写 UI：切走后这条会话只是 detach()，它的收集器还活着，
                // 而 chunk 内的 subscribe() 迟到响应仍会 patch 它自己的 view 并触发这里——
                // 不拦的话会把界面扳回旧会话（真机现象：新建会话后莫名跳到运行中的那条）。
                if (threadSession !== threadSessionLocal) return@collect
                val wasRunning = _ui.value.thread?.running == true
                _ui.update { it.copy(thread = view) }
                // 回合结束（running true→false）：投递暂存的「待处理后续」（与 PWA 同语义）
                if (wasRunning && !view.running) {
                    // 顺序不能反：先唤醒语音循环（它自己会播报回复），再判定完成通知——
                    // 判定里因「语音模式中」跳过，避免一句回复念两遍。
                    voiceSettle?.complete(Unit)
                    voiceSettle = null
                    speakTurnComplete(view)
                    // 回合结束：后台保活 wakelock 一并放掉（未持有时是 no-op）
                    turnWakeLock.release()
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
                    // 会话自己已经写过一句人话的错误横幅（friendlyError），不要用协议原文盖掉它
                    val current = it.thread
                    if (!current?.errorBanner.isNullOrBlank()) {
                        it
                    } else {
                        it.copy(thread = current?.copy(ready = true, errorBanner = error.message ?: "订阅失败"))
                    }
                }
            }
        }
    }

    fun closeThread() {
        // 语音模式挂在这条会话上：离开会话就退，否则循环会在没会话时白等到超时
        stopVoiceChat()
        _ui.value.openThreadId?.let { drafts[it] = _ui.value.draft }
        // 用户主动关掉会话（切换会话时会紧接着重写新值）→ 下次启动不再回到它
        lastThread.threadId = null
        reconnectSyncJob?.cancel()
        reconnectSyncJob = null
        turnWakeLock.release()
        threadSession?.detach()
        threadSession = null
        threadActions = null
        videoUploadJob?.cancel()
        videoUploadJob = null
        directAttachments = null
        _ui.update { it.copy(openThreadId = null, thread = null, draft = "", sending = false, responding = false, respondError = null, configSheetOpen = false, configBusy = false, configError = null, pendingFollowUp = null, sendError = null, attachments = emptyList(), attachmentBusy = false, attachmentError = null, videoUpload = null, recording = false, transcribing = false, voiceError = null) }
    }

    /** 手动重新同步（错误横幅上的按钮）。 */
    fun resyncThread() {
        scope.launch { runCatching { threadSession?.resync() } }
    }

    /**
     * 按需取回视频附件（大视频不再随快照下发；快照里只留占位 + 附件名）。
     *
     * 先写 `.part` 再改名：中途断网 / 退出时不会留下一个「看着有、实际半截」的缓存文件
     * （那种文件的表现是视频能列出但播到一半报错，很难归因）。
     * 目标文件已存在且非空 → 直接算成功（拉过一次就缓在 cacheDir，不该再走网络）。
     *
     * @return 是否成功（false = 附件已被清理 / 主机报错 / 当前没有会话）
     */
    suspend fun fetchVideoAttachment(name: String, target: File, onProgress: (Long, Long) -> Unit): Boolean {
        val actions = threadActions ?: return false
        if (target.length() > 0) return true
        val part = File(target.parentFile, "${target.name}.part")
        return try {
            // 先试**加密直连**（手机不装 Tailscale 时走它：公网明文 HTTP + 应用层加密）。
            // 拿到令牌但主机没要求加密 → 这条路不适用，回落中继分片（保持原有行为）。
            val direct = directAttachments
            val threadId = _ui.value.openThreadId
            val key = session?.sessionKeyOrNull()
            if (direct != null && threadId != null && key != null) {
                val readTarget = direct.requestTarget(threadId, "read", name = name)
                if (readTarget?.enc == AttachmentCrypto.VERSION) {
                    if (direct.downloadEncrypted(readTarget, key, part, onProgress = onProgress, onError = { msg -> reportAttachmentError("加密直连下载失败：$msg") })) {
                        return part.renameTo(target) || target.length() > 0
                    }
                    return false
                }
            }
            actions.fetchAttachmentTo(name, part, onProgress)
            part.renameTo(target) || target.length() > 0
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            false
        } finally {
            // 成功改名后这个文件已经不存在；失败/取消时把它清掉，别把垃圾留在缓存里。
            runCatching { part.delete() }
        }
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

    /**
     * 相册/相机选到的图片（P3）：
     * ① 原图走**直连上传**（内容寻址、去重、可被其它会话复用）；
     * ② prompt 里只带**缩略图**与 key（主机从对象库读原图嗂给模型）；
     * ③ 直连不可用 / 上传失败 → 回落内联（压缩到 ≤280KB，与旧行为一致）。
     *
     * 图片不像大文件那样可以“失败了就叫用户重试”：内联本来就装得下（≤1.2MB base64），
     * 所以这里失败了就静静地走老路，不弹错。
     */
    fun addImageAttachment(uri: android.net.Uri) {
        val direct = directAttachments
        val threadId = _ui.value.openThreadId
        val source = attachmentLoader.loadImageSource(uri).getOrElse {
            // 读不出缩略图（格式不支持等）→ 老路（内联）自己会给出可读错误。
            loadAttachment { attachmentLoader.loadImage(uri) }
            return
        }
        if (direct == null || threadId == null) {
            loadAttachment { attachmentLoader.loadImage(uri) }
            return
        }
        if (_ui.value.videoUpload != null || _ui.value.attachmentBusy) return
        if (_ui.value.attachments.size >= MAX_ATTACHMENTS) {
            _ui.update { it.copy(attachmentError = "最多 $MAX_ATTACHMENTS 个附件") }
            return
        }
        _ui.update { it.copy(attachmentError = null, videoUpload = VideoUpload(source.name, 0, source.size)) }
        videoUploadJob = scope.launch {
            try {
                val upload = direct.uploadMedia(
                    threadId = threadId,
                    originalName = source.name,
                    mimeType = source.mimeType,
                    size = source.size,
                    open = source.open,
                    sessionKey = session?.sessionKeyOrNull(),
                    onProgress = { loaded, total ->
                        _ui.update { state -> state.copy(videoUpload = state.videoUpload?.copy(loaded = loaded, total = total)) }
                    },
                )
                if (upload == null) {
                    // 直连不可用（老主机/未开服务）→ 回落内联。
                    _ui.update { it.copy(videoUpload = null) }
                    loadAttachment { attachmentLoader.loadImage(uri) }
                    return@launch
                }
                _ui.update { state ->
                    state.copy(
                        videoUpload = null,
                        attachments = state.attachments + Attachment.ImageKeyed(
                            key = upload.name,
                            thumbB64 = source.thumbB64,
                            mimeType = source.mimeType,
                            size = source.size,
                        ),
                    )
                }
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                _ui.update { it.copy(videoUpload = null) }
                throw cancelled
            } catch (_: Exception) {
                // 任何失败都静静回落内联（图片内联本来就装得下）。
                _ui.update { it.copy(videoUpload = null) }
                loadAttachment { attachmentLoader.loadImage(uri) }
            } finally {
                videoUploadJob = null
            }
        }
    }

    /** 文件选择器选到的文件：≤6MB 走内联（老路）；更大的走**直连 + 降落到工作区**（P3-S2）。 */
    fun addFileAttachment(uri: android.net.Uri) {
        val direct = directAttachments
        val threadId = _ui.value.openThreadId
        val meta = attachmentLoader.fileMeta(uri)
        // 拿不到元信息 / 读不到大小 / 不大 / 直连不可用 → 都走内联老路（那里有 6MB 检查与明确报错）。
        if (meta == null || meta.size <= MAX_FILE_BYTES || direct == null || threadId == null) {
            loadAttachment { attachmentLoader.loadFile(uri) }
            return
        }
        if (_ui.value.videoUpload != null || _ui.value.attachmentBusy) return
        if (_ui.value.attachments.size >= MAX_ATTACHMENTS) {
            _ui.update { it.copy(attachmentError = "最多 $MAX_ATTACHMENTS 个附件") }
            return
        }
        // 进度条复用视频那条（上传状态本来就只能有一个）。
        _ui.update { it.copy(attachmentError = null, videoUpload = VideoUpload(meta.name, 0, meta.size)) }
        videoUploadJob = scope.launch {
            try {
                val upload = direct.uploadMedia(
                    threadId = threadId,
                    originalName = meta.name,
                    mimeType = meta.mimeType ?: "application/octet-stream",
                    size = meta.size,
                    open = { attachmentLoader.openStream(uri) },
                    sessionKey = session?.sessionKeyOrNull(),
                    // 关键：让主机把文件放进 <会话 cwd>/mpi-inbox/，并把绝对路径回给我们。
                    workspace = true,
                    onProgress = { loaded, total ->
                        _ui.update { state -> state.copy(videoUpload = state.videoUpload?.copy(loaded = loaded, total = total)) }
                    },
                )
                val path = upload?.workspacePath
                if (path == null) {
                    // 主机回的路径缺失（版本过旧/会话工作目录解析不到）：不静默降级成内联，如实报错。
                    _ui.update {
                        it.copy(
                            videoUpload = null,
                            attachmentError = "大文件已传到主机，但没拿到工作区路径（主机版本过旧？）——请升级主机再试",
                        )
                    }
                    return@launch
                }
                _ui.update { state ->
                    state.copy(
                        videoUpload = null,
                        attachments = state.attachments + Attachment.WorkspaceFile(
                            name = upload?.workspaceName ?: meta.name,
                            path = path,
                            size = meta.size,
                        ),
                    )
                }
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                _ui.update { it.copy(videoUpload = null) }
                throw cancelled
            } catch (error: DirectUploadException) {
                _ui.update { it.copy(videoUpload = null, attachmentError = "文件上传失败：${error.message}") }
            } catch (error: Exception) {
                _ui.update { it.copy(videoUpload = null, attachmentError = error.message ?: "文件上传失败") }
            } finally {
                videoUploadJob = null
            }
        }
    }

    /**
     * 相册/文件选到的**视频**：先走直连分片上传（P2，可到 128MB），不可用再回落内联（≤6MB）。
     *
     * 为什么不先看大小：直连是否可用只取决于主机（tailnet / 转发 / 在线），与文件大小无关；
     * 先试直连、失败再按大小决定「内联」还是「给一句能归因的错误」，对用户只需一条路径。
     *
     * 字节**始终流式读**（不在内存里拼整段）：128MB 的视频拼成 ByteArray 就是一次 OOM。
     */
    fun addVideoAttachment(uri: android.net.Uri) {
        val direct = directAttachments
        val threadId = _ui.value.openThreadId
        if (direct == null || threadId == null) {
            reportAttachmentError("先打开一个会话再选视频")
            return
        }
        if (_ui.value.videoUpload != null || _ui.value.attachmentBusy) return
        if (_ui.value.attachments.size >= MAX_ATTACHMENTS) {
            _ui.update { it.copy(attachmentError = "最多 $MAX_ATTACHMENTS 个附件") }
            return
        }
        val source = attachmentLoader.loadVideoSource(uri).getOrElse { error ->
            reportAttachmentError(error.message ?: "无法读取这个视频")
            return
        }
        _ui.update { it.copy(attachmentError = null, videoUpload = VideoUpload(source.name, 0, source.size)) }
        videoUploadJob = scope.launch {
            try {
                val storedName = direct.uploadVideo(
                    threadId = threadId,
                    originalName = source.name,
                    mimeType = source.mimeType,
                    size = source.size,
                    open = source.open,
                    posterB64 = source.posterB64,
                    // 主机声明要加密时用会话密钥派生的密钥；没有就报错，绝不默默传明文。
                    sessionKey = session?.sessionKeyOrNull(),
                    onProgress = { loaded, total ->
                        _ui.update { state -> state.copy(videoUpload = state.videoUpload?.copy(loaded = loaded, total = total)) }
                    },
                )
                if (storedName != null) {
                    _ui.update { state ->
                        state.copy(
                            videoUpload = null,
                            attachments = state.attachments + Attachment.Video(
                                storedName = storedName,
                                originalName = source.name,
                                mimeType = source.mimeType,
                                size = source.size,
                                posterB64 = source.posterB64,
                            ),
                        )
                    }
                    // 同理：自己发的视频点开也直接命中本地缓存（避免白下一遭）。
                    scope.launch { runCatching { attachmentLoader.cacheLocally(uri, "video-attachments", storedName) } }
                    return@launch
                }
                // 直连不可用 → 内联回落（受主机 8MB 内层信封限制，与旧行为一致）
                if (source.size > MAX_FILE_BYTES) {
                    _ui.update {
                        it.copy(
                            videoUpload = null,
                            attachmentError = "视频太大（${formatMb(source.size)}）：直连上传不可用，" +
                                "内联上限只有 6MB。请检查主机是否在线、Tailscale 是否通。",
                        )
                    }
                    return@launch
                }
                inlineFallback(uri, source.size)
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                _ui.update { it.copy(videoUpload = null) }
                throw cancelled
            } catch (error: DirectUploadException) {
                // 直连跑到一半失败：**把原因说出来**（HTTP 状态 / 连接错误），
                // 否则用户只看得到一个停在 0% 的进度条。小文件仍回落到内联。
                if (source.size <= MAX_FILE_BYTES) {
                    inlineFallback(uri, source.size)
                } else {
                    _ui.update {
                        it.copy(
                            videoUpload = null,
                            attachmentError = "直连上传失败：${error.message}",
                        )
                    }
                }
            } catch (error: Exception) {
                _ui.update { it.copy(videoUpload = null, attachmentError = error.message ?: "视频上传失败") }
            } finally {
                videoUploadJob = null
            }
        }
    }

    /**
     * 文件选择器选到的**音频**（P3 统一媒体通道）：先直连上传（内容寻址、可去重），
     * 消息里只带 `storedName`，主机构成 `attach="media" kind="audio"` 引用 → 快照下发 audio 块。
     *
     * 不做内联回落：主机把内联音频当普通文件（不可播），宁可如实报错。
     */
    fun addAudioAttachment(uri: android.net.Uri) {
        val direct = directAttachments
        val threadId = _ui.value.openThreadId
        if (direct == null || threadId == null) {
            reportAttachmentError("先打开一个会话再选音频")
            return
        }
        if (_ui.value.videoUpload != null || _ui.value.attachmentBusy) return
        if (_ui.value.attachments.size >= MAX_ATTACHMENTS) {
            _ui.update { it.copy(attachmentError = "最多 $MAX_ATTACHMENTS 个附件") }
            return
        }
        val source = attachmentLoader.loadAudioSource(uri).getOrElse { error ->
            reportAttachmentError(error.message ?: "无法读取这个音频")
            return
        }
        // 进度条复用视频那条（上传状态本来就只能有一个）。
        _ui.update { it.copy(attachmentError = null, videoUpload = VideoUpload(source.name, 0, source.size)) }
        videoUploadJob = scope.launch {
            try {
                val upload = direct.uploadMedia(
                    threadId = threadId,
                    originalName = source.name,
                    mimeType = source.mimeType,
                    size = source.size,
                    open = source.open,
                    sessionKey = session?.sessionKeyOrNull(),
                    onProgress = { loaded, total ->
                        _ui.update { state -> state.copy(videoUpload = state.videoUpload?.copy(loaded = loaded, total = total)) }
                    },
                )
                if (upload == null) {
                    _ui.update {
                        it.copy(
                            videoUpload = null,
                            attachmentError = "音频上传失败：直连不可用（检查主机是否在线 / Tailscale 是否通）",
                        )
                    }
                    return@launch
                }
                _ui.update { state ->
                    state.copy(
                        videoUpload = null,
                        attachments = state.attachments + Attachment.Audio(
                            storedName = upload.name,
                            originalName = source.name,
                            mimeType = source.mimeType,
                            size = source.size,
                        ),
                    )
                }
                // 本地留一份：自己发的音频点开应该**立即播放**——手机本地本来就有这个文件，
                // 不该再「上传完从主机下回来」（真机实测 18MB 白等 3–20 秒）。
                // 写在与取回路径同一个目录（audio-attachments）+ 同一个键（主机附件名）。
                scope.launch { runCatching { attachmentLoader.cacheLocally(uri, "audio-attachments", upload.name) } }
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                _ui.update { it.copy(videoUpload = null) }
                throw cancelled
            } catch (error: DirectUploadException) {
                _ui.update { it.copy(videoUpload = null, attachmentError = "音频上传失败：${error.message}") }
            } catch (error: Exception) {
                _ui.update { it.copy(videoUpload = null, attachmentError = error.message ?: "音频上传失败") }
            } finally {
                videoUploadJob = null
            }
        }
    }

    /**
     * 系统选择器选到的**任意附件**（P3）：按 mime（拿不到就看扩展名）分流到图/视/音/文件。
     *
     * 为什么放在 ViewModel：判断要用 [attachmentLoader.fileMeta]（需要 Context 才能查
     * ContentResolver），集中在这里才能让附件菜单只剩「拍照 / 附件」两项——用户不必替
     * 程序做分类，而新增一种媒体类型也不用改 UI。
     */
    fun addPickedAttachment(uri: android.net.Uri) {
        val meta = attachmentLoader.fileMeta(uri)
        val mime = meta?.mimeType
        val name = meta?.name
        when {
            mime?.startsWith("image/") == true -> addImageAttachment(uri)
            mime?.startsWith("video/") == true -> addVideoAttachment(uri)
            mime?.startsWith("audio/") == true -> addAudioAttachment(uri)
            looksLikeVideo(name, mime) -> addVideoAttachment(uri)
            looksLikeAudio(name, mime) -> addAudioAttachment(uri)
            else -> addFileAttachment(uri)
        }
    }

    /** 直连不可用时的回落：内联上传（自带 6MB 上限检查）。 */
    private fun inlineFallback(uri: android.net.Uri, size: Long) {
        val inline = attachmentLoader.loadFile(uri)
        _ui.update { state ->
            inline.fold(
                onSuccess = { state.copy(videoUpload = null, attachments = state.attachments + it) },
                onFailure = { state.copy(videoUpload = null, attachmentError = it.message ?: "视频读取失败") },
            )
        }
    }

    /** 取消正在跑的直连上传（输入条上的「取消」）。 */
    fun cancelVideoUpload() {
        videoUploadJob?.cancel()
        videoUploadJob = null
        _ui.update { it.copy(videoUpload = null, attachmentError = "已取消上传") }
    }

    /**
     * 取一个**直连播放 URL**（点开视频时先试它；拿不到就回落中继分片）。
     *
     * 只读、不需写租约；主机不可达 / 未开通转发 / 令牌取失败一律返回 null。
     */
    suspend fun directPlaybackUrl(name: String, mimeType: String?): String? {
        val direct = directAttachments ?: return null
        val threadId = _ui.value.openThreadId ?: return null
        val target = direct.requestTarget(threadId, "read", name = name, mimeType = mimeType) ?: return null
        // 主机要求加密时**不能**把 URL 交给播放器（密文它解不了）：返回 null，让界面走
        // 「取回并解密到本地文件再播」那条路（见 fetchVideoAttachment）。
        if (target.enc == AttachmentCrypto.VERSION) return null
        return target.url
    }

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

    // ---- 语音对话模式（阶段 1：半双工连续对话）----

    /**
     * 长按麦克风 3 秒进入：循环「听（静音自动收尾）→ 转写 → 发送 → 播报 → 再听」。
     *
     * 为什么是半双工：播报时若继续录音，会把 TTS 自己的声音录进去；回声消除（AEC）
     * 留阶段 2。退出：再长按一次或点浮层上的「结束」；会话被关掉也会自动退（Job 取消）。
     */
    fun startVoiceChat() {
        if (_ui.value.voiceChat != null) return
        if (threadSession == null || threadActions == null) return
        voiceChatJob = scope.launch {
            var failures = 0
            _ui.update { it.copy(voiceChat = VoiceChatState.Listening, voiceChatText = null, voiceError = null) }
            try {
                while (isActive) {
                    val transcript = listenOnce()
                    if (transcript == null) {
                        // 静音/识别失败不算致命，但连续几次就说明链路有问题，别死循环
                        if (++failures >= VOICE_MAX_FAILURES) {
                            _ui.update { it.copy(voiceError = "连续几次没识别到内容，已退出语音模式") }
                            break
                        }
                        continue
                    }
                    failures = 0
                    _ui.update { it.copy(voiceChat = VoiceChatState.Thinking, voiceChatText = transcript) }
                    if (!awaitReply(transcript)) break
                    val reply = voiceReplyText()
                    if (reply.isNotEmpty()) {
                        _ui.update { it.copy(voiceChat = VoiceChatState.Speaking) }
                        speakAndWait(reply)
                    }
                    if (isActive) _ui.update { it.copy(voiceChat = VoiceChatState.Listening) }
                }
            } finally {
                voiceSettle = null
                withContext(NonCancellable) {
                    voiceRecorder.cancel()
                    speaker.stop()
                }
                _ui.update { it.copy(voiceChat = null) }
            }
        }
    }

    fun stopVoiceChat() {
        voiceChatJob?.cancel()
        voiceChatJob = null
    }

    /** 录一段（静音或超长自动收尾）→ 送 STT。null = 没听清 / 失败。 */
    private suspend fun listenOnce(): String? {
        val gate = VoiceActivityGate()
        val finished = CompletableDeferred<Unit>()
        val startedAt = SystemClock.elapsedRealtime()
        val started = voiceRecorder.start { rms ->
            val elapsed = SystemClock.elapsedRealtime() - startedAt
            if (gate.onFrame(rms, elapsed) == VoiceGateDecision.Finish && !finished.isCompleted) {
                finished.complete(Unit)
            }
        }
        if (started.isFailure) {
            _ui.update { it.copy(voiceError = started.exceptionOrNull()?.message ?: "无法启动录音") }
            return null
        }
        // 静音判定 / 兼底时长先到者；用户退出会直接取消整个协程
        withTimeoutOrNull(VoiceActivityGate.DEFAULT_MAX_MS + 2_000L) { finished.await() }
        if (!coroutineContext.isActive) return null
        val audioB64 = voiceRecorder.stop().getOrElse { return null }
        _ui.update { it.copy(voiceChat = VoiceChatState.Transcribing) }
        val requesterRef = requester ?: return null
        return try {
            val response = requesterRef.request(
                "stt.transcribe",
                kotlinx.serialization.json.buildJsonObject {
                    put("audioB64", audioB64)
                    put("sampleRate", VoiceRecorder.SAMPLE_RATE)
                },
            )
            (response as? JsonObject)?.get("text")?.jsonPrimitive?.contentOrNull.orEmpty().trim().ifEmpty { null }
        } catch (error: Exception) {
            _ui.update { it.copy(voiceError = error.message ?: "语音识别失败") }
            null
        }
    }

    /** 发送这一句并等回合结束（settle 由视图收集器唤醒）。false = 超时/被取消。 */
    private suspend fun awaitReply(transcript: String): Boolean {
        val settled = CompletableDeferred<Unit>()
        voiceSettle = settled
        send(transcript, SendMode.Prompt, clearDraft = false)
        val ok = withTimeoutOrNull(VOICE_REPLY_TIMEOUT_MS) { settled.await() } != null
        voiceSettle = null
        if (!ok && coroutineContext.isActive) _ui.update { it.copy(voiceError = "等回复超时，已退出语音模式") }
        return ok && coroutineContext.isActive
    }

    /** 要念的回复正文：出错优先报错；空回复返回空串（直接回到「在听」）。 */
    private fun voiceReplyText(): String {
        val view = _ui.value.thread ?: return ""
        val error = view.errorBanner
        if (!error.isNullOrBlank()) return "出错了：${error.take(80)}"
        val reply = view.messages.lastOrNull { it.role == "assistant" }?.let { messageTextOf(it) }
        return Notifier.spokenReply(reply, VOICE_SPEAK_MAX_CHARS)
    }

    /** 播报并等它念完（引擎异常/被打断时有兼底超时，不让循环卡死）。 */
    private suspend fun speakAndWait(text: String) {
        val done = CompletableDeferred<Unit>()
        speaker.speak(
            text,
            onDone = { done.complete(Unit) },
            allowDuringCall = settingsStore.settings.value.speakDuringCall,
        )
        withTimeoutOrNull(VOICE_SPEAK_TIMEOUT_MS) { done.await() }
    }
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
     * 回合结束时的**语音播报**（完成通知不在这里了——它由列表轮询驱动，见 [notifyFinishedTurns]）。
     *
     * 只念「手机发起的回合」：电脑端发起的回合在电脑前跑完，手机念一遍很吵
     * （通知不设这个限制——没看着就该叫一下，但**出声念**更打扰，口径不同）。
     */
    private fun speakTurnComplete(view: ThreadView) {
        val phoneInitiated = phoneTurnStarted
        phoneTurnStarted = false
        if (!phoneInitiated) return
        if (_ui.value.voiceChat != null) return // 语音模式自己会播报回复
        val settings = settingsStore.settings.value
        if (!settings.speakTurnComplete) return
        // 通话中（含微信 VoIP）系统会把 TTS 压掉，念了也是白念，还可能被通话对方听到 →
        // 默认跳过；用户在设置里开了「通话中也播报」就照样试一把。
        if (speaker.inCall() && !settings.speakDuringCall) return
        val title = view.summary?.title
        val reply = view.messages.lastOrNull { it.role == "assistant" }?.let { messageTextOf(it) }
        speaker.speak(
            Notifier.turnCompleteSpeech(settings.voiceSpeechContent, title, reply, settings.voiceFixedPhrase),
            allowDuringCall = settings.speakDuringCall,
        )
    }

    /**
     * 「飞书已读」式的完成通知：**只看会话状态，不区分谁发起的回合**。
     *
     * 为什么不再挂在 threadSession 的 running→false 上（上一版的做法）：只有**当前打开的那个
     * 会话**才有这个回调，用户一划走 / 断连就丢事件，通知永远不来（真机反馈 + 主机 diag 里
     * 成串的 `remote-conn closed … relay-device-offline` 为证）；而且它只认「手机发起」，
     * 与「只要我没看着就该通知我」相反。
     *
     * 现在看**主机列表快照**（连接在线时每 5 秒轮询一次）：上一轮还在 Running、这一轮不在了的
     * 会话就是「刚跑完」。正在看这个会话才不打扰（炨屏/锁屏也算离开，见 [AppVisibility]）。
     */
    private fun notifyFinishedTurns(snapshot: HostSnapshot) {
        val states = snapshot.allThreads.associate { it.id to it.state }
        val finished = snapshot.allThreads.filter { thread ->
            lastThreadStates[thread.id] == RemoteThreadState.Running &&
                thread.state != RemoteThreadState.Running
        }
        lastThreadStates = states
        if (finished.isEmpty()) return

        val settings = settingsStore.settings.value
        val watchingThreadId = if (AppVisibility.isForegroundNow()) _ui.value.openThreadId else null
        val stamp = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date())
        finished.forEach { thread ->
            val watching = watchingThreadId == thread.id
            val reason = when {
                !settings.notifyOnTurnComplete -> "跳过：设置里已关闭"
                watching -> "跳过：正在看这个会话"
                else -> "已通知"
            }
            _ui.update { it.copy(lastTurnNotify = "$reason（${AppVisibility.detail()} · $stamp）") }
            if (Notifier.shouldNotifyTurnComplete(settings.notifyOnTurnComplete, watching)) {
                notifier.notifyTurnComplete(
                    thread.id,
                    thread.title,
                    Notifier.turnCompleteText(thread.preview, null),
                )
            }
        }
    }

    /**
     * 诊断页的「测试通知」：**12 秒后**发一条与「对话完成」同渠道的测试通知。
     *
     * 为什么要延迟：得给用户时间切到后台 / 熄屏——只有那样测的才是「后台能不能弹」，
     * 前台弹一条只能说明渠道没被关。通知状态（权限 + 渠道）本身在诊断页有单独一行。
     */
    fun testNotification() {
        _ui.update {
            it.copy(lastTurnNotify = "测试通知已安排：12 秒后弹出（现在切后台或熄屏等着）")
        }
        scope.launch {
            delay(12_000)
            notifier.notifyTest("测试通知 · 判定依据 ${AppVisibility.detail()}")
        }
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
     * 成功/失败都**不关 Sheet**——用户可能还要连改几项（权限→模型→思考档位），
     * 每设一项就收起一次反而要反复重开；关闭交给用户自己（下滑 / 返回手势）。
     */
    private fun configAction(block: suspend (ThreadActions) -> Unit) {
        val actions = threadActions ?: return
        if (_ui.value.configBusy) return
        _ui.update { it.copy(configBusy = true, configError = null) }
        scope.launch {
            try {
                block(actions)
                _ui.update { it.copy(configBusy = false, configError = null) }
            } catch (error: Exception) {
                _ui.update { it.copy(configBusy = false, configError = error.message ?: "设置失败") }
            }
        }
    }

    private fun send(text: String, mode: SendMode, clearDraft: Boolean = true, retried: Boolean = false) {
        val session = threadSession ?: return
        val actions = threadActions ?: return
        // 附件：图片与文件分别按协议形状打包（主机端会逐项校验）。
        // 图片（P3）：直连上传成功的是「key + 缩略图」，未成功的是内联 base64——由
        // imagePayloads 统一组装（纯函数，单测钉住了两种形状）。
        val pending = _ui.value.attachments
        val images = imagePayloads(pending)
        val files = pending.filterIsInstance<Attachment.File>().map { file ->
            kotlinx.serialization.json.buildJsonObject {
                put("name", file.name)
                put("data", file.bytesB64)
                if (file.mimeType != null) put("mimeType", file.mimeType)
                // 视频的首帧封面：主机落盘后用它当气泡封面（快照不再下发视频本体）。
                file.posterB64?.let { poster ->
                    put("poster", poster)
                    put("posterMimeType", "image/jpeg")
                }
            }
        }
        // 直连上传完成的视频：字节已在主机附件区，消息里**只带主机的附件名**（零字节）。
        val videos = pending.filterIsInstance<Attachment.Video>().map { video ->
            kotlinx.serialization.json.buildJsonObject {
                put("type", "video")
                put("mimeType", video.mimeType)
                put("data", "")
                put("size", video.size)
                put("storedName", video.storedName)
                video.posterB64?.let { poster ->
                    put("poster", poster)
                    put("posterMimeType", "image/jpeg")
                }
            }
        }
        // P3 统一媒体通道：音频只带 storedName（纯函数组装，单测钉住形状）。
        val media = mediaPayloads(pending)
        // 先乐观上屏（§1.1：点击到视觉反馈 < 100ms），失败再标红留在原位
        // 图片用**本地字节**上屏：事件通道会把大 base64 截断（会变成「图片无法显示」），
        // 主机那份完整的图由随后的快照替换。
        val localImageBlocks = pending.mapNotNull { image ->
            when (image) {
                is Attachment.Image ->
                    MessageBlock(type = BlockType.Image, data = image.bytesB64, mimeType = image.mimeType)
                // keyed 图片：本地只有缩略图，先拿它顶上（快照回来前不空缺）。
                is Attachment.ImageKeyed ->
                    MessageBlock(type = BlockType.Image, data = image.thumbB64, mimeType = "image/jpeg")
                else -> null
            }
        }
        // 视频同理：气泡先上封面（快照回来前不空缺）。名字用主机的附件名（就是它以后取字节的 key），
        // 所以点开就能直连播——不必等快照。
        val localVideoBlocks = pending.filterIsInstance<Attachment.Video>().map { video ->
            MessageBlock(
                type = BlockType.Video,
                name = video.storedName,
                mimeType = video.mimeType,
                size = video.size,
                poster = video.posterB64,
                posterMimeType = "image/jpeg",
                omitted = true,
            )
        }
        // 音频同理：气泡先上一个占位条（可读名/大小），快照回来前不空缺。
        val localAudioBlocks = pending.filterIsInstance<Attachment.Audio>().map { audio ->
            MessageBlock(
                type = BlockType.Audio,
                name = audio.storedName,
                mimeType = audio.mimeType,
                size = audio.size,
                label = audio.originalName,
                omitted = true,
            )
        }
        // 大文件（P3-S2）：字节已经在主机的工作目录里，消息里只需带**绝对路径**。
        // 信封写进 text（与桌面端拖入文件同一形式），agent 用文件工具就能读。
        val workspaceFiles = pending.filterIsInstance<Attachment.WorkspaceFile>()
        val workspaceEnvelopes = workspaceFiles.joinToString("") { file ->
            "\n\n<file name=\"${file.name.replace("\"", "&quot;")}\" path=\"${file.path.replace("\"", "&quot;")}\" note=\"attached file; read it with file tools\" />"
        }
        val localId = session.echoUserMessage(text, localImageBlocks + localVideoBlocks + localAudioBlocks)
        // 后台/锁屏播报保活：**点击就抢锁**，而不是等 send RPC 回来。
        // 用户按下 home/锁屏只发生在发出后的几十毫秒内，等成功后（几百 ms）再 acquire
        // 会赶不及——2026-09-26 真机就是切后台 ~1s 内被中继判 relay-device-offline。
        // acquire 幂等，异常/失败由 30 分钟超时兜底。
        if (settingsStore.settings.value.speakInBackground) turnWakeLock.acquire()
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
                val result = actions.send(text + workspaceEnvelopes, mode, images, files, videos, media)
                // 手机发起的回合：现在只影响「是否语音播报」（完成通知与谁发起无关，见
                // notifyFinishedTurns 的飞书已读口径）。
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
                // 回合没能开跑，随手释放上面乐观抢到的保活锁
                turnWakeLock.release()
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

    /**
     * 回到前台时踢一次重连（MpiApp 在前后台变化时调用）。
     *
     * 长时间后台后连接已死，而自动重连是按退避走的（最长 30s）——不等退避就能立刻恢复，
     * 不用再「完全关掉 App」。
     */
    fun kickConnection() {
        session?.kick()
    }

    // ---- 内部 ----

    /**
     * 「对话即主页」：连上并拿到列表后，自动进**运行中**优先、否则最近更新的那个会话。
     * 没有首屏会话列表了，所以这一步不能省——否则连上后只看到一片引导。
     * 只在每次 attach 后做一次；用户自己开/关过会话后不再打扰。
     */
    private fun maybeAutoOpenThread(snapshot: HostSnapshot) {
        synchronized(openLock) {
            if (autoOpenedThread || _ui.value.openThreadId != null) return
            if (pendingThreadOpen.value != null) return // 通知深链优先
            if (session == null || requester == null) return
            // 认证没完成就开会话 = 必吃 NotReady（「连接未就绪」）——等它就绪后再开。
            // 上面的 autoOpenedThread 在这里**不消费**，所以认证完成后仍会开一次。
            if (session?.isAuthenticated != true) return
            val threads = snapshot.allThreads
            if (threads.isEmpty()) return
            // 「上一次打开的会话」优先：「最近打开」比「最近更新」更贴近用户预期，
            // 也不受列表排序/主机缓存影响。
            // 它必须在 cachedAt 判断**之前**——命中就说明缓存里就有这条，断网时
            // 照样能秒开上次那个会话；反过来先 return 会让离线启动什么都不打开。
            val remembered = threads.firstOrNull { it.id == lastThread.threadId }
            // 命不中才需要猜；而猜（Running 优先 / updatedAt 最新）必须等**真实**列表：
            // 首帧常是本地缓存列表（cachedAt != null），可能还没有刚新建的会话，
            // 拿它决定会选错（2026-09-26 真机：新建会话发完消息重启，进的是旧会话）。
            if (remembered == null && snapshot.cachedAt != null) return
            val target = remembered
                ?: threads.firstOrNull { it.state == RemoteThreadState.Running }
                ?: threads.first()
            // 先消费掉「每次 attach 只自动开一次」的机会再动手：
            // 否则它与用户新建会话并发时，会晚一步把界面抢回运行中那条。
            autoOpenedThread = true
            openThreadLocked(target.id)
        }
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
            // 请求超时但连接还在：**不要走同 socket 重认证**。R1 之后 relay 只在 socket
            // 真换掉时才通知主机，所以同 socket 的 hello 永远等不到新挑战（构造上不可能成功）
            // ——只会在 20s 后超时再重试，把 App 卡在「认证中」（真机日志：中继上每 20~40 秒
            // 一次 hello，连着十几次，期间发消息全是「连接未就绪」）。
            // 正确做法：标记订阅失效，下一次 resync/发送前的 ensureSubscribed 会重新注册订阅。
            onStaleConnection = { threadSession?.invalidateSubscription() },
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
                    // 认证前被跳过的「自动开一次会话」在这里补上（那时 session 还没就绪）
                    repository?.snapshot?.value?.let { maybeAutoOpenThread(it) }
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
                notifyFinishedTurns(snapshot)
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
        turnWakeLock.release()
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

        // ---- 语音对话模式（阶段 1）----

        /** 连续几次没识别到内容就退出（避免没配 STT 时死循环）。 */
        private const val VOICE_MAX_FAILURES = 3
        /** 等回复的上限：agent 跑工具可能很久，但无限静默不如明确退出。 */
        private const val VOICE_REPLY_TIMEOUT_MS = 5 * 60_000L
        /** 一次最多念多少字的回复——语音聊天里念全文就是灾难。 */
        private const val VOICE_SPEAK_MAX_CHARS = 300
        /** 播报兼底超时（TextToSpeech 没回调时不让循环卡死）。 */
        private const val VOICE_SPEAK_TIMEOUT_MS = 90_000L

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
                        container.turnWakeLock,
                        container.networkWatcher,
                        container.lastThread,
                    ) as T
            }
    }
}
