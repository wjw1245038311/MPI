# Pi 运行时 1.2 升级 + MCP 内建化（2026-10-15）

> 起因：pi 从我们钉住的 **0.87.0** 跳到了 **1.2.0**（中间是 0.99.x → 1.0.x → 1.1 → 1.2），用户下载了官方 standalone 包 `pi-windows-x64.zip`。
> 本文只记**已核实的事实**与由此决定的改动；未验证项单独列出，不当结论用。
> 冒烟环境：隔离 `PI_AGENT_DIR`（`Work/tempfile/pi12-smoke/home`）+ 解压出的 `pi.exe` 1.2.0 + npm tarball 1.2.0，**没有动过真实的 `~/.pi/agent`**。

## 一、结论

1. **standalone zip 不能用于 MPI**：它只有 `pi.exe`(111 MB) + docs/examples，整包 `dist/` 条目数为 0；而 MPI 解析运行时找 `<root>/pi/dist/cli.js`（`src/main/pi-bridge.ts:62`、`src/main/index.ts:59`、安装校验 `core-updater.ts:555`）。升级必须走 **npm 包**路线。
2. **npm 包路线不会断**：1.2.0 tarball 里 `package/dist/cli.js` 仍在（另新增 `dist/bundle/cli.js`，`bin.pi` 指向后者），现有解析路径继续可用。
3. **MCP 的最大变化不是 changelog 里那条 `pi mcp list --json`**（MPI 不解析该命令，面板直接读写 `mcp.json`），而是：pi ≥ 0.99.0 起 **自带内建 MCP**，且启用标记换成了 `enabled`。已按「直接用内建、不做二选一切换」完成代码改造（见第三节）。

## 二、实测事实（pi.exe / tarball 1.2.0）

| # | 事实 | 证据 |
|---|---|---|
| F1 | 内建 MCP CLI 存在 | `pi.exe mcp --help` → `add/remove/list/login/logout`；`--no-mcp` 帮助文本 "Disable built-in MCP support: no servers connect and no MCP tools" |
| F2 | 内建 MCP 引入版本 = **0.99.0** | 包内 `CHANGELOG.md`：`## [0.99.0] - 2026-09-29` 「Added codemode, tool search, and MCP support as built-in extensions」 |
| F3 | 启用标记只认 `enabled` | 隔离 mcp.json 三条目跑 `pi mcp list --json`：`{"enabled":false}` → `"state":"disabled"`；`{"disabled":true}` → `"enabled": true, "state":"failed"`（**照常尝试连接**） |
| F4 | stdio 服务器默认 `exposure` = `codemode` | 同上输出；含义：MCP 工具不再逐个声明给模型，而是经 codemode / `searchTools()` 按需取用 |
| F5 | `exposure` / `toolExposure` / `oauth.clientName` 等键被正常解析，未知键不报错 | 同一份 fixture 里 `{"url":…,"exposure":"direct","toolExposure":{"*":"hidden"},"oauth":{…}}` → 回显 `exposure: "direct"` |
| F6 | **pi-mcp-adapter 会顶掉内建 MCP** | 装上 adapter 后启动告警：`Extension package "builtin:mcp": … registers command /mcp, so built-in extension mcp was not loaded`；adapter 自己 notify「Turned off Pi's built-in MCP…」；随后 `settings.json` 出现 `"extensions": ["-builtin:mcp"]` |
| F7 | adapter 认两种标记（`disabled` 与 `enabled:false`） | 它 notify `"srv-disabled-true": disabled`；源码 `index.ts:620`、`config.ts:823` |
| F8 | MPI 的 7 个扩展在 1.2 下能加载 | 逐个 `-e <ext>.ts --mode rpc` + `get_state` 全部 `success:true`，无 error/failed 行（permission-gate / todo / taskmode / smart-compact / choice / shelenv） |
| F9 | MPI 用到的 RPC 命令都还在 | `docs/rpc-commands.md`：prompt、steer、abort、compact、fork、clone 均在（另有 follow_up、clear_queue 等） |
| F10 | 1.2.0 有 Breaking Changes 的版本只有 1.2.0 与 1.0.3 | 包内 CHANGELOG 分节统计 |

## 三、代码侧改动（本轮已完成）

按「MCP 直接用内建，不做开关」执行：

| 位置 | 改动 |
|---|---|
| `src/main/plugins.ts` | `McpServerInfo.disabled` → `enabled` + `exposure`；读取兼容旧字段（`mcpEntryEnabled`）；新增 `normalizeMcpDisabledFlags()`（把历史写下的 `disabled: true` 幂等改写成 `enabled: false`）与 `migrateToBuiltinMcp()`（从 pi 的 `settings.json` 摘掉 `npm:pi-mcp-adapter` 并清 `-builtin:mcp`——**两件必须成对做**，否则 adapter 每次启动都会把内建再关掉）；`setMcpServerDisabled` → `setMcpServerEnabled`（启用时删键，与 pi `/mcp` 写法一致）；`writeMcpFile` 改原子写 |
| `src/main/index.ts` | 启动时调用上述两个迁移（幂等、失败不拦启动，结果进 console + `mpi-diag.log`）。**带版本门控**：`piHasBuiltinMcp()` 只在 pi ≥ 0.99 时才摘 adapter——在当前钉住的 0.87 上，adapter 是唯一 MCP 来源，贸然摘掉等于 MCP 直接消失；版本读不到也当作不支持 |
| `src/main/ipc.ts` | 通道改名 `plugins:setMcpServerEnabled`；`plugins:getMcpServers` 先归一化再列出 |
| `src/preload/index.ts`、`store.ts`、`lib/types.ts` | 同步 `enabled` 语义与方法名 |
| `PluginsPanel.tsx` | 删除「MCP 模块不可用」gate 卡片与 `pi-mcp-market` / `pi-mcp-adapter` 依赖条（内建后不再是运行前提），详情栏加 `exposure` 徽章，提示文案改为内建 `/mcp` + `/reload`；`MessagingPanel.tsx` 的飞书 MCP 状态判断跟着改 |
| `styles.css` | 清掉随之孤立的 `.mcp-gate*`、`.mcp-dep*` 共 10 条规则 |
| `scripts/test-mcp-config.mjs` | 新增 9 项断言（含版本门控：0.87 下必须跳过、文件保持原样）：读取兼容、归一化幂等且保留未知键、启用删键、迁移成对且无事可做时不写盘、坏 settings.json 安全跳过 |

## 四、升级执行步骤（**尚未做**，需要确认后再动）

```bash
# 0) 备份（这两个文件是本次唯一会被改到的 pi 侧配置）
cp ~/.pi/agent/settings.json ~/.pi/agent/settings.json.bak-$(date +%F)
cp ~/.pi/agent/mcp.json      ~/.pi/agent/mcp.json.bak-$(date +%F)

# 1) 准备 1.2.0 包树（两种做法，推荐 B，不动全局 pi）
#    A：npm i -g @earendil-works/pi-coding-agent@1.2.0        # 会同时改掉终端 pi
#    B：npm i --prefix <dir> @earendil-works/pi-coding-agent@1.2.0
#       已备好：Work/tempfile/pi12-smoke/pkg（PI_PACKAGE_DIR 指它）

# 2) 改钉住版本 + 重打 runtime 归档（bundle-runtime.mjs 校验 dist/cli.js 与版本一致）
#    package.json: "piRuntimeVersion": "0.87.0" → "1.2.0"
PI_PACKAGE_DIR=/e/MyWorkspace/Work/tempfile/pi12-smoke/pkg/node_modules/@earendil-works/pi-coding-agent \
  PI_RUNTIME_VERSION=1.2.0 npm run bundle

# 3) 冒烟（见下表），全绿再走 docs/RELEASE.md 的发版流程
```

`scripts/bundle-runtime.mjs` 的取值顺序：`PI_PACKAGE_DIR` → `npm root -g` → PATH 上的 `pi.cmd` 同级 node_modules；三处都要求 `dist/cli.js` 且版本等于 `piRuntimeVersion`，否则直接报错（这是好事，防止打进错版本）。

### 冒烟清单（升级后逐项确认）

| 项 | 期望 |
|---|---|
| 「扩展功能 → MCP」列表 | 服务器来自 mcp.json；旧 `disabled:true` 条目被自动改写成 `enabled:false` 并显示为已禁用 |
| 面板开关 | 关掉后面板显示已禁用、终端 `pi mcp list --json` 里 `state: "disabled"` |
| 飞书 MCP 状态行（渠道面板） | 与 mcp.json 实际启用态一致 |
| 任务模式切换 | 系统提示按模式追加内容（`before_agent_start` 在 1.2 变成按 `messageType` 的联合类型，MPI 的两个处理器都没读 `prompt`，预期无感，但必须实测） |
| shell 环境注入 | 模型仍被告知当前 shell（同上事件） |
| 权限审批卡片 / 选择卡片 | 正常弹出与回填（扩展 UI 协议） |
| 智能压缩 | 手动 compact 成功（smart-compact 扩展 import 了 `@earendil-works/pi-ai/compat`，1.2 下加载通过，但真实压缩路径未跑过） |
| 工具白名单类任务模式 | `--tools/--exclude-tools` 语义在 1.x 改过（现在除非条目以 `mcp__` 开头否则不连带排除 MCP 工具），需确认模式行为符合预期 |

## 五、已知取舍与后续项

- **体感变化**：内建 MCP 默认 `exposure: codemode`，模型不再直接看到一堆 `mcp__*` 工具。这与之前 adapter 的「一个代理工具」思路接近，但不是同一个机制；老用户若习惯 `/mcp` 里看到全部工具，需要给 `exposure: "direct"`。
- **未做**：面板显示项目级 `.pi/mcp.json` 覆盖（pi 1.0.0 起支持，同名条目会整体替换用户级）；`toolExposure` 编辑；`oauth.clientRegistration` / `authServerMetadataUrl` / `auth.provider` 表单。
- **本轮改动在 0.87 运行时上是惰性的**：版本门控会跳过 adapter 迁移，所以合并代码不会让现在的 MCP 失效；`normalizeMcpDisabledFlags()` 仍然执行（`enabled:false` 在 adapter 上也生效，实测 F7），属于安全方向。
- **未验证**：F8 只证明扩展能加载，不等于其运行期行为在 1.2 完全等价（尤其 `before_agent_start` 与 compact 路径）。
- **回滚**：`piRuntimeVersion` 改回 `0.87.0` + 重跑 bundle；配置侧把 `.bak-*` 覆盖回去即可（注意 MPI 启动迁移会把 `enabled:false` 保留、不会写回 `disabled`）。
