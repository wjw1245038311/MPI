plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.mpi.remote"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.mpi.remote"
        minSdk = 26
        targetSdk = 34
        versionCode = 8
        versionName = "0.2.6"

        // ML Kit 条码的 native 库（libbarhopper_v3.so）每个 ABI 约 5–6MB，四个 ABI 就是 20MB+。
        // 只留手机（arm64-v8a）与模拟器（x86_64）——个人自用，不做全 ABI 分发包。
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
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")

    // 壳内扫码：CameraX 预览 + ML Kit 条码（bundled 模型，无需 Google Play 服务）
    implementation("androidx.camera:camera-core:1.3.4")
    implementation("androidx.camera:camera-camera2:1.3.4")
    implementation("androidx.camera:camera-lifecycle:1.3.4")
    implementation("androidx.camera:camera-view:1.3.4")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
}
