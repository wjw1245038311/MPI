package com.mpi.app

import android.app.Application

/**
 * 进程入口：只做两件与排障有关的事，别的都留在 [AppContainer]/ViewModel 里。
 *
 * - 装全局崩溃处理器（见 [CrashLog]）——真机闪退后没有任何证据的教训；
 * - 打「启动中」标记，初始化跑完才清（[CrashLog.finishStartup]）——
 *   上次若死在启动阶段，这次自动进安全模式（不自动连上次的主机），保证 App 进得去。
 */
class MpiApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        CrashLog.install(this)
        CrashLog.beginStartup()
    }
}
