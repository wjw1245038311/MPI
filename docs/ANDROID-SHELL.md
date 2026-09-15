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

## 发布与扫码下载

中继不一定一直开着，GitHub 也可能连不上，所以**两个下载源都发**，面板同时给出两张二维码：

| 源 | 地址 | 适用 |
| --- | --- | --- |
| 中继（主） | `/download/mpi-android-<v>.apk` | 手机在 Tailscale 内，最快 |
| GitHub（备选） | `https://github.com/<owner>/<repo>/releases/download/android-v<v>/mpi-android-<v>.apk` | 中继/Tailnet 不可用，且手机能访问 GitHub（仓库公开，无需 token） |
| **Seafile（最省事）** | `Agent/MPI-Android-<v>.apk`（脚本自动拷贝） | 手机上打开 Seafile 直接下；中继/GitHub 都可能慢或不可达时首选 |

```bash
# 1. 构建 + 生成本地产物（版本化 APK + sha256 + 清单，落在 android/publish/）
cd android && JAVA_HOME='E:\MyWorkspace\Software\jdk21' ./gradlew assembleDebug && cd ..
node scripts/publish-android.mjs                 # 只出本地产物
# 本机直连 api.github.com 被墙时带代理：
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:10808 node scripts/publish-android.mjs --github

# 2. 把产物拷到中继静态目录（/var/www/mpi-mobile/download/）
#    mpi-android-<v>.apk、.sha256、mpi-android.json（桌面端读的就是这份清单）
```

⚠️ **安卓的 GitHub Release 必须标成 pre-release**（脚本已内置，已存在的也会被 PATCH 回去）。
原因：桌面端自更新用 electron-updater，在 `allowPrerelease=false` 时会先取 GitHub 的
`/releases/latest` 定标签，再去该标签下找 `latest.yml`。若安卓发布成了“最新稳定版”，更新检查
会去找 `android-v*/latest.yml` 而 404 报错。标为预发布后 `/releases/latest` 仍指向 `v<桌面版本>`，
而按 tag 的直链下载不受影响。

桌面端「手机远程控制」面板的**「手机 App（安卓）」卡片**读 `/download/mpi-android.json`
（主进程取，绕过 CORS；取不到则回退到 `userData/mpi-android.json` 缓存并标注「中继暂不可达」），
显示版本/大小，并渲染两张二维码——**界面上不显示地址**（地址在图片的悬停提示里）。
中继静态服务同时处理 `HEAD`（与 `GET` 同头不带体），方便下载工具/浏览器先探尺寸。

## 扫码配对

二维码里不再是 `mpi://pair?payload=…`（系统相机与大多数扫码器只会把它当文本显示），而是：

```
https://<relay>/#pair=<base64url payload>
```

- 手机扫码 → 系统浏览器或已安装的安卓壳打开该链接（壳在清单里注册了该域名的 VIEW 过滤器）→
  PWA 读到 `#pair=` 即**自动开始配对**，配完用 `history.replaceState` 抹掉地址栏里的票据。
- 桌面端「配对手机」卡片保留了 `mpi://` 链接的文本框，粘贴式配对仍然可用。
- 卡片上的 **「扫码后自动批准（无需在桌面点允许）」** 开关（默认开）：该票在 5 分钟有效期内
  直接放行。票本身就是凭据（二维码/链接泄露等价于泄露票据），它由用户刚在面板上主动生成，
  所以省掉桌面端再点一次；关上开关则回到“扫码后需在面板点允许”的旧行为。

## 壳能力：扫码与自更新

两项都在壳（`android/`）里，不依赖 Google Play 服务：

- **壳内扫码**（`ScanActivity`）：CameraX 预览 + ML Kit `barcode-scanning`（bundled 模型，离线可用）。
  PWA 配对页上的「扫码配对」按钮靠 `window.MpiShell`（`addJavascriptInterface` 注入）探测壳环境；
  识别到文本后由壳归一化成 `https://<relay>/#pair=<payload>` 交给 WebView —— **复用 PWA 已有的
  `#pair=` 自动配对路径，原生侧不重写配对逻辑**。权限被拒时回退到「粘贴配对链接」，不影响其它功能。
  ⚠ PWA 必须监听 `hashchange`：壳内扫码时 WebView 已在本页，loadUrl 只改 hash → same-document
  导航**不重载页面**；若 PWA 只在挂载时读一次 `#pair=` 就会静默无反应（2026-09 真机 bug）。
  未识别到二维码返回壳时弹 toast，不留静默失败。
- **APK 自更新**（`Updater`）：启动 ~3 秒后读 `/download/mpi-android.json` 比对
  `BuildConfig.VERSION_NAME`；有新版就在 WebView 上方浮出原生提示条（「发现新版 X · 更新 / ✕」）。
  点更新 → HttpURLConnection 下载（带进度）→ **sha256 校验**（不一致不安装）→ FileProvider +
  `ACTION_VIEW` 调起系统安装器。Android 不允许静默安装，首次需用户在系统里允许「安装未知应用」。
  点 ✕ 会把该版本记进 prefs，同一版不再反复提示。中继不可达时静默跳过（不打扰）。
- 体积：ML Kit 的 `libbarhopper_v3.so` 每个 ABI 约 5–6MB，已用 `ndk.abiFilters` 只保留
  `arm64-v8a`（手机）+ `x86_64`（模拟器），APK 从 27.6MB 降到 **16MB**。
- 联调放行：debug 构建对 `https://127.0.0.1` 跳过证书校验（WebView 与 `Updater` 一致），
  因为中继证书签的是 tailnet 域名；release 恒 fail-closed。

验证方式：壳内配对页点「扫码配对」→ 拉起相机预览（授予相机权限后）；桌面改版本号重发一版 →
旧壳启动后出现「发现新版 X」→ 点更新 → 下载并调起系统安装器 → 安装完成；点 ✕ 后同一版不再提示。

## 壳契约（PWA ↔ APK，改动前对照）

壳与 PWA 是**两个独立发布的产物**（APK 侧载 / 中继静态托管），两者之间只有以下 JS 桥 + intent
过滤器。改任何一侧前先对照这张清单：

| # | 契约项 | 方向 | 说明 |
| --- | --- | --- | --- |
| 1 | `window.MpiShell.scanPairQr(): void` | 壳注入 → PWA | 拉起 ScanActivity；识别结果归一化成 `https://<relay>/#pair=<payload>` 交给 WebView（loadUrl，可能仅 hash 变化）。**PWA 侧必须监听 hashchange 处理 `#pair=`**（same-document 导航不重载页面）；未识别到二维码时壳弹 toast。PWA 据此在配对页显示「扫码配对」按钮 |
| 2 | `window.MpiShell.shellVersion(): string` | 壳注入 → PWA | 返回壳版本号（`BuildConfig.VERSION_NAME`），诊断/展示用 |
| 3 | 环境探测 | PWA → 壳 | PWA 以 `typeof window.MpiShell?.scanPairQr === "function"` 判定「在壳里」，显示壳专属 UI（扫码按钮、推送提示条）。**必须先探测再使用，不得假设存在** |
| 4 | `window.__mpiBack(): "handled" \| "pass"` | PWA → 壳（返回键握手） | 壳的返回键先执行 `evaluateJavascript("window.__mpiBack ? window.__mpiBack() : 'pass'")`：返回 `"handled"` = 页面已处理（如关抽屉），壳不再动作；否则走 `canGoBack() ? goBack() : moveTaskToBack()`。原因：WebView 的 `canGoBack()` 不把 pushState 历史算进去，没有这个握手按返回键会直接后台化 |
| 5 | VIEW intent filter | 系统 → 壳 | 清单注册中继域名的 https VIEW；扫码/点开的配对链接已装壳则进壳、否则进浏览器（两者共用 `#pair=` 自动配对路径）。「用 MPI 打开」也走这里换服务器地址 |
| 6 | `window.MpiShell.scanDiagnostics(): string` | 壳注入 → PWA（0.2.3+） | 返回 JSON `{shellVersion, baseUrl, events}`——壳侧最近 ≤20 条 load/scan/update 事件（行格式 `<epochMillis> <文本>`，同时写 logcat tag `MpiShell` + SharedPreferences）。PWA `?dbg=1` 浮层每 2s 拉取展示；旧壳无此成员时 PWA 探测式跳过 |
| 7 | `window.MpiShell.startRecording(): string` | 壳注入 → PWA（0.2.6+） | 启动**原生录音**（Kotlin AudioRecord 16k/单声道/PCM16，音频源 VOICE_RECOGNITION→MIC→DEFAULT 逐级回退）。返回 `"ok"` 或 `"err:<原因>"`；无 RECORD_AUDIO 权限时拉起系统授权框并返回 `"err:permission"`。**PWA 探测到该成员时优先于 getUserMedia**（见 contract #10） |
| 8 | `window.MpiShell.stopRecording(): string` | 壳注入 → PWA（0.2.6+） | 停止并返回 JSON `{ok:true,audioB64,sampleRate}` 或 `{error}`。audioB64 = 44 字节 RIFF/WAVE 头 + PCM16，与 PWA `encodeWavPcm16` 输出逐字节同构；< 0.5s 返回 `{"error":"录音太短"}` |
| 9 | `window.MpiShell.cancelRecording(): string` | 壳注入 → PWA（0.2.6+） | 放弃本次录音并释放麦克风（用户点「取消」）。永远返回 `"ok"`；壳/桥不可用时 PWA 静默吞掉异常 |
| 10 | `window.MpiShell.recorderDiagnostics(): string` | 壳注入 → PWA（0.2.6+） | 原生录音最近一次启动结果（`ok src=6` / `err:notInitialized src=6` …），`?dbg=1` 浮层 MEDIA 行的 `native=` 字段 |
| 11 | `window.__mpi_build: string` | PWA → 壳（0.2.7+） | PWA 启动时写入当前 bundle 文件名（`index-XXXX.js`，无哈希的开发态为空串）。壳回前台时读它与中继 `index.html` 引用的名字对比，不同就自动 `reload()`——WebView 长期驻留（按返回只是退到后台，从多任务重开也不重载）会让人一直看到旧页面（2026-09-15 实测）。旧 PWA 无此全局时壳跳过检查，不报错 |

**兼容规则：**

- **新增** PWA 依赖的成员：新 APK 与新 PWA **同时发布**；只更新一侧时功能静默降级（PWA 探测式使用保证不崩）。
- **改现有语义**（如 `__mpiBack` 返回值约定、`#pair=` 载荷格式）：**必须同发新 APK**——旧壳配新 PWA
  会出现「返回键直接后台化」这类静默故障，且用户不会意识到是版本不匹配。
- 两侧都不得假设对方存在：PWA 不裸调 `MpiShell`；壳对 `__mpiBack` 缺失按 `pass` 处理（已内置）。

## 壳菜单与页面自更新（0.2.7+）

WebView 壳没有地址栏，页面若是旧版或地址存错就无从自救，所以：

- **右上角 `⋮`（半透明，不挡正文）** → 刷新页面 / 服务器地址…（复用错误面板的输入框）/ 诊断信息
  （弹窗直接给出 地址·壳版本·**页面构建号**·最近壳事件）。「界面是旧的」这类问题一屏可定位。
- **回前台自动重载**：读 `window.__mpi_build`（PWA 写的当前 bundle 名）与中继
  `GET /index.html`（`Cache-Control: no-cache`）里引用的名字对比，不同就 toast + `reload()`；
  60s 节流，失败静默。
- PWA 侧另有「有新版本 · 点击刷新」浮条（`lib/update-watch.ts`）+ 顶部常驻 `build <hash> · <host>`
  小字，浏览器里同样有效。

## 语音输入：两条采集后端（重要）

PWA 录音后端按环境自动选择，**接口一致**（同样的 16k 单声道 WAV base64）：

| 环境 | 后端 | 说明 |
| --- | --- | --- |
| 壳 0.2.6+ | 原生 `AudioRecord`（`NativeRecorder.kt`） | 走普通 App 录音通路，不受 WebView 实现/厂商 ROM 策略影响 |
| 壳 ≤0.2.5、浏览器 | `getUserMedia` + ScriptProcessor | 逐步放宽约束（默认 DSP → 关 DSP → 单声道 → 显式 deviceId） |

实测：**荣耀 Magic5 / MagicOS 的 WebView 开不了音频设备**——三组约束（默认 / 关闭 AEC·NS·AGC /
单声道）全部报 `NotReadableError "Could not start audio source"`，授权成功后依旧如此，且
`enumerateDevices()` 不返回输入设备。故 0.2.6 起壳内一律走原生录音；`getUserMedia` 只在浏览器
里使用（浏览器无此问题）。遇到「点 mic 没反应」先看 `?dbg=1` 的 MEDIA 行：
`gUM=function` 与 `secure=true` 正常说明安全上下文无问题，`mic=` / `native=` 才是采集结果。

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
- **应用内扫码**：不自带相机扫码器——桌面二维码是 https 链接，用系统相机/任意扫码器即可，
  链接会被浏览器或壳接管。
- **正式签名与上架**：当前是 debug 自签（同一台机器的 `~/.android/debug.keystore`，可覆盖安装）。
  需要长期分发时再补 release keystore。
