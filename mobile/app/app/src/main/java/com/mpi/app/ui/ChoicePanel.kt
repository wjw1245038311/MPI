package com.mpi.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.mpi.app.ui.theme.MpiTheme

/** 一题是否已作答（选项有标签 / 其它有非空文本）。 */
internal fun isChoiceAnswered(answer: ChoiceAnswer?): Boolean = when (answer) {
    null -> false
    is ChoiceAnswer.Option -> answer.label.isNotBlank()
    is ChoiceAnswer.Other -> answer.text.isNotBlank()
}

/**
 * 对话内多题选择面板（批 3；PWA `ChoicePanel.tsx` 的 Compose 版）。
 *
 * 每题点选一个选项（或「其它」自由文本），全部答完点「发送选择」——答案合并成
 * 一条「我的选择：…」消息发出（走 followUp/prompt 路由）。发送后由会话记录推导
 * 状态自动冻结（[ChoicePanelState]），刷新/重连后保持一致。
 *
 * 草稿（未发送的点选）只在本次会话内存里，不做持久化——原生版重进会话后
 * 点选会丢，属已知简化。
 */
@Composable
fun ChoicePanel(
    data: ChoiceBlockData,
    state: ChoicePanelState,
    language: String,
    onSend: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val zh = language == "zh"
    val frozen = state !is ChoicePanelState.Pending

    val answers = remember(data) { mutableStateMapOf<Int, ChoiceAnswer>() }
    val otherText = remember(data) { mutableStateMapOf<Int, String>() }
    var otherOpen by remember(data) { mutableStateOf(-1) }
    var sending by remember(data) { mutableStateOf(false) }
    var showMissing by remember(data) { mutableStateOf(false) }

    val effective: Map<Int, ChoiceAnswer> = if (state is ChoicePanelState.Answered) state.answers else answers
    // 发送失败（乐观回显被撤）→ 状态回到 Pending，按钮要能再点
    LaunchedEffect(state) { if (state is ChoicePanelState.Pending) sending = false }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(MpiTheme.colors.surfaceMuted)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        data.questions.forEachIndexed { qi, question ->
            val current = effective[qi]

            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    text = "${qi + 1}. ${question.title}",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                )

                question.options.forEach { option ->
                    ChoiceOptionRow(
                        label = option.label,
                        detail = option.detail,
                        selected = current is ChoiceAnswer.Option && current.label == option.label,
                        frozen = frozen,
                    ) {
                        answers[qi] = ChoiceAnswer.Option(option.label)
                        otherOpen = -1
                    }
                }

                if (current is ChoiceAnswer.Other) {
                    ChoiceOptionRow(
                        label = if (zh) "其它：${current.text}" else "Other: ${current.text}",
                        detail = null,
                        selected = true,
                        frozen = frozen,
                    ) {
                        otherText[qi] = current.text
                        otherOpen = qi
                    }
                }

                if (!frozen && otherOpen != qi) {
                    TextButton(
                        onClick = {
                            otherText[qi] = (current as? ChoiceAnswer.Other)?.text.orEmpty()
                            otherOpen = qi
                        },
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 4.dp, vertical = 0.dp),
                    ) {
                        Text(if (zh) "其它（输入自定义答案）…" else "Other (type your own)…", style = MaterialTheme.typography.labelSmall)
                    }
                }

                if (!frozen && otherOpen == qi) {
                    OutlinedTextField(
                        value = otherText[qi].orEmpty(),
                        onValueChange = { otherText[qi] = it },
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = { Text(if (zh) "输入自定义答案…" else "Type your answer…", style = MaterialTheme.typography.bodySmall) },
                        singleLine = true,
                        shape = RoundedCornerShape(10.dp),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        TextButton(onClick = { otherOpen = -1 }) { Text(if (zh) "取消" else "Cancel") }
                        Button(
                            onClick = {
                                val text = otherText[qi].orEmpty().trim()
                                if (text.isNotEmpty()) {
                                    answers[qi] = ChoiceAnswer.Other(text)
                                    otherOpen = -1
                                }
                            },
                            enabled = !otherText[qi].orEmpty().trim().isEmpty(),
                            shape = RoundedCornerShape(10.dp),
                        ) { Text(if (zh) "确认" else "OK") }
                    }
                }
            }
        }

        val missing = data.questions.indices.count { !isChoiceAnswered(effective[it]) }

        if (frozen) {
            Text(
                text = if (state is ChoicePanelState.Answered) {
                    if (zh) "已回复" else "Answered"
                } else {
                    if (zh) "已用其它方式回答" else "Answered another way"
                },
                style = MaterialTheme.typography.labelSmall,
                color = MpiTheme.colors.textFaint,
            )
        } else {
            if (showMissing && missing > 0) {
                Text(
                    text = if (zh) "还有 $missing 题未选择" else "$missing question(s) still unanswered",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            Button(
                onClick = {
                    if (missing > 0) {
                        showMissing = true
                        return@Button
                    }
                    sending = true
                    val list = data.questions.indices.map { effective[it] }
                    onSend(buildChoiceReplyText(data.questions, list, language))
                },
                enabled = !sending,
                shape = RoundedCornerShape(10.dp),
            ) {
                Text(if (sending) (if (zh) "发送中…" else "Sending…") else (if (zh) "发送选择" else "Send choices"))
            }
        }
    }
}

@Composable
private fun ChoiceOptionRow(
    label: String,
    detail: String?,
    selected: Boolean,
    frozen: Boolean,
    onClick: () -> Unit,
) {
    val accent = MaterialTheme.colorScheme.primary
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(9.dp))
            .background(if (selected) MpiTheme.colors.accentSoft else Color.Transparent)
            .border(1.dp, if (selected) accent else MpiTheme.colors.border, RoundedCornerShape(9.dp))
            .clickable(enabled = !frozen, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            modifier = Modifier
                .size(14.dp)
                .clip(CircleShape)
                .border(1.dp, if (selected) accent else MpiTheme.colors.border, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            if (selected) {
                Box(Modifier.size(7.dp).clip(CircleShape).background(accent))
            }
        }
        if (selected) {
            Icon(IconCheck, contentDescription = null, tint = accent, modifier = Modifier.size(12.dp))
        }
        Column {
            Text(label, style = MaterialTheme.typography.bodyMedium)
            if (detail != null) {
                Text(detail, style = MaterialTheme.typography.labelSmall, color = MpiTheme.colors.textFaint)
            }
        }
    }
}
