# MPI 待优化问题 & pi-agent-desktop 改进建议清单

> 生成日期：2026-09-08 · 当前版本 v0.4.6
> 来源：① MPI 自身工作历史（记忆/上下文）；② [abcwyc/pi-agent-desktop](https://github.com/abcwyc/pi-agent-desktop/issues) issues #1–#60，重点取最近三周（2026-08-15 之后）。
> 状态说明：pi-agent-desktop 的 issue 分 open / closed（closed 多为已修，其修复方案可移植参考）。

## 优先级速览

| # | 建议 | 来源 | 价值 | 工作量 | MPI 相关性 |
|---|------|------|:---:|:---:|:---:|
| A1 | edit 工具结果增加 unified diff 视图 | p-a-d #52/#53 | ★★★ | 中 | 直接可用 |
| A2 | GFM autolink 吞 CJK 文本修复 | p-a-d #50/#51 | ★★★ | 小 | zh 用户必踩 |
| A3 | RPC 模式支持工厂型扩展小组件 | p-a-d #57 (PR) | ★★★ | 中大 | MPI 正是 RPC 客户端 |
| A4 | agent_end 状态回拉加会话一致性检查 | p-a-d #16 | ★★ | 中小 | 架构相同，需审计 |
| A5 | 新会话首条消息失败的恢复路径补全 | p-a-d #15 | ★★ | 小 | composer 同构风险 |
| A6 | 休眠唤醒后重连/健康探测治理 | p-a-d #11 (PR) | ★★ | 中 | thinkbook/minibox 会休眠 |
| A7 | 用户自定义样式表 custom.css | p-a-d #29 (PR) | ★★★ | 中小 | 魔改场景刚需 |
| B1 | Composer 草稿持久化（LRU） | MPI 自身 + p-a-d #19 | ★★ | 小 | 当前重启即丢输入 |
| B2 | 消息级代码撤销 | p-a-d #39 | ★★★ | 大 | 长期候选 |
| B3 | 常驻 token/缓存成本监控条 | p-a-d #45 | ★★ | 中 | ctx popover 可扩展 |
| B4 | 会话列表树形（文件夹一级/会话二级） | p-a-d #30 | ★★ | 中 | 视多项目使用频率 |
| B5 | 模型警告区分"未认证 provider" vs "pattern 拼错"+可关闭 | p-a-d #48/#49 | ★ | 小 | 检查现有提示文案 |
| B6 | 应用内"检查更新"（替代手动 Seafile 下载） | MPI 自身 | ★★ | 中 | 分发体验 |

---

## Part 1 · MPI 当前待优化项（来自我们自己的工作历史）

### P1-1 上游 pi 三个 bug：MPI 已客户端绕过，等上游修复后可移除 workaround
| 上游 issue | 问题 | MPI 现状 |
|---|---|---|
| [earendil-works/pi#8720](https://github.com/earendil-works/pi/issues/8720)（open） | whitespace-only tool result → provider HTTP 400，会话永久砖死 | session-repair Fix A：空白 content → `"(no output)"` + 一键修复横幅 |
| [earendil-works/pi#8667](https://github.com/earendil-works/pi/issues/8667)（open） | 过期 compaction 落在 tool call/result 对中间 → Anthropic 400 unexpected tool_use_id，永久砖死 | session-repair Fix B：删除对中间的过期 compaction + 子节点重挂 |
| [earendil-works/pi#9124](https://github.com/earendil-works/pi/issues/9124)（open） | runtime dispose 时悬挂 toolCall 残留在持久化历史 | 优雅停机（runDepth + stopGraceful）缓解；上游 PR #9126 open、#9179（压缩期间拒绝树导航）已合并 09-07 |

**行动**：每次升级 pi runtime 前查这三个 issue 状态；上游修复后评估移除对应 workaround。

### P1-2 Composer 草稿不持久化 ✅ 已完成（Unreleased）
~~未发送的输入文本只存在 zustand 内存里，应用重启/崩溃即丢~~ 已实现：草稿按线程 key（`s:<sessionFile>` / `n:<cwd>`）存入 store 并由主进程落盘 `<userData>/drafts.json`；LRU 保留最近 40 份（更新先 delete 再 set，p-a-d #19 语义），单条 >2MB 时丢 base64 图片再落盘；发送/排队后续/清空即删；换文件夹时草稿跟随迁移（目标已有草稿则两者都留）。测试：`npm run test:drafts`。

### P1-3 dev/prod 配置目录分离导致设置"看起来丢了" ✅ 已完成（Unreleased）
~~dev（`%APPDATA%\MPI Dev`）与 prod（`%APPDATA%\MPI`）各自独立 config.json，新 profile 首次启动落默认值（英文/light），即"重装后中文变英文"的成因~~ 已实现：profile 自己没有 config.json（或损坏）时从兄弟 profile 继承 `language` + `theme`（只继承这两项，pins/threads/自动化任务等保持各自独立）。测试：`npm run test:config`。注：prod 覆盖安装不复现此问题（config.json 一直在），仅 dev↔prod 切换时触发。

### P1-4 无应用内更新机制
目前升级靠手动从 Seafile/GitLab 下载安装包。可在设置页加"检查更新"（对比远端 manifest 版本号 + 下载链接），参考 p-a-d 的签名更新体系（#1/#3）但可先做轻量版（只提示+跳转，不做静默安装）。

### P1-5 仅 Windows 构建
无 Linux/macOS。用户三设备均为 Windows，优先级低；若未来要出 Linux 包，注意 p-a-d #40（WebKitGTK 剪贴板图片粘贴）与 #21/#10（flatpak/deb）的经验。

### P1-6 mem0 生态待办（相邻项目，非 MPI 本体）
- thinkbook16p / minibox 需同步 pi-mem0-local 更新代码并 `/reload`（09-05 workstation server 重启后遗留）
- autoCapture 全对话抽取仍走慢 LLM 路径（服务端已加 16000 字符截断护栏；远端设备可考虑关闭或调大 MEM0_TIMEOUT_MS）

### P1-7 会话跨项目拖拽移动（待办，用户拍板「后面考虑做」2026-09-08）
现状：置顶区排序/区内拖拽已支持（v0.4.18 Unreleased），但会话只能在本项目内移动。设计要点（实现时参考）：① 交互 = 把会话拖到另一个项目的行上 → 确认框（提示「移入后该会话的新消息将在目标文件夹执行」）→ 主进程原子完成；正在 streaming 的会话禁止移动。② 数据层 = 改写 .jsonl 首行 header 的 `cwd` + 把文件挪到 `~/.pi/agent/sessions/<目标项目目录名>/`（MPI 按 header cwd 分组，pi 终端侧列表会跟着变，行为一致）。③ 引用同步 = `pinnedThreads[]`、`archivedThreads[].file`、`threadPermissions` key、drafts.json 的 `s:<sessionFile>` key；若该会话正开着需先关闭再按新路径重开。风险：动的是数据文件，建议实现时加备份/回滚（写临时文件+rename）。

### P1-8 会话回收站 + 会话行常驻星形置顶切换（用户拍板 2026-09-08，v0.4.19）
背景：侧栏会话只有「归档/删除」两个按钮，且删除=直接 unlink JSONL，容易误删。用户要求引入回收站机制——**只有在回收站里删除才算永久删除**。拍板决策：① 置顶按钮做成**常驻星形切换**（行上始终可见，点亮=已置顶）；② 回收站 v1 **手动清空**（不做 N 天自动清理，留作后续）；③ 回收站**默认开启**（设置可关，关闭后删除恢复为立即永久删）；④ UI 文案「永久删除会话」统一改为「删除」（弹窗正文按开关分支：开=移入回收站说明，关=不可恢复警告）。
实现要点：`src/main/trash-store.ts`——文件 move 到 `<userData>/trash/<uuid>.jsonl`（rename 失败 EXDEV 时 copy+unlink 兜底），index.json 记录 `{id, originalFile, title, cwd, deletedAt, sizeBytes}`；IPC `thread:delete` 参数扩为 `{file,title?,cwd?}`，按 `config.trashEnabled` 分流（开=移入回收站返回 `trashed:true`，关=原 unlink 路径），新增 `trash:list/restore/purge/empty`（list 顺带清理文件已不存在的索引条目；restore 目标已存在时报错、父目录缺失则重建）；设置「归档与回收站」页新增回收站卡片（恢复/永久删除/清空+总占用，危险操作带确认弹窗）+ 通用设置开关行。i18n exact/prefixes 同步。测试 `npm run test:trash`。

---

## Part 2 · pi-agent-desktop 近期有价值改进建议（按相关性分组）

### A 组：高价值，建议排期

#### A1 · edit 工具结果增加 unified（单栏）diff 视图 ✅ 已完成（Unreleased）— [#52](https://github.com/abcwyc/pi-agent-desktop/issues/52) / PR #53
~~edit 结果难以看出改动位置~~ 已实现：`lib/diff.ts` LCS 行级 diff（>2M 单元格回退分块），`Chat.tsx` UnifiedDiffView 单栏渲染（上下文 + `-`/`+` 着色 + 新旧双行号，git 风格）；设置侧栏「Diff 显示」开关（unified/blocks，默认 unified）。注：MPI 原实现是上下堆叠两个全文块而非左右双栏，痛点主要是大改动里找差异难。测试 `npm run test:diff`。

#### A2 · GFM autolink 吞 CJK 文本 ✅ 已完成（Unreleased）— [#50](https://github.com/abcwyc/pi-agent-desktop/issues/50) / PR #51
~~URL 后紧跟中文时 remark-gfm autolink literal 把后续非 ASCII 字符吞进 `<a>`~~ **已验证复现**（`读https://example.com，然后来解决一下` → url 含 CJK）。已移植 `lib/remark-autolink-trim.ts`（PR #51+#54 类型版）：仅处理 autolink literal（link 唯一子节点 text === url），首个非 ASCII 字符起拆回普通文本；显式 `[文本](url)` 与百分号编码 URL 不受影响。接入 `markdown.tsx` REMARK_PLUGINS（gfm 之后）。测试 `npm run test:markdown`（含无插件时 bug 存在的 sanity 断言，防上游修复后插件失效无感知）。

#### A3 · RPC 模式支持工厂型扩展小组件 — [#57](https://github.com/abcwyc/pi-agent-desktop/pull/57)（open PR）
- **问题**：pi 的 `ExtensionUIContext.setWidget()` 可传字符串数组或组件工厂；RPC 桥接只处理字符串数组，**直接忽略工厂**。导致如 `@juicesharp/rpiv-todo` 这类扩展的工具/命令能注册、但实时待办面板不显示。
- **方案**（PR 已写好）：为 RPC 会话保存工厂组件及位置 → 用无头 TUI + 纯文本主题渲染 → 经现有 `setWidget` 事件发给 UI；处理 `tui.requestRender()` 主动刷新；替换/重载/销毁时释放。
- **MPI 现状**：**MPI 就是 RPC 模式客户端且已有 ext-ui 通道**（mem0 卡片就是这么走的）。移植后扩展生态兼容性显著提升，是"魔改 MPI"差异化能力。工作量中大，但 PR 代码可直接参考。

#### A4 · agent_end 状态回拉加会话一致性检查 — [#16](https://github.com/abcwyc/pi-agent-desktop/issues/16)（已修）
- **问题**：`agent_end` 后异步 fetch 会话状态直接写入 UI，无"当前活动会话是否还是发起时那个"的检查 → 快速切换会话时旧状态覆盖新会话 UI。
- **MPI 现状**：我们的事件流是 main push → `handleEvent` → store reducer，架构不同但同类风险存在（如 compaction_end / message_end 在切线程瞬间到达）。**行动**：审计 store.ts 各 case 是否校验 threadId 与 activeThreadId；不匹配则丢弃或路由到对应 ThreadState。

#### A5 · 新会话首条消息失败的恢复路径 ✅ 已完成（Unreleased）— [#15](https://github.com/abcwyc/pi-agent-desktop/issues/15)（已修）
~~乐观气泡 + 立即清空输入框后，失败恢复逻辑只对"连接错误"生效；其他失败 → 气泡永久残留、无错误提示、输入文本丢失~~ 审计发现 MPI 四个缺口：① `/compact` 与正常发送在 ensureConnected 失败时输入已清但文本丢失（气泡回滚已有）；② prompt/steer/followUp RPC 抛错时乐观气泡永久残留成幽灵消息 + 输入丢失，且流式中误置 `isStreaming=false`；③ 成功后 refreshProjects() 异常被 catch 误报为"发送失败"。已补全：store.ts sendPrompt 增加 restoreDraft（按 draftKeyFor 恢复文本/图片/附件回草稿）、RPC 失败回滚气泡 + 恢复输入、steer/followUp 失败不动进行中任务状态、refreshProjects 独立 try。

#### A6 · 休眠唤醒后的重连治理 — [#11](https://github.com/abcwyc/pi-agent-desktop/pull/11)（已合并 PR）
- **问题**：睡眠恢复后多个健康探测事件重叠，过期失败探测把"离线横幅"卡住；Reconnect 按钮只重复同一 HTTP 请求，修不了失效的 SSE/WebView 连接。
- **方案要点**：取消被取代的探测（superseded probe cancel）→ 服务可达时刷新 WebView 重建 HTTP/SSE → 不可达时走 IPC 重启本地 server。
- **MPI 现状**：pi bridge 是本地子进程，休眠影响较小；但 **remote signaling（WebRTC/WSS）在 thinkbook/minibox 休眠唤醒后是否自愈未验证**。值得按此思路加 wake 事件监听 + 探测去重。

#### A7 · 用户自定义样式表 custom.css — [#29](https://github.com/abcwyc/pi-agent-desktop/pull/29)（已合并 PR）
- **方案**：`~/.pi/agent/desktop/custom.css`，设置页"Open custom.css"按钮首次使用生成带注释模板；样式表在 globals 之后 link，同优先级用户规则胜出；no-store 缓存策略。
- **MPI 现状**：对魔改场景价值很高——调字体/配色/间距不用重新打包。**建议做**（Electron 版实现更简单：main 读文件 → preload 暴露内容或直接用 `<link>` file://）。
- **注**：v0.4.12 开发中已完整实现过（commit `dc16fc6`，含模板/watch 热更新/测试），用户确认对当前样式满意、改动都是小修后 revert。需要时从历史恢复即可，勿重复开发。

### B 组：中价值，按需排期

#### B1 · Composer 草稿持久化 — 见 P1-2（与 p-a-d #19 的 LRU 修复方案合并考虑）
#### B2 · 消息级代码撤销 — [#39](https://github.com/abcwyc/pi-agent-desktop/issues/39)（open，无正文细节）
按 turn/消息粒度回滚 agent 的文件改动。大功能（需要文件快照或 git stash 机制），列为长期候选；若做，git worktree/stash 方案比逐文件备份可靠。
#### B3 · 常驻 token/缓存成本监控条 — [#45](https://github.com/abcwyc/pi-agent-desktop/issues/45)（open）
输入框下方固定栏：input/output/cacheRead/cacheWrite 四项 + 命中率 sparkline，数据只读 assistant 消息 `usage` 字段（provider 真实计数）。我们的 ctx popover 已有 session stats，可扩展为逐轮成本视图。
#### B4 · 会话列表树形展示 — [#30](https://github.com/abcwyc/pi-agent-desktop/issues/30)（open）
文件夹一级、会话二级的树结构，替代"下拉选文件夹→再看会话"的两步切换。取决于你多项目并用的频率；单项目为主则价值低。
#### B5 · 模型警告文案区分 + 可关闭 — [#48](https://github.com/abcwyc/pi-agent-desktop/issues/48) / PR #49（已修）
未认证 provider 的模型被误报为 "No models match pattern"，用户按提示查拼写白费功夫。检查 MPI 模型选择处的同类警告文案，区分"无凭据"与"pattern 不存在"，并允许关闭 banner。
#### B6 · 应用内检查更新 — 见 P1-4

### C 组：低相关 / 仅记录（暂不建议做）

| # | 事项 | 来源 | 不做的理由 |
|---|------|------|-----------|
| C1 | 阿拉伯语 + RTL locale | [#59](https://github.com/abcwyc/pi-agent-desktop/issues/59)/PR #60（open） | MPI 仅 en/zh，无需求；i18n 基建可参考其 registry 设计 |
| C2 | pi-web bind address / allowed hosts / password 可配置 | [#47](https://github.com/abcwyc/pi-agent-desktop/issues/47)（open） | MPI 不捆绑 pi-web，无对应面 |
| C3 | WSL 原生支持 | [#44](https://github.com/abcwyc/pi-agent-desktop/issues/44)（open） | Windows 场景为主，优先级低 |
| C4 | Linux 剪贴板图片粘贴 bug | [#40](https://github.com/abcwyc/pi-agent-desktop/issues/40)（open） | WebKitGTK 特有；出 Linux 包时再处理 |
| C5 | jiti entry 文件被 Next file tracer 丢弃 | PR #58（open） | 对方是 Next standalone 打包机制；MPI 走 npm tarball 捆绑不同。但**提醒**：捆绑 pi runtime 时惰性 require 的模块完整性要验证（esbuild 裁剪已证明此类坑存在） |
| C6 | 废弃内置 node、用用户系统 node | [#32](https://github.com/abcwyc/pi-agent-desktop/issues/32)（closed） | NODE_MODULE_VERSION 不匹配问题真实，但 MPI 捆绑 runtime+node 的隔离性是有意设计；记录为架构权衡参考 |
| C7 | 多选项面板溢出不可滚动 | [#37](https://github.com/abcwyc/pi-agent-desktop/issues/37)（closed） | 顺手审计 MPI 的下拉/多选组件即可，不单独立项 |

### 附：MPI 已有等价能力（对方 issue 无需跟进）
- p-a-d #38「手动 compact 后刷新上下文用量」→ 我们 v0.4.3 已修（压缩后 usage 显示 0 的问题）
- p-a-d #34「模型选择器旁 context-usage ring + session stats」→ 我们的 ctx popover（大数字+%+进度条+四档变色，v0.4.5/0.4.6）

---

## 建议的下一步（供你拍板）
1. ~~**先做 A2**（GFM CJK autolink）~~ ✅ 已完成（见上）。
2. **A3（RPC 工厂型小组件）**：差异化价值最高，建议排期；可先装 `@juicesharp/rpiv-todo` 在 MPI 里实测现状确认缺口。
3. ~~**A1（unified diff）**~~ ✅ 已完成；**A7（custom.css）**：体验类改进，半天到一天（已实现过又 revert，见 A7 注）。
4. **A4/A5**：审计型工作，一次过 store.ts + composer 发送路径，产出风险清单。→ A5 ✅ 已完成（四个缺口已补全，见上）；剩 A4（threadId 一致性审计）。
5. B 组按使用痛点再挑；C 组不动。
