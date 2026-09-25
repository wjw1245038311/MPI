package com.mpi.app

import com.mpi.app.data.RequestException
import com.mpi.app.data.friendlyError
import org.junit.Assert.assertEquals
import org.junit.Test

/** 面向用户的错误文案（纯函数）：协议原文只说给排查听。 */
class FriendlyErrorTest {

    @Test
    fun `not ready becomes a plain sentence`() {
        val e = RequestException("无法发送 thread.subscribe 请求（连接未就绪）", RequestException.Kind.NotReady)
        assertEquals("连接还没准备好，会继续自动重试", friendlyError(e))
    }

    @Test
    fun `timeout points at the manual retry`() {
        val e = RequestException("等待 thread.subscribe 回应超时（10000ms）", RequestException.Kind.Timeout)
        assertEquals("等主机回应超时，可点「重新同步」再试", friendlyError(e))
    }

    @Test
    fun `other errors keep their own text and never come back blank`() {
        assertEquals(
            "主机错误：BOOM",
            friendlyError(RequestException("主机错误：BOOM", RequestException.Kind.HostError)),
        )
        assertEquals("加载失败", friendlyError(RuntimeException()))
    }
}
