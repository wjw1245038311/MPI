# MPI 优化 Backlog（待办合并清单）

> 合并日期：2026-09-17 · 基线版本 v0.6.17（dev == main，已同步）
> 用途：把散在各文档里的「待优化」项合并成一份编号队列。处理时按编号挑条目，做完把状态改 ✅ 并注日期 + commit。
> 来源文档（详细设计要点在那里，本文件只留可执行摘要）：
> `.tmp-workdocs/improvement-suggestions.md` · `docs/REMOTE-PANEL-POLISH.md` · `docs/MOBILE-REMAINING-TODO.md` · `BRAIN-PLAN.md` · `.tmp-workdocs/SUBAGENT-PLAN.md` · `docs/HANDOFF-2026-09-16.md`
>
> **状态图例**：⬜ 未开始 · 🟡 进行中 · ✅ 已完成（注日期+commit） · ⏸ 搁置（用户拍板「后面再说」） · ❓ 待用户拍板/配合

## 0. 已完成基线（勿重复开发）

| 项 | 状态 / 位置 |
|---|---|
| P1-2 Composer 草稿持久化 | ✅ `ae862c2`，drafts.json + LRU40，test:drafts |
| P1-3 dev/prod 配置继承（language/theme） | ✅ `2a33009`，test:config |
| P1-4 应用内更新检查 | ✅ electron-updater → github.com/wjw1245038311/MPI Releases；「帮助→关于 MPI」手动触发 |
| P1-8 会话回收站 + 常驻星形置顶 | ✅ trash-store.ts（trash:list/restore/purge/empty）+ pinned-order，test:trash / test:pinnedorder |
| P1-11 contextWindow 自动探测 | ✅ model-context.ts（内置目录查表 → API 探测 → 128K 兜底），test:model-context |
| P1-12 模型 auto 模式（质量档+延迟切换） | ✅ model-autopilot.ts，test:model-autopilot |
| A1 unified diff 视图 | ✅ lib/diff.ts + UnifiedDiffView，设置「Diff 显示」开关，test:diff |
| A2 GFM autolink 吞 CJK | ✅ lib/remark-autolink-trim.ts（p-a-d #51/#54），test:markdown |
| A5 发送失败恢复（草稿回滚+幽灵气泡） | ✅ `bd1a3ad`，store.sendPrompt restoreDraft/delivered 重构 |
| D2 消息反馈 👍/👎 + 备注 | ✅ feedback-store.ts sidecar，永不进模型上下文，test:feedback |
| D1 @提及 → **拖拽会话引用**（替代方案） | ✅ v0.6.17 #1；@提及曾实现、用户实测否决后回退。教训：编码 agent 场景拖拽比输入触发直接 |
| 远程面板 S1 卡片图标头 | ✅ v0.6.16 #1（icons.tsx 新增 QrCode/Cloud） |
| A7 custom.css | ❌ **已实现又 revert**（`dc16fc6`→`b74b24b`），用户对当前样式满意、勿重复开发；需要时从历史恢复 |

---

## 一、桌面主功能（中大工作量）

### 01 · A3 RPC 工厂型扩展小组件 ⬜ 中大
- **现状**：pi `ExtensionUIContext.setWidget()` 支持组件工厂，RPC 桥只处理字符串数组、直接忽略工厂 → `@juicesharp/rpiv-todo` 这类扩展能注册工具/命令但实时待办面板不显示。MPI 正是 RPC 客户端且已有 ext-ui 通道（mem0 卡片走的就是它）。
- **方案**：为 RPC 会话保存工厂组件+位置 → 无头 TUI + 纯文本主题渲染 → 经现有 setWidget 事件发 UI；处理 `tui.requestRender()` 主动刷新；替换/重载/销毁时释放。p-a-d PR#57（open）代码可直接参考。
- **验收**：MPI 里装 rpiv-todo，实时待办面板显示并随工具调用更新。
- 来源：improvement-suggestions.md Part2-A3

### 02 · D3 Trajectory 轨迹视图 ⬜ 大成本（v1 可轻量）
- dsh `conversation.view` slot ring + Gantt Overview（TTFT/decode 分段、拖选过滤、滚轮缩放）。MPI 与 dsh 差距最大的一项。
- **v1 轻量**：聊天头「轨迹」tab，每步耗时 + token 明细表（usage 数据已有）；Gantt 二期。
- 来源：improvement-suggestions.md Part3-D3

### 03 · B2 消息级代码撤销 ⬜ 大 / 长期候选
- 按 turn/消息粒度回滚 agent 的文件改动。git worktree/stash 方案比逐文件备份可靠。p-a-d #39（open，无正文细节）。

### 04 · P1-7 会话跨项目拖拽移动 ⏸ 用户拍板「后面考虑做」（2026-09-08）
- **交互**：会话拖到另一项目的行上 → 确认框（提示新消息将在目标文件夹执行）→ 主进程原子完成；streaming 中的会话禁止移动。
- **数据层**：改写 .jsonl 首行 header `cwd` + 文件挪到 `~/.pi/agent/sessions/<目标项目目录>/`；引用同步 pinnedThreads / archivedThreads[].file / threadPermissions key / drafts.json `s:<sessionFile>` key；正开着的会话先关再按新路径重开。
- **风险**：动数据文件，实现时加备份/回滚（写临时文件 + rename）。
- 来源：improvement-suggestions.md Part1-P1-7

### 05 · P1-9 MCP 市场卡片一键安装 ⏸ 待办（2026-09-08）
- mcpmarket.cn **无公开安装配置 API** → 从条目 GitHub 仓库拉取：优先 `.mcp.json` / `mcp-server.json`，其次解析 README 的 npx/docker 命令块；能可靠推断 stdio command+args 或 remote url 才显示「一键安装」，否则降级手动指引（复制 JSON）。
- 写入走现有 mcp.json 管理同源逻辑（新增 upsert 入口），重名提示覆盖/改名；需要 env 的条目弹表单，不静默写空。

### 06 · B4 会话列表树形展示 ⬜ 中（价值取决于多项目使用频率）
- 文件夹一级 / 会话二级，替代「下拉选文件夹 → 再看会话」两步切换。p-a-d #30。单项目为主则价值低。

### 07 · B3 常驻 token/缓存成本监控条 ⬜ 中
- 输入框下方固定栏：input/output/cacheRead/cacheWrite + 命中率 sparkline；数据只读 assistant 消息 `usage`（provider 真实计数）。ctx popover 已有 session stats，可扩展为逐轮成本视图。p-a-d #45。

---

## 二、小项快赢（每项 ≤ 半天）

### 08 · D4 composer 权限 chip ⬜ 中小
- 当前会话权限做成 composer chip + popover picker；「decoration is not a second command」——裸 `/permission` 开选择器，选中提交真实命令行（单一事实源）；选 Full access 需显式风险确认。现在四档权限主要靠 ⚡ pill/设置，可发现性偏弱。

### 09 · D5 composer block 模式 ⬜ 中小
- 模型不可用时输入区 inert + 说明文案，恢复免 reload；「null（加载中/失败过）永不阻塞」——慢 host 不锁死可用 composer。现在断连 = 发送时 toast + A5 草稿恢复，前置 block 体验更顺。

### 10 · P1-10 手机远程控制入口图标 ⬜ ~10min
- 导航栏左下角小手机图标（打开 RemotePanel）优化时被移除；Sidebar `onOpenRemote`/`remoteOpen` props 已保留、App.tsx 接线未动，加回一个 iconbtn（Smartphone）即可。可考虑放设置页或标题栏而非原位置。

### 11 · B5 模型警告文案区分 + 可关闭 ⬜ 小
- 「未认证 provider」与「pattern 拼错」分开提示（现在误报 "No models match pattern"），banner 允许关闭。检查 MPI 模型选择处的同类文案。p-a-d #48/#49。

### 12 · D6 「(推荐)」label 后缀解析成徽章 ⬜ 半天
- mpi_ask_choice 已有「（推荐）」约定，现在是纯文本混在 label 里；从 suffix 渲染 pill（dsh 做法）。lib/choice.ts choiceOptions() 是归一化入口。

### 13 · D6 更新跳过版本 + 定时检查 ⬜ 中小
- 启动 + 每 6h、同意才下载、「跳过此版本」不影响后续、支持降级；dsh update-view.ts（128 行状态机）可参考。与现有 electron-updater 手动「检查最新版本」互补。

### 14 · D6 Windows close-to-tray ⬜ 小
- 关窗不退出，agent 后台继续跑。（托盘基建已有：开机自启动/图标缓存修复都动过 tray。）

### 15 · D6 PWA todo-dock ⬜ 中小
- 手机页 composer 上方实时待办 dock（✓/转圈）；MPI PWA 看长任务时没有对应显示。

### 16 · D6 微动效一批 ⬜ 小
- 运行中工具行扫光、turn-status shimmer、滚动条 thumb hover 才显形。

---

## 三、远程面板 & 手机端

### 17 · REMOTE-PANEL S2–S6（工单已写好）⬜ 全套约 1h
- **工单**：`docs/REMOTE-PANEL-POLISH.md`（每步含代码片段+验收）。S1 图标头已完成，剩：
  - **S2 层级重排**（~20min）：状态摘要卡 / 手机 App / 配对手机置顶；信令 + 云中继收进 `.set-adv-toggle` 高级折叠；hint 压到一行内。
  - **S3 二维码统一 + 配对卡重排**（~25min）：统一 `makeQr` 160px、`.set-qr-grid`；配对卡左右分栏（码 | 倒计时+按钮+details 链接）；票据 mm:ss 倒计时 + 重新生成/取消。
  - **S4 表单与按钮统一**（~15min）：删 inline `marginTop`，「信令地址+保存并重连」并一行 `.set-inline-row`。
  - **S5 空态/加载态**（~15min）：二维码骨架屏防跳动；无设备空态图标+提示。
  - **S6 细节动效**（可选 ~15min）：connecting 圆点呼吸、二维码淡入、卡片头 hover。
- **约束**：只改样式与 JSX，不碰 `remote:*` IPC/协议/加密；不在 `.set-card` 内放 `position: fixed`；纯 renderer Ctrl+R 即见；每步后 `npm run typecheck`。

### 18 · P2 GitHub 中继清单上传 ⬜ ~10min（纯网络，需代理）
- `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:10808 node scripts/publish-android.mjs --github` → 把 `android/publish/mpi-android.json` 重传中继 `/download/`。必须标 pre-release（脚本已内置，否则桌面更新器 404）。
- **验收**：curl -I 直链 200 且 sha256 与本地一致；GitHub `/releases/latest` 仍指向桌面版。

### 19 · P5-1 PWA 设置开关 ⬜ 中小
- 主题/字号/语言开关（PWA 目前 zh-only，只有跟随系统明暗）。

### 20 · P5-5 已配对设备在线状态 / 最后活跃 ⬜ 小（重命名需拍板）
- RemotePanel「已配对手机」现在只有列表+移除；不加新 IPC 补在线状态/最后活跃；**重命名功能需用户拍板**。

### 21 · P4 真机验证项 ❓ 需用户配合
- 扫码解码（模拟器虚拟摄像头绿屏，只验到相机拉起）；自更新真实升级（链路已用假版本验证过）；保活/通知——壳内不做推送已拍板，无 GMS 国行机的国内通道（飞书机器人/Server酱）**未实现、属设计变更需拍板**。

### 22 · 归档视图（翻压缩前历史）❓ 用户尚未拍板
- 手机端从 session 文件读压缩点之前的内容、标注「已压缩历史」、按分支正确重建。桌面端同样没有「加载更早」。大成本，先定要不要做。

---

## 四、大脑系统 BRAIN-PLAN（方案 2026-09-16 定稿，未实施）

> 总纲见 `BRAIN-PLAN.md`：文件为真相源（.alexandria/knowledge/ 四级阶梯+lessons）、alexandria 检索层（9/17 试点通过，zvec-grep 降为 fallback）、mem0 降为临时缓存。依赖：S4/S5 不阻塞 S3；S6 等 subagent 基建最顺。

### 23 · S1 mem0 自启动 + 看门狗 ⬜ ≤半天
- **验收**：重启工作站后 :8000 自动可用；kill uvicorn 后 5min 内自愈；MPI 离线提示可见。背景：9/16 实锤 server 无人值守停摆、大脑离线无人知晓。

### 24 · S2 .alexandria/knowledge/ 四级阶梯+lessons 建设 + 一次性迁移 ⬜ 半天→1天
- 试点已有 3 篇示例文档（Architecture.md / domains/FeishuMessaging.md / lessons/DevRestartAfterMainPreloadChange.md，lint+contract 全绿）。剩余：modules/ 补 main 子系统（建议先 pi-bridge/messaging/permission-gate）+ mem0 ~7 条持久教训提炼入 lessons/（一错一文，Symptom→Root Cause→Fix→Guard 结构，[extracted]/[inferred] 标记由引擎机械验证）。验收：lint+contract 全绿。mem0 project scope 20 条：~7 git/changelog 重复 → delete；~5 任务状态快照 → 并入 HANDOFF 或 delete；~7 持久教训 → 提炼入 lessons/。**删记忆前逐条给用户确认**。

### 25 · S3 alexandria 安装实测 ✅ 9/17 完成（原计划 zvec-grep）
- 试点通过：exe v0.1.3 可用；scan 269 files→2089 symbols/17517 edges @1.5s，locate file:line 与源码逐一核对一致、调用图正确；3 篇示例文档 lint 0 errors/warnings + contract 233 units 100% accepted、[extracted] claims 全部对活代码 verified；真实问题检索命中（飞书链路/权限 gate），越界问题诚实返回 Boundaries。剩余：exe 永久位置拍板 + skill 装进 ~/.pi/agent/skills/。已知缺口：abstract class 未索引（全仓库仅 1 个）。

### 26 · S4 context-loader skill 升级 ⬜ 1天
- §2 读取顺序 + Evidence Packet 契约；新会话首轮自动注入①–②；知识/代码问题走 alexandria query/locate/graph（Evidence Packet 是引擎原生输出）；过期条目标 ⚠️（fail-closed）。

### 27 · S5 dream 物化扩展 ⬜ 1天
- `/mem0-dream` 产出 .alexandria/knowledge/ 工作区 diff（按 alexandria 格式）+ compile+contract 当验收门禁 + mem0 prune 清单，不自动 commit。

### 28 · S6 Reflection critic 子代理（可选）❓ critic 模型待拍板（本机 qwen27B vs .220）
- 大任务收尾用便宜模型跑自检再交付；捕获程序性遗漏（漏 typecheck/手册未同步/测试没跑）。复用 SUBAGENT-PLAN subagent 基建。1–2天。

---

## 五、工程 / 运维

### 29 · L1 全量测试间歇 flake 排查 ⬜ 中小
- `app-store` ×2、`pwa-thread` ×1，单跑必过（疑资源竞争/时序）；削弱「全绿」信号。建议单独一轮排查。

### 30 · thinkbook16p「输入框间歇性置灰」❓ 等复现 + mpi-diag.log
- 静态分析已证明 PWA 侧 textarea 无 disabled 路径；需真机日志定位（取证：`%APPDATA%\MPI Dev\logs\mpi-diag.log`）。

### 31 · 安全项 ⬜ 小（一次性）
- 轮换 ECS root 密码 / 关 PasswordAuthentication；复核 `~/.gitconfig` 的 insteadOf。

### 32 · vllm-tts 恢复 ⏸ 等显存空出
- 网关会自动优先它，当前走 Edge TTS fallback。无需动作，观察即可。

### 33 · SUBAGENT-PLAN 双机并行 subagent 扩展安装 ⬜ ~15min、MPI 源码零改动
- pi 官方 subagent 示例装到 `~/.pi/agent/extensions/`（用户级全局扩展），所有 MPI 会话自动加载；子进程 argv[1] 解析已核实无坑。双机并发机制 9/09 实测成立（墙钟 42s ≈ max(两边)）。详见 `.tmp-workdocs/SUBAGENT-PLAN.md`。

### 35 · S1 知识库应用封装：设置行 + KB 浏览面板 + 「添加到知识库」⬜ ~1天
- 用户已拍板 S1 档位（9/17）。设置→通用加「知识库」行（knowledgeBaseDir，默认 <repo>/.alexandria/knowledge/，可指向外部 Obsidian vault）+「用 Obsidian 打开」按钮（obsidian:// URI）；KB 浏览面板复用现有 MD 预览/file tree 基建；消息右键菜单加「添加到知识库」（仿 MessageQuoteMenu「添加为待办」addTodo 模式，按 lesson 格式写入 lessons/）。S2（反向链接图/应用内搜索）不做——交给 Obsidian。

### 34 · 安装包瘦身：纯 renderer 依赖移 devDependencies ⏸ 用户拍板「等 MPI 完全成型后开做」（2026-09-17）
- v0.6.19 +34MB 排查发现机制性重复打包：electron-builder 自动把生产依赖的原始 node_modules 打进 app.asar，而 Vite 早已 bundle 进 out/renderer。mermaid 已单点修复（commit 07b1f7a，下个版本回 ~158MB）。剩余候选：react/react-dom、xlsx、pdfjs-dist、mammoth、jszip、highlight.js、react-markdown/remark/rehype 全家、zustand——估计再省 50–100MB。开工前需逐个确认 main/preload 无运行时 require（ws/node-pty/electron-updater/@larksuiteoapi 必须留 dependencies）。验收：npm run dist 后 exe ≤~158MB + 全量功能回归过。

---

## 待用户拍板汇总

| # | 决策点 |
|---|--------|
| 22 | 归档视图做不做 |
| 28 | S6 critic 模型：本机 qwen27B vs .220 |
| 20 | P5-5 设备重命名要不要（在线状态/最后活跃不需要拍板） |
| 21 | 无 GMS 国行机推送通道选型（飞书机器人 / Server酱 / 不做） |

## 建议执行顺序（供参考，非承诺）

1. **17** —— 工单现成、约 1h 见效、纯 renderer 低风险
2. **01** —— 差异化价值最高，独立排一个迭代
3. **23 + 24** —— 大脑地基：先止血（看门狗）再建知识库
4. 小项打包：**08/09**（composer 交互）+ **10/11/12**（顺手修）一次清掉
5. **26 → 27** 大脑继续推进（25 已完成）；**35** S1 封装可与 24 并行；**33** 随时可插队（15min）
6. 长期候选：**02 / 03 / 04 / 05 / 06 / 07** 按使用痛点再挑
