package com.mpi.app

import android.content.Context
import android.os.Build
import com.mpi.app.data.AndroidKeystoreSecretBox
import com.mpi.app.data.AttachmentLoader
import com.mpi.app.data.FileKeyStore
import com.mpi.app.data.HomeCache
import com.mpi.app.data.KeyStore
import com.mpi.app.data.LastThreadStore
import com.mpi.app.data.NetworkWatcher
import com.mpi.app.data.Notifier
import com.mpi.app.data.SecretBox
import com.mpi.app.data.SettingsStore
import com.mpi.app.data.Speaker
import com.mpi.app.data.ThreadCache
import com.mpi.app.data.TurnWakeLock
import com.mpi.app.data.Updater
import com.mpi.app.data.VoiceRecorder
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
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

    /** 后台/锁屏播报保活 wakelock（回合在跑时防 CPU 睡 / Doze）。 */
    val turnWakeLock: TurnWakeLock = TurnWakeLock(appContext)

    /** 网络恢复监听（快恢复）：AppViewModel 注册回调并 start() 后生效。 */
    val networkWatcher: NetworkWatcher = NetworkWatcher(appContext)

    /** 上一次打开的会话（重启后优先回到它，见 [LastThreadStore]）。 */
    val lastThread: LastThreadStore = LastThreadStore(appContext)

    /** 自更新（M6）：读中继清单、下载、调安装器。 */
    val updater: Updater = Updater(appContext)

    /** 通知点击带来的待打开会话（UI 消费后置空）。 */
    val pendingThreadOpen = MutableStateFlow<String?>(null)

    /**
     * 前后台（由 MainActivity 维护）。
     *
     * 除了给「完成通知只在后台发」用，还驱动**回前台立刻重连**：长时间挂着后连接必然已死，
     * 而重试是按退避走的（最长 30s），不等它就得上用户觉得「必须关掉 App 才恢复」。
     */
    val foreground = MutableStateFlow(false)

    /** 从协程里逃出来的非致命异常（文案）——UI 拿去当「问题」展示。 */
    val uncaught = MutableSharedFlow<String>(extraBufferCapacity = 8)

    /** 与 UI 生命周期同长的作用域（会话/仓库/轮询都挂在这里）。 */
    val scope: CoroutineScope = CoroutineScope(
        SupervisorJob() + Dispatchers.IO + CoroutineExceptionHandler { _, error ->
            // 2026-11-06：以前这里没处理器——任何 scope.launch 里逃出来的异常都会
            // **直接打死进程**（真机就表现为「随机闪退 / 闪退后进不去 App」，而且拿不到任何栈）。
            // 现在：写一份取证 + 通报给 UI（问题列表），进程继续跑。
            if (error is CancellationException) return@CoroutineExceptionHandler
            CrashLog.recordNonFatal(error)
            uncaught.tryEmit("后台任务出错（已忽略）：${error.javaClass.simpleName} ${error.message ?: ""}".trim())
        },
    )

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
