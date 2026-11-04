package com.mpi.app.body.proto

import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * 身体层的线上协议常量（设计文档 §3）。**改动必须同步只给一个事实源**：
 * 客户端（`:bodyclient`）、服务端（`:body`）、桌面代理三方共用这里的常量。
 */
object Proto {
    /** 协议版本；不匹配时返回 [ERR_VERSION]。 */
    const val VERSION = 1
    /** 单帧上限 8 MB（截图走预留的二进制帧，不占这条）。 */
    const val MAX_FRAME = 8 * 1024 * 1024

    // ---- 方法 ----
    const val M_SESSION_OPEN = "session.open"
    const val M_SCREEN_CAPTURE = "screen.capture"
    const val M_ACT_TAP = "act.tap"
    const val M_ACT_TYPE = "act.type"
    const val M_ACT_SCROLL = "act.scroll"
    const val M_ACT_KEY = "act.key"
    const val M_ACT_TAP_XY = "act.tapXY"
    const val M_TASK_BEGIN = "task.begin"
    const val M_TASK_END = "task.end"
    // 事件（身体层 → 客户端，无 id）
    const val E_TASK_STOP = "task.stop"
    const val E_PROGRESS = "progress"
    const val E_CONFIRM_PENDING = "confirm.pending"

    // ---- 错误码 ----
    const val ERR_NOT_ENABLED = "NOT_ENABLED"
    const val ERR_NO_SCREEN = "NO_SCREEN"
    const val ERR_STALE_SCREEN = "STALE_SCREEN"
    const val ERR_DENIED = "DENIED_BY_POLICY"
    const val ERR_DECLINED = "USER_DECLINED"
    const val ERR_NEEDS_USER = "NEEDS_USER"
    const val ERR_BUSY = "BUSY"
    const val ERR_TIMEOUT = "TIMEOUT"
    const val ERR_VERSION = "VERSION_MISMATCH"
    const val ERR_BAD_REQUEST = "BAD_REQUEST"
    /** 需要确认，但这一版还没有确认卡（fail-closed）。 */
    const val ERR_NEEDS_CONFIRM = "NEEDS_CONFIRM"
}

/**
 * 帧格式：`u32 小端长度 | UTF-8 JSON`。
 *
 * 选它而不是 NDJSON 的原因：长度前缀不怕 JSON 里出现换行，也便于以后接二进制帧
 * （`type=0x02`）传截图。
 */
object Frames {

    fun encode(obj: JsonObject): ByteArray {
        val body = obj.toString().toByteArray(Charsets.UTF_8)
        require(body.size <= Proto.MAX_FRAME) { "帧过大：${body.size}" }
        val out = ByteArray(4 + body.size)
        out[0] = (body.size and 0xff).toByte()
        out[1] = ((body.size shr 8) and 0xff).toByte()
        out[2] = ((body.size shr 16) and 0xff).toByte()
        out[3] = ((body.size shr 24) and 0xff).toByte()
        body.copyInto(out, 4)
        return out
    }

    /** 读一帧；正常 EOF 返回 null（对端关闭），其它错误抛 [IOException]。 */
    fun read(input: InputStream): JsonObject? {
        val header = readFully(input, 4, eofOk = true) ?: return null
        val len = (header[0].toInt() and 0xff) or
            ((header[1].toInt() and 0xff) shl 8) or
            ((header[2].toInt() and 0xff) shl 16) or
            ((header[3].toInt() and 0xff) shl 24)
        if (len <= 0 || len > Proto.MAX_FRAME) throw IOException("非法帧长度：$len")
        val body = readFully(input, len, eofOk = false) ?: throw EOFException("帧不完整")
        return Json.parseToJsonElement(String(body, Charsets.UTF_8)) as? JsonObject
            ?: throw IOException("帧不是 JSON 对象")
    }

    fun write(out: OutputStream, obj: JsonObject) {
        out.write(encode(obj))
        out.flush()
    }

    private fun readFully(input: InputStream, size: Int, eofOk: Boolean): ByteArray? {
        val buf = ByteArray(size)
        var read = 0
        while (read < size) {
            val n = input.read(buf, read, size - read)
            if (n < 0) {
                if (read == 0 && eofOk) return null
                throw EOFException("读取中断：$read/$size")
            }
            read += n
        }
        return buf
    }
}

/** 三类消息的构造与取值辅助（避免各处手写 JsonObject）。 */
object Msg {
    fun req(id: Long, method: String, params: JsonObject = JsonObject(emptyMap())): JsonObject = buildJsonObject {
        put("id", id)
        put("method", method)
        put("params", params)
    }

    fun ok(id: Long, result: JsonObject = JsonObject(emptyMap())): JsonObject = buildJsonObject {
        put("id", id)
        put("ok", true)
        put("result", result)
    }

    fun err(id: Long, code: String, message: String): JsonObject = buildJsonObject {
        put("id", id)
        put("ok", false)
        put("code", code)
        put("message", message)
    }

    fun evt(method: String, params: JsonObject = JsonObject(emptyMap())): JsonObject = buildJsonObject {
        put("method", method)
        put("params", params)
    }

    fun methodOf(obj: JsonObject): String? = obj["method"]?.jsonPrimitive?.contentOrNull
    fun idOf(obj: JsonObject): Long? = obj["id"]?.jsonPrimitive?.contentOrNull?.toLongOrNull()
    fun paramsOf(obj: JsonObject): JsonObject = obj["params"] as? JsonObject ?: JsonObject(emptyMap())

    fun str(obj: JsonObject, key: String): String? =
        (obj[key] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() }

    fun int(obj: JsonObject, key: String): Int? = str(obj, key)?.toIntOrNull()
    fun long(obj: JsonObject, key: String): Long? = str(obj, key)?.toLongOrNull()
    fun bool(obj: JsonObject, key: String): Boolean? = str(obj, key)?.toBooleanStrictOrNull()
}
