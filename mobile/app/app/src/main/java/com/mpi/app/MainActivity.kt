package com.mpi.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.mpi.app.ui.BenchmarkScreen
import com.mpi.app.ui.EXTRA_BENCHMARK
import com.mpi.app.ui.theme.MpiTheme

/**
 * M0 骨架自检页（临时）。
 *
 * 目的只有两个：证明工程能编译、证明主题令牌生效。
 * M1 起会被真正的首屏（docs/MOBILE-NATIVE-DESIGN.md §4.3）替换。
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // 基准入口：adb shell am start -n com.mpi.app/.MainActivity --ez benchmark true
        val benchmark = intent?.getBooleanExtra(EXTRA_BENCHMARK, false) == true
        setContent {
            MpiTheme {
                if (benchmark) {
                    BenchmarkScreen()
                } else {
                    Scaffold { innerPadding ->
                        SkeletonScreen(Modifier.padding(innerPadding))
                    }
                }
            }
        }
    }
}

@Composable
private fun SkeletonScreen(modifier: Modifier = Modifier) {
    val colors = MpiTheme.colors
    Column(
        modifier = modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            modifier = Modifier.size(56.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = "M",
                color = MaterialTheme.colorScheme.onPrimary,
                fontSize = MaterialTheme.typography.titleMedium.fontSize,
                fontWeight = FontWeight.Bold,
            )
        }

        Spacer(Modifier.height(12.dp))
        Text("MPI 手机端", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(4.dp))
        Text(
            text = "v${BuildConfig.VERSION_NAME} · M0 骨架",
            style = MaterialTheme.typography.bodySmall,
            color = colors.textDim,
        )

        Spacer(Modifier.height(24.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Swatch(MaterialTheme.colorScheme.primary, "accent")
            Swatch(MaterialTheme.colorScheme.surfaceVariant, "surface")
            Swatch(colors.accentSoft, "soft")
            Swatch(colors.send, "send")
            Swatch(colors.err, "err")
        }

        Spacer(Modifier.height(16.dp))
        Text(
            text = "主题令牌已生效；协议层与界面待 M1 起接入。",
            style = MaterialTheme.typography.bodySmall,
            color = colors.textFaint,
        )
    }
}

@Composable
private fun Swatch(color: Color, label: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier.size(36.dp).clip(RoundedCornerShape(8.dp)).background(color),
        )
        Spacer(Modifier.width(4.dp))
        Text(label, style = MaterialTheme.typography.labelSmall, color = MpiTheme.colors.textFaint)
    }
}

@Preview(showBackground = true)
@Composable
private fun SkeletonScreenPreview() {
    MpiTheme { SkeletonScreen() }
}
