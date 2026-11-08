package com.mpi.app.ui

/**
 * 「回合跑完了要不要出声念一句」的判定（纯函数，可单测）。
 *
 * 为什么要有这个函数：语音播报原先挂在**当前打开会话**的 `running true→false` 回调上，
 * 且只念「手机发起」的回合（见 `AppViewModel.speakTurnComplete` 的历史注释）。真机口径是
 * 「我锁屏了，跑完就叫我一声」——用户没打开那条会话、或回合是电脑端发起的，就**完全不念**；
 * 而通知照发（通知走飞书已读口径）。于是手机上出现「只有通知、没有声音」，且看起来像坏了。
 *
 * 2026-11 改为**与「对话完成」通知同口径**：只要设置开着、用户没在看着那条会话，就念。
 * 本函数只做判定，不碰 Android API，便于单测（[NotifierLogicTest] 之外单开本表）。
 *
 * 与通知的差异（刻意保留）：闹钟式的通知可以吵醒人，出声念更打扰——
 * ① 正在**看**那条会话时不念（通知同样跳过）；
 * ② 语音对话模式（长按麦克风）开着时不念：那套循环自己会播报回复，否则一句念两遍；
 * ③ 通话中（含微信 VoIP）默认跳过，系统会把媒体流压掉或者漏进通话里；
 * ④ 前台但**在看别的会话**时照念（这正是「没看着就该叫我」的口径）。
 */
internal object TurnSpeechLogic {

    /**
     * 判定一次「回合完成」要不要念。
     *
     * @param enabled 用户在设置里开着「完成后语音播报」。
     * @param voiceChatActive 语音对话模式正在跑（它会自己念，别重复）。
     * @param watchingThread 用户此刻正看着这条会话（前台 + 打开的就是它）。
     * @param inCall 当前处于通话中（运营商通话或 VoIP）。
     * @param allowDuringCall 设置里开了「通话中也播报」。
     * @return 是否念 + 给诊断页看的理由（与「对话完成」通知同一套话术风格）。
     */
    fun decide(
        enabled: Boolean,
        voiceChatActive: Boolean,
        watchingThread: Boolean,
        inCall: Boolean,
        allowDuringCall: Boolean,
    ): Decision = when {
        !enabled -> Decision(false, "跳过：设置里已关闭语音播报")
        voiceChatActive -> Decision(false, "跳过：语音对话模式自己会念")
        watchingThread -> Decision(false, "跳过：正在看这个会话")
        inCall && !allowDuringCall -> Decision(false, "跳过：通话中（未允许通话中播报）")
        else -> Decision(true, if (inCall) "已播报（通话中，可能听不到）" else "已播报")
    }

    /** 判定结果。[reason] 直接进诊断页 `lastTurnNotify`，别再让用户猜「为什么没念」。 */
    internal data class Decision(val speak: Boolean, val reason: String)
}
