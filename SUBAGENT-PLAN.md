# MPI 添加 Subagent（双机并行）实施方案

> 目标：在一个 MPI 会话内，把独立子任务并行派给两台 LM Studio 机器同时执行。
> 实测基础（2026-09-09）：两个 `pi -p` 进程分别钉 `new-provider/qwen3.8-27b@q5_k_m`（本机）与
> `lm-studio-34-220/qwen3.8-27b@q5_k_m`（10.215.34.220）同时跑，墙钟 42s ≈ max(两边)，串行需 ~52s+。
> 双机并发机制已验证成立，本方案只是把它包成会话内工具。

## 结论：MPI 源码零改动

关键架构事实（已核实 `src/main/pi-bridge.ts`）：
- MPI 每个线程 = **pi 子进程**（`spawn(node, [cli, --mode rpc, ...])`），不是 in-process SDK；
- pi CLI 用 DefaultResourceLoader，**自动发现 `~/.pi/agent/extensions/` 下的全局扩展**
  （pi-bridge.ts:22 注释："pi extensions keep working inside the desktop app exactly as in the terminal"）；
- MPI 显式传的 `extensions: [gate-ext]`（ipc.ts:316 / automation.ts:214，经 `--extension` 参数）是**叠加**不是替换。

因此：把 pi 官方 subagent 示例装到用户级扩展目录即可被所有 MPI 会话加载。
且子进程内 `process.argv[1]` = pi cli.js（存在），示例自带的 `getPiInvocation()` 会正确解析出
`node <cli> --mode json -p ...`——**无需打补丁**（之前担心的 Electron argv[1] 问题不存在，因为扩展跑在 pi 子进程里）。

## 实施步骤（约 15 分钟）

### 1. 安装 subagent 扩展（复制，勿用符号链接）
```bat
mkdir "%USERPROFILE%\.pi\agent\extensions\subagent"
copy "C:\Users\Administrator\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\examples\extensions\subagent\index.ts" "%USERPROFILE%\.pi\agent\extensions\subagent\"
copy "C:\Users\Administrator\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\examples\extensions\subagent\agents.ts"  "%USERPROFILE%\.pi\agent\extensions\subagent\"
```

### 2. 创建双机 agent 定义（`~/.pi/agent/agents/`，用户级，TUI/GUI 通用）

**worker-a.md**（本机）：
```markdown
---
name: worker-a
description: 本机 LM Studio Qwen3.8-27B Q5_K_M 并行工作者（可读写代码、跑命令）
model: new-provider/qwen3.8-27b@q5_k_m
---
你是 MPI 项目的并行工作子代理，运行在本机 LM Studio。独立完成分配的任务；涉及代码修改时直接落盘，最终用简洁中文输出结果摘要并列出改动文件。
```

**worker-b.md**（10.215.34.220）：同上，仅改两处——
`description: 第二台机 LM Studio (10.215.34.220) Qwen3.8-27B Q5_K_M 并行工作者…`、
`model: lm-studio-34-220/qwen3.8-27b@q5_k_m`。

注意：`model:` 用 **provider/id** 格式（pi `--model` 支持），这是同名模型 ID 精确钉机器的关键。
provider key（`new-provider` / `lm-studio-34-220`）来自 `~/.pi/agent/models.json`，改名需同步改这两个文件。

### 3. 完整重启 MPI → 新会话里直接可用

## 用法示例（会话内自然语言即可）
```
并行执行：worker-a 给 session-store.ts 写单元测试，worker-b 整理 changelog Unreleased 条目
用 worker-b review 一下 pinned-order.ts
链式：先 scout 找草稿持久化相关代码，再 worker-a 实现 X
```
工具名 `subagent`；模式 single / parallel（≤8 任务、4 并发）/ chain。每个子代理 = 独立 pi 进程 + 隔离上下文（`--no-session`），cwd=项目目录，可自行读文件——**任务描述要自包含**。

## 验证计划
1. **单发**：「用 subagent 让 worker-a 只回复 A-OK」→ 结果含 A-OK；本机 `~/.lmstudio/server-logs/2026-09/*.log` 出现对应请求。
2. **双机并行（核心）**：「并行：worker-a 写 60 字描述大海，worker-b 写 60 字描述高山」→
   - 墙钟 ≈ max(单任务) 而非 sum（参考基线：单跑 ~26-45s）；
   - 最严谨：对比两台机 server-logs 里两条请求的时间戳重叠。
3. **故障隔离**：停掉 .220 的 LM Studio 再并行 → B 任务返回 stderr 诊断，A 正常完成，主会话不崩。

## 已知限制 / 风险（v1 接受）
| 项 | 说明 |
|---|---|
| **无权限门** | 子进程不带 gate-ext、无 MPI_GATE_MODE_FILE 消费方 → 子代理在 cwd 有完整工具权限。本机自用可接受；要收紧就在 frontmatter 加 `tools: read, grep, find, ls`（只读） |
| GUI 展示 | onUpdate 流式进度是 TUI widget，GUI 里只见工具卡片的参数+最终结果（每任务输出上限 50KB）。TUI 模式体验完整 |
| 主模型等待 | 子任务执行期间主 agent 在等工具返回——加速的是「可拆独立块」的任务，串行依赖不受益 |
| 上下文隔离 | 每次调用全新会话；跨任务的共享信息要写进任务描述或让 worker 自己读文件/代码 |
| 版本漂移 | 示例绑定当前 pi 版本的扩展 API；`pi update` 后若工具报错，重新从新版 examples 复制覆盖即可 |

## Fallback（仅当第 3 步后 GUI 会话里看不到 subagent 工具）
说明 RPC 模式未走默认发现 → 在 `src/main/ipc.ts:316` 与 `src/main/automation.ts:214` 的 extensions 数组追加
`join(homedir(), ".pi", "agent", "extensions", "subagent", "index.ts")`（两行改动，照 gate-ext 传参方式）。

## 后续待办（非本次）
- [ ] 子进程透传权限门：spawn 时加 `--extension <gate-ext>` + 继承 MPI_GATE_MODE_FILE（需改示例的 spawn 参数或 fork 一份到仓库 resources）
- [ ] provider key 语义化改名（`new-provider` → `lmstudio-a`），同步 agent 定义与本文档
- [ ] GUI 侧栏展示并行子任务实时进度（消费 onUpdate / tool_update 事件）
