package com.mpi.app.body

import android.content.Context
import android.net.LocalServerSocket
import android.net.LocalSocket
import android.util.Log
import com.mpi.app.body.proto.Frames
import com.mpi.app.body.proto.Msg
import com.mpi.app.body.proto.Proto
import java.io.File
import java.security.SecureRandom
import java.util.Collections
import kotlin.concurrent.thread
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * 身体层的服务端（设计文档 §3.1）。
 *
 * - `LocalSocket` 抽象命名空间：不落文件系统，同 uid 才连得上；
 * - 首帧必须是 `session.open`，带**本次启动**随机 token（写在 `filesDir/body/session.token`）；
 * - `kind=remote`（桌面代理）还要求用户显式打开「允许桌面驱动」，默认关。
 *
 * 抽象命名空间在 proot/容器里不可用，但身体层只在 App 进程间通信，不涉及容器。
 */
internal class BodyServer(
    private val context: Context,
    private val dispatcher: BodyDispatcher,
    private val policyStore: BodyPolicyStore,
) {

    private var server: LocalServerSocket? = null
    private val clients = Collections.synchronizedSet(HashSet<LocalSocket>())
    private var acceptThread: Thread? = null

    @Volatile
    private var running = false

    @Volatile
    var lastError: String? = null
        private set

    @Synchronized
    fun start() {
        if (running) return
        val token = hex(32)
        runCatching {
            val dir = File(context.filesDir, "body").apply { mkdirs() }
            File(dir, TOKEN_FILE).writeText(token)
            File(dir, TOKEN_FILE).setReadable(true, true)
        }.onFailure { Log.w(TAG, "写 token 失败", it) }
        val socket = runCatching { LocalServerSocket(SOCKET_NAME) }.getOrElse {
            lastError = "无法监听身体层 socket：${it.message}"
            Log.e(TAG, lastError, it)
            return
        }
        server = socket
        running = true
        acceptThread = thread(name = "mpi-body-accept", isDaemon = true) {
            while (running) {
                val client = try {
                    socket.accept()
                } catch (e: Exception) {
                    if (running) Log.w(TAG, "accept 失败", e)
                    null
                }
                if (client == null) break
                clients += client
                thread(name = "mpi-body-client", isDaemon = true) { serve(client, token) }
            }
        }
        Log.i(TAG, "身体层已监听 @$SOCKET_NAME")
    }

    @Synchronized
    fun stop() {
        running = false
        runCatching { server?.close() }
        server = null
        synchronized(clients) {
            clients.forEach { runCatching { it.close() } }
            clients.clear()
        }
    }

    /** 广播事件（`task.stop` / `progress`）。 */
    fun broadcast(evt: JsonObject) {
        synchronized(clients) {
            clients.forEach { client ->
                runCatching { Frames.write(client.outputStream, evt) }
                    .onFailure { clients.remove(client) }
            }
        }
    }

    private fun serve(client: LocalSocket, token: String) {
        try {
            val input = client.inputStream
            val output = client.outputStream
            val hello = Frames.read(input) ?: return
            val params = Msg.paramsOf(hello)
            val offered = Msg.str(params, "token").orEmpty()
            val kind = Msg.str(params, "kind").orEmpty()
            val protocol = Msg.int(params, "protocol") ?: 0
            val id = Msg.idOf(hello) ?: 0L
            if (offered != token) {
                Frames.write(output, Msg.err(id, Proto.ERR_BAD_REQUEST, "token 不匹配"))
                return
            }
            if (protocol < Proto.VERSION) {
                Frames.write(output, Msg.err(id, Proto.ERR_VERSION, "客户端协议过旧（需要 ${Proto.VERSION}）"))
                return
            }
            if (kind == "remote" && !policyStore.allowRemoteDriving()) {
                Frames.write(output, Msg.err(id, Proto.ERR_DENIED, "桌面驱动未开启"))
                return
            }
            Frames.write(
                output,
                Msg.ok(
                    id,
                    buildJsonObject {
                        put("version", Proto.VERSION)
                        put("kind", kind)
                        put("a11y", deviceConnected())
                        put("caps", "screen,tap,type,scroll,key,task")
                    },
                ),
            )
            while (running) {
                val request = Frames.read(input) ?: break
                val response = dispatcher.handle(request)
                Frames.write(output, response)
            }
        } catch (e: Exception) {
            Log.i(TAG, "客户端断开：${e.javaClass.simpleName} ${e.message}")
        } finally {
            clients -= client
            runCatching { client.close() }
        }
    }

    private fun deviceConnected(): Boolean = BodyHub.connected

    companion object {
        private const val TAG = "MpiBodyServer"

        /** 抽象命名空间（不以 `/` 开头）。客户端必须用同一个名字。 */
        const val SOCKET_NAME = "com.mpi.app.body"

        /** token 文件相对 `filesDir` 的路径。 */
        const val TOKEN_FILE = "body/session.token"

        private fun hex(bytes: Int): String {
            val buf = ByteArray(bytes)
            SecureRandom().nextBytes(buf)
            return buf.joinToString("") { "%02x".format(it) }
        }
    }
}
