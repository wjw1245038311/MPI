package com.mpi.app

import com.mpi.app.body.proto.Frames
import com.mpi.app.body.proto.Msg
import com.mpi.app.body.proto.Proto
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.IOException
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * IPC 帧编解码（`u32 小端长度 | UTF-8 JSON`）。
 * 这条通道是身体层与大脑之间唯一的接触面，边界条件必须钉住：
 * 超长帧拒绝、半帧不挂死、EOF 正常退出。
 */
class BodyFramesTest {

    @Test
    fun `request round-trips with method and id`() {
        val req = Msg.req(7L, Proto.M_SCREEN_CAPTURE, buildJsonObject { put("detail", true) })
        val bytes = Frames.encode(req)
        val back = Frames.read(ByteArrayInputStream(bytes))
        assertEquals(Proto.M_SCREEN_CAPTURE, Msg.methodOf(back!!))
        assertEquals(7L, Msg.idOf(back!!))
        assertEquals(true, Msg.bool(Msg.paramsOf(back!!), "detail"))
    }

    @Test
    fun `two frames in one stream are read separately`() {
        val out = ByteArrayOutputStream()
        Frames.write(out, Msg.evt(Proto.E_TASK_STOP, buildJsonObject { put("reason", "screen_off") }))
        Frames.write(out, Msg.ok(1L))
        val input = ByteArrayInputStream(out.toByteArray())
        val first = Frames.read(input)!!
        val second = Frames.read(input)!!
        assertEquals(Proto.E_TASK_STOP, Msg.methodOf(first))
        assertEquals(1L, Msg.idOf(second))
        assertNull(Frames.read(input))
    }

    @Test
    fun `oversized frames are refused before writing`() {
        val huge = buildJsonObject { put("text", "x".repeat(Proto.MAX_FRAME)) }
        assertTrue(runCatching { Frames.encode(huge) }.isFailure)
    }

    @Test(expected = EOFException::class)
    fun `truncated frame throws instead of hanging`() {
        val bytes = Frames.encode(Msg.ok(1L))
        Frames.read(ByteArrayInputStream(bytes.copyOf(bytes.size - 3)))
    }

    @Test(expected = IOException::class)
    fun `illegal length header is rejected`() {
        val header = ByteArray(4)
        // 0xFF FF FF FF = 非法（负数/超限）
        for (i in 0 until 4) header[i] = 0xFF.toByte()
        Frames.read(ByteArrayInputStream(header))
    }
}
