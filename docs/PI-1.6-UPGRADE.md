# Pi 1.6.0 升级记录（2026-11-25）

> 结论先行：**内置运行时从 `1.5.0` 升到 `1.6.0` 并已重打归档**（`MPI-Runtime-1.6.0-win-x64.tar.gz`，46.3 MiB）。
> 三条风险链路——本地模型的系统提示、RPC 会话生命周期、记忆池捕获——**实测无回归**；
> `session_start` 双触发的修复在真机复现（9 次 → 5 次），但对 MPI 无功能影响。
> 仍需在应用里过一遍的是：长会话压缩、MCP 工具入参、真实交互 TUI。
> 上一份同类记录：`docs/PI-1.5-UPGRADE.md`（1.3 → 1.5，含自动采纳内置运行时的机制）。

## 1. 版本事实

| 项 | 值 |
|---|---|
| 升级前内置 | `1.5.0`（`package.json` → `piRuntimeVersion`） |
| 升级后内置 | `1.6.0`（2026-11-20 发布） |
| 中间版本 | `1.5.1`（11-09）、`1.5.2`（11-10）—— 本次一并接收 |
| 运行时技能包 | `@earendil-works/pi-coding-agent@1.6.0` + `pi-ai / pi-agent-core / pi-codemode / pi-mcp / pi-schema / pi-telemetry / pi-tui@1.6.0`、`typebox 1.3.27`、`undici 8.12.4`（6 个安全公告） |
| 归档产物 | `runtime-release/MPI-Runtime-1.6.0-win-x64.tar.gz`，48 529 259 B（46.3 MiB），`resources/runtime-manifest.json` schema 2 |

应用内「更新 Pi」**只能装内置归档**（`src/main/core-updater.ts:215-246`：上游比内置新时在下载前就返回「升级 MPI 本体」），
所以升 pi 的唯一做法是改 `piRuntimeVersion` + 重打 bundle，随 MPI 发版。

## 2. breaking 与静态核查

### 2.1 1.6.0 的唯一一条

扩展组件 `render()` 返回 `readonly string[]`，`Container` 在子节点未变时返回同一缓存数组；
原地修改渲染输出（含 `Container` 子类里改 `super.render()` 结果）必须先拷贝。

| 检查点 | 结果 |
|---|---|
| 自带扩展是否定义自定义组件 | 无。`rg "extends Container\|Component<\|registerComponent" src/` 零命中，`rg "ui\.custom\("` 零命中 → **不受影响** |
| `find` / `grep` / `read` 的自定义 Operations | 无。`rg "GrepOperations\|ReadOperations" src/main` 零命中 |
| `pi.exec` 退出码消费方 | 无（1.6.0 把信号终止的退出码改成 128+signo）→ 不受影响 |
| `resources_discover` 处理器 | 零个 |

### 2.2 一并接收的 1.5.1 breaking

| 项 | MPI 侧结论 |
|---|---|
| 自定义 `GrepOperations.readFile` 不再用于 context 行 | 未覆写 grep → 不受影响 |
| OpenAI 兼容模型在工具全禁用时不再发 `"tools": []` | 未设 `compat.requiresToolsWithToolHistory`。若某个代理网关在历史含工具调用时要求 `tools` 字段，会报 400 —— **未覆盖**，出现时按该键开启 |

## 3. 对 MPI 有实际影响的行为差异

| 差异 | 出处 | 对本机的实际影响 | 证据 |
|---|---|---|---|
| RPC `new_session`/`switch_session`/`fork`/`clone` 不再把 `session_start`、`resources_discover` 跑两遍 | 1.6.0 Fixed #10470 | 实测 9 次 → 5 次（§5.3）。**对 MPI 无功能影响**：唯一的 `session_start` 处理器是 `src/main/mpi-memory-ext.ts:747`，只做 `rememberCtx` + `scheduleSweep`，另有 `sweepTimer` 合并、`sweeping` 互斥、游标幂等三重去重 | 实测 |
| 非 OpenAI 的 OpenAI 兼容 provider 以 `system` role 发送系统提示与会话中途 system 消息 | 1.6.0 Fixed #10741 | **两版请求体逐字段一致**：basalt → `developer`（`compat.supportsDeveloperRole:true` + reasoning），workbuddy → `system`（显式 `false`）。角色由既有 `compat` 判定决定，1.6.0 未改这条路径。中途 system 消息路径本机不触发（`supportsMidConvoSystemMessages` 默认 `false`，两版相同） | 实测（部分未覆盖） |
| 默认 system prompt | — | **文本逐行相同**，唯一差异是内嵌的文档/示例路径指向各自包目录（`…/versions/1.5.0/pi/docs` → `…/package/docs`）。1.5 记录里「系统提示收紧是否削弱 MPI 注入」这条待观察项就此关闭 | 实测 |
| `cacheWarming` 默认 `streaming` → `idle` | 1.5.1 Changed | `~/.pi/agent/settings.json` 未显式配置 → 空闲期也会向端点发保温请求（本地模型 = 额外 GPU 时间）。**本次不改配置**，先观察一轮；要回到旧行为就显式写 `"cacheWarming": "streaming"` | 静态核对 |
| `find` 的 path 模式改为相对搜索目录（等价 grep 的 glob） | 1.6.0 Changed #12066 | `find` 在受信任工具表里（`src/shared/tool-trust-meta.ts:22`、`src/main/permission-gate-ext.ts:145`）。`src/*.ts` 不再匹配 `pkg/src/a.ts`，任意深度要写 `**/src/*.ts`；配合 1.5.1 的 Windows 分隔符修复，跨平台一致性变好 | 静态核对 |
| 会话替换后的诊断（模型不可用被静默换掉、项目扩展加载失败、`enabledModels` 不匹配）在**所有模式**都报一次，RPC 走 stderr | 1.6.0 Fixed #11264/#10470 | `src/main/pi-bridge.ts:501-519` 只在非预期退出时保留 stderr 尾部（≤32KB）→ 正常运行的线程里这些诊断既不进 UI 也不进日志。`takeUnreportedDiagnostics()` 是 SDK API，MPI 是纯 RPC 宿主用不上 → 见 §6 待办 | 静态核对 |
| Anthropic message threads 扩到任何 `api.anthropic.com` baseUrl | 1.6.0 Changed #11987 | 本机 6 个自建 provider 全是 `api: openai-completions`，无一在 anthropic 域 → 无影响 | 静态核对 |
| llama.cpp 扩展默认端口 8080 → 9931 | 1.6.0 Changed #12001 | 本机走 `models.json` 显式 `baseUrl`，未用该扩展 → 无影响 | 静态核对 |
| `openai-codex`：默认模型改 `gpt-6.2-sol`、不再忽略 `maxTokens`、GPT-6.2 系统提示 prompt cache 命中修复、WebSocket 60 分钟上限改为换连接重试；GPT-6.2 Astra/Sol 不接受 reasoning effort `none`/`minimal` ⇒ `thinking off` 不可用 | 1.6.0 Added/Changed/Fixed | 这台设备的会话模型不含该 provider → 未覆盖。若之后用 Codex 订阅跑主力模型，注意「thinking 无 off 档」 | 未覆盖 |
| `pi update` 在 Windows 托管安装下因 PATH 里旧系统 Node 而失败 | 1.6.0 Fixed #12048 | MPI 的运行时是应用自带（`<userData>/runtime/versions`），不走 `pi update` 那条路径 → 受益有限 | 静态核对 |

## 4. 打包步骤（2026-11-25 实测）

**不需要 `--install-strategy=nested`**（1.5 记录里那条）：把 npm tarball 解开后直接在包目录内 `npm install`，
依赖就落在 `<pi 包>/node_modules`，正好满足 `bundle-runtime.mjs` 的 `cpSync(<pi 包>/node_modules, …)`。

```bash
mkdir -p Work/tempfile/pi-160 && cd Work/tempfile/pi-160
npm pack @earendil-works/pi-coding-agent@1.6.0 && tar -xzf earendil-works-pi-coding-agent-1.6.0.tgz
cd package && npm install --omit=dev --ignore-scripts     # 122 包 / 37s，自带 node_modules 共 79 个顶层目录 / 124 MB

cd /e/MyWorkspace/Project/MPI
PI_PACKAGE_DIR="E:/MyWorkspace/Work/tempfile/pi-160/package" npm run bundle
# [bundle-runtime] pruned pi runtime: 15908 files/112.3 MiB -> 5729 files/49.2 MiB
# runtime asset: MPI-Runtime-1.6.0-win-x64.tar.gz (46.3 MiB) + resources/runtime-manifest.json
```

`--ignore-scripts` 已验证可用：该包跑通了 `--version`、print 对话、RPC 命令、17 个扩展加载（§5）。
产物与 manifest 都在 `.gitignore` 里，不入库；`--local` 发版时用本地产物。

## 5. 实测记录

方法（全部与真实环境隔离，未写真实 `~/.pi/agent`、未写真实知芽池、未改 `src/`）：

```bash
export PI_CODING_AGENT_DIR=<temp cfg>   # 只放 models.json + 最小 settings.json
export PI_OFFLINE=1                     # 不刷新模型目录
node <cli> --provider basalt --model "Qwen3.8-Flash-Next UD-IQ4_XS" \
     --print --no-session --no-tools --no-mcp --no-skills --extension <探针> …
```
- 1.5.0 用现成运行时 `…/MPI Dev/runtime/versions/1.5.0/pi/dist/bundle/cli.js`；1.6.0 用上表解包安装的那份。
- 探针：`cap.js`（`before_provider_request` 的 role 分布 + 生命周期事件计数）、`cap2.js`（默认 system prompt 全文落盘）、
  `rpc-drive.js`（复刻 `pi-bridge.ts` 的 `{id,type,…}` + LF 帧格式跑会话命令）、`smoke-ext.js`（加载全部生成扩展起 RPC）。
- 文件与数据都在 `Work/tempfile/pi-160/`（约 158 MB，可随时清除）。

### 5.1 系统提示是否生效（4 组合）

用 30 字最小 system prompt（唯一规则=只输出 `CAP-7788`），两版 × basalt/workbuddy 全部正确回述，无 400、无 `Unexpected message role`。耗时 2.3–7.5s，无差异。

### 5.2 请求体对比

| 组合 | role 序列 | 指令角色 | 顶层键 |
|---|---|---|---|
| 1.5.0 / 1.6.0 × basalt | `developer, user` | idx=0 `developer` | `max_completion_tokens,messages,model,prompt_cache_key,prompt_cache_retention,reasoning_effort,store,stream,stream_options` |
| 1.5.0 / 1.6.0 × workbuddy | `system, user` | idx=0 `system` | 同上 |

⇒ 两版无差异。

### 5.3 RPC 会话替换的事件计数

命令序列 `get_state → prompt → new_session → switch_session → fork → switch_session → clone`（`fork` 两版都返回 `Invalid entry ID for forking`，取 entryId 的方式不对，未计入）：

| 事件 | 1.5.0 | 1.6.0 |
|---|---|---|
| `session_start` | **9**（`[1,1,2,1,2,1,2,1,2]` = 启动 1 + 4 次替换 ×2） | **5**（`[1,1,1,1,1]`） |
| `resources_discover` | **9** | **5** |
| `session_shutdown` | 5 | 5（未变） |
| `get_state` 字段集合 / 各命令 success / `agent_start·turn_*·message_*·agent_settled` 计数 | —— | **逐项相同** |

### 5.4 记忆池捕获链路（真实扩展）

加载 `%APPDATA%/MPI Dev/mpi-memory.ts`（`ensureMemoryExtension` 生成的那份），inbox/pool 指向临时目录：
两版都写出 `.pending-<key>.json`（`reason=settled`，窗口 258 / 264 字符）与 `.cursor-<key>.json`，
`MPI_MEMORY_MODEL` 未设 ⇒ 不抽模型、不产生候选。**快照文件都只有 1 条**——双触发不会造成重复快照，
幂等性由游标保证（`newTurns()` 第二次取到 0 增量直接 return），不是靠 `scheduleSweep` 合并。

### 5.5 全部扩展的 RPC 冒烟

`%APPDATA%/MPI Dev/*.ts` 共 **17** 个生成扩展（16 个 `mpi-*.ts` + `pi-studio-permission-gate.ts`），两版都是
`get_state.success=true`、**stderr 0 行**。注意：用的是最小 settings（不含 `settings.packages`），
1.5 记录提到的用户安装包 `typebox` peerDependencies 警告属另一条路径，本次未覆盖。

### 5.6 本机采纳（dev 实例，2026-11-25 15:50）

dev 模式下 `embeddedRuntimeArchivePath()` 会直接抛 `embedded Pi runtime is only available in a packaged app`
（`src/main/runtime-package.ts:206`），所以上述“启动时静默采纳”在开发实例里不可用，按 1.5 记录同样的手工流程：

```bash
RT="$APPDATA/MPI Dev/runtime"
cp -p "$RT/current.json" "$RT/current.json.bak-1.5.0"                 # 备份旧指针
mkdir -p "$RT/.staging-manual/extracted"
/c/Windows/System32/tar.exe -xzf runtime-release/MPI-Runtime-1.6.0-win-x64.tar.gz -C "$RT/.staging-manual/extracted"
mv "$RT/.staging-manual/extracted" "$RT/versions/1.6.0"                # 布局 node/ npm/ pi/，与 1.5.0 一致
# 写 current.json：{"schema":1,"version":"1.6.0"}（与 activateRuntimeRoot 的格式一致）
```

| 检查 | 结果 |
| --- | --- |
| 归档完整性 | size 48 529 259 一致；sha512（base64）与 `resources/runtime-manifest.json` 相等 |
| 目录布局 | `versions/1.6.0/{node,node.exe}` + `pi/dist/cli.js` 均在（等价 `isUsableRuntimeRoot`），162 MB |
| 自带 node 自检 | `versions/1.6.0/node/node.exe -v` → v24.19.0；用它跑 `pi/dist/cli.js --version` → 1.6.0 |
| 装机后的 RPC 冒烟 | 用 `versions/1.6.0` 那份 node+cli 加载 17 个生成扩展 → `get_state.success=true`，stderr 0 行 |
| 当前进程的运行时 | **仍是 1.5.0**。`resolvePiRuntime()` 的结果按进程缓存（`pi-bridge.ts:195`）→ 要重启 dev 实例才换 |

旧树 `versions/1.5.0`（164 MB）本次没被删，但**下一次启动会被删**：`index.ts:520` 无条件在启动时调
`cleanupOldRuntimes()` → `cleanupRuntimeVersions()`（只保留 active 版本，dev 也一样）。回滚方法见 §7。

## 6. 遗留风险与待办

| 项 | 说明 |
|---|---|
| `cacheWarming` 默认变 `idle` | 本地端点的空闲 GPU 抢占需观察一轮再决定显式配置 |
| 会话中途 system 消息 | 本机配置下不触发，未测 |
| `fork` 命令本身 | 本次 entryId 取法不对，两版行为一致（都拒绝），严格讲未执行成功 |
| ~~`scripts/test-devmail-app.mjs`~~ | **已修**：`resolveManagedPiRuntimeDir()` 改为先按 `piRuntimeVersion` 定位 `<userData>/runtime/versions/<版本>/pi`，退到本机最高可用版本，都没有时报错开带指引。实测解析到 `versions/1.6.0/pi`，`npm run test:devmail` 25 项全绿 |
| RPC stderr 诊断不进界面 | 建议：把子进程 stderr 按行落日志面板（独立小改动） |
| 长会话压缩 / MCP 工具入参 / 交互 TUI | 仍需人工在应用里过一遍（1.5 记录同样未覆盖） |

## 7. 回滚

本机（dev）：`cp "$APPDATA/MPI Dev/runtime/current.json.bak-1.5.0" "$APPDATA/MPI Dev/runtime/current.json"` 后重启 dev 即可（
`versions/1.5.0` 未删）。注意 `cleanupRuntimeVersions()` 会删掉所有非 active 版本目录（`index.ts:520` 启动时调），
所以一旦用 1.6.0 启过一次应用，`versions/1.5.0` 就没了 —— 回滚需要重新解压：

```bash
/c/Windows/System32/tar.exe -xzf runtime-release/MPI-Runtime-1.5.0-win-x64.tar.gz -C <目标>
# 解出 node/ npm/ pi/ → 放到 runtime/versions/1.5.0/，再把 current.json 指回 1.5.0
```

仓库侧：`package.json` 的 `piRuntimeVersion` 改回 `1.5.0` + `PI_PACKAGE_DIR=<1.5.0 包> npm run bundle`。
设备侧（发行版）：`ensureEmbeddedRuntimeCurrent()` 只在**内置严格更新**时自动换（`src/shared/runtime-version.ts`），
不会自动降级，所以必须靠装旧版 MPI 或手工解压。
