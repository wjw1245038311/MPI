# 手机端下一阶段：UX 重做 + 多设备 + 壳能力

四个缺失/诉求：① 壳内扫码 ② APK 自更新 ③ 对话为主页、头像抽屉（项目/会话）、二级抽屉（设备）、
支持绑定多台设备 ④ 整体风格对齐桌面端。

本文是实施计划（含验收标准与依赖顺序）。**待拍板项在 §5**，未定的先按推荐值执行。

## 0. 侦察结论（已核实，别再重复调查）

| 事实 | 位置/证据 | 对计划的影响 |
| --- | --- | --- |
| **多主机数据层已具备** | `mobile/pwa/src/lib/keystore.ts`：`KeyStore.listPairings()/savePairing()/deletePairing()`，`PairingRecord` 以 `hostId` 为键；IDB 里 `pairings` 是多条 | 多设备**只需做 UI**，不用改存储 |
| 设备身份是一份、按主机各发 token | `DeviceRecord`（一份 seed）+ 每条 `PairingRecord.deviceToken` | 同一台手机绑多台桌面天然成立 |
| 现有顶层视图只有两态 | `App.tsx`：`view: "pairing" \| "home"`，会话是 home 的子状态 `openThreadId` | 要重做成「对话为主页 + 抽屉」 |
| 现有切换入口只有一个按钮 | `App.tsx` 约 451 行「断开 / 切换主机」 | 要换成设备列表 |
| PWA 目前**纯深色** | `mobile/pwa/src/styles.css`：`color-scheme: dark`，`--bg #12141a`、`--accent #7aa2f7` | 风格对齐是一次真正的换皮 |
| 桌面端**默认浅色 + 明暗两套** | `src/renderer/src/styles.css`：`--bg #ffffff`、`--accent #2e7d52`、`--text-dim/faint`、`--radius 12px`、`--font` | 令牌可直接移植（同名同值） |
| 壳内扫码可行、**不需要 GMS** | Google Maven 可达：`com.google.mlkit:barcode-scanning:17.3.0`（自带模型）、`androidx.camera:camera-*:1.3.4` | 用 CameraX 预览 + ML Kit 识别 |
| 壳现只有 INTERNET 权限 | `android/app/src/main/AndroidManifest.xml` | 扫码要 `CAMERA`；自更新要 `REQUEST_INSTALL_PACKAGES` + FileProvider |
| 中继已托管 APK + 清单 | `/download/mpi-android.json`（version/size/sha256/github） | 自更新直接读它，不用新协议 |

## 1. 阶段 A：壳能力（Android 侧，独立可交付，建议先做）

### A1 壳内扫码（约 40 分钟）

- 依赖：`androidx.camera:camera-core/camera2/lifecycle/view` + `com.google.mlkit:barcode-scanning`
- `ScanActivity`：CameraX 预览 + `BarcodeScanning.getClient()` 逐帧识别；识别到第一条结果即返回。
- 入口两处：① WebView 页面上浮一个小的扫码按钮（原生 overlay，只在 `pairing` 视图显示——用 JS 桥告知
  壳当前视图；或先做成常驻右下角小按钮，简单但略丑）；② 抽屉里的「添加设备」。
- **识别结果的去向**：不自己解析配对协议——把识别到的 URL 直接交给 WebView 加载：
  - `mpi://pair?payload=…` → 构造 `https://<relay>/#pair=<payload>`（复用桌面二维码的约定）
  - `https://<relay>/#pair=…` → 直接加载
  - PWA 已支持 `#pair=` 自动配对，因此**零协议改动**。
- 权限：`CAMERA`（运行时申请）；拒绝时给一句引导，不影响其它功能。
- 验收：桌面生成配对二维码 → 手机壳内点扫码 → 对准 → 自动配对成功（免确认开着时桌面无需任何操作）；
  扫到非配对二维码时提示「这不是配对码」。

### A2 APK 自更新（约 40 分钟）

- 壳启动后延迟几秒静默检查：读 `/download/mpi-android.json`（中继不可达时读 GitHub 清单/直链），
  比对 `BuildConfig.VERSION_NAME`。
- 有新版本 → WebView 顶部一条**原生提示条**：「发现新版 0.2.0 · 更新 / 稍后」。
- 「更新」→ `DownloadManager` 下载到 `cacheDir`（带进度）→ `FileProvider.getUriForFile` →
  `ACTION_VIEW` 调起系统安装器（`REQUEST_INSTALL_PACKAGES`；Android 8+ 首次需用户在系统里允许
  「安装未知应用」，此时给一句引导）。
- 校验：下载完比一次 sha256（清单里有），不一致就不安装。
- 验收：把 `versionName` 改成 0.2.0 发一版到中继 → 旧壳里出现「发现新版 0.2.0」→ 点更新 → 装完
  版本号变成 0.2.0；杀掉重进不再提示。

## 2. 阶段 B：多设备（PWA，约 40 分钟）

- `PairingRecord` 增两个可选字段：`hostName?`（显示名）、`lastSeenAt?`（列表排序用，本地维护即可）。
- **设备抽屉**：列出 `listPairings()`：显示名 / hostId 短码 / 中继主机名 / 状态点（当前主机高亮）。
  操作：切换、移除（`deletePairing`）、添加（跳配对页）。
- 切换流程：复用现有 `disconnect` → 用目标记录的 `relayUrl/hostId/deviceToken` 走 `attachAutoReauth`
  重连路径（现有代码已按 `listPairings().find(p => p.deviceToken)` 选第一条，改成按选中的 hostId）。
- 主机显示名来源（见 §5 决策 3）：优先配对 payload 里带；没有则用 `hostId` 前 6 位。
- 验收：两台桌面各自生成配对码 → 手机依次配对 → 设备抽屉出现两条 → 切换后项目/会话/对话都切换；
  移除一台后不再出现在列表，且不影响另一台。

## 3. 阶段 C：手机端信息架构重做（飞书式，约 1.5 小时）

- **主页 = 对话**：进入即打开最近会话（无会话则打开该主机最近一个会话/显示空态）。
- **点左上角头像 → 一级抽屉（项目 + 会话）**：现有 `home-card` 的内容搬进抽屉；顶部显示当前主机名 +
  头像；支持「新建会话」。
- **再往左 → 二级抽屉（设备）**：阶段 B 的列表；顶部「添加设备」。
- 交互细节：
  - 手势：左右滑开/关、点遮罩关闭；抽屉宽度 `min(320px, 86vw)`，二级抽屉叠在一级之上。
  - **返回键语义**（壳已接管返回键）：有抽屉开着 → 关抽屉；否则退回到会话列表；否则后台化。
    实现：抽屉开合时 `history.pushState` + 监听 `popstate`（PWA 内即可，不用改壳）。
  - 空态：未配对 → 引导「扫码配对」；已配对无会话 → 引导「新建会话」。
- 验收：进入即对话；头像点开有项目/会话；再左滑到设备列表；返回键逐级关闭；三种空态都有引导。

## 4. 阶段 D：视觉对齐桌面端（约 1 小时）

- 把 PWA 的 `:root` 令牌换成与桌面端**同名同值**：`--bg/--panel/--border/--text/--text-dim/--text-faint/
  --accent/--accent-soft/--radius/--radius-sm/--font`，并支持明暗两套（默认跟随系统；桌面端已有实现可抄）。
- 组件对齐（照桌面端数值搬）：卡片圆角/padding/阴影、按钮三态（主/次/危险）、输入框高度与内间距、
  消息气泡与头像尺寸、`msg-tool` 工具卡的观感。
- 图标：在 `mobile/pwa/src/components/icons.tsx` 建一份与桌面端同风格的图标集（24 viewBox、
  `stroke=currentColor`、`strokeWidth 1.7`、圆头），先只做用到的 8–10 个（不 import 渲染层代码）。
- 验收：与桌面端并排截图比对，颜色/圆角/字重/间距明显一致；明暗两种模式下都不出现对比度问题。

## 5. 待拍板（未定则按推荐执行）

1. **主题**：推荐「跟随系统，明暗两套，令牌同桌面端」；备选「保持纯深色，只对齐组件观感」。
2. **多设备语义**：推荐「一台手机绑多台桌面」（数据层已支持）；`同一台桌面被多台手机访问`桌面端已支持，
   本次不动。
3. **设备显示名**：推荐「配对时由桌面端在 payload 里带机器名（`os.hostname()`），手机端可改备注」；
   备选「手机端手动命名」。
4. **执行分工**：阶段 A（壳能力）与 B/C/D 是否分给不同执行者？建议 A 先做（用户可立刻扫码/自更新），
   B 之后 C，D 最后统一收口（避免样式改两遍）。

## 6. 风险与回归

- **C 是最大改动**：PWA 信息架构重做必须保持现有能力（配对、E2E、流式、审批卡、通知深链）不回归——
  安全网是 `npm test`（`pwa-home`/`pwa-thread`/`pwa-actions`/`pwa-pairing` 等）与 `npm run typecheck`
  （含 PWA 的 `npx tsc --noEmit`）。
- A2 自更新涉及「安装未知应用」的系统限制：无法静默安装，必须走系统安装器——文案要写清这一步。
- 壳内扫码需要相机权限；荣耀等 ROM 会再问一次相机授权，拒绝时不能挡住手动粘贴配对链接的老路径。
- 抽屉与返回键：用 `history.pushState` + `popstate` 实现，避免与壳的返回键处理打架（壳目前是
  `onBackPressedDispatcher` → `webView.canGoBack()` → `goBack()`，天然兼容 pushState 历史）。
