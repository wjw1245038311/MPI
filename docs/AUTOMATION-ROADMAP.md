# 定时任务改造路线图（P0 → P2）

> 基线：v0.16.0 · 2026-11-26
> 范围：`src/main/automation.ts`（调度 + 执行）、`src/main/config.ts:474-520`（数据模型）、
> `src/renderer/src/components/AutomationPanel.tsx`（面板）、`src/main/system-notifications.ts`（通知）
> 现状与缺陷清单见本文 §0；批次排期见 §2；数据模型与迁移见 §3；每批的改动细节见 §4。

## 0. 摘要

实现现状：到点起一个全新 pi 会话、无人值守需交互即失败的做法成立；缺的是「任务作为对象」的容量——历史、下次时间、可跳转结果、错过补偿。

| 编号 | 问题 | 用户可见表现 | 批次 |
|---|---|---|---|
| 1 | 每日/每周只在 60 秒窗口内匹配（`automation.ts:69`） | 那 1 分钟未 tick（睡眠/合盖/暂停）→ 整天空过，无提示 | A |
| 2 | 错过与补跑无记录 | 面板看不出「昨天该跑没跑」 | A |
| 3 | 修改时间后当天不生效（`slotKey` 按日历天，`automation.ts:78`） | 把 09:00 改 14:00，当天不再触发 | A |
| 4 | 无「下次运行时间」 | 用户只能自己推算 | A |
| 5 | 「立即运行」无 loading/disabled，重复点击被静默吞掉 | 不知道是否已触发 | A |
| 6 | 无运行历史，只有 `lastStatus/lastError/lastRunAt` 三字段（`config.ts:486`） | 失败原因过一会儿就看不到 | B |
| 7 | 面板点不开结果会话 | 只能回侧栏按「定时任务: xxx」翻找 | B |
| 8 | 失败只弹 3 秒 toast，无系统通知、无「待查看」 | 关到托盘等于没看见 | B |
| 9 | 结果只回桌面，不走飞书/微信/PWA | 手机上不可见 | B（需拍板） |
| 10 | 无人值守任务直接在项目目录改文件，可带 full 权限 | 夜间改坏工作区 | C |
| 11 | 无重试 | 429/网络抖动直接判失败 | C |
| 12 | 无全局并发上限，超时硬编码 30 分钟（`automation.ts:173`） | 同分钟多任务各起一个 100–300MB 进程 | C |
| 13 | 面板中文硬编码约 20 处 + `language === "zh"` 14 处 | 英文界面整片中文 | D（可先做） |
| 14 | 只有 每小时/每天/每周 三种 | 无「每 N 分钟」「跑一次」 | D |
| 15 | 不能从会话里让 agent 建任务 | 只能手填表单 | D |
| 16 | 无事件触发（文件变更 / git 事件） | — | E（范围外） |

## 1. 目标与不变量

**目标**

1. 每次「应当执行」的运行，在面板上都能查到结果或明确的「已错过」。
2. 任一历史运行的完整会话，两次点击内可打开。
3. 失败在应用不在前台时可见，且不丢失。

**不变量（保持现有行为，不得回归）**

| 不变量 | 现有依据 |
|---|---|
| 无人值守遇到需人工输入（select/confirm/input/editor）一律失败，不挂起 | `automation.ts` 的 `extUi.cancelledMethod()` 判定 |
| 固定模型不存在时失败，不静默回退默认 | `resolveTaskModel` + `setModel` 抛错 |
| 完成判定不只看 `agent_settled`，还校验 `stopReason` | `getAssistantFailure()` |
| 每次 tick 重读 config，不用内存快照 | `automation.ts:103` 的 `persistedTasks()` |
| 定时任务会话不加载 `mpi_channel_*` 工具 | `automation.ts` 的 extensions 清单 |
| 沙盒为默认权限，full 需显式选择 | `AutomationTask.permission` |

## 2. 批次与排期

工时为本机单人估算，不含评审；每批可独立交付、独立回滚。

| 批次 | 内容 | 工时 | 风险 | 依赖 | 交付判据 |
|---|---|---|---|---|---|
| **A** | 调度正确性：补跑窗口、槽位语义、下次运行时间、运行中状态 | 1.5 天 | 中（改触发判定，需覆盖迁移） | 无 | 睡眠跨过时间点后恢复即补跑一次并在面板留痕 |
| **B** | 运行历史 + 点开会话 + 失败系统通知 + 待查看标记 | 1.5 天 | 低（新增 sidecar，不动调度） | A（复用槽位字段） | 任一历史 run 可跳到其会话；应用在后台时失败有系统通知 |
| **C** | 可靠性：工作树隔离开关、重试、全局并发与任务级超时 | 1.5–2 天 | 中（动 git 与项目目录） | A | git 仓库任务在独立 worktree 跑，项目工作区不被改动 |
| **D** | 能力：文案国际化、间隔/一次性调度、`mpi_schedule_task` 工具、列表管理 | 2 天 | 低 | A、B | 英文界面无中文残留；会话内说「以后每天 9 点…」可生成任务（需用户确认） |
| **E** | 事件触发（文件变更 / git 状态） | 1 天+ | 高（新依赖、噪声） | C | 不进 v1 范围，单独立项 |

建议顺序：**D1（国际化，30 分钟）先行**，其余按 A → B → C → D。理由：国际化无依赖、可当天见效，可与其他批次并行。

## 3. 数据模型变更与迁移

### 3.1 `AutomationTask` 新增字段（`src/main/config.ts:486`）

```ts
interface AutomationTask {
  // …现有字段不动…
  /** 补跑窗口（分钟）：触发时刻错过但未超过该窗口时补一次；0 = 不补跑 */
  catchUpMinutes?: number;        // 默认 120
  /** 任务级运行超时（分钟），替代硬编码 30 */
  timeoutMinutes?: number;        // 默认 30，上限 180
  /** 独立工作树（仅 git 工作目录生效） */
  isolation?: "none" | "worktree"; // 默认 none
  /** 失败重试 */
  retry?: { attempts: 1 | 2 | 3; backoffMinutes: number }; // attempts 默认 1 = 不重试
  /** 上次应执行槽位（ISO 时刻，如 2026-11-26T09:00）；替代按日历天的 lastRunSlot */
  lastSlot?: string;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  /** 错过未补跑的时刻，用于面板留痕 */
  lastMissedAt?: number;
}
```

`lastRunSlot` 保留读取（旧版写入），新代码只写 `lastSlot`；`lastRunAt` 继续维护以兼容备份导入。

### 3.2 运行历史（新增 sidecar）

文件：`<configDir>/automation-runs.json`；复用 `config.ts` 的 `writeJsonAtomic`。

```ts
interface AutomationRun {
  id: string;
  taskId: string;
  trigger: "schedule" | "catchup" | "manual";
  status: "ok" | "error" | "missed" | "skipped" | "aborted";
  startedAt: number;
  finishedAt?: number;
  error?: string;
  sessionFile?: string;   // 供「点开会话」
  model?: string;         // provider/modelId，实际使用值
  attempts?: { at: number; error: string }[];
  reviewed?: boolean;     // 失败是否已被查看
  worktreePath?: string;  // 批次 C
}

interface AutomationRunsFile { version: 1; runs: Record<string, AutomationRun[]> }
```

保留策略：每任务最近 30 条，全局最多 500 条，按 `startedAt` 淘汰。

**选择 sidecar 而非并入 config.json 的理由**：config.json 是设置导入/导出的整体单元（`config.ts:1037` 白名单），把运行历史塞进去会让「导入别人的设置」携带无意义的历史，也会让每次运行都重写整份配置。

### 3.3 迁移

| 旧状态 | 迁移动作 | 时点 |
|---|---|---|
| 只有 `lastRunAt` | `lastAttemptAt = lastRunAt`，不推断 `lastSlot` | 加载时（`config.ts:783` 的 map 内） |
| `lastRunSlot = "2026-11-26"`（旧格式） | 丢弃，按新 `lastSlot`（ISO 时刻）重算；当天若已过时刻且在上次 `lastRunAt` 之后，则视为已执行 | 调度器首次 tick |
| `automation-runs.json` 不存在或损坏 | 按空历史启动，不覆盖损坏文件（改名 `.bad` 保留） | 加载时 |
| 导出/导入设置 | 历史不进备份；任务本身字段随 config.json 走 | 批次 B 内确认 |

## 4. 批次详细改动

### 4.1 批次 A · 调度正确性

| 改动 | 文件 | 要点 |
|---|---|---|
| 抽出纯函数调度模块 | 新增 `src/main/automation-schedule.ts` | `nextRunAfter(schedule, from)`、`dueRunsBetween(schedule, from, to)`、`nextSlotAfter`、`slotId(schedule, date)`、`describeSchedule(schedule, language)`；全部无 IO、可直接单测 |
| 替换匹配逻辑 | `automation.ts:69/78/103` | 删除 `matches()`/旧 `slotKey()`，`tick()` 改为：`const due = latestDueSince(task, lastSlotOrLastRunAt, now)`；`due` 存在且 `now - due ≤ catchUpMinutes` → 执行（`trigger: "catchup"`）；超窗口 → 写 `lastMissedAt` + 一条 `status: "missed"` 历史（批次 B 落地前只写字段） |
| 槽位语义 | `automation.ts` | `lastSlot` 存 ISO 时刻（`2026-11-26T09:00`），改时间/频率后自然不同 → 修问题 3；`hourly` 用 `…T14:20` |
| 下次运行时间 | `automation.ts` + `ipc.ts` | `automation:getTasks` 返回 `nextRunAt`（实时计算，不落盘），面板行与空态直接展示 |
| 定时器 | `automation.ts:147` | `setInterval` 改链式 `setTimeout`：下次延迟 = `min(20_000, nextRunAt - now)`，最坏误差 < 2s；`lastSlot` 去重保证幂等 |
| 唤醒补跑 | `src/main/index.ts` | 订阅 `powerMonitor.on("resume")` 与 `"user-did-become-active"`，触发一次 `tick()`；未接电事件时靠 A 的补跑窗口兜底 |
| 运行中状态 | `automation.ts` + `preload` + `store.ts` | `automation:getTasks` 附带 `runningTaskIds`；面板「立即运行」据此置 loading/disabled（UI-SPEC §2.1） |
| `runNow` 语义 | `ipc.ts:8447` | 立即 resolve（fire-and-forget），进度通过 `pi:automation` 事件回报；当前写法让 IPC 挂到任务结束（最长 30 分钟） |

### 4.2 批次 B · 运行历史与可观测

| 改动 | 文件 | 要点 |
|---|---|---|
| 历史读写 | 新增 `src/main/automation-runs-store.ts` | `appendRun/updateRun/listRuns/prune/reviewRuns`；原子写；损坏不覆盖 |
| 会话文件捕获 | `automation.ts:208` | `start()` 后读 `bridge.getState()` 拿 `sessionFile`（与 `ipc.ts:4245` 同一取值方式），写入 `AutomationRun.sessionFile` |
| 写入时点 | `automation.ts` | start → `queued/running`；`settle`/catch/finally → `ok/error/aborted`；超时 → `aborted` 并保留最后错误 |
| IPC | `ipc.ts:8434` | 新增 `automation:getRuns(taskId, limit)`、`automation:markReviewed(id[])`、`automation:openRun(id)`；preload 同步加 |
| 面板历史 | `AutomationPanel.tsx` | 任务行可展开「最近运行」：时间 / 触发方式 / 状态 / 耗时 / 右侧「打开会话」；空态给出「尚未运行」+「立即运行」入口（UI-SPEC §1 五态） |
| 打开会话 | `store.ts` | 复用 `openThread(task.cwd, sessionFile)`；会话文件不存在时给「会话已被删除或归档」提示，不白屏 |
| 系统通知 | `system-notifications.ts` | 新增 `notifyAutomationResult({taskId, name, ok, error, sessionFile})`；点击 → 聚焦窗口 + `app:focus-thread` 打开该会话；只在窗口未聚焦时弹（沿用现有 `show()` 判定） |
| 待查看标记 | `AutomationPanel.tsx` | 侧栏「定时任务」图标红点 + 面板顶部「N 条失败待查看」，点开即 `markReviewed` |
| 跨设备（需拍板 Q4） | `messaging` | 任务完成/失败按现有通道发一条短消息（截断到 `truncateForChat`），链接式文本指向会话名；不开则跳过 |

### 4.3 批次 C · 可靠性

| 改动 | 文件 | 要点 |
|---|---|---|
| 工作树隔离 | 新增 `src/main/automation-worktree.ts` + `automation.ts` | 仅 `isolation: "worktree"` 且 cwd 是 git 仓库：`git worktree add <configDir>/mpi-worktrees/<taskId>/<runId> -b mpi-auto/<taskId>/<runId>`；运行结束保留分支、记录 `worktreePath`，历史里给「查看改动 / 合并 / 丢弃」；`git worktree prune` 清理登记，磁盘目录按保留策略删 |
| 重试 | `automation.ts` | 只对可重试错误（进程非零退出、超时、网络类 `errorMessage`）重试；`stopReason` 为业务失败时不重试；退避 `backoffMinutes`，同一次 Run 记 `attempts[]` |
| 全局并发 | `automation.ts` | `maxConcurrentAutomationRuns`（config，默认 2）用信号量；超出→ `status: "queued"` + 排队，面板显示「排队中」 |
| 任务级超时 | `automation.ts:173` | `RUN_TIMEOUT_MS` → `task.timeoutMinutes`（默认 30，上限 180）；超时写 `aborted` 并 `stopGraceful()` |

### 4.4 批次 D · 能力

| 改动 | 文件 | 要点 |
|---|---|---|
| D1 国际化 | `AutomationPanel.tsx` + `lib/i18n.ts` | 全部硬编码中文迁入词典；`summarize()`/`DAY_NAMES` 复用 `describeSchedule` 的中英版本，避免两处维护 |
| D2 调度表达力 | `config.ts` + `automation-schedule.ts` | 新增 `frequency: "interval"`（每 N 分钟，N ≥ 15）与 `frequency: "once"`（指定时刻跑一次后自动 `enabled: false`）；`TaskSchedule` 加判别字段，旧三档不动；cron 表达式留到有明确需求再做 |
| D3 会话内建任务 | 新增 `src/main/mpi-schedule-ext.ts` | 工具 `mpi_schedule_task({name, prompt, schedule, cwd?, permission?})`：只写草稿并返回「待用户确认」，**确认卡由用户点击后才落 config**；仅交互会话加载（`automation.ts` 的 extensions 清单不加入）；沙盒会话不允许创建 `permission: "full"` 的任务 |
| D4 列表管理 | `AutomationPanel.tsx` | 暂停全部 / 复制任务 / 排序（下次运行时间）/ 搜索 / 编辑中关闭面板给出未保存提示（`askConfirm`） |

### 4.5 批次 E · 事件触发（范围外）

仅记录方向：文件变更（`fs.watch` 递归，避免新增 chokidar 依赖）或 git 状态轮询作为触发源，复用批次 A 的 `dueRunsBetween` 之外的第二个触发通道。噪声控制（debounce、最大触发频率）必须先定，否则不进实现。

## 5. 待拍板

| # | 决策点 | 建议默认 | 影响 |
|---|---|---|---|
| Q1 | 补跑窗口默认值 | 120 分钟 | 0 = 完全不补跑（保守但丢失午休场景）；1440 = 当天任意时刻补，可能跑到过时任务 |
| Q2 | 运行历史是否进「设置 → 备份与恢复」 | 不进 | 进则备份体积增长、导入带无意义数据；不进则换机后历史丢失 |
| Q3 | 工作树隔离默认值 | 默认关，git 仓库任务在面板提示可开 | 默认开会让用户项目里多出分支与目录 |
| Q4 | 完成/失败是否推送到飞书/微信 | 先不推 | 涉及既有通道语义（通道会话 vs 通知），需要单独设计 |
| Q5 | 是否允许 agent 自建定时任务 | 允许起草，必须用户确认后落盘 | 直接落盘等于让 agent 在无人值守下自行调度，不可接受 |

## 6. 测试与验收

**新增测试（`scripts/`，接 `npm test -- automation`）**

| 脚本 | 覆盖 |
|---|---|
| `test-automation-schedule.mjs` | `nextRunAfter`：小时跨天、周跨周、月末、闰日 2/29、时刻非法（`25:00`）、`days` 为空；`dueRunsBetween`：窗口边界（恰好等于 `catchUpMinutes`）、跨多日、上次槽位为空；改时间后槽位重算（问题 3 回归） |
| `test-automation-runs.mjs` | 追加/更新/截断（每任务 30、全局 500）、损坏文件降级、`reviewed` 统计 |
| `test-automation-worktree.mjs`（批次 C） | 非 git 目录回退 none、分支命名、清理与 prune |

**手工验收（每批一次）**

| 批次 | 动作 — 检查什么 |
|---|---|
| A | 建每日任务设为 2 分钟后的时刻 → 触发正常；再设一次并让系统睡眠跨过触发点 5 分钟 → 恢复后补跑一次、历史/面板有记录、不重复触发 |
| A | 任务已跑过当天，把时刻改到更晚 → 当天仍会触发（问题 3 修复） |
| A | 点「立即运行」→ 按钮立即变 loading + 禁用，面板行显示运行中；重复点击不再起第二个进程 |
| B | 故意让任务失败（固定一个不存在的模型）→ 应用最小化时收到系统通知，点击打开该会话；面板顶部出现「1 条失败待查看」 |
| B | 历史里任意一条「打开会话」→ 落到对应「定时任务: xxx」会话；把该会话删除后再点 → 给出明确提示 |
| C | git 仓库任务开 worktree → 项目工作区 `git status` 无变化，历史里有「查看改动」，diff 可读 |
| C | 断网环境跑联网任务 → 按 `retry.attempts` 重试，历史 `attempts[]` 完整记录 |
| D | 切英文 → 定时任务面板无中文残留；`grep -nE "[一-龥]"` 命中为空 |
| D | 会话里说「以后每天 9 点生成日报」→ agent 起草任务并弹确认卡，点取消不落盘 |

每批结束：`npm run typecheck` + `npm test -- automation`（批次 C 另加 `npm test -- worktree`）。

## 7. 范围内不做

- 云执行（需要服务端托管与会话回传，超出本仓边界）。
- 定时任务会话加载 `mpi_channel_*` 工具（省 token 的既有决策）。
- 把 `AutomationTask` 类型从 `config.ts` 迁出到独立模块：属纯整理，不解决任何用户可见问题，按需单独做。
- cron 表达式（除 D2 决策通过）。

## 8. 证据说明

**已核实（源码）**

- 60 秒匹配窗口：`automation.ts:69` 的 `matches()` 对 daily/weekly 做 `hhmm === schedule.time` 等值比较。
- 按日历天去重：`automation.ts:78` 的 `slotKey()` 对非 hourly 返回 `Y-M-D`。
- 硬编码超时：`automation.ts:173` 的 `RUN_TIMEOUT_MS = 30 * 60 * 1000`。
- 运行记录字段仅 3 个：`config.ts:486-503`。
- 面板无「打开会话」入口、无历史区：`AutomationPanel.tsx` 全文无 `openThread` 引用。
- 系统通知只挂交互会话：`ipc.ts:967` 的 `notifyTaskComplete` 调用点在会话桥接事件里。
- 远程广播要求 payload 带可映射的 `threadId`：`ipc.ts:4960` 起，无 threadId 直接 return。

**推断（未实测）**

- `powerMonitor` 的 `resume` / `user-did-become-active` 事件在当前 Electron 版本可用，以及合盖睡眠期间定时器是否被统一暂停——按「主进程 timer 在睡眠期间不补发」推论，需在批次 A 实现时先用最小脚本验证。
- pi 的 `getState()` 返回值含 `sessionFile` 字段：依据 `ipc.ts:4245` 的既有取值方式推论，字段名需在实际桥接返回里确认。
- 运行历史 sidecar 不阻塞主进程：按 `feedback-store.ts` 同构实现推论。

**结论**

批次 A 与 B 覆盖「会话是可查对象」这一核心缺口，合计约 3 天；C 解决无人值守破坏性与抖动失败；D 属体验与创建方式补齐。E 不进 v1。
