plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.mpi.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.mpi.app"
        // 与旧壳 (com.mpi.remote) 区分，保证两者可并存安装
        minSdk = 26
        targetSdk = 34
        versionCode = 58
        versionName = "0.5.53"

        // 只保留手机（arm64-v8a）与模拟器（x86_64）——个人自用，不做全 ABI 分发包
        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

tasks.withType<Test>().configureEach {
    // 中继集成测试（RelayHandshakeTest，M0-6）需要定位仓库根与 node。
    // repoRoot = mobile/app 的上两级；node 可用 MPI_NODE 覆盖 пути。
    systemProperty("mpi.repoRoot", rootProject.projectDir.parentFile.parentFile.absolutePath)
    systemProperty("mpi.nodePath", System.getenv("MPI_NODE") ?: "node")
    testLogging {
        events("passed", "failed", "skipped")
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(composeBom)

    // 扫码配对（M4）：CameraX 预览 + ML Kit 条形码识别（bundled 模型，离线可用、无需 GMS）
    implementation("androidx.camera:camera-core:1.3.4")
    implementation("androidx.camera:camera-camera2:1.3.4")
    implementation("androidx.camera:camera-lifecycle:1.3.4")
    implementation("androidx.camera:camera-view:1.3.4")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // Compose UI（BOM 管版本）
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")

    // 协议与网络（M0-4 起使用）
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // 加密：Ed25519 / X25519（Android 原生支持随版本而异，BC 可控且跨版本一致）
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit:2.0.21")

    debugImplementation("androidx.compose.ui:ui-tooling")
}
