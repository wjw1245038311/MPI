# BRAIN-PLAN — MPI / pi agent 的"大脑"设计（2026-09-16）

状态：**L2 引擎已切换 alexandria（试点 2026-09-17 通过），KB 建设中**。本文档是跨会话迭代拍板用的单一事实源；每完成一项把对应条目从「待办」移到「已完成」并注日期。

## 0. 背景与问题

pi agent 在 MPI 项目深入开发中表现出明显的"失忆感"（重复劳动的来源）：

- 每次新会话重新解释项目状态、重新发现历史决策；
- 模块职责/数据流/依赖关系每次重新 grep+read 推导（飞书链路、remoteBackend 边界、权限 gate 链等反复出现）;
- mem0 语义记忆已部署但**对人不可见**（黑盒）、无过期机制、与 git 内容重复漂移；
- 2026-09-16 实锤：mem0 server (:8000) 无人值守停摆，大脑离线无人知晓。

输入材料（两篇知乎文章）：

| 文章 | 作者 | 价值 |
|------|------|------|
| 《AI Agent中6种常用的设计模式》 zhuanlan.zhihu.com/p/2026610927135389386 | 苏三说技术 | 模式分类学（ReAct/ToolUse/Reflection/Planning/MultiAgent/HITL）；架构图里的 Memory 模块=大脑。Java/Spring 视角，代码不可搬 |
| 《我给Pi装上了一颗大脑——Pi-Brain》 zhuanlan.zhihu.com/p/2060675192968442171 | 大米88 | **正是给 pi agent 做的**项目级知识系统；三层架构+硬原则（见 §2）。**已开源 = luser-dami/DamiAgentInfra → alexandria/ 模块（2026-09-17 核实，见 §3）**——原则与引擎都取 |

对照六模式，MPI/pi 现状：ReAct/ToolUse/HITL（权限四档+mpi_ask_choice）已原生具备；Planning≈loop-dev 闭环；Multi-Agent≈SUBAGENT-PLAN subagent 扩展（待实施）；**Reflection 缺失**（无自动 critic）。大脑侧缺口见 §5。

## 1. 核心原则（从 Pi-Brain 提炼，全部采纳）

1. **文件为真相源，索引是编译产物。** Markdown/文档 = 源码；mem0、zvec-grep 索引都是可丢弃的编译缓存，坏了重建无损失。人随时可用编辑器/git log 审计整个大脑。
2. **事实与推断分开记录。** 每条知识带 `[事实@commit]` / `[推断]（依据：…）` 标记 + 证据（文件#行号/commit）。agent 不得把二者同等置信。
3. **边界完整性。** 条目要写"不回答什么"，防局部结论被过度泛化。
4. **fail-closed。** 宁少召回，不把残缺/过期知识包装成高可信答案；证据不足时显式 `fallback_to_source`（去读源码），而不是硬答。
5. **一项目一颗大脑。** KB 随仓库走 git（天然跨设备同步）；不做全局跨项目库防同名符号串库。mem0 保持 per-machine 缓存定位。
6. **不替代源码。** 大脑是"资深同事给的导航图"：先查 Brain → 缩小范围 → 打开关键源码确认。改变默认路径，不禁用源码读取。

## 2. 三层架构（最终形态）

```
┌─ L1 人审永久层（.alexandria/knowledge/，git 同步 = 跨设备真相源）──────┐
│ 四级阶梯 + 经验层（AUTHORING.md 契约；引擎 lint/contract 机械强制）： │
│   Architecture.md    L0 项目入口视图：技术栈/模块地图/核心数据流      │
│   domains/           L1 跨模块端到端流程（如 FeishuMessaging）        │
│   modules/           L2 单一代码单元职责/边界                        │
│   features/          L3 可独立检索的原子关键项                       │
│   lessons/           经验层：一个错误→一条教训（applies-when/guard-strength）│
├─ L2 检索层（alexandria 引擎，现成；索引是编译产物，gitignored）──────┤
│ .alexandria/index/alexandria.db  代码符号/调用图 + 知识单元          │
│   scan（词法扫描，支持 TS）/ compile（[extracted] claim 对活代码验证  │
│   + Chunk Contract 门禁 accepted/degraded/quarantined）              │
│   query → Evidence Packet：BM25+符号+图+向量多路融合、               │
│   answerability 自评 + recommended action（proceed/fallback_to_source）│
├─ L3 易逝语义记忆（已有 mem0，降级定位）──────────────────────┤
│ mem0 server :8000    只存"还没到写文件程度"的临时事实          │
│   + KB/源码的模糊召回兜底；dream 负责物化晋升到 L1            │
└──────────────────────────────────────────────────────────────┘
状态层不新建文件：最新 docs/HANDOFF-*.md（ls -t）+ changelog.md Unreleased 节
+ todo 面板 = 当前在飞状态（复用现有工件，零新机制）。
```

### L1 条目格式约定（= alexandria AUTHORING.md 契约）

原「扁平三件套」格式作废，改用 alexandria 四级阶梯 + lessons（9/17 试点通过）。核心规则（细节以引擎仓库 `AUTHORING.md` 为准）：

- **标题关键词定语义**：章节标题必须含关键词子串（`## Data Flow` / `## Key Claims` / `## Boundaries` / `## Evidence`；lesson 用 Symptom→Root Cause→Fix→Guard），否则静默降级为无语义的 section。
- **事实/推断分离由引擎机械强制**：claim 节 bullet 带 `[extracted]`（可机器验证）/ `[inferred]`（语义判断）；compile 时 extracted claim 对活代码验证，标 verified/drifted——9/16 原则「agent 不得把二者同等置信」现在由引擎执行。
- **证据绑定**：`## Evidence` 节严格格式 `` - `symbol` defined at `path` ``；符号在代码中解析不到 → unit degraded（fail-closed）。
- **边界完整性**：module/feature 文档必须有 `## Boundaries`（"不回答什么"）；lesson 用 frontmatter `excludes:` 当边界。
- **粒度=文件**：一条教训一个文件、一个模块一个文件——原「150 行尺寸预算」被分层结构天然替代；文档过大时拆 features/（可独立检索）或 inline ###（不可独立检索）。
- 语言：中文为主（BM25/向量对中文均可用；**标题关键词必须英文**才能触发 kind 分类）。

ADR-lite 决策记录不设独立 tier——写进对应 module/domain 文档的 `## Key Claims` bullet，够重要的单独成 feature 文档。

### context-loader 确定性读取顺序（升级后）

```
① 最新 docs/HANDOFF-*.md（一句话状态+环境表）        ← 已有工件
② changelog.md Unreleased 节                          ← 已有工件
③ alexandria query "<问题>" --scope unit   （教训优先："以前踩过这个坑吗"）← L1+L2，一次往返出 Evidence Packet
④ alexandria locate/refs/graph（符号级问题：定义在哪/谁引用/影响面）← L2 代码层，按需
⑤ mem0 语义检索                                        ← L3 模糊兜底，最后才用
```

输出契约按 Evidence Packet 思路升级：注入时标注来源与日期；**过期条目标 ⚠️"用前对源码验证"**；证据不足明说去读源码（fallback_to_source），不硬灌。

## 3. L2 检索层选型结论（调研于 2026-09-16）

| 候选 | 结论 |
|------|------|
| **alexandria** luser-dami/DamiAgentInfra/alexandria | ✅ **采用（2026-09-17 试点通过）**。= 文章 Pi-Brain 本体开源版。Rust 单二进制（Releases 有 Windows x64 预编译 exe，无需工具链）；compiler-free 词法扫描支持 TS；知识文档 → Knowledge Units + claim 对活代码验证 + Chunk Contract 门禁；query → Evidence Packet（BM25+符号+图+向量 RRF 融合、answerability 自评）。**试点证据**：269 files→2089 symbols/17517 edges @1.5s；locate file:line 与源码逐一核对一致；调用图正确；lint 0 errors/warnings；contract 233 units 100% accepted、[extracted] claims 全部 verified；真实问题检索命中（飞书链路/权限 gate）；越界问题诚实返回 Boundaries。已知缺口：`export abstract class` 未索引（全仓库仅 1 个）、项目年轻 v0.1.3 |
| **zvec-grep (zg)** zvec-ai/zvec-grep ⭐3546 | ⏸️ 降为 fallback。9/16 调研结论仍有效（Apache 2.0 / 活跃 / Node≥22 / Windows ✓ / 本地 embedding）；若 alexandria 长期用出问题可随时切回（索引是编译产物，切换零成本） |
| 大米88 Pi-Brain 原版 | ✅ **已开源** = 上表 alexandria（9/16「仓库未找到」被推翻：文章后记写明已开源，GitHub luser-dami/DamiAgentInfra）。原则与引擎都取 |
| context-mode (mksglu) | ⏸️ 暂缓。pi adapter 已知 bug：issue #426 注册 0 工具但路由块引用不存在工具，可靠性存疑 |
| Whamp/pi-brain、misabegovic/pi-brain、gitsense/pi-brains | ℹ️ 方向验证：独立项目收敛到同一哲学（git 版本化记忆 / 永久层+易逝层分离+晋升），佐证本设计方向正确；暂不引入，避免多套机制 |

安装命令（待执行）：

```bash
# alexandria v0.1.3 预编译 exe（当前在 /tmp/alexandria-pilot/，永久位置待拍板）
alexandria --project-root <repo> init      # scaffold .alexandria/{alexandria.toml, knowledge/}
alexandria --project-root <repo> scan      # 代码索引（增量；代码变更后重跑）
alexandria --project-root <repo> compile   # 知识编译（文档变更后重跑）+ Chunk Contract 门禁
# agent skill：DamiAgentInfra/alexandria/skills/alexandria/SKILL.md → ~/.pi/agent/skills/
# .gitignore：加 .alexandria/index/（db 是编译产物）；alexandria.toml + knowledge/ 进 git
```

## 4. L3 mem0 层改造

1. **可靠性 A1（最优先）**：Windows 计划任务——登录时拉起 `python -m uvicorn mem0_server:app --host 127.0.0.1 --port 8000`（工作目录 E:\MyWorkspace\Work\mem0-data）+ 每 5 分钟 `/health` 探测失败自愈。多设备只需 workstation 一台自启（其余走 tailnet）。附加：MPI 启动探测 /health，离线时 UI 角落灰点提示。
2. **过期纪律**：条目带日期；context-loader 注入超期未确认条目标 ⚠️；dream 把超期项移入 archive（L1）或 delete。
3. **定位收窄**：只存临时事实 + 模糊召回兜底；值得长期记的一律落 L1 文件。

## 5. dream 物化机制（扩展 pi-mem0-local 的 dream skill）

现有 dream = consolidate/prune mem0 内部条目。升级为"物化"流水线：

```
consolidate（去重/合并矛盾，已有）
→ materialize：稳定条目按格式写入 docs/knowledge/ 工作区改动（不自动 commit）
→ 尺寸预算执行：超 150 行拆分 / 过期移 archive.md
→ prune：已物化或过期的 mem0 条目 delete
→ 产出 git diff 待用户审核（HITL：大脑的每次"成长"留痕在 git log，错了可 revert）
```

触发：手动 `/mem0-dream`；自动条件沿用现有配置（minHours/minSessions/minMemories）。

## 6. 一次性迁移计划（基于 2026-09-16 get_all dump，project scope 20 条）

| 分类 | 数量 | 处置 |
|------|------|------|
| git/changelog 重复（发版记录、Unreleased 条目等，commit hash/SHA256 都在 git） | ~7 | mem0 delete |
| 任务状态快照（做完即过期：手机端交接完成、PWA S4 完成…） | ~5 | 仍有效的并入最新 HANDOFF；过期的 delete |
| 持久教训/坑（雷电模拟器抢2222、S8部署×4、异步写串行化、WIP卷入…） | ~7 | 提炼入 pitfalls.md（带日期+证据），mem0 对应条目 delete |

执行约束：**删记忆前逐条给用户确认**；迁移后大脑 = git 仓库 + 干净临时缓存。

## 7. 实施路线与验收标准

| # | 步骤 | 工作量 | 验收标准 |
|---|------|--------|----------|
| S1 | mem0 自启动+看门狗（A1） | ≤半天 | 重启工作站后 :8000 自动可用；kill uvicorn 后 5min 内自愈；MPI 离线提示可见 |
| S2 | 建 .alexandria/knowledge/（四级阶梯+lessons）+ 一次性迁移 | 半天→1天 | 试点已有 3 篇示例文档（Architecture / FeishuMessaging domain / dev-restart lesson，全绿）；剩余 = modules/ 补 main 子系统 + mem0 ~7 条持久教训提炼入 lessons/；lint+contract 全绿；mem0 project scope ≤10 条且全部为临时事实；git diff 经用户审核 commit |
| S3 | alexandria 安装实测（原计划 zvec-grep） | ✅ **2026-09-17 完成** | 试点通过，证据见 §3。剩余：exe 永久位置拍板 + skill 装进 ~/.pi/agent/skills/ |
| S4 | context-loader skill 升级（§2 读取顺序+Evidence Packet 契约） | 1天 | 新会话首轮自动注入①-②；知识/代码问题走 alexandria query（Evidence Packet 是引擎原生输出）；过期条目标 ⚠️ |
| S5 | dream 物化扩展 | 1天 | `/mem0-dream` 产出 .alexandria/knowledge/ 工作区 diff（按 alexandria 格式）+ compile+contract 当验收门禁 + mem0 prune 清单，不自动 commit |
| S6（可选） | Reflection critic 子代理：大任务收尾用便宜模型（本地 qwen3.8-27B / .220）跑自检再交付；复用 SUBAGENT-PLAN subagent 基建 | 1-2天 | loop-dev 收尾多一步 critic 报告；程序性遗漏（漏 typecheck/手册未同步/测试没跑）能被捕获 |

依赖：S4/S5 不阻塞 S3；S6 等 SUBAGENT-PLAN 扩展落地后最顺。

## 8. 明确不做

- ❌ 自建索引编译层 / Knowledge Unit 契约机器（alexandria 现成提供，仍不自建）
- ❌ 安装 zvec-grep（降为 fallback，暂不装；若 alexandria 出问题再启用）
- ❌ mem0 存代码内容（它只存决策/事实/临时状态）
- ❌ 全局跨项目知识库（一项目一颗大脑）
- ❌ context-mode（可靠性未证实前不引入）
- ❌ 第二套记忆系统或自建 vector store

## 9. 已拍板 / 待拍板

**已拍板（2026-09-16）**：文件为真相源；状态层复用 HANDOFF/changelog/todo 不建 state.md；中文为主；跨设备走 git（mem0 保持 per-machine，B3 隔离问题不再需要处理）。

**已拍板（2026-09-17）**：L2 引擎 = alexandria（试点通过）；KB 位置/格式 = `.alexandria/knowledge/` 四级阶梯+lessons（原 docs/knowledge/ 扁平三件套作废）；Obsidian 同步拓扑 A——KB 在仓库内、git 为唯一同步通道、Obsidian 只当本地编辑器；MPI 应用封装档位 S1——设置「知识库」行 + KB 浏览面板（复用 MD 预览基建）+ 消息右键「添加到知识库」（S2 反向链接图/应用内搜索不做，交给 Obsidian）。

**待拍板**：S6 critic 模型选本机 qwen27B 还是 .220；alexandria exe 永久位置（建议 E:\MyWorkspace\Software\alexandria\ 并加 PATH）；modules/ 首批覆盖哪些模块（建议先 main/renderer/pi-bridge 三大块）。

## 10. 已完成

- 2026-09-16：mem0 server :8000 停摆发现并手动拉起（`uvicorn mem0_server:app --host 127.0.0.1 --port 8000`，工作目录 E:\MyWorkspace\Work\mem0-data；后端 LLM :1234 / embedding :1235 正常）
- 2026-09-16：两篇文章消化 + zvec-grep/context-mode/Pi-Brain 生态调研完成（§3）
- 2026-09-17：alexandria 试点通过，L2 由 zvec-grep 切换为 alexandria（证据见 §3）；MPI 仓库已 scaffold `.alexandria/` + scan（2089 symbols/17517 edges）+ 3 篇示例知识文档 compile 全绿（lint 0/0、contract 233 units 100% accepted、[extracted] claims 全部 verified）；Pi-Brain 开源位置确认 = luser-dami/DamiAgentInfra
