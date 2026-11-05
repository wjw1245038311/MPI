package com.mpi.app.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * 本地缓存的账号状态（**整体进 SecretBox 加密存储**）。
 *
 * [keyB64] 是 PBKDF2 派生的同步密钥：有了它才能解密同步包。它被 AndroidKeyStore
 * 包了一层——所以：
 *   · 日常（重启 App）自动同步不需要再输密码；
 *   · 卸载/换机后这份没了，用户重新登录（输密码）即可恢复——这正是账号的意义。
 */
@Serializable
data class AccountState(
    val session: AccountSession,
    /** PBKDF2 派生密钥（base64）。 */
    val keyB64: String,
    val lastSyncAt: Long = 0,
    /** 服务端同步包的版本号（写入时递增，便于诊断"谁覆盖了谁"）。 */
    val revision: Int = 0,
)

/**
 * 账号同步包：**个人信息**这一版只装两样东西（2026-11-05 用户决定）。
 *
 *   1. 主机配对清单（[PairingRecord]，含 deviceToken / 主机公钥 / 中继候选）
 *   2. App 设置（一个扁平字符串表；键名与桌面/PWA 对齐，见 [SETTING_KEYS]）
 *
 * 不装的：会话历史、草稿、附件（在各自主机上，量大且与设备强相关）。
 *
 * 合并策略是**本地优先**：同一个 hostId 以本机为准（本机的 relayUrl/lastGood 才是最新的），
 * 远端多出来的补进来。**删除不做同步**——"换掉手机"和"误删"在服务端看起来一样，
 * 自动跟随删除会把另一台设备上还能用的配对干掉。
 */
@Serializable
data class SyncPayload(
    val version: Int = AccountSync.VERSION,
    val updatedAt: Long = 0,
    val pairings: List<PairingRecord> = emptyList(),
    val settings: Map<String, String> = emptyMap(),
)

object AccountSync {
    const val VERSION = 1

    /** 这一版参与同步的设置项（新增键要三端一起改，否则别端会当成未知键忽略）。 */
    val SETTING_KEYS = setOf("appearance", "fontSize", "showToolCalls", "showThinking")

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    fun encode(payload: SyncPayload): ByteArray = json.encodeToString(SyncPayload.serializer(), payload).toByteArray()

    fun decode(bytes: ByteArray): SyncPayload? = runCatching {
        json.decodeFromString(SyncPayload.serializer(), bytes.decodeToString())
    }.getOrNull()

    /**
     * 配对清单合并（纯函数）：本地优先，远端补齐缺的 hostId。
     *
     * 顺序保持本地顺序（界面里的排序不该因为一次同步跳变），远端新增的追加在末尾。
     */
    fun mergePairings(local: List<PairingRecord>, remote: List<PairingRecord>): List<PairingRecord> {
        val known = local.map { it.hostId }.toSet()
        return local + remote.filterNot { it.hostId in known }
    }

    /** 设置合并：本地已有键为准，远端补缺（与配对清单同一语义）。 */
    fun mergeSettings(local: Map<String, String>, remote: Map<String, String>): Map<String, String> {
        val merged = LinkedHashMap(local)
        for ((key, value) in remote) {
            if (key in SETTING_KEYS && key !in merged) merged[key] = value
        }
        return merged
    }

    /**
     * 同步哪些设置：只收**用户显式改过、且跨设备有意义**的项（外观/字号/两块展示开关）。
     * 刻意不收：通知与语音（与这台手机的系统能力绑定）、保活（同）、草稿（会话相关）。
     */
    fun settingsToMap(settings: AppSettings): Map<String, String> = buildMap {
        put("appearance", settings.appearance.wire)
        put("fontSize", settings.fontSize.wire)
        put("showToolCalls", settings.showToolCalls.toString())
        put("showThinking", settings.showThinking.toString())
    }

    /** 把远端的设置写回本地（只认白名单键；非法值忽略，绝不把本地改成坏值）。 */
    fun applySettings(map: Map<String, String>, store: SettingsStore) {
        // 只认**已知取值**：未知值保持本地不变（fromStored 会把未知值回落到默认，
        // 那等于用远端的一个坏值把本地设置清成默认）。
        map["appearance"]?.takeIf { it in APPEARANCES }?.let { store.setAppearance(Appearance.fromStored(it)) }
        map["fontSize"]?.takeIf { it in FONT_SIZES }?.let { store.setFontSize(FontSize.fromStored(it)) }
        map["showToolCalls"]?.toBooleanStrictOrNull()?.let(store::setShowToolCalls)
        map["showThinking"]?.toBooleanStrictOrNull()?.let(store::setShowThinking)
    }

    private val APPEARANCES = setOf("system", "light", "dark")
    private val FONT_SIZES = setOf("small", "normal", "large")

    /** 把当前状态打包成待上传的同步包。 */
    fun build(pairings: List<PairingRecord>, settings: Map<String, String>, now: Long = System.currentTimeMillis()): SyncPayload =
        SyncPayload(
            version = VERSION,
            updatedAt = now,
            pairings = pairings,
            settings = settings.filterKeys { it in SETTING_KEYS },
        )
}
