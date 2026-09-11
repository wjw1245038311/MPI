# MPI 全仓综合 Review —— v0.5.1（2026-09-09）

> 范围：src/main、src/preload、src/renderer、scripts、package.json。
> 基线：typecheck + 12 项测试（drafts/config/markdown/diff/compactions/toolargs/permission/pinnedorder/trash/searchtrash/usage/html-reference）+ electron-vite build，修复前后全绿。
> 方法：import 引用图扫描（找死文件）、preload API vs renderer 调用交叉核对（找死 IPC）、tsc --noUnusedLocals 临时开启（找死变量/导入）、逐模块通读 main 全部 30+ 文件与 renderer 核心组件。

## 一、已直接修复的小问题（11 项，净删 ~194 行）

| # | 位置 | 问题 | 处理 |
|---|------|------|------|
| 1 | `ChangelogModal.tsx` | **跨平台隐患**：import `@repo-root/CHANGELOG.md?raw`，实际文件是 `changelog.md`（git 里小写）。Windows NTFS 大小写不敏感所以一直能跑，Linux/macOS 或 CI 上构建必挂 | 改为小写导入 |
| 2 | `package.json` | 未使用依赖 `clsx`、`skills`（全仓无任何 import；skills 占 node_modules ~4MB） | 移除 + npm install 同步 lockfile（-123 行），安装包体积略减 |
| 3 | `ipc.ts` + `preload/index.ts` | **死 IPC ×3**：`app:unpinProject`（renderer 的 store.unpinProject 实际走 setProjectPinned(cwd,false)）、`thread:getModels`（模型列表随 gatherThread 返回，刷新走 thread:refreshModels）、`thread:getCommands`（命令列表随 open/loadHistory 返回） | main handler + preload 入口全删；renderer 侧 store action `unpinProject` 保留（它调的是 setProjectPinned） |
| 4 | `index.ts` / `preload` / `TitleBar.tsx` | **死链**：window:maximized-changed 事件 → preload onMaximizedChanged/isMaximized → TitleBar `max` state，state 只写不读（最大化按钮本来就是 toggle 语义） | 三层全删 |
| 5 | `fs-service.ts` | 未使用导入 `readFileSync`；死函数 `fileExists`、`baseName`（IPC handler 自己内联实现了 statSync） | 删除 |
| 6 | `plugins.ts` | 死导出 `addPackage`（无调用方）；`runPiCli` 的 `onLine` 参数无任何调用方传入 | 删除 |
| 7 | `runtime-package.ts` | 未使用导入 `dirname` | 删除 |
| 8 | `remote/service.ts` | 未使用类型导入 `RemoteUiRequest` | 删除 |
| 9 | `ipc.ts` filePreviewService.tree | `target` 变量声明后从未读取（但 assertRemotePath 的**校验副作用必须保留**，否则路径逃逸不报错） | 改为无赋值调用 + 注释说明 |
| 10 | `App.tsx` | 订阅了 `sidebarOpen` 却从不使用——每次折叠/展开导航栏都会触发整个 App 树（含 Chat/Preview）多余重渲染 | 删除订阅，顺带修掉这个隐性性能问题 |
| 11 | `Composer.tsx` | 未使用的图标导入 Paperclip / ImageIcon / Smile | 删除 |

修复后复扫：`tsc --noEmit --noUnusedLocals`（node + renderer 两个工程）**零告警**；typecheck、12 项测试、build 全过。

## 二、无法直接拍板的问题（待你审查）

### A. 「分支(Fork)」和「克隆(Clone)」行为完全相同 —— 建议对齐 pi 官方语义
- Chat 每条 Agent 回复下方有两个按钮：`分支` / `克隆`，分别走 `thread:fork` / `thread:clone`。
- main 侧两个 handler **100% 同构**（都调 `bridge.branchAt(entryId)`），store action 也只有 toast 文案不同。
- **根因**：`branchAt` 发的是自定义扩展命令 `/mpi-branch-at <entryId>`（permission-gate-ext.ts:933，内部 `ctx.fork(entryId, {position:"at"})`），pi RPC 原生的 `fork`/`clone` 命令完全没用上。
- **pi 官方语义**（https://pi.dev/docs/latest/usage + /rpc）：
  - `/fork` = 从之前某条消息分叉出新会话；RPC `{"type":"fork","entryId":...}`，响应带 `text`（被分叉消息原文），TUI 里会放回输入框供编辑重发
  - `/clone` = 把当前活跃分支整体复制成新会话文件（当前位置、不选点）；RPC `{"type":"clone"}` 无参数
- **佐证原始意图**：store fork action 有 `res.selectedText → pendingEditorText → Composer 预填输入框` 管道，但 main 从不填 selectedText（死代码）——正是为原生 fork 的 text 响应设计的。
- ✅ **已实施（用户拍板「完整对齐」）**：
  1. **分支**：按钮移到每条**用户消息**的悬停操作条；走原生 RPC `fork`（position "before"），响应 text → selectedText → Composer 预填输入框（接通了原死管道）
  2. **克隆**：改为整段会话复制（`bridge.send("clone")`，pi 运行时内部 = fork(leafId, {position:"at"})）；入口移到侧栏会话行右键菜单「克隆会话」
  3. 移除 `/mpi-branch-at` 扩展命令、`bridge.branchAt`、synchronizedCommands 里的过滤特判；store `forkThreadFromAgentReply`→`forkThread`，`cloneThread(id)` 去掉 entryId
  - ⚠️ 技术细节：原生 RPC fork 默认 position="before" **只接受用户消息 entryId**（传 agent 回复 id 会抛 Invalid entry ID），所以分支按钮必须挂在用户消息上；旧「从某条回复分叉」的能力由「点下一条提问的分支」或「克隆」覆盖

### B. 应用自更新整条链路是死代码（~300 行 + 1 个依赖 + UI 区块）
- `app-updater.ts` 里 `APP_UPDATE_DISABLED = true` 硬编码（个人项目，避免上游发布覆盖本地修改），于是 electron-updater 集成、`electron-updater` 依赖、IPC ×3（check/download/installAppUpdate）、preload 入口、Settings「MPI 应用更新」整块 UI 全部空转。
- **附带风险**：package.json `build.publish` 仍指向上游项目的 GitHub releases——将来若有人跑 `electron-builder --publish always`，会把 MPI 发布到别人的仓库（当前 dist 流程不带 publish，暂无实际影响）。
- 选项：① 保持现状（想保留"以后接自己的更新源再启用"的余地）；② 彻底移除 app-updater.ts + 依赖 + IPC + UI 区块 + publish 配置，Settings 只留版本号展示；③ 换成指向自己发布源的轻量版本检查。

### C. i18n DOM 桥接设计：能用但脆弱
- `lib/i18n.ts` 用 MutationObserver 翻译**已渲染的文本节点**（exact 字典 → prefixes → regex 三层），靠 PROTECTED_TEXT_SELECTOR 长列表保护用户/Agent 内容不被误翻。
- 维护成本：每新增一类动态文案要手工加 regex；新组件若含用户内容要记得加进保护选择器，漏了就会把会话内容当 UI 翻译。
- 选项：① 维持现状（当前覆盖完整、有测试路径）；② 长期迁移到 t() 函数式 i18n（大重构，所有组件文案要过一遍，建议单独立项）。

### D. thread:prompt / steer / followUp 三个几乎相同的 IPC handler
- 各 7 行，仅 bridge.prompt/steer/followUp 不同。可合并为一个带 action 参数的 handler。纯观感问题、价值低，**倾向不动**。

### E. tsconfig 关闭了 noUnusedLocals/noUnusedParameters —— 死代码就是这么攒出来的
- 本次临时开启扫出 9 处（已全部清理）。建议正式开启：现在开是零告警通过的，以后新增死代码会在 typecheck 阶段直接暴露。
- 风险：几乎没有（strict 已开，只是多两个检查项）。

### F. .gitignore 残留 android/* 条目
- 仓库里没有 android/ 目录（Android companion 是独立项目），这些 ignore 规则是从上游项目带过来的。可删可留，无实际影响。

## 三、审查过但确认没问题的点（供参考）

- **AppConfig 双副本**（main/config.ts + renderer/lib/types.ts）：逐字段比对为子集关系、无漂移；renderer 侧只含 UI 需要的字段且部分可选。已知维护约定（加字段要两边同步），暂不需改。
- **permission-gate-ext.ts**（949 行安全门）：fail-closed 规则设计严谨，本次未动任何安全逻辑。
- **warm spare bridge / TUI generation token / stopGraceful(runDepth)**：竞态处理都有注释和测试覆盖，设计合理。
- **remote/* 模块**：路径逃逸校验（assertRemotePath + realpath）、敏感文件过滤、事件脱敏（remoteSafeEventValue）齐全；仅清理了 1 个未使用类型导入。
- **scripts/ 下三个"无 package.json 入口"的脚本**（test-pty-electron.cjs / test-tui-resume.mjs / test-tui-spawn.mjs）：头部注释标明是 dev 诊断工具，有意保留，不算死代码。
- **cloudflare-signaling/**、**signaling/**、**protocol/remote-v1.schema.json**：远程 companion 的配套部署件与协议 schema（test:remote-protocol 引用），均在用。
- **imageassets/**（~3MB 截图）：README 引用中，保留。

## 四、验证记录

```
npm run typecheck                                  # PASS
tsc --noUnusedLocals（node + renderer 临时开启）    # 0 告警（修复前 9 处）
npm run test:drafts|config|markdown|diff|compactions|toolargs|permission|pinnedorder|trash|searchtrash|usage|html-reference   # 12/12 PASS
npm run build                                      # PASS
```

> 未打包发版：按惯例等你在设备上验证后再 dist。本次改动全部是死代码移除 + 一个跨平台导入修正，行为零变化（唯一可感知差异：折叠导航栏时 App 少一次全树重渲染）。
