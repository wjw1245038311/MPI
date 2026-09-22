// 原生手机端（Kotlin + Jetpack Compose）
// 设计见 docs/MOBILE-NATIVE-DESIGN.md；本工程与仓库根目录的 android/（旧 WebView 壳，冻结）无关。
// 版本组合与旧壳保持一致（AGP 8.7.3 / Kotlin 2.0.21），这套组合已在本机验证可用。
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.0.21" apply false
}
