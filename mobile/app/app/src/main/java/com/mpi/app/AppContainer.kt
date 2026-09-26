package com.mpi.app

import android.content.Context
import android.os.Build
import com.mpi.app.data.AndroidKeystoreSecretBox
import com.mpi.app.data.AttachmentLoader
import com.mpi.app.data.FileKeyStore
import com.mpi.app.data.HomeCache
import com.mpi.app.data.KeyStore
import com.mpi.app.data.Notifier
import com.mpi.app.data.SecretBox
import com.mpi.app.data.SettingsStore
import com.mpi.app.data.Speaker
import com.mpi.app.data.ThreadCache
import com.mpi.app.data.Updater
import com.mpi.app.data.VoiceRecorder
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * 手写的依赖容器 —— 不引入 DI 框架（见设计文档 §1.2 减法清单）。
 * 单人项目里 Hilt 之类的框架只会增加维护面，不会减少任何实际复杂度。
 */
class AppContainer(context: Context) {

    private val appContext: Context = context.applicationContext

    init {
        // 前后台判定要实时查屏幕/锁屏状态（见 AppVisibility）——在这里把 Context 交给它，
        // 避免在静态对象里硬持有一个 Application 引用又不初始化。
        AppVisibility.attach(appContext)
    }

    val secretBox: SecretBox = AndroidKeystoreSecretBox()

    val keyStore: KeyStore = FileKeyStore(
        file = File(appContext.filesDir, FileKeyStore.FILE_NAME),
        secretBox = secretBox,
    )

    /** 本地界面设置（外观 / 字号）——非敏感，明文存储。 */
    val settingsStore: SettingsStore = SettingsStore(appContext)

    /** 会话快照本地缓存（本地缓存 A 方案）——明文存应用私有目录。 */
    val threadCache: ThreadCache = ThreadCache(File(appContext.filesDir, ThreadCache.DIR_NAME))

    /** 首页列表本地缓存——明文存应用私有目录。 */
    val homeCache: HomeCache = HomeCache(File(appContext.filesDir, HomeCache.DIR_NAME))

    /** 附件读取（相册 / 文件 → 压缩 + base64）。 */
    val attachmentLoader: AttachmentLoader = AttachmentLoader(appContext)

    /** 原生录音（语音输入）。 */
    val voiceRecorder: VoiceRecorder = VoiceRecorder()

    /** 本地通知与前台服务（M5）。 */
    val notifier: Notifier = Notifier(appContext)

    /** 语音播报（对话完成念一句，系统 TTS；失败静默降级）。 */
    val speaker: Speaker = Speaker(appContext)

    /** 自更新（M6）：读中继清单、下载、调安装器。 */
    val updater: Updater = Updater(appContext)

    /** 通知点击带来的待打开会话（UI 消费后置空）。 */
    val pendingThreadOpen = MutableStateFlow<String?>(null)

    /**
     * 系统返回手势的「右侧侧滑」通道（Android 13+ 预测性返回）。
     *
     * 为什么需要它：屏幕最右那条缝归**系统返回手势**，App 拿不到 touch（即使申请了
     * systemGestureExclusion，系统也只接受约 200dp 高）→ 贴边侧滑要么被当返回、要么划不动。
     * 现在改用预测性返回的回调：手势来自右侧时，用它的 progress 驱动右侧节点面板跟手，
     * 手势完成就把面板打开——不占系统手势区，也不需要排除区。
     */
    val rightPanelSwipe = MutableStateFlow<Float?>(null)

    /** 是否允许把「来自屏幕右侧的返回手势」当成右侧面板的侧滑（由会话页置位）。 */
    val rightSwipeEnabled = MutableStateFlow(false)

    /** 返回手势完成 → 请 UI 把右侧面板滑到位（每次 +1）。 */
    val openRightPanel = MutableStateFlow(0)

    /** 面板已开时，右边缘向内滑 = 关闭（每次 +1）。 */
    val closeRightPanel = MutableStateFlow(0)

    /** 右侧面板当前是否已展开（UI 更新）：决定「右边缘向内滑」是开还是关。 */
    val rightPanelOpen = MutableStateFlow(false)

    /**
     * 前后台（由 MainActivity 维护）。
     *
     * 除了给「完成通知只在后台发」用，还驱动**回前台立刻重连**：长时间挂着后连接必然已死，
     * 而重试是按退避走的（最长 30s），不等它就得上用户觉得「必须关掉 App 才恢复」。
     */
    val foreground = MutableStateFlow(false)

    /** 与 UI 生命周期同长的作用域（会话/仓库/轮询都挂在这里）。 */
    val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /**
     * 报给桌面端的设备名（多设备列表里用来区分是哪台手机）。
     * 去掉可能引起困扰的字符，并留一个兜底。
     */
    val deviceName: String = run {
        val model = Build.MODEL?.trim().orEmpty()
        val manufacturer = Build.MANUFACTURER?.trim().orEmpty()
        val name = when {
            model.isEmpty() -> "Android 手机"
            manufacturer.isEmpty() || model.startsWith(manufacturer, ignoreCase = true) -> model
            else -> "$manufacturer $model"
        }
        name.replace(Regex("[\\p{Cntrl}]"), "").take(40).ifEmpty { "Android 手机" }
    }
}
