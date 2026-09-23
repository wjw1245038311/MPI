package com.mpi.app.data

import kotlinx.serialization.Serializable

/**
 * 持久化契约 —— 字段与 PWA 的 `mobile/pwa/src/lib/keystore.ts` **完全对齐**
 * （同名同义），便于日后双端互查与排障。
 */

/** 设备身份：一台手机一份 Ed25519 种子，多台主机共用。 */
@Serializable
data class DeviceRecord(
    /** Ed25519 种子（base64url）。 */
    val seedB64url: String,
    val name: String,
)

@Serializable
data class PairingRecord(
    val hostId: String,
    val relayUrl: String,
    val deviceId: String,
    /** 来自 pair.accepted 的稳定令牌；重连时用它走 hello 重认证。 */
    val deviceToken: String? = null,
    /** 主机 X25519 公钥（b64url），用于派生 E2E 会话密钥。 */
    val hostX25519PubB64u: String? = null,
    val pairedAt: Long,
    /** 配对载荷带来的桌面机器名。 */
    val hostName: String? = null,
    /** 手机端本地重命名（显示优先于 hostName；只存本机）。 */
    val displayName: String? = null,
    /** 最近一次连接时间；多设备列表按它排序、自动重连优先选最近用过的。 */
    val lastSeenAt: Long? = null,
) {
    /** 列表展示用的名字：本地备注 > 机器名 > hostId 前 6 位。 */
    val shownName: String
        get() = displayName?.trim()?.takeIf { it.isNotEmpty() }
            ?: hostName?.trim()?.takeIf { it.isNotEmpty() }
            ?: "主机 ${hostId.take(6)}"

    /** 排序/自动重连用的时间戳（旧记录没有 lastSeenAt 时回退到 pairedAt）。 */
    val sortKey: Long
        get() = lastSeenAt ?: pairedAt
}

interface KeyStore {
    suspend fun getDevice(): DeviceRecord?

    suspend fun saveDevice(record: DeviceRecord)

    suspend fun getPairing(hostId: String): PairingRecord?

    suspend fun savePairing(record: PairingRecord)

    suspend fun deletePairing(hostId: String)

    suspend fun listPairings(): List<PairingRecord>

    /** 显式清空本地数据（必须由用户主动确认后调用，见 §1.1「不静默清空」）。 */
    suspend fun reset()
}

/** 内存实现：测试与非 Android 环境。 */
class MemoryKeyStore : KeyStore {
    private var device: DeviceRecord? = null
    private val pairings = linkedMapOf<String, PairingRecord>()

    override suspend fun getDevice(): DeviceRecord? = device

    override suspend fun saveDevice(record: DeviceRecord) {
        device = record
    }

    override suspend fun getPairing(hostId: String): PairingRecord? = pairings[hostId]

    override suspend fun savePairing(record: PairingRecord) {
        pairings[record.hostId] = record
    }

    override suspend fun deletePairing(hostId: String) {
        pairings.remove(hostId)
    }

    override suspend fun listPairings(): List<PairingRecord> = pairings.values.toList()

    override suspend fun reset() {
        device = null
        pairings.clear()
    }
}
