package com.mpi.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mpi.app.ui.theme.MpiTheme

/**
 * 上次崩溃的现场（启动时先展示，可复制/分享）。
 *
 * 为什么先占一屏而不是弹个 toast：手机端崩溃后没有任何证据可拿（没有 logcat、没有文件），
 * 用户只能描述「闪退了」。这一页把线程、异常类型、栈、版本、设备一次性摆出来，一键复制即可。
 *
 * 安全模式（[safeMode]）时额外说明「本次不会自动连接上次的主机」——那是「完全进不去 App」
 * 的逃生门：出问题的那条自动重连路径这次不跑。
 */
@Composable
fun CrashScreen(
    report: String,
    safeMode: Boolean,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    var copied by remember { mutableStateOf(false) }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MpiTheme.colors.bg)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("上次启动崩溃了", style = MaterialTheme.typography.titleMedium)
        Text(
            if (safeMode) {
                "已用**安全模式**启动：这次不会自动连接上次的主机（也不会后台同步账号）。" +
                    "把下面这段发给开发者，就能定位原因；要恢复正常，进 App 后手动点一台主机即可。"
            } else {
                "这是上一次崩溃的记录（本次启动不受影响）。复制后发给开发者即可定位。"
            },
            style = MaterialTheme.typography.bodySmall,
            color = MpiTheme.colors.textDim,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(onClick = {
                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                clipboard?.setPrimaryClip(ClipData.newPlainText("MPI 崩溃记录", report))
                copied = true
            }) { Text(if (copied) "已复制" else "复制") }
            TextButton(onClick = {
                // 分享走系统面板（飞书/微信/邮件都行）——比让用户手抄快得多
                val intent = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, report)
                }
                runCatching { context.startActivity(Intent.createChooser(intent, "分享崩溃记录")) }
            }) { Text("分享") }
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onDismiss) { Text(if (safeMode) "进入 App" else "知道了") }
        }
        Text(
            report,
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .horizontalScroll(rememberScrollState())
                .background(MpiTheme.colors.surfaceMuted)
                .padding(10.dp),
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurface,
        )
        if (safeMode) {
            Text(
                "提示：如果安全模式下依然崩溃，说明问题不在「自动重连」，请把这份记录发我；" +
                    "也可以在彻底退出 App 后重开一次看是否恢复。",
                style = MaterialTheme.typography.labelSmall,
                color = MpiTheme.colors.textFaint,
            )
        }
    }
}
