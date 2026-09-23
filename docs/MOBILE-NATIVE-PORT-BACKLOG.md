# 原生手机端 · PWA 交互细节移植清单（施工图）

> **本文自包含**。解决的问题：原生版（`mobile/app/`）是重写，PWA（`mobile/pwa/`，旧 WebView 壳
> `android/` 加载的就是它）上迭代过的交互优化不会自动继承，导致「交互不友好」。
> 本文把 PWA 侧确认做过的优化逐条列出，对照原生现状，按批次给出落点。
>
> 设计基线：`docs/MOBILE-NATIVE-DESIGN.md`；交接文档：`docs/MOBILE-NATIVE-HANDOFF.md`。
> 最后更新：2026-09-23。

---

## 0. 一句话现状

- **批 1、批 2 已完成**（配置 chip/Sheet：批 1；输入区：批 2）。
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

## 3. 批次 3 多题选择面板（未做）

PWA `ChoicePanel.tsx` + `lib/choice-block.ts`（提交 `e1b6018` / `3a6021b`）。

- agent 在回复里输出 choices 围栏 → 手机端渲染成**可点选面板**（多题、单选/多选）。
- 点选后走 `thread.prompt` / `thread.followUp`（按运行态路由，空闲时裸 followUp 会卡在 pi 队列）。
- 「其它」自由输入、草稿 localStorage 持久化、围栏容错。
- 原生现状：❌ 完全没有。设计文档也未列，属真正漏掉的一项。

---

## 4. 批次 4 首屏与抽屉（未做）

| 细节 | PWA 做法 | 原生现状 |
| --- | --- | --- |
| 设备重命名（本地别名，内联改名） | 点设备名内联改（`614afef`） | ❌ `AppViewModel.renameHost` 已有，缺 UI 入口 |
| 抽屉会话分组 | 按「今天 / 昨天 / 更早」（`MOBILE-UX-PLAN` §3） | ❌ 扁平列表 |
| 抽屉「新建会话」入口 | 多项目内联选择（`ee12813`） | ❌ 无 |
| 会话项长按 | 重命名 / 置顶 / 删除（T3 避坑） | ❌ 无 |
| 首屏示例提示词 | 3 条真实能力示例 | 部分（3 个 QuickAction，但行为是刷新/切设备，非示例发送） |
| 添加设备返回 | 抽屉历史单条目制，避免多步跳转（`f2dd3d5`） | 已有（二级页 + cancelAddHost） |

---

## 5. 批次 5 设置页与诊断（未做）

| 页面 | 内容 | 出处 |
| --- | --- | --- |
| 设置 | 外观（跟随系统/浅/深，原生当前只有跟随系统）、字号、语音、通知、诊断、关于 / 检查更新 | 设计文档 §6 |
| 诊断 | 连接状态、App 版本、最近事件、协议 seq——用户向 AI 反馈问题的主要凭据 | 设计文档 §6 / PWA `?dbg=1`（`70b06ab`） |

---

## 6. 批次 6（依赖原生能力，属 M4–M6，不算「丢失」）

语音输入、图片/文件附件、扫码配对、APK 自更新、构建号与「有新版本」浮条、前台服务与通知。
出处：PWA 提交 `568802c` / `eacf2d7` / `4e81d10` / `9dc3141` / `93fadd9` / `02ae898`。

---

## 7. 施工约定

- 每批：`JAVA_HOME=<MyWorkspace>/Software/jdk21 ./gradlew assembleDebug :app:testDebugUnitTest`。
- 新增样式只用桌面端同名令牌（`MpiTheme.colors`）；纯函数抽出来放单测。
- 每批一个 commit（中文 + conventional），**不自动 push**。
- 批次完成时同步更新本文件与 `MOBILE-NATIVE-HANDOFF.md` 的 M2/M3 表格。
