# 任务模式硬执行（enforce）+ 工具信任列表 设计报告

日期：2026-07-18 · 状态：**已实现（P0+P1）** · 范围：仅 MPI 应用层，**不改 pi core**

## 0. 实现备注（相对原设计的差异）

1. **F5 增强——config 兜底**：gate 的 `readEnforce` 除读 `taskmodes/<uuid>.json` 外，还从 config.json 的 `threadTaskModes × taskModes.enforce` 推导 enforce（research/review 视为恒强制，镜像 renderer 的 normalizeTaskModes）。作用：**旧版本写的状态文件没有 enforce 字段**，升级后已处于调研模式的存量线程也能立即被拦截，无需用户重新应用模式。两者任一命中即生效。
2. **F10 落点调整**：`mpi_request_mode_switch` 工具直接加在现有 choice 桥（mpi-choice-ext.ts）里，不新建扩展文件；main 侧拦截逻辑在 `thread:extuiResponse` handler + onExtUi 记录 pendingModeSwitch（含渠道会话的 grace-period 自动拒绝）。目标权限从卡片标题解析（名称→级别反查表）。
3. **额外修复（测试发现的既有漏洞）**：原 gate 的 write/edit 分支在 readonly 下对**普通项目内写入并不拦截**（只有敏感/通配/缺路径走 gateWrite），`return undefined // sandbox: ...` 直接放行。已补 `effective === "readonly"` 硬拦截 + 测试用例锁定。
4. **F7 toast**：应用 enforce 模式时统一提示“强制只读优先于权限设置”；agent 发起的切换通过新推送通道 `pi:modeSwitched` 同步 pill（usePiEvents 订阅）。
5. **验证**：typecheck ✅；test:permission / test:taskmodes / test:choice 全绿（新增用例见各脚本末尾注释块）；electron-vite build ✅。changelog Unreleased 已记录。
6. **F10 闭环回归修复（2026-07 实测发现）**：`mpi_request_mode_switch`（及 `mpi_todo_add/list`）最初未列入 SAFE_TOOLS，enforce=readonly 下被扩展工具分支硬拦——agent 在调研模式内无法请求切权限，只能靠用户手动去 UI 改。已把这三个工具加入 SAFE_TOOLS（mode-switch 仅弹确认卡、真实切换发生在 main 侧用户批准后；todo 只写 MPI 自己的待办面板），并加回归用例锁定；mem0_memory 等其余扩展工具在强制只读下仍照拦。
7. **F1 mid-turn 工具可见性恢复（2026-09 e2e 实测发现）**：隔离 pi RPC harness 完整闭环实测（lm-studio relay q5）发现——同轮内批准 mode-switch 后 write/edit 要到下一轮 `before_agent_start` 才恢复，同轮模型被迫用 bash/`node -e` 写文件、每条命令弹沙盒审批卡（实测 8 张）。修复：① mpi-taskmode-ext 新增 `tool_call` hook（状态读取 mtime+size 缓存），同轮状态变化即时 reconcile 工具可见性——双向覆盖（解除后恢复 / 运行中重新应用模式立即隐藏）；依据是 pi 的 `prepareNextTurnWithContext` 在**每次模型请求前**重读 `agent.state.tools`，故同轮下一次迭代即生效。② mpi-choice-ext 批准后即时恢复 write/edit：main 是「先回应 select、后 applyAgentModeSwitch」，存在时序竞争——恢复前先验证状态文件里 enforce 确实已解除（未解除则跳过，由 ① 的 tool_call hook 兜底自纠正）；批准结果文本同步加强为明确提示优先用 write/edit。实测：批准后全部文件修改走 edit/write，bash 写操作归零。
8. **「越权请求即时告知」优化 A'+B1+C（2026-09 审查模式实测发现）**：审查模式下提出明显超出只读能力的执行型请求（“生成 txt 记录今日杭州天气”），agent 未第一时间告知用户，先试了 4 条会被拦截的命令才解释。根因：指令无「冲突即报」规则 + 低估拦截范围（只提写操作，实际网络请求/非白名单命令也被拦）+ 进入模式仅瞬时 toast。修复：① **A'** mpi-taskmode-ext 在 enforce=readonly 时注入固定双语 `ENFORCED_READONLY_CONTRACT` 块（准确拦截清单 + “若用户请求超出本模式能力，必须在第一条回复中明确告知『当前任务模式无法完成该请求』+ 给出切换选项，且不得尝试任何会被拦截的操作”），置于用户可编辑指令**之前**；放代码级而非默认指令文本——存量 config.json 已持久化旧指令（可编辑、normalizeTaskModes 不覆盖已有条目），只改默认值对存量线程无效。② **B1** applyTaskMode toast 扩充为完整约束清单 + “如需执行操作请先切换任务模式或权限”。③ **C** readonly 分支 4 类拦截消息（bash/write/edit/扩展工具）追加 stopAndReport 句（“请立即停止尝试同类操作，并在回复中第一时间告知用户当前模式无法完成该请求”）。回归：test-task-modes（契约注入、仅 enforce 也注入、置于指令前）、test-permission-gate（plain readonly 与 enforce 两条路径的拦截消息均含 stop-and-report 句）、e2e 新增 case **c5-review-conflict**（审查模式 + 事故原话；通过标准 = 首条输出即冲突报告 + 被拦尝试 ≤1 + 零文件变更——契约理想值是 0，但 q5 偶发先探测一次，而原始事故是 4 次静默尝试，≤1 仍可区分修复前后）。实测通过（q5：零被拦尝试，首条回复“当前任务模式无法完成该请求”+执行计划+备选方案；卡片拒绝后正确询问如何继续）。

9. **内置模式清单整合（2026-09）**：删除内置「默认 / 短任务 / 谨慎」三个模式，新增内置「均衡（balanced）= sandbox + low」并恒排第一，把自定义「迭代（iterate）= full + low + loop-dev 说明书」提升为内置并排第二（调研/审查保持第三、第四）。要点：① **旧 id 清理**——normalizeTaskModes 显式丢弃 legacy id（`default`/`short`/`cautious`/`long`），不再降级成可删自定义模式；内置按固定顺序 `[balanced, iterate, research, review]` 置顶、自定义随其后。② **调研/审查的 permission 钉为 readonly**（在 enforce 硬地板下原是死参数）——normalize 同时强制 `enforce:"readonly"` 与 `permission:"readonly"`；摘要逻辑对 enforce 模式不再重复显示 permission，消除「沙盒 · 强制只读」这类矛盾文案。③ **迭代说明书可移植**——内置 seed 用 `@agent/skills/loop-dev/SKILL.md` 令牌（而非硬编码绝对路径），`thread:setTaskMode` 在 main 侧用 `getAgentDir()` 解析为真实路径后落盘，sanitize 放行 `@agent/` 前缀；skill 未安装时该模式扩展优雅跳过。④ **默认模式对新会话生效**——新任务占位线程创建后调用 `applyTaskMode(默认模式)`（`resolveDefaultTaskMode` 在配置 id 失效时回退 balanced），使权限/思考/注入三者都真正应用；此前 defaultTaskModeId 仅影响 pill 显示。⑤ **重名修复**——管理弹窗的 nameTaken 改比 `taskModeName` 有效显示名（大小写/空白归一），自定义模式不再能与内置同名。回归：test-task-modes 覆盖 legacy 清理、canonical 排序、research/review 双钉、`@agent/` 令牌、resolveDefaultTaskMode 回退、摘要去重；`npm test` 34 passed / 3 skipped / 0 failed，typecheck + build ✅。追补（同日）：⑥ 内置指令**去环境依赖**——迭代文案不再硬编码 “mem0”，改为“记忆/知识库工具（若已配置，否则写项目内笔记）”，并加回归断言禁止内置指令出现特定工具名。由于内置指令会持久化到 config.json 且 normalize 默认不覆盖（保护用户编辑），新增 RETIRED_BUILTIN_INSTRUCTIONS：存储值精确等于旧默认文案时才自动刷新，用户改过的不动。⑦ 新增只读**详情弹窗** `TaskModeDetailModal`：从 ⚡ 下拉行尾和管理弹窗行尾的 ⓘ 均可打开，展示参数摘要 + 强制只读提示 + 完整行为指令 + 说明书路径，无需进编辑表单即可“打开查看”一个模式会注入什么。⑧ 内置模式**说明质量提升**：调研/审查指令删除与 `ENFORCED_READONLY_CONTRACT` 重复的「本模式强制只读」前缀（硬拦截与越权告知由契约+gate 保证，指令只留“怎么把活干好”）；调研改为「边界→多源验证→结论+证据 / 已核实·推测·未知 / 建议步骤 / 待拍板点」结构化输出；审查改为「对象+假设→严重度分级+证据要求→已检查/未覆盖清单+自查」；迭代补「每步含验收标准」「连续两次无进展即停下上报」「小任务走快速通道」；均衡保持无指令。旧文案经 RETIRED 精确匹配自动刷新。

---

## 1. 背景与问题

### 1.1 事故现象
在「调研模式 + 完全权限」下让 agent 处理语音模块部署任务，agent 没有先给出调研方案，直接执行了部署操作。

### 1.2 根因（已逐行核实）

| # | 缺口 | 证据 |
|---|------|------|
| R1 | **完全权限 = 零拦截**。gate 扩展的 `tool_call` handler 第一行即放行一切：`if (mode === "full") return undefined;`，bash/write/edit/子智能体全部无确认。 | `src/main/permission-gate-ext.ts`（tool_call handler 开头） |
| R2 | **调研模式的"不执行"是纯 prompt 软约束**。行为指令只是每轮注入系统提示词的一段文字（`mpi-taskmode-ext.ts` → `before_agent_start`），模型可违反；且用户请求本身是「部署语音模块」这类执行型任务，会被模型解读为命中例外条款"除非用户明确要求"。 | `src/main/mpi-taskmode-ext.ts`、`src/renderer/src/lib/task-modes.ts`（BUILTIN_RESEARCH_ID 指令文本） |
| R3 | **即使默认 sandbox 也挡不干净**：项目内文件写入、`npm run build/test/lint/dev`、项目内 `node script.js` 在 sandbox 下自动放行（scriptAllow / projectMutationDecision），大量"部署类"操作无摩擦通过。 | `permission-gate-ext.ts`（SAFE_PROJECT_NPM_TASK、projectScriptDecision） |
| R4 | **缺少工作流约束**：指令没有"先出方案 → 停下等批准 → 再执行"的强制流程，UI 也没有"是否执行该方案"的确认环节。 | — |

### 1.3 附带问题（用户反馈）
沙盒模式下 `mem0_memory`（来自全局 pi package `I:\MyWorkspace\Work\pi-mem0-local`）不在 gate 的 SAFE_TOOLS 白名单，**每个新会话第一次调用都要弹审批**；现有"本会话允许工具"选项只在本线程内存中生效，重启/换线程即失效。用户希望有跨会话持久的"信任某工具"机制。

---

## 2. 设计目标 / 非目标

**目标**
1. 任务模式可携带**硬执行属性** `enforce: "readonly"`：激活期间无论权限 pill 是什么（包括 full），写操作在 pi 进程内被强制拦截——调研/审查内置模式默认开启。
2. 调研工作流闭环：**先出方案 → 用户确认 → 才允许执行**（prompt + 现有 mpi_ask_choice 卡片实现，P1 增加 agent 请求切模式的工具）。
3. **工具信任列表** `trustedTools`：用户对某扩展工具点一次"始终允许"后跨会话、跨线程免审批；设置中可撤销。
4. 全部改动落在 MPI 现有桥接架构内（raw-string 扩展 + per-thread 状态文件 + config.json），不新增 IPC 通道，不改 pi core。

**非目标**
- 不做细粒度路径/命令级策略配置 UI（gate 分类器已覆盖）。
- 不改权限 pill 的四级语义本身；enforce 是叠加在模式上的独立维度。
- 不支持 enforce=write-only 等其他取值（预留字段，本期只实现 readonly）。

---

## 3. pi core 能力依据（为什么不用改底层）

已在本机安装的 **pi 0.85.1**（`I:\MyWorkspace\Software\nodejs\node_modules\@earendil-works\pi-coding-agent`）中核实：

| 能力 | API / 事件 | 用途 |
|---|---|---|
| 拦截任意工具调用 | `pi.on("tool_call")` 返回 `{ block: true, reason }`（docs/extensions.md "Tool Events"，可 mutate input、可 terminate） | enforce=readonly 的硬拦截；MPI permission-gate 已在用 |
| 按会话启停工具 | `pi.getActiveTools() / pi.setActiveTools(names)`，**对内置工具有效**（docs 原文示例即 "Switch to read-only"） | 调研模式下把 write/edit 从模型可见工具中移除，省 token、防试探 |
| 每轮注入上下文 | `before_agent_start` 返回 `{ systemPrompt }` / message | MPI taskmode 桥已在用 |
| 参照实现 | 官方示例 `examples/extensions/plan-mode/index.ts`：setActiveTools 禁用 edit/write + bash 只读白名单 + agent_end 询问"执行计划/继续规划" | 本设计 C2/D 的直接蓝本 |

**版本兼容**：若 app-managed runtime（userData/runtime）可能低于引入 `setActiveTools` 的版本，扩展内做 `typeof pi.setActiveTools === "function"` 特性检查降级——没有它时仅靠 gate 拦截（C1）已能完整强制只读。

---

## 4. 总体架构

```
┌─ renderer ────────────────────────────────┐      ┌─ main (Electron) ─────────────────────────┐
│ TaskModesModal / Composer pill            │      │ ipc.ts                                       │
│  applyTaskMode(threadId, modeId)          │ IPC  │  thread:setPermission → writeGateMode(.mode) │
│   ├ setPermission(live, mode.permission)  │─────▶│  thread:setTaskMode    → taskmodes/<uuid>.json│
│   ├ setThinking(...)                      │      │        { instructions, specFile, enforce }   │
│   └ thread.setTaskMode({…, enforce})      │      │  extui respond 拦截 → config.trustedTools   │
└───────────────────────────────────────────┘      └──────────────┬──────────────────────────────┘
                                                                  │ spawn env / 文件（均已有通道）
                    ┌─ pi 进程（每线程独立，warm spare 按线程 adopt）─▼──────────────────────────┐
                    │ permission-gate-ext.ts（tool_call）                                        │
                    │   1) 读 taskmodes/<uuid>.json.enforce（mtime 缓存）                          │
                    │      enforce=readonly → 走现有 readonly 分支，【优先于 full 早退】            │
                    │   2) config.trustedTools（复用现有 mtime 缓存读取）→ 扩展工具免审批           │
                    │ mpi-taskmode-ext.ts                                                        │
                    │   before_agent_start: 注入指令/说明书（现状不变）                             │
                    │      + enforce=readonly → pi.setActiveTools() 移除 write/edit；切换时恢复    │
                    └────────────────────────────────────────────────────────────────────────────┘
```

关键点：
- **单一事实源**：enforce 只存在于 `taskmodes/<uuid>.json`（现有文件加字段），main 侧零新增同步逻辑。
- **每线程独立 pi 进程** → setActiveTools / gate 状态互不串扰；warm spare adopt、switchSession 后下一轮 `before_agent_start` 自然对齐。
- enforce 与权限 pill **正交**：pill 决定"非 enforce 场景下的拦截强度"，enforce 是模式自带的地板（floor），只升不降。

---

## 5. 分文件改动明细

### F1 `src/renderer/src/lib/types.ts` — TaskModeDef
```ts
export interface TaskModeDef {
  id: string; name?: string; builtin?: boolean;
  permission?: PermissionLevel; thinking?: string;
  instructions?: string; specFile?: string;
  /** P0 新增：硬执行属性。"readonly" = 激活期间强制只读，优先于权限 pill（含 full）。 */
  enforce?: "readonly";
}
```

### F2 `src/renderer/src/lib/task-modes.ts`
- `builtinTaskModes()`：research、review 两个内置模式加 `enforce: "readonly"`。
- `sanitizeMode()`：`if (r.enforce === "readonly") mode.enforce = "readonly";`（其余值丢弃，防脏配置）。
- `taskModeSummary()`：有 enforce 时追加徽标文本「强制只读 / enforced read-only」，下拉行可见。
- **内置指令文本更新**（zh/en）——调研模式改为工作流式：
  > 当前处于调研模式（本模式强制只读，任何写操作都会被系统拦截）：先广泛收集信息（网络搜索、读文件、查文档），关键事实多源交叉验证；**完成后必须先输出完整调研方案（结论 + 来源标注「已核实/推测」+ 建议执行步骤），然后停下来等待用户确认；在用户明确批准之前，不要尝试任何部署、安装或写操作**。信息不足时如实说明，不要编造。
- review 模式指令同步补一句"本模式强制只读"（其默认权限本就是 readonly，enforce 只是防用户改 pill）。

### F3 `src/renderer/src/components/TaskModesModal.tsx`
- 列表行 summary 已含徽标（F2）；编辑表单底部 hint 增加说明：内置调研/审查模式带「强制只读」，权限级别仅影响非 enforce 行为。
- （P1 可选）自定义模式表单加"强制只读"复选框 → `enforce` 字段。

### F4 `src/main/ipc.ts` — `thread:setTaskMode`（约 L2653）
状态文件写入处增加字段透传：
```ts
const enforce = args?.enforce === "readonly" ? "readonly" : "";
writeFileSync(file, JSON.stringify({ instructions, specFile, ...(enforce ? { enforce } : {}) }), "utf8");
```
- 空内容删文件的现有逻辑不变（模式清除 → enforce 自动失效）。
- `thread:delete` 已清理 taskmodes/<uuid>.json，无需改动。
- **无新 IPC**：renderer `applyTaskMode`（store.ts L3294）在 setTaskMode 调用里多传一个 `enforce: mode.enforce || ""`；preload `index.d.ts`/`index.ts` 的 setTaskMode 参数类型同步加可选字段。

### F5 `src/main/permission-gate-ext.ts` — enforce 覆盖 + trustedTools（核心）
1. **读 taskmode 状态**：新增与 mpi-taskmode-ext 同款的读取逻辑——env `MPI_TASKMODE_DIR`（pi-bridge L386 已对所有桥设置，无需改 bridge）+ `ctx.sessionManager.getSessionFile()` 推 uuid → `<dir>/<uuid>.json`。按 mtime+size 缓存（复用现有 language() 的缓存手法），解析失败/无文件 = 无 enforce（fail-open 到普通 gate 逻辑）。
2. **enforce 优先于 full**：tool_call handler 开头改为：
   ```ts
   const mode = currentMode();
   const enforced = readEnforce(ctx);            // "readonly" | null
   if (mode === "full" && !enforced) return undefined;
   const effective = enforced ? "readonly" : mode; // enforce 只升不降
   ```
   后续所有分支用 `effective`。效果：调研+full 下，mutating bash / write / edit / 子智能体全部走**现有 readonly 拦截分支**（含中文阻止原因），SAFE_TOOLS（read/grep/web_search/mpi_ask_choice/mpi_todo_*…）照常放行——"出方案 + 问用户"流程不受影响。
3. **trustedTools**：扩展 config.json 缓存读取，返回 `{ lang, trusted: Set<string> }`；在扩展工具分支（SAFE_TOOLS/SUBAGENT 之后、requestApproval 之前）插入：
   ```ts
   if (effective !== "readonly" && trusted.has(toolName)) return undefined;
   ```
   - **语义**：sandbox/strict 下免审批；**readonly（含 enforce）仍拦截**——保持只读严格性，也避免把信任列表变成绕过调研模式的旁路。
   - **范围**：仅扩展工具生效；bash/write/edit 永远走各自分类逻辑，不可被信任列表放行（防误配）。
4. requestApproval 选项增加第 5 项（仅扩展工具、非 readonly 时）：`始终允许该工具（跨会话） / Always allow this tool (persistent)`。

### F6 `src/main/mpi-taskmode-ext.ts` — setActiveTools 隐藏写工具
- `before_agent_start` 中读到 `state.enforce === "readonly"` 且 `typeof pi.setActiveTools === "function"`：
  - 首次进入：记录 `toolsBefore = pi.getActiveTools()`，`pi.setActiveTools(toolsBefore.filter(t => t !== "write" && t !== "edit"))`。
  - 状态消失（切模式/清除）：恢复 `toolsBefore ∪ {write, edit}`（进程重启后无内存记录时按此并集兜底）。
- 每轮对账，天然覆盖 resume / warm spare adopt / switchSession。
- 注意：该扩展文件保持自包含（raw string 独立落盘），不 import gate 的代码。

### F7 `src/renderer/src/store.ts` — applyTaskMode UX
- 应用带 enforce 的模式且当前 pill 为 full/strict/sandbox 时，toast 提示："调研模式强制只读：权限设置暂不生效，切换出该模式后恢复"（zh/en）。
- （可选）pill 显示加锁角标表示被 enforce 覆盖。

### F8 `src/main/ipc.ts` — "始终允许"响应拦截（trustedTools 落盘）
- `onExtUi` 收到审批请求时，若为扩展工具审批（标题前缀匹配现有 `isSandboxApprovalRequest` + 解析出 toolName），记录 `pendingTrust[requestId] = toolName`。
- extui respond IPC（L2995 附近）：若响应 value === "始终允许该工具…" 且命中 pendingTrust → `updateConfig({ trustedTools: [...new Set([...prev, tool])] })`，toast 提示已加入信任列表；再照常转发给 pi 进程。
- gate 扩展下一轮 tool_call 即读到新 config（mtime 缓存失效），无需重启。

### F9 （P1）设置页管理 trustedTools
- Settings 增加"工具信任列表"小节：列出 `config.trustedTools`，可逐条删除；说明文案解释语义（sandbox/strict 免审批、只读模式仍拦截）。
- config.ts 的 Config 接口加 `trustedTools?: string[]`。

### F10 （P1）调研闭环工具 `mpi_request_mode_switch`
- choice-extension（或新小扩展）注册工具：agent 在方案输出后调用 `mpi_request_mode_switch({ to: "sandbox"|"full", reason })` → main 弹确认卡片（复用 extui select："agent 请求从调研模式切换到沙盒权限以执行方案，是否允许？"）→ 用户确认后 main 走现有 setPermission + setTaskMode(清除) 逻辑**实时切换**（writeGateMode + 状态文件删除，均已有）。
- 效果：用户在卡片上点一次"同意执行"，agent 即获得真实权限继续干活——完整闭环，且每一步都有硬拦截兜底。

---

## 6. trustedTools 设计要点（记忆权限问题专项）

| 项 | 决定 | 理由 |
|---|---|---|
| 触发入口 | 审批卡片第 5 选项"始终允许该工具" | 零学习成本，痛点现场一键解决；比先去设置页找列表更顺 |
| 存储 | `config.json → trustedTools: string[]`（全局） | gate 已按 mtime 缓存读 config.json，读取近乎免费；全局生效符合"记忆权限到处都要用"的诉求 |
| 作用域 | 仅扩展工具；sandbox/strict 免审批；readonly/enforce 仍拦截 | bash/write/edit 不可信任放行（安全底线）；只读严格性不被旁路 |
| 撤销 | 设置页列表删除；切到 full 再切回时现有 approvedTools 清空逻辑不受影响 | 可逆、可见 |
| mem0_memory 现状 | 加入信任列表后：search/add/update/delete 全部免审批（sandbox/strict） | 用户明确表达该工具"每次审批很麻烦"，视为其声明安全；若日后想区分 action（只信 search），可在 gate 里按 `event.input.action` 细化——本期不做 |

---

## 7. 边界情况与风险

| 场景 | 行为 |
|---|---|
| draft 线程（无 session 文件） | 推不出 uuid → 无 enforce、无注入（现状一致）；首次发消息后 session 建立，下一轮生效 |
| 应用重启 / resume | taskmode 扩展每轮 before_agent_start 对账 setActiveTools；gate 每次 tool_call 读状态文件——均自愈 |
| warm spare adopt / switchSession | 同上，按线程独立进程隔离 |
| 子智能体（run_subagent 等） | readonly 分支现有逻辑直接阻止（"内部操作无法逐项拦截"），enforce 继承该行为 |
| 渠道会话（飞书/微信） | enforce=readonly 下审批弹窗大幅减少；mpi_ask_choice 走现有 grace-period 自动取消流程，不变 |
| automation 无人值守 | 无 UI 时 requestApproval 本就返回 blocked（"无可用确认界面"），enforce 只进一步收紧，一致 |
| pi runtime 版本旧、无 setActiveTools | 特性检查降级：仅 gate 拦截（C1）仍完整强制只读；工具隐藏缺失只是多耗 token |
| enforce + full 的 UX 歧义 | F7 toast + 模式 summary 徽标双重提示"强制只读优先于权限设置" |
| 脏配置 | sanitizeMode 丢弃非法 enforce 值；状态文件 JSON 解析失败 = 无 enforce（fail-open 到普通 gate，不破坏 agent loop） |

---

## 8. 测试计划（手工清单）

1. 调研模式 + full：让 agent "部署 X" → write/edit 调用被拦截并显示中文原因；bash `npm run build`、`Set-Content` 等 mutating 命令被拦；read/grep/web_search/mpi_ask_choice 正常。
2. 调研模式下 agent 输出方案后调 mpi_ask_choice（P1：mpi_request_mode_switch）→ 用户点"执行" → 权限实时切换，agent 继续执行成功。
3. 切回默认模式 → write/edit 工具恢复可见、full 下行为与现状一致。
4. sandbox + mem0_memory：首次弹审批选"始终允许该工具" → 本会话后续免审；**重启应用/新线程**再调仍免审；设置页删除后恢复审批。
5. readonly（审查模式）+ trustedTools 含 mem0_memory → 仍被拦截（语义验证）。
6. resume：调研模式下重启 MPI，重开该线程 → 写工具仍隐藏、拦截仍在。
7. 渠道会话在 enforce=readonly 下跑任务 → 无审批卡死，grace-period 逻辑正常。

---

## 9. 分期与工作量

| 期 | 内容 | 文件 | 量级 |
|---|---|---|---|
| **P0（先堵洞）** | F1–F5、F7：enforce 数据链路 + gate 硬拦截 + 指令工作流化 + toast | types.ts / task-modes.ts / ipc.ts / preload / permission-gate-ext.ts / store.ts | ~半天 |
| **P1** | F6（setActiveTools）、F8+F9（trustedTools 全链路+设置页）、F3 复选框、F10（切模式工具） | mpi-taskmode-ext.ts / ipc.ts / choice-extension.ts / Settings UI / config.ts | ~1–2 天 |

**临时缓解（改码前）**：调研模式下不要用完全权限；或把内置调研模式的权限参数改为只读。注意这只是止血——用户再切回 full 即复发，且 sandbox 下仍有 R3 的放行面。

> 实现状态：P0+P1 已全部落地（见第 0 节备注），本文件保留作为设计依据与回归参考。
