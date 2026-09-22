package com.mpi.app.data

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * 中继**控制帧**（首帧决定 socket 角色，见 mobile/relay/README.md）。
 *
 * ⚠️ 控制帧不是 protocol envelope：没有 `v` / `sessionId` / `sentAt`，
 * 只有 `type` + 少量字段。别和 [com.mpi.app.protocol.Envelope] 混用。
 */
object ControlFrames {
    /** 设备首帧：请求配对。中继按 ticket 原样转给对应 host。 */
    fun pairRequest(ticket: String, deviceId: String, name: String): String = buildJsonObject {
        put("type", "pair.request")
        put("ticket", ticket)
        put("deviceId", deviceId)
        put("name", name)
    }.toString()

    /**
     * 设备认证帧：用已配对得到的 deviceToken 绑定到 (hostId, deviceId)。
     * 重连时发它会让中继通知 host 重发 pair.challenge，从而走重认证。
     */
    fun hello(deviceId: String, deviceToken: String, hostId: String?): String = buildJsonObject {
        put("type", "hello")
        put("deviceId", deviceId)
        put("deviceToken", deviceToken)
        if (hostId != null) put("hostId", hostId)
    }.toString()
}
