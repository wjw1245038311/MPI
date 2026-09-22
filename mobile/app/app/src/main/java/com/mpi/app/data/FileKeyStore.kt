package com.mpi.app.data

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** 本地存储损坏或密钥不匹配（例如换了签名/清过 Keystore）。 */
class KeyStoreCorruptException(message: String, cause: Throwable? = null) : Exception(message, cause)

@Serializable
internal data class StoreSnapshot(
    val version: Int = FileKeyStore.STORE_VERSION,
    val device: DeviceRecord? = null,
    val pairings: List<PairingRecord> = emptyList(),
)

/**
 * 文件型本地存储：整个快照 → JSON → [SecretBox] 加密 → base64 → 落盘。
 *
 * 为什么不用 DataStore：这里是单进程、单写者的个人应用，一个文件足够；
 * 少一层依赖 = 少一处维护面（§1.2 减法清单）。写入用「临时文件 + 原子替换」，
 * 避免写一半掉电导致整个存储损坏。
 *
 * 存储损坏时**抛 [KeyStoreCorruptException] 而不是静默清空**——清用户数据必须是显式动作。
 */
class FileKeyStore(
    private val file: File,
    private val secretBox: SecretBox,
) : KeyStore {

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    /** 串行化读改写，避免并发保存互相覆盖。 */
    private val mutex = Mutex()

    private var cached: StoreSnapshot? = null

    override suspend fun getDevice(): DeviceRecord? = read().device

    override suspend fun saveDevice(record: DeviceRecord) = update { it.copy(device = record) }

    override suspend fun getPairing(hostId: String): PairingRecord? =
        read().pairings.firstOrNull { it.hostId == hostId }

    override suspend fun savePairing(record: PairingRecord) = update { snapshot ->
        val others = snapshot.pairings.filterNot { it.hostId == record.hostId }
        snapshot.copy(pairings = others + record)
    }

    override suspend fun deletePairing(hostId: String) = update { snapshot ->
        snapshot.copy(pairings = snapshot.pairings.filterNot { it.hostId == hostId })
    }

    override suspend fun listPairings(): List<PairingRecord> = read().pairings

    /** 显式清空本地数据（用户主动要求时调用）。 */
    suspend fun reset() = mutex.withLock {
        withContext(Dispatchers.IO) {
            file.delete()
            cached = StoreSnapshot()
        }
    }

    private suspend fun read(): StoreSnapshot = mutex.withLock {
        cached ?: loadFromDisk().also { cached = it }
    }

    private suspend fun update(transform: (StoreSnapshot) -> StoreSnapshot) = mutex.withLock {
        val next = transform(cached ?: loadFromDisk())
        withContext(Dispatchers.IO) { writeToDisk(next) }
        cached = next
    }

    private fun loadFromDisk(): StoreSnapshot {
        if (!file.exists()) return StoreSnapshot()
        val raw = try {
            file.readBytes()
        } catch (e: Exception) {
            throw KeyStoreCorruptException("无法读取本地存储：${e.message}", e)
        }
        if (raw.isEmpty()) return StoreSnapshot()
        return try {
            val sealed = Base64.getDecoder().decode(raw)
            json.decodeFromString(StoreSnapshot.serializer(), secretBox.open(sealed).decodeToString())
        } catch (e: Exception) {
            throw KeyStoreCorruptException(
                "本地存储无法解密（密钥变更或数据损坏）；如需继续请显式重置本地数据",
                e,
            )
        }
    }

    private fun writeToDisk(snapshot: StoreSnapshot) {
        file.parentFile?.mkdirs()
        val sealed = secretBox.seal(json.encodeToString(StoreSnapshot.serializer(), snapshot).encodeToByteArray())
        val encoded = Base64.getEncoder().encode(sealed)

        // 先写临时文件再原子替换：写一半被打断也不会毁掉旧数据
        val temp = File(file.parentFile, "${file.name}.tmp")
        temp.writeBytes(encoded)
        try {
            Files.move(
                temp.toPath(),
                file.toPath(),
                StandardCopyOption.REPLACE_EXISTING,
                StandardCopyOption.ATOMIC_MOVE,
            )
        } catch (_: Exception) {
            // 某些文件系统不支持原子移动，退化为普通替换
            Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
    }

    companion object {
        const val STORE_VERSION = 1

        /** 真机默认位置：应用私有目录，root 之外读不到。 */
        const val FILE_NAME = "mpi-mobile-store.bin"
    }
}
