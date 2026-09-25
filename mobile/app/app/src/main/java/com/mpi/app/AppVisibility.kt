package com.mpi.app

/**
 * App 是否在前台（进程级标记）。
 *
 * 只服务一个判断：**「对话完成」通知只在后台/锁屏时发**——盯着屏幕看回复时再响一次
 * 纯属打扰（用户确认的口径）。由 [MainActivity] 的 onStart/onStop 维护，
 * 本 App 只有一个 Activity，所以一个标记就够，不需要引入生命周期库。
 */
object AppVisibility {
    /** onStart 之后、onStop 之前为 true（锁屏/切后台即 false）。 */
    @Volatile
    var foreground: Boolean = false
}
