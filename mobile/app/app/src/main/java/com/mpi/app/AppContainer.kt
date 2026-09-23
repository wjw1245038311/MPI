package com.mpi.app

import android.content.Context
import android.os.Build
import com.mpi.app.data.AndroidKeystoreSecretBox
import com.mpi.app.data.FileKeyStore
import com.mpi.app.data.KeyStore
import com.mpi.app.data.SecretBox
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * 手写的依赖容器 —— 不引入 DI 框架（见设计文档 §1.2 减法清单）。
 * 单人项目里 Hilt 之类的框架只会增加维护面，不会减少任何实际复杂度。
 */
class AppContainer(context: Context) {

    private val appContext: Context = context.applicationContext

    val secretBox: SecretBox = AndroidKeystoreSecretBox()

    val keyStore: KeyStore = FileKeyStore(
        file = File(appContext.filesDir, FileKeyStore.FILE_NAME),
        secretBox = secretBox,
    )

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
