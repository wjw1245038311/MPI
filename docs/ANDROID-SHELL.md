# 安卓壳（MPI APK）

给手机一个全屏容器 App：打开即是**桌面会话的实时视图**，可以在手机上继续桌面正在跑的对话。

- 包名 `com.mpi.remote`，源码在仓库 `android/`
- **只面向个人自用**：debug 自签、侧载安装，不做上架
- 刻意不做的事见文末「边界」

## 为什么是"壳"而不是重写一个原生 App

手机端的一切（配对、E2E 加密、会话流、审批卡）都已经在 `mobile/pwa` 里实现并验收过
（见 `docs/MOBILE-DESIGN.md` §6）。壳的价值只有两点：**全屏无浏览器外壳**（像 App 一样
常驻、不会被浏览器标签页回收）和**出问题时的原生兜底 UI**。所以壳里没有任何传输或加密
代码——它载入的就是中继托管的那份 H5 构建。

> 历史包袱提醒：仓库里 `scripts/test-remote-protocol.mjs` 早期断言过 `android/...WebRtcClient.kt`
> （STUN/心跳/直连），那是上一代 WebRTC 直连架构的安卓端，已随 WSS 中继方案退役；该测试已改为
> 断言当前壳的结构（见文件内注释）。

## 目录与职责

| 文件 | 职责 |
| --- | --- |
| `app/src/main/java/com/mpi/remote/MainActivity.kt` | 全屏 WebView、返回键、预览 origin 白名单、触摸不拦截、加载失败兜底面板（改中继地址）、`BuildConfig.DEBUG` 才开的调试与本地 TLS 放行 |
| `app/src/main/java/com/mpi/remote/RemoteProtocol.kt` | 协议**类型镜像**（`protocol/remote-v1.schema.json` 的 Kotlin 视图）。今天不参与收发，用于让原生侧扩展字段时不能自创字段名 |
| `app/src/main/AndroidManifest.xml` | INTERNET 权限、单 Activity、以及 `https://<relay>` 的 VIEW intent-filter（「用 MPI 打开」= 换中继地址） |
| `app/src/main/res/*` | 自适应图标（复用 PWA 那张折线图标）、主题、字符串 |

中继地址存在 `SharedPreferences("mpi-shell")` 的 `baseUrl`（默认 `DEFAULT_BASE_URL`）。
加载失败时兜底面板可以直接改；页面正常时用「用 MPI 打开」中继链接来切换。

## 构建

前置（本机已装，装在仓库外的 `E:\MyWorkspace\Software\`）：

| 组件 | 版本/路径 |
| --- | --- |
| JDK | Temurin 21（`E:\MyWorkspace\Software\jdk21`） |
| Android SDK | `E:\MyWorkspace\Software\android-sdk`（build-tools;35.0.0、platform-tools、platforms;android-35） |
| Gradle | 8.10.2（`E:\MyWorkspace\Software\gradle-8.10.2`，也可用仓库里的 wrapper） |

```bash
cd android
JAVA_HOME='E:\MyWorkspace\Software\jdk21' ./gradlew assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

两个必踩的坑（都已处理，改动时别踩回去）：

1. **下载源**：`services.gradle.org` 与 Adoptium 的二进制都 307 跳 `github.com`（本机被墙）。
   `gradle/wrapper/gradle-wrapper.properties` 的 `distributionUrl` 指向华为镜像
   `https://repo.huaweicloud.com/gradle/…`；JDK 从清华 `mirrors.tuna.tsinghua.edu.cn/Adoptium/` 取。
   Google Maven / Maven Central / Plugin Portal 本身可达，无需代理。
2. **`android/local.properties` 的 `sdk.dir` 必须用正斜杠**（`E:/MyWorkspace/Software/android-sdk`）。
   反斜杠会被 Java Properties 当转义吞掉，报「文件名、目录名或卷标语法不正确」。

`local.properties` 是机器相关的，已在 `.gitignore` 里；换机器要重新写。

## 安装与使用

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk   # 或把 APK 传到手机点安装
```

首次使用：桌面 MPI → 侧栏「手机远程控制（云中继）」→ 生成配对二维码 → 手机壳里粘贴
`mpi://pair?payload=…` 链接 → 桌面点「允许」。之后打开壳就是上次的会话列表。

## 模拟器联调（本机自测，无需真机）

雷电模拟器**没有 Tailscale**，到不了 tailnet 上的中继，所以用回环隧道把它接进去：

```bash
# ① 宿主把 tailnet 中继映射到本机回环（临时脚本，不入库）
node %TEMP%/mpi-relay-fwd.mjs            # 127.0.0.1:9443 → 100.67.5.31:9443
# ② 模拟器用宿主回环
F:/leidian/LDPlayer14/adb.exe reverse tcp:9443 tcp:9443
# ③ 壳内地址改成 https://127.0.0.1:9443/
F:/leidian/LDPlayer14/adb.exe shell am start -n com.mpi.remote/.MainActivity \
  -a android.intent.action.VIEW -d "https://127.0.0.1:9443/"
```

- `127.0.0.1` 在 WebView 里算**安全上下文**，`isSecureContext=true`、`crypto.subtle` 可用，
  E2E 加密照常工作。
- 中继证书签的是 tailnet 域名，所以走回环必然证书不匹配：debug 构建在
  `onReceivedSslError` 里放行 `https://127.0.0.1`（release 永远 fail-closed）。
- 配对链接里的 `relayUrl` 要改写成 `wss://127.0.0.1:9443/ws` 再注入（`hostId`/密钥与 URL
  无关，改写不影响 E2E）。
- 看壳内页面/注入 JS：`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`
  （socket 名从 `adb shell cat /proc/net/unix | grep webview_devtools` 取），
  然后 `http://127.0.0.1:9222/json/list` 接 CDP。debug 构建已开 `setWebContentsDebuggingEnabled`。

## 边界（刻意不做）

- **后台常驻与锁屏推送**：WebView 里没有 `PushManager`（实测 `pushManager=false`、
  `Notification=undefined`），且个人自用只需「打开就能看到」。桌面审批的锁屏通知仍由浏览器
  PWA + WebPush 承担（那条路需要 Google Play 服务，见 `MOBILE-DESIGN.md` §7/§8.1）。
- **WebRTC 直连 / 原生传输**：已由 WSS 中继取代，壳里不重复实现。
- **正式签名与上架**：当前是 debug 自签（同一台机器的 `~/.android/debug.keystore`，可覆盖安装）。
  需要长期分发时再补 release keystore。
