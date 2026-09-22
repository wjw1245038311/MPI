package com.mpi.app

import com.mpi.app.data.DeviceRecord
import com.mpi.app.data.FileKeyStore
import com.mpi.app.data.KeyStoreCorruptException
import com.mpi.app.data.MemoryKeyStore
import com.mpi.app.data.PairingRecord
import com.mpi.app.data.RawKeySecretBox
import com.mpi.app.data.SecretBox
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * M1-1：本地配对信息持久化。
 *
 * 这些是 JVM 单测——Android Keystore 那一层不参与（它只负责生成/保管密钥），
 * 「加密卷 + 落盘 + 损坏检测」这套逻辑全在本地可验证。
 */
class KeyStoreTest {

    private lateinit var dir: File

    private val key = ByteArray(32) { (it + 1).toByte() }

    private fun box(): SecretBox = RawKeySecretBox(key)

    private fun storeIn(dir: File, box: SecretBox = box()) =
        FileKeyStore(File(dir, FileKeyStore.FILE_NAME), box)

    private fun samplePairing(hostId: String, seenAt: Long?) = PairingRecord(
        hostId = hostId,
        relayUrl = "wss://relay.example:9443/ws",
        deviceId = "device-abc",
        deviceToken = "token-$hostId",
        hostX25519PubB64u = "LskKQ96RhY9Um5j-df_mQx-w1dvARuYW1i67PVQ9a1w",
        pairedAt = 1_700_000_000_000,
        hostName = "wei_jw 工作站",
        lastSeenAt = seenAt,
    )

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("mpi-keystore-test").toFile()
    }

    @After
    fun tearDown() {
        dir.deleteRecursively()
    }

    @Test
    fun `device and pairings survive a reload`() = runBlocking {
        val store = storeIn(dir)
        store.saveDevice(DeviceRecord(seedB64url = "WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo", name = "测试手机"))
        store.savePairing(samplePairing("host-1", seenAt = 1_700_000_100_000))
        store.savePairing(samplePairing("host-2", seenAt = null))

        // 新实例读同一个文件 = 模拟应用重启
        val reloaded = storeIn(dir)
        assertEquals("WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo", reloaded.getDevice()?.seedB64url)
        assertEquals("测试手机", reloaded.getDevice()?.name)
        assertEquals(2, reloaded.listPairings().size)
        assertEquals("token-host-1", reloaded.getPairing("host-1")?.deviceToken)
        assertEquals("wei_jw 工作站", reloaded.getPairing("host-2")?.hostName)
        assertNull(reloaded.getPairing("host-2")?.lastSeenAt)
    }

    @Test
    fun `saving the same host replaces instead of duplicating`() = runBlocking {
        val store = storeIn(dir)
        store.savePairing(samplePairing("host-1", seenAt = 1))
        store.savePairing(samplePairing("host-1", seenAt = 2).copy(displayName = "我的主机"))

        val pairings = store.listPairings()
        assertEquals("同一 hostId 应被覆盖", 1, pairings.size)
        assertEquals("我的主机", pairings.single().displayName)
        assertEquals(2L, pairings.single().lastSeenAt)
    }

    @Test
    fun `deleting one host keeps the others`() = runBlocking {
        val store = storeIn(dir)
        store.savePairing(samplePairing("host-1", seenAt = 1))
        store.savePairing(samplePairing("host-2", seenAt = 2))
        store.deletePairing("host-1")

        assertEquals(listOf("host-2"), store.listPairings().map { it.hostId })
        assertNull(store.getPairing("host-1"))
    }

    @Test
    fun `on-disk content does not leak the token in plaintext`() = runBlocking {
        val store = storeIn(dir)
        store.savePairing(samplePairing("host-1", seenAt = 1))
        store.saveDevice(DeviceRecord("WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo", "测试手机"))

        val raw = File(dir, FileKeyStore.FILE_NAME).readBytes().decodeToString()
        assertFalse("deviceToken 不应以明文落盘", raw.contains("token-host-1"))
        assertFalse("种子不应以明文落盘", raw.contains("WlpaWlpa"))
        assertFalse("主机名不应以明文落盘", raw.contains("wei_jw"))
    }

    @Test
    fun `tampered file is reported instead of silently reset`() = runBlocking {
        val store = storeIn(dir)
        store.savePairing(samplePairing("host-1", seenAt = 1))

        // 翻转一个字节模拟损坏
        val file = File(dir, FileKeyStore.FILE_NAME)
        val bytes = file.readBytes()
        bytes[bytes.size / 2] = (bytes[bytes.size / 2].toInt() xor 0x01).toByte()
        file.writeBytes(bytes)

        try {
            storeIn(dir).listPairings()
            fail("损坏的存储必须报错，而不是静默返回空")
        } catch (e: KeyStoreCorruptException) {
            assertTrue("错误信息应给出可操作提示", e.message!!.contains("重置"))
        }
    }

    @Test
    fun `a different key cannot open the store`() = runBlocking {
        storeIn(dir).savePairing(samplePairing("host-1", seenAt = 1))

        val otherKey = ByteArray(32) { 0x7f }
        try {
            storeIn(dir, RawKeySecretBox(otherKey)).listPairings()
            fail("换密钥后必须报错")
        } catch (e: KeyStoreCorruptException) {
            assertTrue(e.message!!.contains("密钥变更"))
        }
    }

    @Test
    fun `explicit reset clears the store`() = runBlocking {
        val store = storeIn(dir)
        store.savePairing(samplePairing("host-1", seenAt = 1))
        store.reset()

        assertTrue("重置后不再有配对记录", store.listPairings().isEmpty())
        // 重置后仍可继续使用（不是把文件弄成坏状态）
        store.savePairing(samplePairing("host-2", seenAt = 2))
        assertEquals(listOf("host-2"), store.listPairings().map { it.hostId })
    }

    @Test
    fun `missing file yields an empty store`() = runBlocking {
        val store = storeIn(dir)
        assertNull(store.getDevice())
        assertTrue(store.listPairings().isEmpty())
    }

    @Test
    fun `memory store behaves the same as the file store`() = runBlocking {
        val store: com.mpi.app.data.KeyStore = MemoryKeyStore()
        store.saveDevice(DeviceRecord("seed", "手机"))
        store.savePairing(samplePairing("host-1", seenAt = 1))
        store.savePairing(samplePairing("host-1", seenAt = 5))

        assertEquals("手机", store.getDevice()?.name)
        assertEquals(1, store.listPairings().size)
        assertEquals(5L, store.getPairing("host-1")?.lastSeenAt)
        store.deletePairing("host-1")
        assertTrue(store.listPairings().isEmpty())
    }

    // ---- 展示与排序的回退规则（§4.5 多设备列表要用）----

    @Test
    fun `shown name prefers local rename then host name then short id`() {
        val base = samplePairing("abcdef1234567890", seenAt = null)
        assertEquals("本地备注优先", "手机A", base.copy(displayName = "手机A").shownName)
        assertEquals("其次用机器名", "wei_jw 工作站", base.shownName)
        assertEquals("都没有时回退到短 id", "主机 abcdef", base.copy(hostName = "  ").shownName)
    }

    @Test
    fun `sort key falls back to pairedAt for legacy records`() {
        val record = samplePairing("host-1", seenAt = null)
        assertEquals("旧记录用 pairedAt 排序", record.pairedAt, record.sortKey)
        assertEquals(42L, record.copy(lastSeenAt = 42L).sortKey)
    }
}
