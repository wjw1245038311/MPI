package com.mpi.app.ui

import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import android.content.Context
import java.io.File
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mpi.app.data.Attachment
import com.mpi.app.data.ThreadView
import com.mpi.app.data.VoiceSpeechContent
import com.mpi.app.protocol.BlockType
import com.mpi.app.protocol.MessageBlock
import com.mpi.app.protocol.RemotePermission
import com.mpi.app.protocol.ThreadMessage
import com.mpi.app.ui.theme.MpiTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/**
 * 大视频**按需拉取**的实现（点开才拉）。由 AppViewModel 通过 CompositionLocalProvider 提供
 * （见 MpiApp），默认实现返回 null＝不可用。
 *
 * 为什么走 CompositionLocal 而不是逐层传参：视频块嵌在「消息行 → 块列表 → Block 分发」
 * 好几层里，逐层加参数会污染每个中间组件的签名（PWA 侧用滚动容器上的事件委托避开同一问题）。
 * 参数：(附件名, 目标文件, 进度回调) → 是否成功。目标文件已存在且非空时实现方应直接返回 true
 * （拉过的视频缓在 cacheDir，下次点开不应再走网络）。
 */
val LocalVideoFetcher = staticCompositionLocalOf<suspend (String, File, (Long, Long) -> Unit) -> Boolean> {
    // 外层是 defaultFactory: () -> T，内层才是真正的拉取函数（默认不可用）。
    { _, _, _ -> false }
}

/**
 * 会话视图（§4.4）：顶栏 + 消息流。
 *
 * 错误一律**顶部横幅 + 可操作按钮**（§1.1），不遮住内容；滚动跟随在用户手动上滑时
 * 自动停止，并浮出「回到底部」——避免读到一半被流式输出拽走。
 */
@Composable
fun ThreadScreen(
    view: ThreadView,
    draft: String,
    sending: Boolean,
    responding: Boolean,
    respondError: String?,
    onBack: () -> Unit,
    onResync: () -> Unit,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
    onAbort: () -> Unit,
    onRetry: (String) -> Unit,
    onRespond: (kotlinx.serialization.json.JsonObject) -> Unit,
    onSendChoice: (String) -> Unit,
    onOpenSettings: () -> Unit,
    onOpenSearch: () -> Unit,
    /** 双击顶栏标题 → 快速重命名（与侧栏长按菜单同语义）。 */
    onRenameTitle: (String) -> Unit,
    /** 是否显示工具/终端调用行（本地设置，默认显示；开关在设置页「对话分栏」）。 */
    showToolCalls: Boolean,
    /** 是否显示思考过程块（本地设置，默认显示；设置页「对话分栏」同源）。 */
    showThinking: Boolean,
    /** 语音输出快捷设置（标题旁喇叭图标）：与 SettingsScreen 三项同语义。 */
    speakTurnComplete: Boolean,
    voiceSpeechContent: VoiceSpeechContent,
    speakDuringCall: Boolean,
    onSetSpeakTurnComplete: (Boolean) -> Unit,
    onSetVoiceSpeechContent: (VoiceSpeechContent) -> Unit,
    onSetSpeakDuringCall: (Boolean) -> Unit,
    choiceDrafts: Map<String, ChoiceAnswer>,
    onChoiceDraftChange: (String, ChoiceAnswer?) -> Unit,
    onClearChoiceDrafts: (String) -> Unit,
    attachments: List<Attachment>,
    attachmentBusy: Boolean,
    attachmentError: String?,
    onPickImage: (Uri) -> Unit,
    onPickFile: (Uri) -> Unit,
    onAttachmentPermissionDenied: () -> Unit,
    onRemoveAttachment: (Int) -> Unit,
    onDismissAttachmentError: () -> Unit,
    recording: Boolean,
    transcribing: Boolean,
    voiceError: String?,
    onStartVoice: () -> Unit,
    onStopVoice: () -> Unit,
    onCancelVoice: () -> Unit,
    /** 长按麦克风 3 秒：进入语音对话模式（阶段 1）。 */
    onStartVoiceChat: () -> Unit,
    onVoicePermissionDenied: () -> Unit,
    onDismissVoiceError: () -> Unit,
    /** 语音对话模式状态（null = 未开启）；开启时在输入条上方显示状态条。 */
    voiceChat: VoiceChatState?,
    /** 语音模式下最近一句识别到的文本（显示在状态条里）。 */
    voiceChatText: String?,
    onStopVoiceChat: () -> Unit,
    /** 会话节点面板状态：**手势挂在消息区那个 Box 上**（判定区域 = 消息区，不含输入框），
     *  面板本体也在这里渲染与滚动定位。 */
    nodePanel: NodePanelState,
    pendingFollowUp: String?,
    sendError: String?,
    /** 主机回退成排队时的说明（非错误；气泡仍会停在「发送中」直到 pi 投递）。 */
    sendNote: String?,
    onDismissSendNote: () -> Unit,
    onSteerPending: () -> Unit,
    onReEditPending: () -> Unit,
    onDismissSendError: () -> Unit,
    configSheetOpen: Boolean,
    configBusy: Boolean,
    configError: String?,
    onOpenConfigSheet: () -> Unit,
    onDismissConfigSheet: () -> Unit,
    onDismissConfigError: () -> Unit,
    onSetPermission: (RemotePermission) -> Unit,
    onSetModel: (String, String) -> Unit,
    onSetThinking: (String) -> Unit,
    onSetMode: (String) -> Unit,
    onCompact: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val listState = rememberLazyListState()
    val renderable = view.renderable
    val atBottom by remember { derivedStateOf { !listState.canScrollForward } }
    // 工具/思考块隐藏时的可见列表（纯函数，可单测）：只影响展示，不影响 allMessages 的状态推导
    // 点击消息里的图片 → 全屏预览（见 ImagePreviewDialog）。
    var previewImage by remember { mutableStateOf<ImageBitmap?>(null) }
    val showThinkingPlaceholder = shouldShowThinkingPlaceholder(view)
    val display = visibleMessages(renderable, showToolCalls, showThinking)
        // 占位行出现时，把「已 start 但一个块都没有」的流式消息从列表里摘掉：
        // 否则会先渲染一个只有头像的空行（MessageRow 对空 blocks 只画头像），
        // 紧接着再跟着我们的占位行——屏上会出现两个「M」头像。
        .let { list ->
            if (showThinkingPlaceholder) {
                list.filterNot { it.id == view.streaming?.id && !hasVisibleContent(it) }
            } else {
                list
            }
        }

    // ---- 会话节点（右边缘左划拉出）----
    // 节点 = 用户消息（与桌面端左侧用户消息导航同口径）；索引按 display 算，可直接定位滚动。
    val nodes = userMessageNodes(display)
    val jumpScope = rememberCoroutineScope()

    // 「贴底跟随」记的是**用户意图**：只有用户自己往回滚才取消，内容增长本身不算。
    // 旧写法直接拿 atBottom 当跟随条件：增量事件常早于测量，滚动会停在半路，
    // 此后 canScrollForward 一直为 true → 永远不再跟随，必须手动拖到底（真机反馈）。
    // 改成意图态后，每次增量都会再贴一次底，偶发半路停住也能自愈。
    var following by remember { mutableStateOf(true) }
    LaunchedEffect(listState) {
        snapshotFlow { listState.isScrollInProgress to listState.lastScrolledBackward }
            .collect { (scrolling, backward) ->
                following = nextFollowing(following, scrolling, backward, listState.canScrollForward)
            }
    }

    // 内容增长时，只要还在跟随就贴底。key 取「消息数 + 流式内容总长度」：
    // 只看最后一块的长度会漏掉「变的不是最后一块」（如工具结果回填）。
    val streamLength = view.streaming?.blocks?.sumOf { it.text?.length ?: 0 } ?: 0
    LaunchedEffect(display.size, streamLength, showThinkingPlaceholder) {
        if (following && display.isNotEmpty()) {
            // 必须用大 offset 真滚到底：scrollToItem(lastIndex) 只是把最后一条的“顶部”
            // 对齐视口，最后一条很长时仍可下滚，atBottom 就永远为 false（按钮不消失）。
            // 占位行是 display 之外的第 size 个 item，贴底得滚到它。
            val lastItem = if (showThinkingPlaceholder) display.size else display.lastIndex
            listState.scrollToItem(lastItem, Int.MAX_VALUE)
        }
    }

    // safeDrawingPadding：同时避让状态栏（截图里标题被时间压住）、手势条与键盘
    // 根用 Box：图片预览要做成**真·全屏覆盖层**。Dialog 在这个 Compose 版本下会被
    // 平台默认宽度限制住（实测只铺中间一块），所以自己搭一层，才能盖住顶栏与输入条。
    Box(modifier) {
    Column(Modifier.fillMaxSize().safeDrawingPadding()) {
        ThreadTopBar(
            title = view.summary?.title?.ifEmpty { null } ?: "会话",
            compacting = view.compacting,
            speakTurnComplete = speakTurnComplete,
            voiceSpeechContent = voiceSpeechContent,
            speakDuringCall = speakDuringCall,
            onSetSpeakTurnComplete = onSetSpeakTurnComplete,
            onSetVoiceSpeechContent = onSetVoiceSpeechContent,
            onSetSpeakDuringCall = onSetSpeakDuringCall,
            onBack = onBack,
            onOpenSettings = onOpenSettings,
            onOpenSearch = onOpenSearch,
            onRenameTitle = onRenameTitle,
        )

        if (configError != null) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 2.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(MpiTheme.colors.surfaceMuted)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = configError,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onDismissConfigError) { Text("知道了") }
            }
        }

        if (view.errorBanner != null) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 4.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(MpiTheme.colors.surfaceMuted)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = view.errorBanner,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onResync) { Text("重新同步") }
            }
        }

        if (view.showingCached) {
            // 简洁一句：一个圈圈 + 「加载中…」就够。
            // 之前写「离线：显示本地缓存（刚刚），正在获取最新内容…」——信息量给足了，
            // 但没人需要读这一句（用户反馈：标题下面话太多）。
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 4.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(MpiTheme.colors.surfaceMuted)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CircularProgressIndicator(
                    modifier = Modifier.size(13.dp),
                    strokeWidth = 2.dp,
                    color = MpiTheme.colors.textDim,
                )
                Text(
                    text = "加载中…",
                    style = MaterialTheme.typography.bodySmall,
                    color = MpiTheme.colors.textDim,
                    modifier = Modifier.padding(start = 8.dp),
                )
            }
        }

        Box(
            Modifier
                .weight(1f)
                // 判定区域 = 这个消息区 Box：输入框/顶栏不在里面，所以它们的手势不受影响
                .edgeSwipeNodePanel(nodePanel),
        ) {
            // 图片块拿不到 ThreadScreen 的 state（隔了好几层），用 CompositionLocal 把
            // 「打开预览」这件事传下去，免得为一张图把回调穿过整条渲染链。
            CompositionLocalProvider(LocalImagePreviewer provides { previewImage = it }) {
            when {
                !view.ready -> CenteredHint(text = "正在载入会话…", loading = true)

                display.isEmpty() -> CenteredHint(text = "这个会话还没有消息")

                else -> LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(vertical = 10.dp),
                ) {
                    items(display, key = { it.id }) { message ->
                        MessageRow(
                            message = message,
                            onRetry = onRetry,
                            allMessages = renderable,
                            finalized = message.id != view.streaming?.id,
                            onSendChoice = onSendChoice,
                            threadId = view.threadId,
                            drafts = choiceDrafts,
                            onDraftChange = onChoiceDraftChange,
                            onClearDrafts = onClearChoiceDrafts,
                        )
                    }
                    // prefill 等待占位：agent 在跑但还没有流式消息（本地模型可达数十秒），
                    // 与桌面端同一谓词（见 ThinkingIndicator.kt）。
                    if (showThinkingPlaceholder) {
                        item(key = "thinking-placeholder") { ThinkingPlaceholderRow() }
                    }
                }
            }
            }

            NodePanelLayer(
                nodes = nodes,
                activeIndex = { listState.firstVisibleItemIndex },
                state = nodePanel,
                panelWidth = NODE_PANEL_WIDTH,
                onJump = { node ->
                    nodePanel.close()
                    val index = display.indexOfFirst { it.id == node.id }
                    if (index >= 0) jumpScope.launch { listState.animateScrollToItem(index) }
                },
            )

            if (!atBottom && display.isNotEmpty()) {
                ScrollToBottomButton(
                    listState = listState,
                    itemCount = display.size,
                    // 手动回到底部 = 重新跟随，否则下一条增量又不会自动跟
                    onFollowAgain = { following = true },
                    modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 6.dp),
                )
            }
        }

        // 审批卡停在输入条上方：agent 此刻停住等回应，而用户可能正在上面翻上下文
        view.pendingUi?.let { request ->
            ApprovalCard(
                request = request,
                responding = responding,
                error = respondError,
                onRespond = onRespond,
            )
        }

        // 语音模式：状态条贴在输入条上方，**消息区照旧可见**（不做全屏浮层，
        // 否则把对话盖住了——语音只是输入方式，对话才是主体）
        voiceChat?.let { state ->
            VoiceChatBar(state = state, lastText = voiceChatText)
        }

        Composer(
            draft = draft,
            onDraftChange = onDraftChange,
            sending = sending,
            running = view.running,
            attachments = attachments,
            attachmentBusy = attachmentBusy,
            attachmentError = attachmentError,
            onPickImage = onPickImage,
            onPickFile = onPickFile,
            onAttachmentPermissionDenied = onAttachmentPermissionDenied,
            onRemoveAttachment = onRemoveAttachment,
            onDismissAttachmentError = onDismissAttachmentError,
            recording = recording,
            transcribing = transcribing,
            voiceError = voiceError,
            onStartVoice = onStartVoice,
            onStopVoice = onStopVoice,
            onCancelVoice = onCancelVoice,
            onStartVoiceChat = onStartVoiceChat,
            onVoicePermissionDenied = onVoicePermissionDenied,
            onDismissVoiceError = onDismissVoiceError,
            voiceChatActive = voiceChat != null,
            onStopVoiceChat = onStopVoiceChat,
            pendingFollowUp = pendingFollowUp,
            sendError = sendError,
            sendNote = sendNote,
            onDismissSendNote = onDismissSendNote,
            usageLabel = readContextUsage(view.contextUsage).let { ctx ->
                if (ctx.hasValue) "${ctx.percent.roundToInt()}%" else "—"
            },
            onOpenModelContext = onOpenConfigSheet,
            onSend = onSend,
            onAbort = onAbort,
            onSteerPending = onSteerPending,
            onReEditPending = onReEditPending,
            onDismissSendError = onDismissSendError,
        )

        if (configSheetOpen) {
            ConfigSheet(
                view = view,
                busy = configBusy,
                error = configError,
                onDismiss = onDismissConfigSheet,
                onSetPermission = onSetPermission,
                onSetModel = onSetModel,
                onSetThinking = onSetThinking,
                onSetMode = onSetMode,
                onCompact = onCompact,
                onRefresh = onResync,
            )
        }
    }
    // 预览盖在最上层（含顶栏与输入条）：真正的「全屏」。
    previewImage?.let { ImagePreviewOverlay(it, onClose = { previewImage = null }) }
    }
}

/**
 * 底部输入条（§4.4）。
 *
 * 运行中时语义自动变为「追加指令」（steer），发送键改成「追加」并额外给出「停止」——
 * 与桌面端一致，也避免用户在 agent 跑着时误以为自己在开新话题。
 */
@Composable
private fun Composer(
    draft: String,
    onDraftChange: (String) -> Unit,
    sending: Boolean,
    running: Boolean,
    attachments: List<Attachment>,
    attachmentBusy: Boolean,
    attachmentError: String?,
    onPickImage: (Uri) -> Unit,
    onPickFile: (Uri) -> Unit,
    onAttachmentPermissionDenied: () -> Unit,
    onRemoveAttachment: (Int) -> Unit,
    onDismissAttachmentError: () -> Unit,
    recording: Boolean,
    transcribing: Boolean,
    voiceError: String?,
    onStartVoice: () -> Unit,
    onStopVoice: () -> Unit,
    onCancelVoice: () -> Unit,
    onStartVoiceChat: () -> Unit,
    onVoicePermissionDenied: () -> Unit,
    onDismissVoiceError: () -> Unit,
    voiceChatActive: Boolean,
    onStopVoiceChat: () -> Unit,
    pendingFollowUp: String?,
    sendError: String?,
    /** 主机回退成排队时的说明（非错误）。 */
    sendNote: String?,
    onDismissSendNote: () -> Unit,
    /** 用量百分比（显示在圆钮里）；模型 / 压缩 / 刷新共用同一个面板入口。 */
    usageLabel: String,
    onOpenModelContext: () -> Unit,
    onSend: () -> Unit,
    onAbort: () -> Unit,
    onSteerPending: () -> Unit,
    onReEditPending: () -> Unit,
    onDismissSendError: () -> Unit,
) {
    // 相册（Android 13+ 系统照片选择器，无需权限）/ 任意文件
    // 拍照：写一个 cacheDir 文件 → FileProvider 交给系统相机 → 结果 URI 回本应用
    val context = LocalContext.current
    var photoUri by remember { mutableStateOf<Uri?>(null) }
    val takePicture = rememberLauncherForActivityResult(
        ActivityResultContracts.TakePicture(),
    ) { ok ->
        val uri = photoUri
        photoUri = null
        if (ok && uri != null) onPickImage(uri)
    }

    fun launchPhoto() {
        val file = java.io.File(context.cacheDir, "mpi-photo-${System.currentTimeMillis()}.jpg")
        val uri = androidx.core.content.FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            file,
        )
        photoUri = uri
        takePicture.launch(uri)
    }

    // 已声明 CAMERA 权限时，系统相机会要求它已授予
    val cameraPermissionForPhoto = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> if (granted) launchPhoto() else onAttachmentPermissionDenied() }

    val pickImages = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(3),
    ) { uris -> uris.forEach(onPickImage) }
    val pickFiles = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris -> uris.forEach(onPickFile) }
    // 已授权时 RequestPermission 会立即回调 true，无需先查权限
    // 长按 3 秒的语音模式：与普通点击共用同一个权限申请，用一个标记区分拿到权限后干什么
    var pendingVoiceChat by remember { mutableStateOf(false) }
    val micPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            if (pendingVoiceChat) onStartVoiceChat() else onStartVoice()
        } else {
            onVoicePermissionDenied()
        }
        pendingVoiceChat = false
    }
    var attachMenuOpen by remember { mutableStateOf(false) }

    Column {
        if (attachmentError != null) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(MpiTheme.colors.bg)
                    .padding(start = 12.dp, end = 4.dp, top = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = attachmentError,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onDismissAttachmentError) { Text("知道了") }
            }
        }

        if (voiceError != null) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(MpiTheme.colors.bg)
                    .padding(start = 12.dp, end = 4.dp, top = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = voiceError,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onDismissVoiceError) { Text("知道了") }
            }
        }

        if (attachments.isNotEmpty()) {
            AttachmentBar(attachments = attachments, onRemove = onRemoveAttachment)
        }
        // 发送 / 停止失败贴输入框显示（PWA 语义）：这里才是手指所在的位置。
        if (sendNote != null) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(MpiTheme.colors.bg)
                    .padding(start = 12.dp, end = 4.dp, top = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = sendNote,
                    style = MaterialTheme.typography.bodySmall,
                    color = MpiTheme.colors.textDim,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onDismissSendNote) { Text("知道了") }
            }
        }

        if (sendError != null) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(MpiTheme.colors.bg)
                    .padding(start = 12.dp, end = 4.dp, top = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = sendError,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onDismissSendError) { Text("知道了") }
            }
        }

        if (pendingFollowUp != null) {
            PendingFollowUpBanner(text = pendingFollowUp, onReEdit = onReEditPending, onSteer = onSteerPending)
        }

        // composer 卡片（对齐套壳版：输入在上、按钮行在下）
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 6.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(MpiTheme.colors.surfaceMuted)
                .border(1.dp, MpiTheme.colors.border, RoundedCornerShape(16.dp))
                .padding(horizontal = 10.dp, vertical = 6.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            // 输入区：整行、无描边
            Box(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 8.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                if (draft.isEmpty()) {
                    Text(
                        text = when {
                            running && pendingFollowUp != null -> "再排一条…"
                            running -> "输入插话…发送后排队，任务完成时自动发出"
                            else -> "说点什么…"
                        },
                        style = MaterialTheme.typography.bodyLarge,
                        color = MpiTheme.colors.textFaint,
                    )
                }
                BasicTextField(
                    value = draft,
                    onValueChange = onDraftChange,
                    modifier = Modifier.fillMaxWidth(),
                    textStyle = MaterialTheme.typography.bodyLarge.copy(
                        color = MaterialTheme.colorScheme.onSurface,
                    ),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    maxLines = 6,
                )
            }

            // 按钮行（套壳版 .composer-row）
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Box {
                    RoundIconButton(
                        onClick = { attachMenuOpen = true },
                        enabled = !attachmentBusy && attachments.size < 3,
                        background = MpiTheme.colors.control,
                    ) {
                        if (attachmentBusy) {
                            CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                        } else {
                            Icon(
                                IconPlus,
                                contentDescription = "添加附件",
                                tint = MpiTheme.colors.textDim,
                                modifier = Modifier.size(17.dp),
                            )
                        }
                    }
                    DropdownMenu(expanded = attachMenuOpen, onDismissRequest = { attachMenuOpen = false }) {
                        DropdownMenuItem(
                            text = { Text("拍照") },
                            onClick = {
                                attachMenuOpen = false
                                cameraPermissionForPhoto.launch(android.Manifest.permission.CAMERA)
                            },
                        )
                        DropdownMenuItem(
                            text = { Text("相册") },
                            onClick = {
                                attachMenuOpen = false
                                pickImages.launch(
                                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                                )
                            },
                        )
                        DropdownMenuItem(
                            text = { Text("文件") },
                            onClick = {
                                attachMenuOpen = false
                                pickFiles.launch(arrayOf("*/*"))
                            },
                        )
                    }
                }

                Spacer(Modifier.weight(1f))

                Spacer(Modifier.weight(1f))

                // 按钮行统一成圆形按钮（真机诉求：＋ / 话筒 / 发送 大小要均衡）
                // 模型 + 用量合成一个圆钮，放在话筒左边
                RoundIconButton(
                    onClick = onOpenModelContext,
                    background = MpiTheme.colors.control,
                ) {
                    Text(
                        text = usageLabel,
                        style = MaterialTheme.typography.labelSmall,
                        color = MpiTheme.colors.textDim,
                        maxLines = 1,
                    )
                }

                when {
                    // 语音模式开着：这颗钮就是开关（图标已换成声波，点一下退出）
                    voiceChatActive -> {
                        RoundIconButton(onClick = onStopVoiceChat, background = MpiTheme.colors.accentSoft) {
                            Icon(IconVoiceChat, contentDescription = "语音对话中（点一下结束）", tint = MpiTheme.colors.send, modifier = Modifier.size(17.dp))
                        }
                    }

                    transcribing -> {
                        RoundIconButton(onClick = {}, enabled = false, background = MpiTheme.colors.control) {
                            CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                        }
                    }

                    recording -> {
                        RoundIconButton(onClick = onCancelVoice, background = MpiTheme.colors.control) {
                            Icon(IconClose, contentDescription = "取消录音", tint = MpiTheme.colors.textDim, modifier = Modifier.size(17.dp))
                        }
                        RoundIconButton(onClick = onStopVoice, background = MpiTheme.colors.control) {
                            Icon(IconMic, contentDescription = "结束录音并转文字", tint = MpiTheme.colors.err, modifier = Modifier.size(17.dp))
                        }
                    }

                    else -> {
                        RoundIconButton(
                            onClick = { micPermission.launch(android.Manifest.permission.RECORD_AUDIO) },
                            enabled = !sending,
                            background = MpiTheme.colors.control,
                            // 长按 3 秒 → 语音对话模式（与点一下的「语音输入」区分开）
                            onLongHold = {
                                pendingVoiceChat = true
                                micPermission.launch(android.Manifest.permission.RECORD_AUDIO)
                            },
                        ) {
                            Icon(IconMic, contentDescription = "语音输入（长按 3 秒进入语音对话）", tint = MpiTheme.colors.textDim, modifier = Modifier.size(17.dp))
                        }
                    }
                }

                if (running) {
                    RoundIconButton(onClick = onAbort, enabled = !sending, background = MpiTheme.colors.control) {
                        Icon(IconStop, contentDescription = "停止", tint = MpiTheme.colors.err, modifier = Modifier.size(16.dp))
                    }
                }

                val hasContent = draft.isNotBlank() || attachments.isNotEmpty()
                // 空输入时不显示发送键，有内容才出现
                if (hasContent) {
                    RoundIconButton(
                        onClick = onSend,
                        enabled = !sending,
                        background = if (sending) MpiTheme.colors.control else MpiTheme.colors.send,
                    ) {
                        Icon(
                            IconSend,
                            contentDescription = if (running) "发送（排队）" else "发送",
                            tint = if (sending) MpiTheme.colors.textFaint else MpiTheme.colors.sendFg,
                            modifier = Modifier.size(16.dp),
                        )
                    }
                }
            }
        }
    }
}

/**
 * 「待处理后续」横幅（PWA `.pending-fu`）：运行中发送的内容先暂存，回合结束后自动投递。
 * 两个动作：✎ 取回输入框重编，⚡ 立即插入（steer，打断当前回合马上处理）。
 */
@Composable
private fun PendingFollowUpBanner(text: String, onReEdit: () -> Unit, onSteer: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 2.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(MpiTheme.colors.surfaceMuted)
            .padding(start = 10.dp, end = 4.dp, top = 4.dp, bottom = 8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(MpiTheme.colors.ok))
            Spacer(Modifier.size(6.dp))
            Text(
                text = "待处理后续",
                style = MaterialTheme.typography.labelSmall,
                color = MpiTheme.colors.textDim,
                fontWeight = FontWeight.Medium,
            )
            Text(
                text = "· 当前任务完成后自动发送",
                style = MaterialTheme.typography.labelSmall,
                color = MpiTheme.colors.textFaint,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(start = 4.dp),
            )
            IconButton(onClick = onReEdit, modifier = Modifier.size(32.dp)) {
                Icon(
                    IconEdit,
                    contentDescription = "重新编辑",
                    tint = MpiTheme.colors.textDim,
                    modifier = Modifier.size(16.dp),
                )
            }
            IconButton(onClick = onSteer, modifier = Modifier.size(32.dp)) {
                Icon(
                    IconSpark,
                    contentDescription = "立即插入",
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(15.dp),
                )
            }
        }
        Text(
            text = text,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(end = 8.dp, start = 12.dp),
        )
    }
}

/** 待发送附件条（图片显缩略图、文件显名字）——每个都带移除按钮。 */
@Composable
private fun AttachmentBar(attachments: List<Attachment>, onRemove: (Int) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(MpiTheme.colors.bg)
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 10.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        attachments.forEachIndexed { index, attachment ->
            AttachmentChip(attachment = attachment, onRemove = { onRemove(index) })
        }
    }
}

@Composable
private fun AttachmentChip(attachment: Attachment, onRemove: () -> Unit) {
    Box(Modifier.size(54.dp)) {
        when (attachment) {
            is Attachment.Image -> {
                // 已压缩到 ≤280KB，解码成缩略图不会爆内存（最多 3 张）
                val bitmap = remember(attachment.bytesB64) {
                    runCatching {
                        val bytes = android.util.Base64.decode(attachment.bytesB64, android.util.Base64.NO_WRAP)
                        android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
                    }.getOrNull()
                }
                if (bitmap != null) {
                    Image(
                        bitmap = bitmap,
                        contentDescription = "图片附件",
                        modifier = Modifier.fillMaxSize().clip(RoundedCornerShape(8.dp)),
                        contentScale = ContentScale.Crop,
                    )
                } else {
                    Box(Modifier.fillMaxSize().clip(RoundedCornerShape(8.dp)).background(MpiTheme.colors.control))
                }
            }

            is Attachment.File -> {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .clip(RoundedCornerShape(8.dp))
                        .background(MpiTheme.colors.surfaceMuted)
                        .padding(5.dp),
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text("文件", style = MaterialTheme.typography.labelSmall, color = MpiTheme.colors.textFaint)
                    Text(
                        text = attachment.name,
                        style = MaterialTheme.typography.labelSmall,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }

        Box(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .size(18.dp)
                .clip(CircleShape)
                .background(Color(0xCC000000))
                .clickable(onClick = onRemove),
            contentAlignment = Alignment.Center,
        ) {
            Text("×", color = Color.White, fontSize = 12.sp)
        }
    }
}

/**
 * 会话视图滚动的跟随决策（纯函数，可单测）。
 *
 * - 用户主动往回滚（正在滚动且方向向后）→ 停止跟随，不把正在阅读的人拽走。
 * - 只要处于最底（没有可滚动余量）→ 恢复跟随（手动拖到底也能重新跟上）。
 * - 其余情况保持现状：内容增长本身不算用户意图，不能因此取消跟随。
 */
internal fun nextFollowing(
    current: Boolean,
    scrolling: Boolean,
    scrolledBackward: Boolean,
    canScrollForward: Boolean,
): Boolean = when {
    scrolling && scrolledBackward -> false
    !canScrollForward -> true
    else -> current
}

@Composable
private fun ScrollToBottomButton(
    listState: androidx.compose.foundation.lazy.LazyListState,
    itemCount: Int,
    onFollowAgain: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    Box(
        modifier = modifier
            .size(30.dp)
            .clip(CircleShape)
            .background(MpiTheme.colors.surfaceMuted)
            .border(1.dp, MpiTheme.colors.border, CircleShape)
            .clickable {
                onFollowAgain()
                scope.launch { if (itemCount > 0) listState.scrollToItem(itemCount - 1, Int.MAX_VALUE) }
            },
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            IconDown,
            contentDescription = "回到底部",
            tint = MpiTheme.colors.textDim,
            modifier = Modifier.size(14.dp),
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ThreadTopBar(
    title: String,
    compacting: Boolean,
    speakTurnComplete: Boolean,
    voiceSpeechContent: VoiceSpeechContent,
    speakDuringCall: Boolean,
    onSetSpeakTurnComplete: (Boolean) -> Unit,
    onSetVoiceSpeechContent: (VoiceSpeechContent) -> Unit,
    onSetSpeakDuringCall: (Boolean) -> Unit,
    onBack: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenSearch: () -> Unit,
    /** 双击标题 → 快速重命名（与侧栏长按菜单同语义）。 */
    onRenameTitle: (String) -> Unit,
) {
    var voiceMenuOpen by remember { mutableStateOf(false) }
    // 双击标题弹重命名框；draft 每次打开时刷新为当前标题，避免残留上次输入。
    var renaming by remember { mutableStateOf(false) }
    var draft by remember { mutableStateOf(title) }
    Row(
        modifier = Modifier.fillMaxWidth().padding(start = 2.dp, end = 8.dp, top = 6.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onBack) {
            Icon(IconArrowLeft, contentDescription = "返回", tint = MaterialTheme.colorScheme.onSurface)
        }
        // 语音输出快捷入口（标题左侧）：短按直接开/关播报，长按弹设置菜单。
        // 开 = 声波 + 强调色，关 = 静音 + 浅灰——不开菜单也能一眼看出当前状态。
        Box(modifier = Modifier.padding(start = 2.dp)) {
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(999.dp))
                    .background(if (speakTurnComplete) MpiTheme.colors.accentSoft else Color.Transparent)
                    .combinedClickable(
                        onClick = { onSetSpeakTurnComplete(!speakTurnComplete) },
                        onLongClick = { voiceMenuOpen = true },
                    )
                    .padding(horizontal = 8.dp, vertical = 3.dp),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = if (speakTurnComplete) IconVolume else IconVolumeOff,
                    contentDescription = if (speakTurnComplete) "语音播报：开" else "语音播报：关",
                    tint = if (speakTurnComplete) MaterialTheme.colorScheme.primary else MpiTheme.colors.textFaint,
                    modifier = Modifier.size(15.dp),
                )
            }
            DropdownMenu(
                expanded = voiceMenuOpen,
                onDismissRequest = { voiceMenuOpen = false },
            ) {
                // 「设置 → 账号」里三项的快捷入口（语义与 SettingsScreen 完全一致，只是前置）。
                // 点完不关菜单：快速设置常要连调几项。
                VoiceMenuItem(
                    label = "完成后语音播报",
                    checked = speakTurnComplete,
                    onClick = { onSetSpeakTurnComplete(!speakTurnComplete) },
                )
                VoiceMenuItem(
                    label = voiceContentLabel(VoiceSpeechContent.Fixed),
                    checked = speakTurnComplete && voiceSpeechContent == VoiceSpeechContent.Fixed,
                    enabled = speakTurnComplete,
                    onClick = { onSetVoiceSpeechContent(VoiceSpeechContent.Fixed) },
                )
                VoiceMenuItem(
                    label = voiceContentLabel(VoiceSpeechContent.Reply),
                    checked = speakTurnComplete && voiceSpeechContent == VoiceSpeechContent.Reply,
                    enabled = speakTurnComplete,
                    onClick = { onSetVoiceSpeechContent(VoiceSpeechContent.Reply) },
                )
                VoiceMenuItem(
                    label = "通话中也播报",
                    checked = speakDuringCall,
                    onClick = { onSetSpeakDuringCall(!speakDuringCall) },
                )
            }
        }
        // 标题最多占屏幕宽度的一半，超出用省略号（真机反馈的诉求）。
        // 「项目 · 空闲」状态行已删：信息量低；运行中看输入条停止钮、压缩中有转圈。
        // 双击标题 → 快速重命名（与侧栏长按菜单同语义）；单击无动作。
        Text(
            text = title,
            style = MaterialTheme.typography.titleMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .weight(1f)
                .padding(start = 4.dp)
                .widthIn(max = (LocalConfiguration.current.screenWidthDp / 2).dp)
                .combinedClickable(onClick = {}, onDoubleClick = { draft = title; renaming = true }),
        )
        // 只在压缩中显示转圈：运行中状态行已经有「运行中」文字，
        // 再放一个圈用户不知道它干嘛的（真机反馈）。
        if (compacting) {
            CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
        }
        // 搜索与设置（截图那种右侧图标组）；工具行开关已移到设置页「对话分栏」
        IconButton(onClick = onOpenSearch) {
            Icon(
                IconSearch,
                contentDescription = "搜索",
                tint = MpiTheme.colors.textDim,
                modifier = Modifier.size(19.dp),
            )
        }
        IconButton(onClick = onOpenSettings) {
            Icon(
                IconSettings,
                contentDescription = "设置",
                tint = MpiTheme.colors.textDim,
                modifier = Modifier.size(19.dp),
            )
        }
    }

    // 双击标题 → 重命名对话框（与侧栏长按菜单同一风格；保存走 onRenameTitle）。
    if (renaming) {
        AlertDialog(
            onDismissRequest = { renaming = false },
            title = { Text("重命名会话") },
            text = {
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    placeholder = { Text("会话名称", style = MaterialTheme.typography.bodySmall) },
                )
            },
            confirmButton = {
                TextButton(
                    onClick = { renaming = false; onRenameTitle(draft.trim()) },
                    enabled = draft.isNotBlank(),
                ) { Text("保存") }
            },
            dismissButton = { TextButton(onClick = { renaming = false }) { Text("取消") } },
        )
    }
}

/** 语音输出快捷菜单项：标签 + 选中勾（与 ConfigSheet 模型下拉同一风格）。 */
@Composable
private fun VoiceMenuItem(
    label: String,
    checked: Boolean,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    DropdownMenuItem(
        text = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(text = label, style = MaterialTheme.typography.bodyMedium)
                if (checked) {
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
        enabled = enabled,
        onClick = onClick,
    )
}

/** 消息正文（复制用）：只取文本块，工具 / 思考 / 图片不参与。 */
internal fun messageTextOf(message: ThreadMessage): String =
    message.blocks.filter { it.type == BlockType.Text }.mapNotNull { it.text }.joinToString("\n").trim()

/**
 * 按「是否显示工具调用 / 思考过程」过滤要渲染的消息（纯函数，可单测）：
 * - 隐藏时丢掉对应类型的块；
 * - 丢掉后完全没有块的消息一并丢掉（否则会留下空白的助手气泡）；
 *   （模型正在思考、还没有正文时整条消息会暂时不可见——活动指示靠输入条停止钮，与工具行同口径）；
 * - 只用于展示，调用方仍拿原列表做 choices 面板的状态推导。
 */
internal fun visibleMessages(
    messages: List<ThreadMessage>,
    showToolCalls: Boolean,
    showThinking: Boolean = true,
): List<ThreadMessage> {
    val hidden = buildSet {
        if (!showToolCalls) add(BlockType.Tool)
        if (!showThinking) add(BlockType.Thinking)
    }
    if (hidden.isEmpty()) return messages
    return messages.mapNotNull { message ->
        if (message.blocks.none { it.type in hidden }) {
            message
        } else {
            val blocks = message.blocks.filterNot { it.type in hidden }
            if (blocks.isEmpty()) null else message.copy(blocks = blocks)
        }
    }
}

@Composable
private fun MessageRow(
    message: ThreadMessage,
    onRetry: (String) -> Unit,
    allMessages: List<ThreadMessage>,
    finalized: Boolean,
    onSendChoice: (String) -> Unit,
    threadId: String,
    drafts: Map<String, ChoiceAnswer>,
    onDraftChange: (String, ChoiceAnswer?) -> Unit,
    onClearDrafts: (String) -> Unit,
) {
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val text = messageTextOf(message)
    // 手机上选中文本很难，复制整条反而常用（PWA 的长按复制语义）。
    val copy: () -> Unit = {
        if (text.isNotEmpty()) {
            clipboard.setText(AnnotatedString(text))
            Toast.makeText(context, "已复制", Toast.LENGTH_SHORT).show()
        }
    }
    if (message.role == "user") {
        UserMessageRow(message, onRetry, onCopy = copy)
    } else {
        AssistantMessageRow(
            message = message,
            onCopy = copy,
            copyable = text.isNotEmpty(),
            allMessages = allMessages,
            finalized = finalized,
            onSendChoice = onSendChoice,
            threadId = threadId,
            drafts = drafts,
            onDraftChange = onDraftChange,
            onClearDrafts = onClearDrafts,
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun UserMessageRow(message: ThreadMessage, onRetry: (String) -> Unit, onCopy: () -> Unit) {
    val failed = message.errorMessage != null
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = {}, onLongClick = onCopy)
            .padding(horizontal = 14.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.End,
    ) {
        Column(horizontalAlignment = Alignment.End) {
            Box(
                Modifier
                    .widthIn(max = 300.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(if (failed) MpiTheme.colors.surfaceMuted else MpiTheme.colors.userBubble)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            ) {
                Column {
                    // 用户消息也要渲染图片块（之前只滤 Text，自己发的图直接看不见——真机反馈）
                    message.blocks.forEach { block ->
                        when (block.type) {
                            // fillWidth=false：气泡 shrink-wrap 贴住文字（微信式右对齐小气泡）；
                            // 之前默认撑满 300dp，短消息变成「大块 + 居中文字」。
                            BlockType.Text -> MessageText(block.text.orEmpty(), color = MaterialTheme.colorScheme.onSurface, fillWidth = false)
                            BlockType.Image -> ImageBlock(block)
                            BlockType.Video -> VideoBlock(block)
                            else -> Unit
                        }
                    }
                    if (message.pending) {
                        Text(
                            text = "发送中…",
                            style = MaterialTheme.typography.labelSmall,
                            color = MpiTheme.colors.textFaint,
                        )
                    }
                }
            }
            if (failed) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = message.errorMessage.orEmpty(),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    TextButton(onClick = { onRetry(message.id) }) {
                        Text("重试", style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun AssistantMessageRow(
    message: ThreadMessage,
    onCopy: () -> Unit,
    copyable: Boolean,
    allMessages: List<ThreadMessage>,
    finalized: Boolean,
    onSendChoice: (String) -> Unit,
    threadId: String,
    drafts: Map<String, ChoiceAnswer>,
    onDraftChange: (String, ChoiceAnswer?) -> Unit,
    onClearDrafts: (String) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = {}, onLongClick = onCopy)
            .padding(horizontal = 14.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            Modifier.size(26.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                "M",
                color = MaterialTheme.colorScheme.onPrimary,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
            )
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            message.blocks.forEachIndexed { index, block ->
                when (block.type) {
                    BlockType.Tool -> ToolBlockRow(block, key = "${message.id}-tool-$index")
                    BlockType.Thinking -> ThinkingBlockRow(block, key = "${message.id}-think-$index")
                    BlockType.Image -> ImageBlock(block)
                    BlockType.Video -> VideoBlock(block)
                    BlockType.Text -> if (!block.text.isNullOrBlank()) {
                        // 定稿的 assistant 文本才认 choices 面板（流式中间态仍按代码块）
                        if (finalized) {
                            ChoiceAwareText(
                                text = block.text,
                                threadId = threadId,
                                messageId = message.id,
                                allMessages = allMessages,
                                language = "zh",
                                onSendChoice = onSendChoice,
                                drafts = drafts,
                                onDraftChange = onDraftChange,
                                onClearDrafts = onClearDrafts,
                            )
                        } else {
                            MessageText(block.text)
                        }
                    }
                }
            }
            if (message.errorMessage != null) {
                Text(
                    text = message.errorMessage,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            // 可见的复制入口（长按不够好发现，PWA 两种都留）
            if (copyable) {
                TextButton(
                    onClick = onCopy,
                    contentPadding = PaddingValues(horizontal = 4.dp, vertical = 0.dp),
                ) {
                    Icon(
                        IconCopy,
                        contentDescription = null,
                        tint = MpiTheme.colors.textFaint,
                        modifier = Modifier.size(13.dp),
                    )
                    Spacer(Modifier.size(4.dp))
                    Text("复制", style = MaterialTheme.typography.labelSmall, color = MpiTheme.colors.textFaint)
                }
            }
        }
    }
}

/** 工具行：默认折成一行（§4.4 / §7 避坑 #4）；点击展开参数与结果。 */
@Composable
private fun ToolBlockRow(block: MessageBlock, key: String) {
    var expanded by remember(key) { mutableStateOf(false) }
    val label = block.name ?: "工具"
    val preview = block.argsText?.let { " · ${it.take(40)}" }.orEmpty()

    Column(Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .clickable { expanded = !expanded }
                .padding(vertical = 4.dp, horizontal = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = if (expanded) "▾" else "▸",
                style = MaterialTheme.typography.bodySmall,
                color = MpiTheme.colors.textFaint,
            )
            Spacer(Modifier.size(6.dp))
            Text(
                text = label,
                style = MaterialTheme.typography.bodySmall,
                color = if (block.isError) MpiTheme.colors.err else MpiTheme.colors.textDim,
            )
            if (!expanded && preview.isNotEmpty()) {
                Text(
                    text = preview,
                    style = MaterialTheme.typography.labelSmall,
                    color = MpiTheme.colors.textFaint,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (block.running) {
                Spacer(Modifier.size(6.dp))
                CircularProgressIndicator(Modifier.size(11.dp), strokeWidth = 2.dp)
            }
        }
        if (expanded) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(MpiTheme.colors.codeBg)
                    .padding(8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (!block.argsText.isNullOrBlank()) {
                    Text(
                        text = block.argsText,
                        style = MaterialTheme.typography.bodySmall.copy(
                            fontFamily = FontFamily.Monospace,
                            fontSize = 12.sp,
                        ),
                        color = MpiTheme.colors.textDim,
                    )
                }
                if (!block.text.isNullOrBlank()) {
                    Text(
                        text = block.text,
                        style = MaterialTheme.typography.bodySmall.copy(
                            fontFamily = FontFamily.Monospace,
                            fontSize = 12.sp,
                        ),
                        color = if (block.isError) MpiTheme.colors.err else MaterialTheme.colorScheme.onSurface,
                    )
                } else if (block.running) {
                    Text("执行中…", style = MaterialTheme.typography.labelSmall, color = MpiTheme.colors.textFaint)
                }
            }
        }
    }
}

/** 思考块：默认折叠（§4.4），点开可见。 */
@Composable
private fun ThinkingBlockRow(block: MessageBlock, key: String) {
    var expanded by remember(key) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .clickable { expanded = !expanded }
                .padding(vertical = 3.dp, horizontal = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = if (expanded) "▾ 思考过程" else "▸ 思考过程",
                style = MaterialTheme.typography.labelSmall,
                color = MpiTheme.colors.textFaint,
            )
        }
        if (expanded) {
            MessageText(block.text.orEmpty(), color = MpiTheme.colors.textDim)
        }
    }
}

/**
 * 「点击图片打开全屏预览」的传递通道。
 *
 * 图片块在 MessageRow 下面好几层，把回调一路穿下去既吵又容易漏；预览本身是
 * 屏幕级状态（ThreadScreen 持有），用 CompositionLocal 最贴合。null = 不支持预览。
 */
internal val LocalImagePreviewer = staticCompositionLocalOf<((ImageBitmap) -> Unit)?> { null }

/** 全屏图片预览覆盖层：双指缩放（1x–6x）、拖移，点空白或返回关闭。 */
@Composable
private fun ImagePreviewOverlay(bitmap: ImageBitmap, onClose: () -> Unit) {
    var scale by remember { mutableStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    val transformState = rememberTransformableState { zoomChange, panChange, _ ->
        scale = (scale * zoomChange).coerceIn(1f, 6f)
        // 缩回 1x 时把位移归零，否则图片会“滑出”屏幕且再也回不到中间。
        offset = if (scale <= 1f) Offset.Zero else offset + panChange
    }
    // 覆盖层不是 Dialog，返回键要自己接（否则会直接退出会话）。
    BackHandler { onClose() }
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.96f))
            .pointerInput(Unit) { detectTapGestures { onClose() } },
        contentAlignment = Alignment.Center,
    ) {
        Image(
            bitmap = bitmap,
            contentDescription = "图片预览（双指缩放，点空白关闭）",
            modifier = Modifier
                .fillMaxSize()
                .graphicsLayer(
                    scaleX = scale,
                    scaleY = scale,
                    translationX = offset.x,
                    translationY = offset.y,
                )
                .transformable(transformState),
            // Fit：完整显示不裁切；竖图会顶满高度，横图顶满宽度。
            contentScale = ContentScale.Fit,
        )
    }
}

/**
 * 消息里的**视频块**：气泡内直接播放。
 *
 * 数据是主机内联下发的 base64（见 mobile/shared/protocol.ts 的 video 块 /
 * src/main/remote/video-refs.ts）。ExoPlayer 吃不下 `data:` URI，所以先把字节落到 cacheDir
 * 再播（同一份数据只写一次）。
 *
 * **懒创建**：没点 ▶ 之前不建播放器——一个会话里可能有多个视频，每个都建个 ExoPlayer
 * 会白占内存与硬件解码器。点开后内联播放，⛶ 进全屏（Dialog 铺满屏幕）。
 */
@Composable
private fun VideoBlock(block: MessageBlock) {
    val context = LocalContext.current
    // block.data 变了才重写文件（列表滚动会导致重组）。
    val inlineSource = remember(block.data) { block.data?.let { writeVideoCacheFile(context, it, block.mimeType) } }

    // 大视频**按需拉**：快照里只有占位（没有 data），但带了名字——点开才把字节拉回来。
    // 拉取实现由 AppViewModel 通过 CompositionLocal 提供（见 LocalVideoFetcher 的注释）。
    val fetchVideo = LocalVideoFetcher.current
    val scope = rememberCoroutineScope()
    // 拉回来的视频缓在 cacheDir/video-attachments/（与内联视频同一目录）。
    val videoDir = remember(context) { File(context.cacheDir, "video-attachments").apply { mkdirs() } }
    var fetchedSource by remember(block.name) { mutableStateOf<File?>(null) }
    var fetching by remember(block.name) { mutableStateOf(false) }
    var fetchError by remember(block.name) { mutableStateOf<String?>(null) }
    var fetchedBytes by remember(block.name) { mutableStateOf(0L) }
    var totalBytes by remember(block.name) { mutableStateOf(block.size?.toLong() ?: 0L) }
    val source = inlineSource ?: fetchedSource

    if (source == null) {
        // 没名字（历史遗留 / 附件已被清理）→ 真占位，点了也没得拉。
        if (block.name == null) {
            VideoPlaceholder(block)
            return
        }
        LazyVideoCard(
            block = block,
            fetching = fetching,
            error = fetchError,
            loaded = fetchedBytes,
            total = totalBytes,
            onPlay = {
                if (fetching) return@LazyVideoCard
                val name = block.name ?: return@LazyVideoCard
                fetching = true
                fetchError = null
                fetchedBytes = 0L
                scope.launch {
                    val target = File(videoDir, name)
                    val ok = runCatching {
                        fetchVideo(name, target, { loaded, total ->
                            fetchedBytes = loaded
                            if (total > 0) totalBytes = total
                        })
                    }.getOrElse { false }
                    fetching = false
                    if (ok && target.length() > 0) {
                        fetchedSource = target
                    } else {
                        fetchError = "附件已不可用（可能已被清理）"
                    }
                }
            },
        )
        return
    }

    // 飞书式：气泡里只给一个视频框（首帧当封面 + 中央 ▶），点一下**直接全屏**。
    // 播放器只在全屏期间存在，所以列表里不会积一堆 ExoPlayer。
    var playing by remember(source) { mutableStateOf(false) }
    val player = remember(source, playing) {
        if (!playing) {
            null
        } else {
            ExoPlayer.Builder(context).build().apply {
                setMediaItem(MediaItem.fromUri(Uri.fromFile(source)))
                prepare()
                playWhenReady = true
            }
        }
    }
    // 离开组合（滚出屏幕/切会话/退出）时释放——否则解码器泄漏。
    DisposableEffect(player) {
        onDispose { player?.release() }
    }

    // 首帧当封面：用 MediaMetadataRetriever 抽一帧（不建播放器），失败就只剩深色底。
    val poster = remember(source) { extractFirstFrame(source) }
    VideoPosterCard(block = block, poster = poster, onPlay = { playing = true })

    if (playing && player != null) {
        Dialog(
            onDismissRequest = { playing = false },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Box(Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { ctx -> PlayerView(ctx).apply { useController = true } },
                    update = { view -> view.player = player },
                )
                TextButton(
                    modifier = Modifier.align(Alignment.TopEnd).padding(12.dp),
                    onClick = { playing = false },
                ) { Text("关闭", color = Color.White) }
            }
        }
    }
}

/**
 * 大视频的**懒加载卡片**：快照里只给了占位（没有字节）但带了附件名——点开才按需拉。
 *
 * 为什么需要一个单独的卡片：与有字节的卡片观感一致（深色 16:9 框 + ▶），但没首帧可铺，
 * 所以多一行提示，并在拉取期间把进度写在框里——否则拉几十 MB 时用户只能盯着一块
 * 没有任何反馈的深色方框（真机反馈里最容易被当成“卡死”的形态）。
 */
@Composable
private fun LazyVideoCard(
    block: MessageBlock,
    fetching: Boolean,
    error: String?,
    loaded: Long,
    total: Long,
    onPlay: () -> Unit,
) {
    Box(
        modifier = Modifier
            .widthIn(max = 300.dp)
            .aspectRatio(16f / 9f)
            .clip(RoundedCornerShape(10.dp))
            .background(Color.Black)
            .clickable(enabled = !fetching) { onPlay() },
        contentAlignment = Alignment.Center,
    ) {
        when {
            error != null -> Text(
                text = error,
                modifier = Modifier.padding(horizontal = 12.dp),
                style = MaterialTheme.typography.labelSmall,
                color = Color.White.copy(alpha = 0.85f),
            )
            fetching -> {
                val percent = if (total > 0) ((loaded * 100) / total).toInt().coerceIn(0, 99) else 0
                Text(
                    text = if (total > 0) "正在获取视频 $percent%" else "正在获取视频…",
                    style = MaterialTheme.typography.labelMedium,
                    color = Color.White,
                )
            }
            else -> Box(
                modifier = Modifier
                    .size(46.dp)
                    .clip(CircleShape)
                    .background(Color.Black.copy(alpha = 0.42f)),
                contentAlignment = Alignment.Center,
            ) {
                Text("▶", color = Color.White, fontSize = 16.sp)
            }
        }
        Text(
            text = formatVideoMeta(block),
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(6.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(Color.Black.copy(alpha = 0.55f))
                .padding(horizontal = 6.dp, vertical = 1.dp),
            style = MaterialTheme.typography.labelSmall,
            color = Color.White,
        )
    }
}

/**
 * 视频框：首帧封面 + 中央 ▶ + 右下角尺寸/格式。
 *
 * 首帧取不到（编解码器不支持/文件异常）时退化成深色底 + ▶——仍可点开播，不拦人。
 */
@Composable
private fun VideoPosterCard(block: MessageBlock, poster: ImageBitmap?, onPlay: () -> Unit) {
    Box(
        modifier = Modifier
            .widthIn(max = 300.dp)
            .aspectRatio(16f / 9f)
            .clip(RoundedCornerShape(10.dp))
            .background(Color.Black)
            .clickable { onPlay() },
        contentAlignment = Alignment.Center,
    ) {
        if (poster != null) {
            Image(
                bitmap = poster,
                contentDescription = "视频（点击播放）",
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Crop,
            )
        }
        Box(
            modifier = Modifier
                .size(46.dp)
                .clip(CircleShape)
                .background(Color.Black.copy(alpha = 0.5f)),
            contentAlignment = Alignment.Center,
        ) {
            Text("▶", color = Color.White, fontSize = 16.sp)
        }
        Text(
            text = formatVideoMeta(block),
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(6.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(Color.Black.copy(alpha = 0.55f))
                .padding(horizontal = 6.dp, vertical = 1.dp),
            style = MaterialTheme.typography.labelSmall,
            color = Color.White,
        )
    }
}

/** 抽首帧当封面（飞书式观感）。失败 → null：卡片退化成深色底 + ▶，不影响点开播。 */
private fun extractFirstFrame(file: File): ImageBitmap? {
    val retriever = android.media.MediaMetadataRetriever()
    return try {
        retriever.setDataSource(file.absolutePath)
        retriever.getFrameAtTime(0)?.asImageBitmap()
    } catch (error: Throwable) {
        null
    } finally {
        try {
            retriever.release()
        } catch (_: Throwable) {
            // release 失败无需处理
        }
    }
}

/** 没有本体时的占位（不静默丢消息）。 */
@Composable
private fun VideoPlaceholder(block: MessageBlock) {
    Row(
        modifier = Modifier
            .widthIn(max = 320.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(MpiTheme.colors.control)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("🎬", style = MaterialTheme.typography.titleMedium)
        Column {
            Text(block.name ?: "视频", style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                // 主机在 block.text 里写了“为什么没下发”（超出预算 / 临时文件被清理）。
                text = block.text?.takeIf { it.isNotBlank() } ?: "视频未随本次同步下发",
                style = MaterialTheme.typography.labelSmall,
                color = MpiTheme.colors.textFaint,
            )
        }
    }
}

private fun formatVideoMeta(block: MessageBlock): String {
    val size = block.size
    val sizeText = when {
        size == null || size <= 0 -> null
        size >= 1_000_000 -> String.format("%.1fMB", size / 1_000_000.0)
        else -> "${(size + 1023) / 1024}KB"
    }
    return listOfNotNull(sizeText, block.mimeType?.takeIf { it.isNotBlank() })
        .joinToString(" · ")
        .ifEmpty { "点击播放" }
}

/**
 * 视频 base64 → cacheDir 文件（ExoPlayer 播不了 `data:` URI）。
 *
 * 名字用「长度 + 前 16 字节哈希」做指纹，同一份数据不重复写；失败（数据截断/超大）返回 null，
 * 由调用方退化成占位卡片。
 */
private fun writeVideoCacheFile(context: Context, raw: String, mimeType: String?): File? {
    return try {
        val base64 = if (raw.startsWith("data:")) raw.substringAfter(',', raw) else raw
        // 主机侧单个视频 ≤3MB（base64 ≈4.2MB）；远超这个量级的说明数据异常，不硬解。
        if (base64.length > 6_000_000) return null
        val bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
        if (bytes.isEmpty()) return null
        val extension = when (mimeType?.lowercase()) {
            "video/webm" -> "webm"
            "video/quicktime" -> "mov"
            "video/x-matroska" -> "mkv"
            else -> "mp4"
        }
        val head = bytes.copyOf(minOf(16, bytes.size))
        val name = "v-${Integer.toHexString(bytes.size)}-${Integer.toHexString(head.contentHashCode())}.$extension"
        val directory = File(context.cacheDir, "video-attachments").apply { mkdirs() }
        val target = File(directory, name)
        if (!target.exists()) target.writeBytes(bytes)
        target
    } catch (error: Throwable) {
        null
    }
}

/**
 * 消息里的图片块：把 base64 / data URL 解成 Bitmap 直接显示。
 *
 * 解码失败（数据截断、格式不支持）时给一行明确提示，**不静默丢掉**。
 */
@Composable
private fun ImageBlock(block: MessageBlock) {
    val bitmap = remember(block.data) {
        runCatching {
            val raw = block.data
            if (raw.isNullOrEmpty()) return@runCatching null
            val base64 = if (raw.startsWith("data:")) raw.substringAfter(',', raw) else raw
            val bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
            android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
        }.getOrNull()
    }

    if (bitmap != null) {
        // LocalImagePreviewer.current 只能在 @Composable 上下文里读（clickable 的 lambda 不是）
        val previewer = LocalImagePreviewer.current
        Image(
            bitmap = bitmap,
            contentDescription = "图片（点击放大）",
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(10.dp))
                // 点击放大：手机上小图看不清（截图 / 报错图常常如此）。
                .clickable { previewer?.invoke(bitmap) },
            contentScale = ContentScale.Fit,
        )
    } else {
        Text(
            text = "［图片无法显示${block.mimeType?.let { " · $it" } ?: ""}］",
            style = MaterialTheme.typography.labelSmall,
            color = MpiTheme.colors.textFaint,
        )
    }
}

@Composable
private fun CenteredHint(text: String, loading: Boolean = false) {
    Column(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (loading) {
            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            Spacer(Modifier.height(10.dp))
        }
        Text(text, style = MaterialTheme.typography.bodySmall, color = MpiTheme.colors.textDim)
    }
}

/**
 * 统一的圆形按钮（真机诉求：输入框那排按钮大小要均衡）。
 * 外层 40dp 保住触摸目标，内层 32dp 圆是视觉尺寸。
 */
@Composable
private fun RoundIconButton(
    onClick: () -> Unit,
    background: androidx.compose.ui.graphics.Color,
    enabled: Boolean = true,
    /**
     * 长按 3 秒的入口（语音对话模式）；null = 不做长按手势（就是点一下）。
     *
     * 不用 `detectTapGestures(onLongPress=…)`：那是系统长按时长（~0.4s），而用户要 3 秒——
     * 这个时长才能把「长按进语音模式」与「点一下录音」干净分开。
     */
    onLongHold: (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val haptic = LocalHapticFeedback.current
    // 计时器跑在普通协程里：指针事件作用域是「受限挂起」，不能在里面调 withTimeout
    // （编译器会直接报 Restricted suspending functions…）。
    val holdScope = rememberCoroutineScope()
    var holdFired by remember { mutableStateOf(false) }
    val interaction: Modifier = if (onLongHold == null) {
        Modifier.clickable(enabled = enabled, onClick = onClick)
    } else {
        Modifier.pointerInput(enabled) {
            if (!enabled) return@pointerInput
            awaitEachGesture {
                awaitFirstDown(requireUnconsumed = false)
                holdFired = false
                val timer = holdScope.launch {
                    delay(LONG_HOLD_MS)
                    holdFired = true
                    // 3 秒到：震一下再进语音模式（手感上「按够了」）
                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                    onLongHold()
                }
                val up = waitForUpOrCancellation()
                timer.cancel()
                // 松手早于 3 秒 = 普通点击；否则长按已生效，不能再当点击
                if (up != null && !holdFired) onClick()
            }
        }
    }
    Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
        Box(
            modifier = Modifier
                .size(32.dp)
                .clip(CircleShape)
                .background(background)
                .then(interaction),
            contentAlignment = Alignment.Center,
        ) {
            content()
        }
    }
}

/**
 * Prefill 等待占位行：agent 在跑但 assistant 消息还没开始（本地模型 prefill 可达
 * 数十秒）。**计时器就在这里**——每秒只有这一行重组，不会带着整条消息列表重建。
 */
@Composable
private fun ThinkingPlaceholderRow() {
    var elapsedSec by remember { mutableStateOf(0) }
    LaunchedEffect(Unit) {
        val startedAt = System.currentTimeMillis()
        while (true) {
            delay(1_000)
            elapsedSec = ((System.currentTimeMillis() - startedAt) / 1000).toInt()
        }
    }
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 2.dp)
        Text(
            text = "思考中 · ${formatElapsed(elapsedSec)}",
            style = MaterialTheme.typography.bodySmall,
            color = MpiTheme.colors.textFaint,
        )
    }
}

/** 长按进入语音模式的时长（用户指定 3 秒）。 */
private const val LONG_HOLD_MS = 3_000L
