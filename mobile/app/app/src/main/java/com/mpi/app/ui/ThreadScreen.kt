package com.mpi.app.ui

import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mpi.app.data.Attachment
import com.mpi.app.data.ThreadView
import com.mpi.app.protocol.BlockType
import com.mpi.app.protocol.MessageBlock
import com.mpi.app.protocol.RemotePermission
import com.mpi.app.protocol.RemoteThreadState
import com.mpi.app.protocol.ThreadMessage
import com.mpi.app.ui.theme.MpiTheme
import kotlinx.coroutines.launch

/**
 * 会话视图（§4.4）：顶栏 + 消息流。
 *
 * 错误一律**顶部横幅 + 可操作按钮**（§1.1），不遮住内容；滚动跟随在用户手动上滑时
 * 自动停止，并浮出「回到底部」——避免读到一半被流式输出拽走。
 */
@Composable
fun ThreadScreen(
    view: ThreadView,
    projectName: String?,
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
    onVoicePermissionDenied: () -> Unit,
    onDismissVoiceError: () -> Unit,
    pendingFollowUp: String?,
    sendError: String?,
    onSteerPending: () -> Unit,
    onReEditPending: () -> Unit,
    onDismissSendError: () -> Unit,
    sheet: ToolbarSheet?,
    configBusy: Boolean,
    configError: String?,
    onOpenSheet: (ToolbarSheet) -> Unit,
    onDismissSheet: () -> Unit,
    onDismissConfigError: () -> Unit,
    onSetPermission: (RemotePermission) -> Unit,
    onSetModel: (String, String) -> Unit,
    onSetMode: (String) -> Unit,
    onCompact: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val listState = rememberLazyListState()
    val renderable = view.renderable
    val atBottom by remember { derivedStateOf { !listState.canScrollForward } }

    // 内容增长时仅在「本来就在底部」的前提下跟随
    LaunchedEffect(renderable.size, view.streaming?.blocks?.lastOrNull()?.text?.length) {
        if (renderable.isNotEmpty() && atBottom) {
            // 必须用大 offset 真滚到底：scrollToItem(lastIndex) 只是把最后一条的“顶部”
            // 对齐视口，最后一条很长时仍可下滚，atBottom 就永远为 false（按钮不消失）。
            listState.scrollToItem(renderable.lastIndex, Int.MAX_VALUE)
        }
    }

    // safeDrawingPadding：同时避让状态栏（截图里标题被时间压住）、手势条与键盘
    Column(modifier = modifier.fillMaxSize().safeDrawingPadding()) {
        ThreadTopBar(
            title = view.summary?.title?.ifEmpty { null } ?: "会话",
            projectName = projectName,
            state = view.summary?.state,
            running = view.running,
            compacting = view.compacting,
            onBack = onBack,
        )

        // 会话级配置 chip 行（§4.4）——权限 / 模式 / 模型 / 上下文用量。
        ThreadToolbar(view = view, busy = configBusy, onOpen = onOpenSheet)

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

        Box(Modifier.weight(1f)) {
            when {
                !view.ready -> CenteredHint(text = "正在载入会话…", loading = true)

                renderable.isEmpty() -> CenteredHint(text = "这个会话还没有消息")

                else -> LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(vertical = 10.dp),
                ) {
                    items(renderable, key = { it.id }) { message ->
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
                }
            }

            if (!atBottom && renderable.isNotEmpty()) {
                ScrollToBottomButton(
                    listState = listState,
                    itemCount = renderable.size,
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
            onVoicePermissionDenied = onVoicePermissionDenied,
            onDismissVoiceError = onDismissVoiceError,
            pendingFollowUp = pendingFollowUp,
            sendError = sendError,
            onSend = onSend,
            onAbort = onAbort,
            onSteerPending = onSteerPending,
            onReEditPending = onReEditPending,
            onDismissSendError = onDismissSendError,
        )

        if (sheet != null) {
            ThreadToolbarSheet(
                sheet = sheet,
                view = view,
                busy = configBusy,
                error = configError,
                onDismiss = onDismissSheet,
                onSetPermission = onSetPermission,
                onSetModel = onSetModel,
                onSetMode = onSetMode,
                onCompact = onCompact,
            )
        }
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
    onVoicePermissionDenied: () -> Unit,
    onDismissVoiceError: () -> Unit,
    pendingFollowUp: String?,
    sendError: String?,
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
    val micPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> if (granted) onStartVoice() else onVoicePermissionDenied() }
    var attachMenuOpen by remember { mutableStateOf(false) }

    Column {
        HorizontalDivider(color = MpiTheme.colors.border)

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

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(MpiTheme.colors.bg)
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Box {
                IconButton(
                    onClick = { attachMenuOpen = true },
                    enabled = !attachmentBusy && attachments.size < 3,
                    modifier = Modifier.size(44.dp),
                ) {
                    if (attachmentBusy) {
                        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    } else {
                        Icon(
                            IconPlus,
                            contentDescription = "添加附件",
                            tint = MpiTheme.colors.textDim,
                            modifier = Modifier.size(20.dp),
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
            OutlinedTextField(
                value = draft,
                onValueChange = onDraftChange,
                modifier = Modifier.weight(1f),
                placeholder = {
                    Text(
                        text = when {
                            running && pendingFollowUp != null -> "再排一条…"
                            running -> "输入插话…发送后排队，任务完成时自动发出"
                            else -> "说点什么…"
                        },
                        style = MaterialTheme.typography.bodyMedium,
                    )
                },
                maxLines = 5,
                shape = RoundedCornerShape(14.dp),
            )
            when {
                transcribing -> {
                    Box(Modifier.size(44.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    }
                }

                recording -> {
                    // 录音中：左取消、右结束（同一位置再点即完成——微信式）
                    IconButton(onClick = onCancelVoice, modifier = Modifier.size(44.dp)) {
                        Icon(
                            IconClose,
                            contentDescription = "取消录音",
                            tint = MpiTheme.colors.textDim,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                    IconButton(onClick = onStopVoice, modifier = Modifier.size(44.dp)) {
                        Icon(
                            IconMic,
                            contentDescription = "结束录音并转文字",
                            tint = MpiTheme.colors.err,
                            modifier = Modifier.size(22.dp),
                        )
                    }
                }

                else -> {
                    IconButton(
                        onClick = { micPermission.launch(android.Manifest.permission.RECORD_AUDIO) },
                        enabled = !sending,
                        modifier = Modifier.size(44.dp),
                    ) {
                        Icon(
                            IconMic,
                            contentDescription = "语音输入",
                            tint = MpiTheme.colors.textDim,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
            }
            if (running) {
                IconButton(onClick = onAbort, enabled = !sending, modifier = Modifier.size(44.dp)) {
                    Icon(
                        IconStop,
                        contentDescription = "停止",
                        tint = MpiTheme.colors.err,
                        modifier = Modifier.size(20.dp),
                    )
                }
            }
            IconButton(
                onClick = onSend,
                enabled = (draft.isNotBlank() || attachments.isNotEmpty()) && !sending,
                modifier = Modifier.size(44.dp),
            ) {
                Icon(
                    IconSend,
                    contentDescription = if (running) "发送（排队）" else "发送",
                    tint = if ((draft.isNotBlank() || attachments.isNotEmpty()) && !sending) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MpiTheme.colors.textFaint
                    },
                    modifier = Modifier.size(22.dp),
                )
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

@Composable
private fun ScrollToBottomButton(
    listState: androidx.compose.foundation.lazy.LazyListState,
    itemCount: Int,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    Box(
        modifier = modifier
            .size(38.dp)
            .clip(CircleShape)
            .background(MpiTheme.colors.surfaceMuted)
            .border(1.dp, MpiTheme.colors.border, CircleShape)
            .clickable {
                scope.launch { if (itemCount > 0) listState.scrollToItem(itemCount - 1, Int.MAX_VALUE) }
            },
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            IconDown,
            contentDescription = "回到底部",
            tint = MpiTheme.colors.textDim,
            modifier = Modifier.size(18.dp),
        )
    }
}

@Composable
private fun ThreadTopBar(
    title: String,
    projectName: String?,
    state: RemoteThreadState?,
    running: Boolean,
    compacting: Boolean,
    onBack: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(start = 2.dp, end = 8.dp, top = 6.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onBack) {
            Icon(IconArrowLeft, contentDescription = "返回", tint = MaterialTheme.colorScheme.onSurface)
        }
        Column(Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (state != null) {
                    StateDot(state, size = 7)
                    Spacer(Modifier.size(5.dp))
                }
                Text(
                    text = buildString {
                        if (!projectName.isNullOrEmpty()) append("$projectName · ")
                        append(state?.label() ?: "状态未知")
                        if (running) append(" · 运行中")
                        if (compacting) append(" · 压缩中")
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = MpiTheme.colors.textDim,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (running || compacting) {
            CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
        }
    }
}

/** 消息正文（复制用）：只取文本块，工具 / 思考 / 图片不参与。 */
internal fun messageTextOf(message: ThreadMessage): String =
    message.blocks.filter { it.type == BlockType.Text }.mapNotNull { it.text }.joinToString("\n").trim()

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
                    message.blocks.filter { it.type == BlockType.Text }.forEach { block ->
                        MessageText(block.text.orEmpty(), color = MaterialTheme.colorScheme.onSurface)
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
                    BlockType.Image -> ImageBlockHint(block)
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

/** 图片块渲染属 M4（图片输入/渲染一起做）；这里只提示存在，避免静默丢失。 */
@Composable
private fun ImageBlockHint(block: MessageBlock) {
    Text(
        text = "［图片${block.mimeType?.let { " · $it" } ?: ""}（手机端渲染待 M4）］",
        style = MaterialTheme.typography.labelSmall,
        color = MpiTheme.colors.textFaint,
    )
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
