# 原生手机端 · PWA 交互细节移植清单（施工图）

> **本文自包含**。解决的问题：原生版（`mobile/app/`）是重写，PWA（`mobile/pwa/`，旧 WebView 壳
> `android/` 加载的就是它）上迭代过的交互优化不会自动继承，导致「交互不友好」。
> 本文把 PWA 侧确认做过的优化逐条列出，对照原生现状，按批次给出落点。
>
> 设计基线：`docs/MOBILE-NATIVE-DESIGN.md`；交接文档：`docs/MOBILE-NATIVE-HANDOFF.md`。
> 最后更新：2026-09-23。

---

## 0. 一句话现状

- **批 1–5 已完成**（PWA 交互细节）；**M4 原生能力完成**（附件 / 语音 / 扫码）；**M5 通知 + 前台服务完成**。
- 批 2–5 未做；批 6 依赖原生能力阶段（M4/M5/M6），不属本次欠账。

**原则**：只做 PWA 已验证过的交互，不新设计；视觉一律用桌面端同名令牌；不引 UI / 图标库。

---

## 1. 批次 1 ✅ 对话页配置 chip 行 + 底部 Sheet

对齐 PWA `ThreadView.tsx` 的 `.thread-toolbar` + 底部 Sheet（提交 `4617985` / `9c33f92` / `4f3d947`）。

| 交付 | 原生落点 |
| --- | --- |
| 权限 chip（沙盒 / 完整权限，选中态配色） | `ui/ThreadToolbar.kt` |
| 任务模式 chip（基线 / 模式名，含「只读」标记） | 同上 |
| 模型 chip（短名，>18 字符截断；切换中显示「切换中…」） | 同上 |
| 上下文用量 chip（`%`，四档配色 + `—` 兜底） | 同上 |
| 底部 Sheet：权限 / 模式 / 模型 / 用量四个面板 | `ThreadToolbarSheet` |
| 压缩上下文入口（回合进行中 / 压缩中禁用并说明原因） | `ContextSheet` |
| 返回键语义：Sheet 开着先关 Sheet | `MpiApp.kt` |
| 上下文用量口径（60/75/90 阈值、压缩后 estimatedTokens 回退） | `readContextUsage` 等纯函数 |

**关键约束**：用量口径必须与桌面端 ring / PWA `lib/context-usage.ts` 一致——压缩后 pi 把
`tokens` 报成 null，要用 `estimatedTokens` 回退，否则错误显示 0%。

**测试**：`ThreadToolbarLogicTest`（8 项，纯函数）。

---

## 2. 批次 2 ✅ 输入区打磨

对齐 PWA `ThreadView.tsx` 的 composer（提交 `4e81d10` / `49f1d32` / `aaeb0b0` / `a22bd2b`）。

| 细节 | 落点 |
| --- | --- |
| 「待处理后续」：运行中发送 → 本地暂存，回合结束自动投递；横幅可 ✎ 取回重编 / ⚡ 立即插入（steer）；已有暂存时再发 → followUp 排队 | `AppViewModel.sendDraft/flushPendingFollowUp/steerPendingFollowUp/reEditPendingFollowUp` + `PendingFollowUpBanner` |
| 输入框 placeholder 三态（录音中 / 运行中排队 / 空闲） | `Composer` |
| 发送 / 停止改图标按钮 | `IconSend` / `IconStop` |
| 发送 / 停止失败贴输入框（`THREAD_BUSY` 翻译成人话） | `AppUiState.sendError` |
| 长按复制整条 + assistant 可见「复制」按钮 | `ThreadScreen.MessageRow` / `messageTextOf` |

**测试**：`ThreadComposerLogicTest`（复制文本口径）。

---

## 3. 批次 3 ✅ 多题选择面板

PWA `ChoicePanel.tsx` + `lib/choice-block.ts`（提交 `e1b6018` / `3a6021b`）的 Compose 移植。

| 交付 | 落点 |
| --- | --- |
| 解析：```choices 围栏（严格 + 截第一个完整 JSON 两级降级） | `ChoiceLogic.parseChoiceBlockData` / `parseChoiceBodyLoose` |
| 围栏级容错：粘行闭合 / 漏写闭合 / 解析失败降级代码块 + 提示 | `withChoiceSegments` |
| 回复构造与解析（`我的选择：\n1. 题 → 选项`） | `buildChoiceReplyText` / `parseChoiceReply` |
| 面板状态从会话记录推导（pending / answered / superseded） | `deriveChoicePanelState` |
| UI：每题选项 + 「其它」自由输入 + 「发送选择」 | `ChoicePanel.kt` |
| 发送路由：运行中 → followUp，空闲 → prompt；不清用户草稿 | `AppViewModel.sendChoice` |

**测试**：`ChoiceLogicTest`（17 项）。

**已知简化**：草稿只在会话内存（PWA 用 localStorage），重进会话点选会丢。

---

## 4. 批次 4 ✅ 首屏与抽屉

| 交付 | 落点 |
| --- | --- |
| 设备重命名（本地别名，内联改名） | `MpiApp.HostRow` + `AppViewModel.renameHost` |
| 抽屉会话分组：今天 / 昨天 / 更早（本地日历日） | `AppDrawer.dayBucketLabel` / `drawerDayGroups` |
| 抽屉「新建会话」入口（单项目直建；多项目内联选择；请求中禁用） | `AppDrawer.NewThreadEntry` + `AppViewModel.createThread` |

**测试**：`AppDrawerTest`（4 项，含跨零点不误判）。

### 未做（需要新协议，不属纯 UI）

| 项 | 缺口 |
| --- | --- |
| 会话项长按：重命名 / 置顶 / 删除 | `src/main/remote/protocol.ts` **没有** thread.rename / pin / delete；要主机 + PWA + 原生三端同改 + 测试 |
| 首屏示例提示词改成「点即发送」 | 当前是 3 个 QuickAction（刷新/切设备），不是真实示例发送 |

---

## 5. 批次 5 ✅ 设置页与诊断

| 页面 | 内容 | 落点 |
| --- | --- | --- |
| 设置 | 外观三选（跟随系统 / 浅 / 深）、字号三档（0.9 / 1.0 / 1.15）、诊断入口、关于（版本号） | `SettingsScreen.kt` + `SettingsStore` + `MpiTheme(fontScale)` |
| 诊断 | App 版本、本机设备名、连接状态、当前电脑、已配对电脑、项目/会话数、当前会话状态、最近问题 | `DiagnosticsScreen.kt` |

设置非敏感数据，用明文 SharedPreferences（不用 Keystore 加密卷——那是给配对凭证的）。
只放**已经能起作用**的项：语音 / 通知 / 检查更新属 M4/M5/M6，放上去点了没反应违反 §1.1。

**测试**：`SettingsLogicTest`（4 项）。

---

## 6. 批次 6（原生能力，M4–M6）

出处：PWA 提交 `568802c` / `eacf2d7` / `4e81d10` / `9dc3141` / `93fadd9` / `02ae898`。

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 图片 / 文件附件 | ✅ | `Attachments.kt`（降采样 ≤1280px + JPEG 质量循环 ≤280KB；文件 ≤6MB）+ composer 附件菜单 + 缩略图 chips。拍照入口待加（需 FileProvider） |
| 语音输入 | ✅ | 原生 `AudioRecord`（PCM16 16k mono，音频源逐级回退）→ WAV → `stt.transcribe` → 文本追加到输入框 |
| 扫码配对 | ✅ | CameraX 预览 + ML Kit bundled 条码识别（离线可用、无需 GMS）；配对页新增「扫码配对」入口 |
| APK 自更新 / 新版本浮条 | ⏳ | M6 |
| 前台服务与通知 | ✅ | `MpiLinkService`（前台服务仅保活）+ 审批本地通知（点击直达会话）；不做通知栏就地批准（v2） |

---

## 7. 施工约定

- 每批：`JAVA_HOME=<MyWorkspace>/Software/jdk21 ./gradlew assembleDebug :app:testDebugUnitTest`。
- 新增样式只用桌面端同名令牌（`MpiTheme.colors`）；纯函数抽出来放单测。
- 每批一个 commit（中文 + conventional），**不自动 push**。
- 批次完成时同步更新本文件与 `MOBILE-NATIVE-HANDOFF.md` 的 M2/M3 表格。
