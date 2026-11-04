package com.mpi.app.body

import android.content.Context
import kotlinx.serialization.json.JsonObject

/**
 * 身体层的进程内枢纽（`docs/PHONE-AGENT-PLAN.md` §1）。
 *
 * 只有 `:body` 进程用它：无障碍服务连上就 [attach]（起 socket 服务），
 * 断开就 [detach]。调试页也走同一条路径，确保「调试看到的」和「客户端拿到的」是同一套。
 */
internal object BodyHub {

    @Volatile
    private var service: MpiA11yService? = null

    @Volatile
    private var dispatcher: BodyDispatcher? = null

    @Volatile
    private var server: BodyServer? = null

    @Volatile
    private var policyStore: BodyPolicyStore? = null

    @Volatile
    var lastStopReason: String? = null
        private set

    val connected: Boolean get() = service != null

    /** 调试页在没有无障碍连接时也要能问出「为什么不可用」，所以单独提供初始化。 */
    fun ensure(context: Context) {
        val app = context.applicationContext
        val store = policyStore ?: BodyPolicyStore(app).also { policyStore = it }
        if (dispatcher == null) {
            dispatcher = BodyDispatcher(
                device = { service },
                policyStore = store,
                emit = { evt -> server?.broadcast(evt) },
            )
        }
    }

    @Synchronized
    fun attach(service: MpiA11yService) {
        this.service = service
        ensure(service)
        if (server == null) {
            val store = policyStore ?: BodyPolicyStore(service.applicationContext).also { policyStore = it }
            val d = dispatcher ?: return
            server = BodyServer(service.applicationContext, d, store).also { it.start() }
        }
    }

    @Synchronized
    fun detach(reason: String) {
        lastStopReason = reason
        service = null
        dispatcher?.stop(reason)
        server?.stop()
        server = null
    }

    /** 熄屏 / 打断：只停任务，不拆服务端（服务可能还在）。 */
    fun offerStop(reason: String) {
        lastStopReason = reason
        dispatcher?.stop(reason)
    }

    fun handle(request: JsonObject): JsonObject? = dispatcher?.handle(request)

    fun policyStore(): BodyPolicyStore? = policyStore
}
