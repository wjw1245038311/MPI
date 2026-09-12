# 新功能测试落地指南（功能测试注册表 + 应用内测试面板）

> 本文回答：**一个新模块做完后，怎么给它设计验证方案、怎么把验证方案变成可运行、可回看的用例、以及怎么在应用内看结果。**
>
> 与 [E2E-TESTING.md](E2E-TESTING.md) 的分工：
> - **E2E-TESTING.md = 基础设施手册**：测试金字塔 L0–L3、各层命令与时间预算、harness 架构 / case 模板 / 产物 schema、CI 策略、失败分类与回归管理。属于「平台怎么用」。
> - **本文 = 新功能落地手册**：从设计边界 → 测试点 → 分层选择 → 注册用例 → 应用内运行/回看 → 准入准出。属于「一个新功能要走的路」。
>
> 两者配合使用：设计阶段读本文第 1–4 节，实现/回归阶段按 E2E-TESTING.md 第 3 节 checklist 执行命令，交付阶段按本文第 6 节登记用例。

---

## 1. 一句话原则

**每个新功能都要有「可运行、可复现、能回看」的验证用例；验证方案不是一段散文，而是注册表里的数据 + 一键可跑的动作。**

判定标准：新人（或 agent）拿到一个功能名，能在 5 分钟内通过「开发工具 → 自动化测试」找到它的用例、看到断言点、点一下跑起来、并读懂上一次的结果——否则验证方案不算完成。

---

## 2. 五步落地法

```
① 设计边界表  →  ② 拆测试点  →  ③ 选层  →  ④ 写用例（注册 + 实现）  →  ⑤ 跑通 + 登记
```

### ① 设计边界表（在写代码之前）

在设计文档里为功能列一张「**应通过 / 应拦截 / 应拒绝 / 边界**」表，每行一句话：

| 场景 | 期望行为 | 判据（可观测产物） |
|---|---|---|
| 主路径 | 功能生效 | 文件生成 / UI 状态 / 返回值 |
| 越权 | 被拦截 | 拦截原因出现在结果里 |
| 边界输入 | 不崩、给出明确提示 | 错误文案 / 状态码 |
| 异常路径 | 回退或拒绝 | 无副作用（产物未变） |

**这张表的每一行，后面都要变成一条断言。** 没有判据的行 = 无法验证 = 过不了准出。

### ② 拆测试点

把边界表拆成**可独立判定**的测试点（test point），一个测试点对应一条或一组断言。原则：

- 一个测试点只验证一件事（避免「一跑挂一片、不知道挂在哪」）。
- 优先覆盖**安全边界**与**已知易错路径**（历史 F#/坑），而不是穷举。
- 每个测试点写清「**层**」与「**命令**」。

### ③ 选层（性价比最高的一层）

| 测试点性质 | 落层 | 形式 |
|---|---|---|
| 纯逻辑（解析/校验/状态机/工具函数） | **L1** | `scripts/test-<name>.mjs` |
| agent 行为闭环（多轮、工具可见性、拦截真实发生） | **L2** | `scripts/e2e/harness.mjs` case |
| Electron / IPC / renderer / UI 渲染 | **L3 手动**（暂无自动化） | 重启 MPI 走 checklist |
| 编译 / 产物正确性 | **L0** | `typecheck` + `build` |

选层口诀：**能用 L1 就别上 L2；L2 只留给「必须真的让模型跑一遍」的东西；UI 层暂时手动。**

### ④ 写用例（注册 + 实现）

一次新功能通常产生 **1 条 L1 + 0~1 条 L2 + 1 条 L3 手动**：

1. **实现**：L1 写进对应 `scripts/test-*.mjs`（新模块新建文件）；L2 按 E2E-TESTING.md §5.3 模板加 case。
2. **注册**：在 `tests/registry/` 落一个 JSON（见第 3 节）——**这是「把它加入自动化测试」的全部动作**。
3. **坏用例不阻断**：注册表解析失败的条目只会在面板显示为错误，不影响其它用例。

### ⑤ 跑通 + 登记

- 本地跑一次：L1 → `npm test -- <name>`；L2 → `node scripts/e2e/harness.mjs <case-id>`。
- 在 changelog 的「验证方式」里登记用例标识（L1 名 / L2 case-id）。
- 在应用内确认面板能列出该用例、能跑、能看到结果。

---

## 3. 用例注册表（`tests/registry/*.json`）

**一个文件 = 一个用例**。面板自动发现该目录下的所有 `.json`，因此新增用例**不改任何 UI 代码**。

### 3.1 字段

```jsonc
{
  "id": "logic-trusted-tools",          // 必填，^[a-z0-9][a-z0-9-]*$，全局唯一
  "title": "工具信任列表 · 纯逻辑",       // 必填，面板显示名
  "feature": "权限与安全",               // 必填，用于左栏分组
  "kind": "logic",                       // 必填，"logic" | "scenario"
  "source": "src/renderer/src/lib/trusted-tools.ts",  // 必填，代码/文档位置
  "passCriteria": "5 组断言全绿",         // 必填，通过标准（一句话）
  "description": "……",                  // 可选，更详细说明
  "logicTest": "trustedtools",           // kind=logic 必填：run-all-tests 过滤词
  "assertions": ["切换后状态翻转", "…"],  // 可选，断言点列表（面板逐项展示）
  "preprompt": "……",                    // 可选（scenario 常用）：场景提示词
  "harnessCaseId": "c2-full-loop",       // kind=scenario 必填：harness case id
  "repeat": 2                            // 可选，≥1；建议重复次数（安全边界类填 2）
}
```

### 3.2 两种 kind

| kind | 运行方式 | 适用 | 结果视图 |
|---|---|---|---|
| `logic` | `node scripts/run-all-tests.mjs <logicTest>` | 纯逻辑测试点 | 流式输出 + 通过/失败 + exit code |
| `scenario` | `node scripts/e2e/harness.mjs <harnessCaseId>` | agent 行为闭环 | checks 逐项 + 模拟对话（transcript）+ 历史运行 |

> `scenario` 复用现有 harness case——**不要为了注册表去改 harness 的断言逻辑**；注册表只是把已有 case 暴露到面板。

### 3.3 校验规则（主进程 `test-registry.ts`）

- 必需字段缺失 / 类型错误 → 该文件进 `errors`，面板顶部横幅提示，其余用例照常。
- `id` 重复 → 后者进 `errors`。
- 未知字段被丢弃（宽松，便于渐进演进）。

L1 回归：`scripts/test-test-registry.mjs`（`npm test -- test-registry`）。

---

## 4. 应用内测试面板

入口：标题栏 **「开发工具 → 自动化测试」**（仅 dev 构建；打包版整条菜单不渲染）。

- **左栏**：按 `feature` 分组，每条带「逻辑 / 场景」徽标；运行中显示 …。
- **右栏**：
  - 来源、ID、描述、断言点、通过标准；
  - **逻辑**用例：点「运行」→ 流式输出 + 通过/失败（exit code）；
  - **场景**用例：点「新建会话模拟」→ 在一次性沙盒项目里跑真实 agent（约 1–3 分钟），结束后显示：
    - `result.json.checks` 逐项 ✓/✗；
    - `logs/transcript.txt` 解析成的 **USER / ASSISTANT / 工具调用** 模拟对话（就是「新建对话模拟测试」的呈现）；
    - 可展开 harness 原始日志；
    - **历史运行**（读 `tmp/research-e2e/results-summary.json`，最近优先，显示状态/模型/被拦数/切换卡数）。
- **刷新**：新增/修改注册表文件后点「刷新」即可，无需重启或改 UI。
- **真实通过与否依赖本地模型 relay**：relay 不在线时场景用例显示 timeout/error 与原因，**不会误报为通过**（见 E2E-TESTING.md §5.4）。

> 面板仅在 dev 构建可用；非 dev 环境主进程直接拒绝 `tests:*` IPC。

---

## 5. 「把它加入自动化测试」——一句话流程

当你说「**把 <功能> 加入自动化测试**」时，agent 应执行：

1. **定位**：找到该功能的实现与已有验证点（L1 文件 / harness case）。
2. **补测试点**：对照第 2 节的边界表，缺哪条补哪条（缺 L1 就写 L1，涉及 agent 行为才加 L2 case）。
3. **注册**：在 `tests/registry/` 新增一个 JSON（字段按第 3.1 节）。
4. **验证**：跑一次该用例（L1 或 L2），确认绿；坏文件不影响其余。
5. **登记**：更新 changelog 的「验证方式」，写明用例标识。

**不需要**改面板代码、改 `test-runner.ts`、或改 harness 内部逻辑——注册表是纯数据。

---

## 6. 准入 / 准出标准

### 6.1 准入（开始写代码前）

- [ ] 设计文档里有边界表（应通过 / 应拦截 / 应拒绝 / 边界），每行有可观测判据。
- [ ] 已标注该功能涉及哪些层（L0/L1/L2/L3）。

### 6.2 准出（功能算完成）

- [ ] L0：`npm run typecheck` 绿；动 main/preload/renderer 时 `npm run build` 绿。
- [ ] L1：新逻辑测试点已落 `scripts/test-*.mjs`，`npm test` 全绿（bug 修复必须带 R# 回归）。
- [ ] L2：涉及 agent 行为/权限流时，harness case 跑过（安全边界类连跑 2 次）。
- [ ] L3：重启 MPI 手动走一遍功能主路径 + 边界路径。
- [ ] **注册表**：功能在 `tests/registry/*.json` 有至少一条用例，且应用内面板能列出、能跑、能看到结果。
- [ ] 登记：changelog「验证方式」写明用例标识；设计文档备注 F#/R# 双向引用。

### 6.3 不合格的常见形态

- 只有一段「验证方式」文字，没有可运行用例 → 不算完成。
- 用例没进 `tests/registry/` → 面板看不到，等于不存在。
- 断言依赖模型措辞的精确匹配 → flaky，改成范围/存在性/时序。
- L2 case 复用了内部实现细节而非产物 → 脆弱，改为断言 result.json / transcript / 磁盘产物。

---

## 7. renderer / UI 层策略（当前）

harness 目前只驱动 `pi` CLI + main 扩展，**覆盖不到 Electron / IPC / renderer**。当前策略：

- **L0 兜底**：`typecheck` + `build` 产物字符串核对（确认改动进了 bundle）。
- **L1 抽纯逻辑**：把 renderer 里的纯函数抽到 `src/renderer/src/lib/*.ts`（如 `trusted-tools.ts`），用 `node --experimental-strip-types` 单测。
- **L3 手动**：UI 渲染 / 交互 / IPC 往返由发版前 checklist 覆盖。
- **不做**：renderer 组件级自动化（无测试基建）、打包版自动化（面板仅 dev）。
- 若未来引入组件测试基建，在本文与 E2E-TESTING.md 同步新增一层（暂命名 L1.5 renderer）。

---

## 8. 速查

```
# 新增一个用例（L1）
1. 写测试：scripts/test-<name>.mjs（+ 可选 npm script test:<name>）
2. 落注册表：tests/registry/<id>.json  { kind:"logic", logicTest:"<name>" }
3. 跑：npm test -- <name>
4. 面板刷新 → 点「运行」

# 新增一个用例（L2，agent 行为）
1. 按 E2E-TESTING.md §5.3 在 harness.mjs 加 case
2. 落注册表：tests/registry/<id>.json  { kind:"scenario", harnessCaseId:"cN-..." }
3. 跑：node scripts/e2e/harness.mjs cN-...
4. 面板刷新 → 点「新建会话模拟」→ 看模拟对话 + checks

# 校验注册表本身
npm test -- test-registry
```
