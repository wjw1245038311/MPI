package com.mpi.app.data

import android.content.Context
import android.os.PowerManager

/**
 * 后台播报保活（wakelock）。
 *
 * 为什么需要：前台服务只保**进程**活着；锁屏/退后台后设备进 Doze，CPU 睡 + 网络被限——
 * 「回复完成」收不及时，语音播报会晚到重连那一刻甚至漏掉。手机发起的回合在跑期间持一个
 * PARTIAL_WAKE_LOCK，连接保持在线，播报才准时。
 *
 * 成本：亮屏时为零（CPU 本来就醒着）；锁屏期间 CPU 保持唤醒直到回合结束——这正是目的。
 *
 * 防泄漏：[acquire] 自带超时（[MAX_HOLD_MS]）自动释放；正常释放点在回合结束 / 关会话 /
 * ViewModel 销毁（AppViewModel）。
 *
 * 失败策略与 [Speaker] 一致：任何异常静默降级——拿不到锁就回到旧行为，绝不影响主流程。
 */
class TurnWakeLock(context: Context) {

    private val powerManager =
        context.applicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager

    @Volatile
    private var lock: PowerManager.WakeLock? = null

    /** 幂等：已持有时重复调用是 no-op。 */
    fun acquire() {
        if (lock?.isHeld == true) return
        val newLock = runCatching {
            powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MPI:turn-wake")
                .apply { setReferenceCounted(false) }
        }.getOrNull() ?: return
        if (!runCatching { newLock.acquire(MAX_HOLD_MS) }.isSuccess) return
        lock = newLock
    }

    /** 幂等：未持有时调用安全。超时自动释放后再调也是 no-op（isHeld=false）。 */
    fun release() {
        val current = lock ?: return
        lock = null
        runCatching { if (current.isHeld) current.release() }
    }

    private companion object {
        /** 自动释放兜底：回合不该跑这么久；真跑了也不让锁一直挂着。 */
        const val MAX_HOLD_MS = 30 * 60_000L
    }
}
