# MPI 代码梳理与优化清单（2026-10-14）

> 基线：v0.10.1 · commit `9c715a8` · 本机 workstation 全量静态扫描（未运行应用）。
> 范围：`src/`（桌面）、`mobile/`（PWA + 原生 App + relay）、`scripts/`、构建配置。
> **架构全景图**：`docs/archify/mpi-panorama.html`（Archify v3.1 生成，validate / deliver / check / browser-check 四道门全过；每个节点挂 `文件:行号` 证据，钉在 commit `9c715a8`。数据源 `docs/archify/mpi-panorama.candidate.json`，复跑命令见文末）。
>
> 与既有文档的关系：`docs/OPTIMIZATION-BACKLOG.md` 记的是**功能级**待办（编号 01–35），本文件只收**代码结构 / 交互实现层面**的新发现；两者重叠处已标注「= backlog #N」，不重复开发。
> 证据列全部为可核对的 `文件:行号`；标注「推断」的条目是由此推出的结论，不是文档字面写的，采纳前需实测。

## 规模快照

| 区域 | 文件数 | 行数 | 备注 |
|---|---|---|---|
| `src/main` | 134 | 41 799 | 其中 `ipc.ts` 6 054（14%） |
| `src/renderer` | 79 | 31 577 | 其中 `styles.css` 11 386 |
| `src/preload` | 2 | 627 | 手写 219 个 invoke |
| `src/shared` | 5 | 485 | 仅 8 个文件引用 |
| `mobile/`（PWA+原生+relay） | 155 | 36 159 | Kotlin 111 文件为主 |
| `scripts/` | 176 | 27 768 | 含 137 个 `test-*.mjs` |

---

## 一、结论先行：建议动手的排序

| # | 项目 | 证据 | 收益 | 工作量 | 爆炸半径 / 风险 |
|---|---|---|---|---|---|
| R1 ✅ | 统一原子 JSON store | `draft-store.ts:90`、`feedback-store.ts:62`、`todo-store.ts:151`、`observed-tools.ts:83` 各写一份 tmp+rename；`config.ts:976` 直接 `writeFileSync` | 消除崩溃半写坏配置/待办的风险，去掉 4 份重复状态机 | 半天 | 中：动持久化写入路径，需配迁移测试 |
| R2 | `ipc.ts` 按域拆成 `ipc/<domain>.ts` | `ipc.ts:1423→6054`＝单个 `registerIpc()` 约 4 630 行、215 个 handler；`:3709` 起 handler 内嵌网络与缓存逻辑 | 可维护性、diff 噪声、并行改冲突 | 1–2 天（机械搬） | 中：纯搬运不改行为，typecheck + `npm test -- pwa`/`remote` 覆盖 |
| R3 | 类型依赖反转修正 | `src/main` 有 **19 个文件** `import type … from "../renderer/src/lib/types"`（如 `ipc.ts:60`、`app-store.ts:23`） | 分层清晰：主进程不再依赖渲染层源码树 | 半天 | 小：仅类型导入，编译期擦除 |
| R4 ✅ | 确认框统一为应用内组件 | 原生 `window.confirm` 仍在用：`AppStorePanel.tsx:43,209`、`AutomationPanel.tsx:152`、`PluginsPanel.tsx:943,1605`、`Settings.tsx:1756,1808,1863`；而 `MemoryPoolTab.tsx:110` 注释明确写「不用原生 window.confirm：原生模态在 Electron/Windows 上会留下焦点问题」 | 交互一致性 + 修掉已知焦点缺陷 | 半天 | 小：只改 renderer |
| R5 | 重面板懒加载 | 全仓 `React.lazy` / `Suspense` **0 处**；`Chat.tsx:25` 静态引入 `TuiView` → xterm（约 1 MB）常驻首屏；产物主 chunk `out/renderer/assets/index-*.js` = **3.3 MB** | 首屏解析量下降（幅度未实测） | 半天 | 小–中：需给每个 lazy 点配骨架 fallback |
| R6 | i18n 从 DOM 翻译桥迁到消息表 | `lib/i18n.ts:679 installLanguageBridge()` 用全局 `MutationObserver` 遍历文本节点 + `title/aria-label/placeholder`；组件内另有 **736 处** `language === "zh" ? … : …`（Settings 303、Chat 73、Composer 67） | 去掉每帧全树遍历与「标签卡在英文」类回归（该风险见 `i18n.ts:31` 注释自述） | 大（渐进） | 中：按面板逐个迁，先冻结新增三元写法 |
| X1 ✅ | 全局快捷键与应用菜单 | `App.tsx:74-95` 只处理 Ctrl+K 与缩放；`src/main` 无任何 `accelerator` | 高频操作可键盘化（新建会话 / 设置 / 切面板 / 停止生成） | 半天 | 小 |
| X2 | Toast 补齐能力 | `store.ts:3216 pushToast()` 无数量上限、固定 5.2 s、不去重；`Toasts.tsx` 仅 18 行，无 `role="status"` / `aria-live`、无操作按钮 | 长任务连发提示不再刷屏；错误提示可带「重试」 | 半天 | 小 |
| X3 | 空态 / 骨架屏组件化 | `className="spinner"` 裸用 **52 处**，「加载中…」文案 5 份，各面板空态各写各的 | 观感一致 + backlog #17 的 S5 直接复用 | 半天 | 小 |

> ✅ = **2026-10-15 已落地**（R1 / R4 / X1），实现与验收见「五、P0 已落地内容」。其余项待排。

---

## 二、代码结构问题明细

### A. 分层与依赖方向

- **A1 主进程反向依赖渲染层**（=R3）：`src/shared/` 已存在但只有 485 行、8 个引用点；真正的跨进程类型全在 `renderer/src/lib/types.ts`（1 027 行），于是主进程 19 处越过目录边界取类型。建议把跨进程类型移到 `src/shared/types/`，`lib/types.ts` 只 re-export，保持调用点不动。
- **A2 `ipc.ts` 上帝文件**（=R2）：除体量外，问题是 handler 里写业务（例：`remote:getPhoneApp` 在 `:3709-3756` 内做中继拉取、字段校验、缓存回退、异常包装）。建议 `src/main/ipc/{app,pi,thread,remote,settings,...}.ts` 每域一文件，`ipc.ts` 只保留 `registerIpc()` 组装 + `send()` 广播工具（现 `:1425`）。
- **A3 IPC 契约三处手写**：`ipcMain.handle` 219 处（`ipc.ts` 205 + `tui.ts` 14）、`preload/index.ts` 手写 invoke 219 个、返回类型再写一遍。偏差无人守——建议加一条静态测试脚本比对「handler 通道集合 ⊇ preload invoke 通道集合」，比引入 codegen 便宜（推断：先验证偏差是否真实存在再决定是否上契约层）。

### B. 持久化

- **B1 原子写重复且不一致**（=R1）：`draft-store` / `feedback-store` / `todo-store` / `observed-tools` 各自实现 tmp+rename；`config.ts:976`、`models-service.ts`、`plugins.ts` 等直接覆写。全仓 `writeFileSync` 调用 110 处、`JSON.parse` 分散在 30+ 文件。
- **B2 缺 schema 版本位**：`data-migration.ts`（913 行）承担一次性搬迁，但 store 文件本身没有 `version` 字段，后续结构演进只能继续往 migration 里堆条件（推断，需核对 `data-migration.ts` 现有能力后再定方案）。

### C. 渲染层结构

- **C1 单 store 承载全部状态**：`store.ts` 4 153 行，`interface PiStore`（`:1126-1420`）约 **294 个字段/动作**。订阅侧是健康的——266 处 `useStore((s) => …)` 选择器、0 处裸 `useStore()`，所以这是**可维护性**问题而非渲染性能问题。建议按 zustand slice 拆 `threads / preview / remote / zhiya / ui` 五片，保持 `useStore` 出口不变以零改动调用方。
- **C2 巨型组件**：`Settings()` 一个函数 **1 250→3 983＝2 733 行**；`Chat()` 857 行（内部已 memo 化子块，结构好于 Settings）。对照 `PluginsPanel.tsx`：主组件仅约 104 行、其余拆成子组件——按这个范式把 Settings 按 tab 拆文件即可。
- **C3 样式单文件**：`styles.css` 11 386 行 / 1 727 条规则，暗色主题靠 9 处 `:root[data-theme="dark"]` 覆盖块补写（`:4166`、`:9155` 等），仍有硬编码色值残留（`#fff` 74 次、`#c0392b` 18 次）。已有 1 375 处自定义属性，说明 token 体系存在但没走完——建议把「亮/暗成对」的色值收敛进 `:root` 变量，删掉重复覆盖块。

### D. 重复实现

| 符号 | 出现位置 | 处理 |
|---|---|---|
| `Toggle` 组件 | `Settings.tsx`、`AutomationPanel.tsx`、`MessagingPanel.tsx`、`PluginsPanel.tsx` | 抽 `components/ui/Toggle.tsx` |
| `base64ToBytes` / `bytesToBase64` | `lib/tts.ts`、`remote/transport.ts`、`Composer.tsx` | 抽 `lib/bytes.ts` |
| `compareVersions` | `app-updater.ts`、`core-updater.ts` | 抽 `lib/version.ts`（更新器语义不同则保留两份并注明） |
| `ensureLoaded` 状态机 | `draft-store`、`feedback-store`、`observed-tools`、`todo-store` | 由 R1 的统一 store 吸收 |

### E. 打包与运行时

- **E1 生产依赖双份进包**：= backlog #34（用户已拍板「等 MPI 完全成型后开做」）。现状未变——`react`、`react-dom`、`xlsx`、`pdfjs-dist`、`mammoth`、`jszip`、`highlight.js`、`react-markdown`/`rehype-*`、`zustand`、`@xterm/*`、`qrcode` 仍在 `dependencies`，而 Vite 已把它们打进 `out/renderer`。
- **E2 首屏 chunk 过大**（=R5）：主 chunk 3.3 MB；重依赖里 mermaid / pdfjs / xlsx / mammoth / jszip 已经按需 `import()`（`Preview.tsx:933,975,1212,1276`、`markdown.tsx:47`），**唯独 xterm 走静态引入**。注意：`highlight.js` 已是显式子集（`lib/code-languages.ts:30`），不是全量语法，无需再动。
- **E3 静默失败**：`.catch(() => {})` / `catch {}` 共 **73 处**（main + renderer）。多数是「缓存只是锦上添花」这类合理吞掉，但需要一次审计把「用户点了没反应」的那批改成 toast 或 diag 日志（`diag-log.ts` 已有落盘通道）。

### F. 工程效率与多端

- **F1 测试入口表膨胀**：`scripts/test-*.mjs` 137 个，`package.json` 里对应 137 条 `test:*`。`run-all-tests.mjs` 已支持自动发现（找不到 script 时回退 `node --experimental-strip-types`），所以 script 表可按域收敛成 `test:memory` / `test:pwa` / `test:remote` 分组，减少每次新增功能改三处。
- **F2 四套前端并存**：桌面 Electron renderer、`mobile/pwa`（React）、`mobile/app`（Compose 原生）、`android/`（WebView 壳，版本线 0.5.x 与原生 0.2.x 并行）。协议在 **三处**同步：`src/main/remote/protocol.ts`、`mobile/shared/protocol.ts`（自述 vendored copy）、`Envelope.kt`，靠 `test-pwa-shared.mjs` / `test-remote-history-limit.mjs` 守一致。现状可接受，但每加一个 remote 请求要改三处——建议把「协议即数据」提出来（`protocol/remote-v1.schema.json` 已存在），由脚本生成 TS/Kotlin 常量（推断：先确认 schema 文件是否已被 CI 使用，再决定生成器范围）。

---

## 三、交互优化清单

> 只列**实现层面**能直接落地的；功能级条目（轨迹视图、成本条、归档视图…）仍在 `OPTIMIZATION-BACKLOG.md`，此处只给编号引用，避免两份清单打架。

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| X1 | 全局快捷键几乎为零 | `App.tsx:74` 仅 Ctrl+K + 缩放；主进程无 `accelerator` | 建 `lib/shortcuts.ts` 注册表：Ctrl+N 新会话、Ctrl+, 设置、Ctrl+1..9 切面板、Esc 停止生成、Ctrl+Shift+P 命令面板（复用 SearchModal） |
| X2 | 两套确认框混用 | =R4 | 统一 `ConfirmDialog`（`MemoryPoolTab.tsx:650` 的实现提为公共组件），原生 confirm 全替换 |
| X3 | 无空态 / 骨架屏规范 | 裸 `spinner` 52 处、空态文案各写各的 | `ui/EmptyState`、`ui/Skeleton` 两个组件 + 每面板补「为什么是空 + 下一步动作」文案；顺带完成 backlog #17 的 S5 |
| X4 | Toast 能力不足 | =X2 见上；`store.ts:3216` | 数量上限（如 4）、同文本去重合并计数、可选 action 按钮、`role="status"` + `aria-live="polite"` |
| X5 | 滚动跟随逻辑手写且分散 | `Chat.tsx` 内 `stickRef` / `handleWheel` / `handleUserScroll` / `nearBottomPx` 四套协同，注释自述历史踩坑多（`:80-264`） | 抽 `useStickToBottom(ref, deps)` hook + 单测（现有行为不变，只为让下一个改动不必重新踩坑） |
| X6 | 远程面板层级与配对卡 | 工单现成：`docs/REMOTE-PANEL-POLISH.md` S2–S6（=backlog #17） | 按工单执行，约 1 h，纯样式与 JSX |
| X7 | Composer 权限可发现性 / 断连时输入区状态 | backlog #08、#09 | 权限 chip + popover；模型不可用时输入区 inert + 说明 |
| X8 | PWA 无设置项、设备无在线状态 | backlog #19、#20 | PWA 主题/字号/语言开关；已配对设备显示最后活跃 |
| X9 | 无障碍覆盖不均 | `aria-label`：PluginsPanel 22、Chat 16、Settings 5；`role` 仅零散 dialog/menuitem | 先给「图标按钮 + 自定义可点 div」补 `aria-label` 与键盘可达（Enter/Space），再谈焦点陷阱 |
| X10 | 拖拽 / 右键菜单实现各写一份 | `onContextMenu` 5 文件、`dataTransfer` 4 文件 | 抽 `useContextMenu()` + `useDropTarget()`，统一菜单项数据结构（`ipc.ts:4812` 已是通用 popup 通道，可直接复用） |

---

## 四、建议批次（确认后执行）

| 批次 | 内容 | 验证范围（按 AGENTS.md 爆炸半径） |
|---|---|---|
| **P0 止血**（1–1.5 天） | R1 原子 store、R4/X2 确认框统一、X1 快捷键 | typecheck + `npm test -- trash drafts todo permission` + 手动过一遍删除类操作 |
| **P1 结构**（2–3 天） | R2 拆 `ipc.ts`、R3 类型下沉、D 重复实现合并 | typecheck + 全量 `npm test`（动共享基础设施） |
| **P2 体验**（1.5–2 天） | X3 空态/骨架、X4 Toast、X6 远程面板 S2–S6、X5 hook 抽取 | typecheck + `npm test -- pwa remote markdown` |
| **P3 中期**（按需拍板） | R5 懒加载、R6 i18n 迁移、C1 store 切片、E1 依赖瘦身（=backlog #34） | 每项单独一轮，全量回归 |

> 未列入建议的：`android/` 与 `mobile/app/` 合并、协议 codegen——收益取决于后续手机端投入方向，需要你先拍板再评估。

---

## 五、P0 已落地内容（2026-10-15）

> 代码提交：`d12ad67 refactor(p0): 原子写统一 + 确认框统一 + 全局快捷键注册表`（未 push）。

| 项 | 改动 | 新增文件 | 验证 |
|---|---|---|---|
| R1 | 抽出原子写底座：`atomicReplace`（含 Windows EPERM 假失败容错，原只在 `zhiya/pool.ts`）提到 `src/main/fs-atomic.ts`；新增 `src/main/json-store.ts`（`readJsonRaw` / `writeJsonAtomic`）。`config.ts`（原来是直接覆写）、`draft-store` / `feedback-store` / `todo-store` / `observed-tools` 改为共用；写入时序（FLUSH_MS、退出前 flush）没动 | `src/main/fs-atomic.ts`、`src/main/json-store.ts`、`scripts/test-json-store.mjs`（9 项断言） | `npm run test:json-store` + 全量 L1 |
| R4 | 全局确认框：store 新增 `confirmAsk` / `askConfirm()` / `closeConfirm()`，新组件 `ConfirmDialog.tsx` 挂在 App 根部；**8 处原生 `window.confirm` 全部迁完**（AppStore 信任告知与卸载、定时任务删除、MCP 移除、扩展包移除、设置放弃未保存 / 删提供商 / 重读模型），记忆池自实现的那份确认层删除、改用同一个组件（CSS `.mempool-confirm-*` → `.confirm-*`） | `src/renderer/src/components/ConfirmDialog.tsx` | typecheck + 全量 L1；应用内逐个走删除类操作 |
| X1 | 快捷键注册表 `lib/shortcuts.ts`（修饰键严格匹配、默认不在输入框抢键、Ctrl+= 与 Ctrl+Shift+= 互认）；原有 Ctrl+K / 缩放迁入，新增 **Ctrl+N 新建会话**、**Ctrl+, 打开设置**、**Esc 停止生成**（仅当前会话在跑且无其它弹层时） | `src/renderer/src/lib/shortcuts.ts`、`scripts/test-shortcuts.mjs`（5 项断言） | `npm run test:shortcuts` |

> 全量回归结果：`npm run typecheck` 通过；`npm test` = **136 passed / 3 skipped / 0 failed**（3 个 skip 是 `run-all-tests.mjs` 里写明的手动诊断项）。
> 顺带修一个迁移带来的坑：`test-memorypool.mjs` 以前直接 `import("../src/main/zhiya/pool.ts")` 而没注册 `ts-ext-loader`；pool.ts 现在多了相对导入，该测试已补上 loader 注册（与其余 21 个脚本一致）。

---

## 附：全景图复跑命令

```bash
# archify 便携安装在 E:/MyWorkspace/Software/archify（v3.1.0，零 npm install）
cd /e/MyWorkspace/Project/MPI
node /e/MyWorkspace/Software/archify/bin/archify.mjs finalize architecture \
  docs/archify/mpi-panorama.candidate.json docs/archify/mpi-panorama.html \
  --repo-root . --quality showcase --json --out-dir <tempfile>/review-<n>

# 发送链路时序图（sequence）
node /e/MyWorkspace/Software/archify/bin/archify.mjs finalize sequence \
  docs/archify/mpi-send-path.candidate.json docs/archify/mpi-send-path.html \
  --repo-root . --quality showcase --json --out-dir <tempfile>/review-<n>
```

证据基线：`git rev-parse HEAD` = `9c715a848b77a344349900f2c356af0e00e60ffc`；改代码后若行号漂移，需同步 candidate.json 的 `sources.line`。
