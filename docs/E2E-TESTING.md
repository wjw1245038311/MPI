# MPI 自动化测试方案（Test Pyramid L0–L3）

本方案沉淀自「任务模式强制只读 + mode-switch 闭环」的 e2e 实测经验，并参考行业通用实践
（test pyramid、shift-left、CI gate、回归管理、flaky 治理）制定。**每个新功能落地时按第 3 节流程执行**，
测试用例与功能保持可追溯。

> 本文是**基础设施手册**（平台怎么用）。新功能的测试设计、用例注册与交付标准见
> [FEATURE-TESTING.md](FEATURE-TESTING.md)（功能测试注册表 + 应用内测试面板）。

## 1. 目标与原则

| 原则 | 含义 | 来源教训 |
|---|---|---|
| **Shift-left（左移）** | 越便宜的检查越早跑：编译/单测秒级拦截，e2e 分钟级兜底 | 模板字符串笔误 `}]`→`]}` 直到 e2e 产物 node --check 才暴露 |
| **产物驱动断言** | 验证磁盘文件、session jsonl、mtime 时序等客观产物，不信模型自述 | "只读模式已阻止"必须出现在 toolResult 里才算拦截生效 |
| **隔离与确定性** | 每次 run 独立目录（agent dir / config / todos），dummy project 固定内容 + hashTree 快照 | harness 的 `run-<case-id>/` 全量重建，可重复执行 |
| **回归优先** | bug 修复必须附带回归用例；没有回归用例的修复不算完成 | F10（mode-switch 被自身拦截）→ SAFE_TOOLS 回归用例 |
| **保真加载** | e2e 直接加载 `src/main/*.ts` 真实扩展与生产一致的 env，不 mock 被测对象 | 探针验证 pi jiti 可加载 .ts 后确立 |

## 2. 测试金字塔总览

```
        ┌────────────┐
        │ L3 真机冒烟 │  手动 · 每次发版前 · UI/IPC/renderer
       ┌┴────────────┴┐
       │ L2 e2e harness│  ~1–3 min/case · agent 行为闭环（LLM 参与）
      ┌┴──────────────┴┐
      │   L1 单元测试    │  npm test ≈ 5s · 逻辑边界 / 回归用例 R#
     ┌┴────────────────┴┐
     │  L0 静态门禁       │  typecheck + build ≈ 30s · 编译/产物正确性
     └──────────────────┘
```

| 层 | 命令 | 时间预算 | 触发时机 | 抓什么 |
|---|---|---|---|---|
| **L0** | `npm run typecheck`；改 main/preload/renderer 后加 `npm run build`，并确认 `out/main/index.js` 含改动 | ~30s | 每次提交前 / CI | 类型错误、模板字符串笔误、"改了源码但产物没更新" |
| **L1** | `npm test`（聚合运行器 `scripts/run-all-tests.mjs`，自动发现 `scripts/test-*.mjs`）；过滤：`npm test -- permission choice` | ~5–10s | 每次提交前 / CI（PR + push main） | 拦截/放行矩阵、配置继承、状态迁移等纯逻辑边界 |
| **L2** | `node scripts/e2e/harness.mjs [case-id]`；`--list` 查看用例 | ~1–3 min/case（q5 模型） | 涉及 agent 行为/扩展交互/权限流的功能，合并前必跑一次 | 多轮对话闭环、工具可见性、拦截真实发生、时序竞争、UI 卡片流 |
| **L3** | 重启 MPI 按第 6 节 checklist 手动过 UI | ~5 min | 每次发版前 / 大功能合并后 | Electron/IPC/renderer 层（harness 覆盖不到）：pill 同步、卡片渲染、toast |

> L2 依赖本地模型 relay（`lm-studio-34-220-relay`），不进 CI；CI 只跑 L0+L1（见第 7 节）。

## 3. 新功能落地标准流程（Checklist）

```
□ 1 设计先行：在设计文档写清「应拦截 / 应放行」边界表 + 失败模式
     （参考 TASKMODE-ENFORCE-DESIGN.md；每个边界一行，后面直接变成断言）
□ 2 实现代码
□ 3 L0：npm run typecheck（+ build，确认 out/main 含改动）
□ 4 L1：在对应 scripts/test-*.mjs 加回归用例（新模块则新建 test-<name>.mjs），
     npm test -- <相关名> 全绿；bug 修复必须带 R# 回归用例（第 8 节）
□ 5 L2（涉及 agent 行为/扩展交互/权限流时必做）：
     往 scripts/e2e/harness.mjs 的 CASES 数组加 case → node scripts/e2e/harness.mjs <case-id>
□ 6 结果分析：run-<case>/result.json + logs/transcript.txt；
     失败记为 F# finding（第 8 节），修复后重跑到绿
□ 7 L3：重启 MPI，按 checklist 手动冒烟 UI
□ 8 记录：changelog.md Unreleased 小节（含「验证方式」）+ 设计文档备注 + mem0 记忆
```

**可追溯性要求**：每个功能在 changelog/设计文档中列出它对应的测试标识
（L1 用例名 / L2 case-id），例如 `test:permission → enforce 块`、`harness c1-enforcement`。
反向也成立：每个 L2 case 的注释里写清它守护哪个功能/finding。

## 4. L1 单元测试约定

- **命名**：`scripts/test-<name>.mjs`，独立进程、无共享状态、不依赖网络/GPU/模型。
- **命令一致性**：聚合运行器优先执行 package.json 中对应的 `test:<name>` script（保证 flags 一致），
  找不到时回退 `node --experimental-strip-types scripts/<file>`。**建议**为需要额外 flags 的测试加 npm script（如 `--experimental-strip-types` 之外的 flags）；纯脚本无需额外 flags 时可省略，聚合运行器会自动回退。
- **跳过语义**：环境相关前置缺失 → SKIP（不算失败，打印原因）；逻辑断言失败 → FAIL。
  当前 SKIP 项：`remote-protocol`（需 android tree）、`tui-spawn`/`tui-resume`（交互式 PTY 诊断）。
  `test-tui-race.cjs` 需先 bundle，不纳入自动发现（`npm run test:tuirace`）。
- **常用命令**：

```powershell
npm test                          # 全量 L1（CI gate）
npm test -- permission choice     # 只跑名字含过滤词的
node scripts/run-all-tests.mjs --list
$env:MPI_TEST_TIMEOUT_MS = "300000"; npm test   # 调单测超时（默认 180s/个）
```

- **基线**（2026-09-12 建立，随用例增长更新）：36 passed / 3 skipped / 0 failed。新增测试后保持全绿；
  若某测试在本机因环境无法运行，加入 `run-all-tests.mjs` 的 `skipReason()` 并注明原因，不得静默删除。

## 5. L2 e2e harness 指南（scripts/e2e/harness.mjs）

### 5.1 架构

```
harness.mjs ──spawn──▶ pi CLI --mode rpc
                        │  --extension src/main/permission-gate-ext.ts   （真实 .ts，jiti 加载）
                        │  --extension src/main/mpi-todo-ext.ts
                        │  --extension src/main/mpi-choice-ext.ts
                        │  --extension src/main/mpi-taskmode-ext.ts
                        │  env: MPI_GATE_MODE_FILE / MPI_TASKMODE_DIR / MPI_CHOICE_CONFIG / MPI_TODO_*
                        ▼
              dummy project（todo-cli，固定内容 + hashTree 快照）
harness ◀──stdout JSONL──┘   extension_ui_request ──▶ harness 按策略自动应答卡片
```

### 5.2 保真点（与 src/main/ipc.ts / pi-bridge.ts 对齐，改动 main 侧时同步检查这里）

1. **隔离**：`PI_AGENT_DIR`/`PI_CODING_AGENT_DIR` → `run-<case>/agent/`；models/settings/auth.json 从真实 agent dir 复制。
2. **动作序列 = main 的 applyAgentModeSwitch**：mode-switch 批准时依次「写 gate 文件 + 删 taskmodes/<uuid>.json + 清 config.threadTaskModes」。main 侧该函数改动时必须同步 harness。
3. **UI 卡片自动应答策略**（`handleExtUi`）：模式切换卡 → approve/deny（case 的 `onModeSwitch`）；方案选择卡 → 选含「推荐」项；沙盒审批卡 → allow-once 并记入 `approvalCards`（出现即 finding，说明模型绕路了）。
4. **验证靠产物**：hashTree 前后对比 → filesCreated/filesModified；session jsonl 解析 → toolCalls / blockedEvidence（匹配「只读模式已阻止」）/ errors；mtime < mode-switch 时刻的文件写入 = `noPreSwitchWrites` 失败。

### 5.3 Case 模板（新功能加 case 用这个骨架）

```js
{
  id: "cN-<feature-slug>",            // run 目录名 run-cN-...，唯一
  provider: "lm-studio-34-220-relay",
  modelId: "qwen3.8-27b@q5_k_m",      // 迭代用 q5（~50s/turn）；勿默认 q4（~15min/turn）
  onModeSwitch: "approve" | "deny",   // 本 case 对模式切换卡的应答策略
  turns: [
    { name: "<turn-slug>", prompt: "……明确、可判定的任务描述……" },
  ],
},
// + runCase() 里加一段 per-case checks（信息性布尔）与显式 pass 判定（ok = ...），
//   断言只依赖产物：result.checks / filesCreated / blockedEvidence / modeSwitchRequests / mtime。
```

**加 case 五步**：① CASES 数组加对象 → ② runCase 分析段加 checks + ok 判定 → ③ `node scripts/e2e/harness.mjs --list` 确认出现 → ④ 跑单 case → ⑤ 看 result.json/transcript.txt，把 pass 标准写进 case 注释（守护哪个功能/finding）。

### 5.4 模型选择与 flaky 治理

| 模型 | 速度 | 用途 |
|---|---|---|
| `qwen3.8-27b@q5_k_m` | ~50s/turn | **迭代主力**，所有 case 默认它 |
| `qwen3.8-27b@q4_k_m` | ~15min/turn | 仅单轮能力下限验证（c3），不进日常回归 |
| `qwen3.8-27b@q6_k` | relay 载入不稳定 | 仅由 `c4-research-q6` 单独使用（记录该量化档的能力下限）；**不进日常回归**，relay 加载失败时按环境问题处理，不作为回归基线 |

LLM e2e 天然非确定，治理规则：

- **relay 不可用时的降级**：L2 依赖本地模型 relay。若 relay 未启动或模型加载失败，harness 会以 `status=timeout/error` 结束——这属于**环境缺失而非功能回归**，不得据此判定功能失败；此时以 L0+L1+L3 手动为准，恢复 relay 后重跑。自动化测试面板对这种情况如实显示 timeout/error 与原因（不会误报为通过）。
- **关键 case N-of-M**：守护安全边界（拦截类）的 case 连跑 2 次都过才算绿；行为类 case 1 次 + 失败重跑 1 次区分 flaky/真回归。
- **断言写"可判定"**：避免对措辞做精确匹配，用范围（如「约500字」=350–900 字符）、存在性、时序。
- **每次 run 追加 `results-summary.json`**，保留历史；同一 case 连续 ≥2 次 flaky → 先修断言或提示词稳定性，再谈模型问题。
- 沙盒审批卡出现次数（`approvalCards.length`）是"模型绕路率"指标：批准后仍频繁弹审批 = 工具恢复/提示有问题（F1 就是这么发现的）。

### 5.5 产物 schema（run-<case-id>/）

| 文件 | 内容 |
|---|---|
| `result.json` | status(pass/fail/timeout/error)、checks、toolCalls、blockedEvidence、filesCreated/Modified、modeSwitchRequests、choiceCards、approvalCards、turnDurationsMs、errors |
| `logs/transcript.txt` | 人类可读全量对话（user/assistant/thinking/toolCall/toolResult） |
| `logs/events.jsonl` | pi stdout 原始事件流 |
| `agent/sessions/*.jsonl` | pi session 文件（断言数据源） |

辅助调试脚本（一次性工具，留在 gitignored 的 `tmp/research-e2e/`）：`peek-session.mjs`、`tool-calls.mjs`、`tail-events.mjs`、`show-result.mjs`。

## 6. L3 真机冒烟 checklist 模板

每次发版前 / 大功能合并后，重启 MPI（dev 或打包版）逐项过：

```
□ 新建会话应用目标模式 → pill/权限指示正确
□ 触发新功能主路径 → UI 渲染、toast、状态同步符合设计文档
□ 触发边界路径（拒绝/取消/异常输入）→ 行为与 L2 case 的 deny 分支一致
□ 重启应用后状态持久化正确（config/taskmodes/todos）
□ 控制台无新增报错；扩展加载日志正常
```

## 7. 执行策略与 CI

| 环 | 内容 | 时机 |
|---|---|---|
| **快环**（开发中） | `node --check <改过的 .js>` + `npm test -- <相关名>` | 每次编辑后，秒级反馈 |
| **提交门禁** | `npm run typecheck` + `npm test`（+ build 若动 main/preload/renderer） | 每次 commit/PR |
| **合并前** | L2：新功能 case + 受影响的既有 case（安全边界类 ×2） | PR 合并前 |
| **发版前** | L2 全量 + L3 checklist + `npm run build` 产物抽查 | tag / release |

CI 现状（`.github/workflows/`）：

- **tests.yml**（本方案新增）：PR + push main → windows-latest，Node 24.14.0，`npm ci` → L0 typecheck → L1 `npm test`。
- **build-installers.yml**（既有）：打包前已有 typecheck + `test:permission`（win32），保留不动。
- L2 不进 CI（依赖本地模型 relay）；若未来 relay 可云端化，把 tests.yml 加一个手动触发的 e2e job 即可（harness 已支持 env 覆盖路径：`MPI_E2E_NODE/MPI_E2E_PI_CLI/MPI_E2E_AGENT_DIR`）。

## 8. 失败分类与回归管理

- **F# finding**：测试/实测发现的缺陷编号，记录在 changelog Unreleased + 设计文档备注（例：F1 = mid-turn 批准后 write/edit 下一轮才恢复；F10 = mode-switch 工具被自身 enforce 拦截）。
- **R# regression**：每个 F# 修复必须落一个回归用例并双向引用。已落地示例：

| Finding | 现象 | 回归用例（位置） |
|---|---|---|
| F10 | enforce=readonly 拦掉 mpi_request_mode_switch/todo_* | `test-permission-gate.mjs` enforce 块：放行 SAFE_TOOLS、mem0_memory 仍拦 |
| F1 | mid-turn 批准后工具下一轮才恢复 | `test-task-modes.mjs`/`test-choice.mjs`：tool_call hook 即时 reconcile + 批准时先验证 enforce 已解除再恢复；L2 c2-full-loop 复验「批准后 bash 写归零」 |

- **规则**：修复 PR 无回归用例 → 不合并；新 case/checks 注释里标注守护的 F#/功能。

## 9. 实测教训（任务模式 e2e，2026-07 ~ 2026-09）

1. **prompt 约束 ≠ 硬执行**：必须 e2e 验证拦截真实发生（blockedEvidence），不是看模型说"我不会写"。
2. **模型会绕路**：bash 代 write/edit、`node -e`/嵌套 shell/管道试旁路 → 用例要主动探这些路径（c1 的 write-probe turn）。
3. **时序竞争只有多轮真跑才暴露**（F1）——单测抓不到，L2 不可省。
4. **小模型会犯错**：产物用 `node --check` + 内容范围检查验证；编辑含模板字符串的 JS 后必须 node --check。
5. **字符级扫描有盲区**：码点/反引号配对/BOM/CRLF 全查不出 `}]`↔`]}`，最终靠「磁盘切片 vs 手敲版逐码点对比」定位——产物比对优先于静态检查。

## 10. 速查卡

```powershell
# L0
npm run typecheck
npm run build            # 动 main/preload/renderer 时；随后确认 out/main/index.js 含改动

# L1
npm test                 # 全量（CI gate）
npm test -- permission   # 过滤
node scripts/run-all-tests.mjs --list

# L2
node scripts/e2e/harness.mjs --list
node scripts/e2e/harness.mjs c1-enforcement    # 单 case
node scripts/e2e/harness.mjs                   # 全量（慢，q4 case 除外按需）
Get-Content tmp/research-e2e/run-c1-enforcement/result.json -Raw

# L3：重启 MPI → 第 6 节 checklist
```
