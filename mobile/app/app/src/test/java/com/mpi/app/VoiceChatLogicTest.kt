package com.mpi.app

import com.mpi.app.ui.VoiceChatState
import com.mpi.app.ui.voiceChatLabel
import org.junit.Assert.assertEquals
import org.junit.Test

/** 语音对话模式浮层文案（纯函数）。 */
class VoiceChatLogicTest {

    @Test
    fun `every state has a distinct label`() {
        val labels = VoiceChatState.entries.map { voiceChatLabel(it) }
        assertEquals(VoiceChatState.entries.size, labels.toSet().size)
        assertEquals("在听……说完停一下就行", voiceChatLabel(VoiceChatState.Listening))
        assertEquals("正在识别", voiceChatLabel(VoiceChatState.Transcribing))
        assertEquals("等回复中", voiceChatLabel(VoiceChatState.Thinking))
        assertEquals("正在播报", voiceChatLabel(VoiceChatState.Speaking))
    }
}
