# Pi 1.5.0 升级记录（2026-11-03）

> 结论先行：**已把内置运行时从 `1.3.0` 升到 `1.5.0` 并重打归档**，MPI 自带扩展静态核对与 RPC 冒烟均通过；
> 唯一需要人在应用里过一遍的是「带工具调用的真实对话 / 长会话压缩 / MCP 工具」。
> 上一份同类记录：`docs/PI-1.2-UPGRADE.md`（0.87 → 1.2，含 `core-updater` 路由真值表）。

## 1. 版本事实

| 项 | 值 |
|---|---|
| 升级前内置 | `1.3.0`（`package.json` → `piRuntimeVersion`） |
| 升级后内置 | `1.5.0`（2026-11-02 发布） |
| 中间版本 | `1.4.0`（2026-10-21） |
| 运行时技能包 | `@earendil-works/pi-coding-agent@1.5.0` + `pi-ai/pi-agent-core/pi-codemode/pi-mcp/pi-tui@1.5.0`、`typebox 1.3.27` |

注意：应用内「更新 Pi」**只能装内置归档**（`core-updater.ts` 在下载前判定，上游比内置新时直接提示「升级 MPI 本体」），
所以升 pi 的唯一正确做法就是改 `piRuntimeVersion` + 重打 bundle，随 MPI 发版。

## 2. 1.5.0 的 breaking（唯一一条）

工具参数校验从 TypeBox 换到 `@earendil-works/pi-schema`：

- `Type.Refine()` / `Type.BigInt()` / `Type.Undefined()` / codecs / `Format.Set()` 这类**超出 JSON Schema 的能力对 tool args 失效**；
- 纯 JSON Schema 工具（含 MCP 工具）现在和 TypeBox 工具一样做**类型强转**（数字字符串 → number、单值 → 数组）；
- 校验失败给模型看的文案格式变了（`- path: missing` 取代 `must have required properties path`）。

### MPI 侧核查结论

| 检查点 | 结果 |
|---|---|
| 自带扩展的 TypeBox 用法 | 只有 `Type.Object/String/Number/Optional`（`mpi-choice-ext` 等），**全是纯 JSON Schema** → 不受影响 |
| 是否使用 `Refine/BigInt/Undefined/Format` | 无（`rg "Type\.(Refine\|BigInt\|Undefined\|Format\|Unsafe)" src` 零命中） |
| 运行时入口 `contentText` / `completeSimple` | 1.5.0 仍在（`pi-ai` 根导出 + `pi-ai/compat`） |
| RPC 命令表 | 与 1.3.0 一致：`prompt/steer/follow_up/abort/clear_queue/new_session/get_state/set_model/cycle_model/get_available_models/set_thinking_level/compact/set_auto_compaction/bash/abort_bash/get_session_stats/switch_session/fork/clone/get_entries/get_tree/get_messages/get_commands/…` |
| 扩展 UI 方法 | `select/confirm/input/editor/notify/setStatus/setWidget/setTitle/set_editor_text` 仍在，签名未变 |

**仍需人工验证**：MCP 工具入参被强转后行为是否变化（例如 `"5"` 变成 `5`）。

## 3. 顺带拿到的修复（1.4.0）

- 摘要/分支摘要改用模型输出上限，不再因「思考吃满固定上限」失败（MPI 的 `mpi-smart-compact-ext.ts` 自算 `maxOut`，语义会与 pi 默认分叉，但不会坏）。
- 并发扩展对话框不再互相顶掉（第二个 `select` 曾让第一个 promise 永不 settle）——MPI 把 select/confirm 桥成对话框，这条直接受益。
- `mcp.json` 带 UTF-8 BOM 不再导致整份 MCP 列表被跳过。
- 截断工具调用恢复后，会话不再永久 400。
- Windows 路径比较改为大小写不敏感（skills 重复加载、`/resume` 藏会话、`pi remove` 匹配不到）。

## 4. 打包时的新坑：pi 包目录必须自带 `node_modules`

`scripts/bundle-runtime.mjs` 会 `cpSync(<pi 包>/node_modules, …)`，但 `npm install` 默认**提升**依赖，
`node_modules/@earendil-works/pi-coding-agent/` 下面没有 `node_modules` → 直接 `ENOENT`。

正确姿势（2026-11-03 实测）：

```bash
# 1) 用 nested 布局装一份 1.5.0（让依赖落在 pi 包自己的 node_modules 里）
npm install --prefix /e/MyWorkspace/tempfile/pi-1.5.0/nested \
  --install-strategy=nested @earendil-works/pi-coding-agent@1.5.0 --omit=dev

# 2) 指向 pi 包目录重打归档
export PI_PACKAGE_DIR='E:\MyWorkspace\tempfile\pi-1.5.0\nested\node_modules\@earendil-works\pi-coding-agent'
npm run bundle
```

产物：`runtime-release/MPI-Runtime-1.5.0-win-x64.tar.gz`（46.4 MiB）+ `resources/runtime-manifest.json`
（两者都在 `.gitignore` 里，不入库；`--local` 发版时用本地产物）。

## 5. 冒烟结果

把归档解到临时目录，用内置 Node 跑 1.5.0 CLI：

- `--version` → `1.5.0`；
- 用本机 `<userData>` 下全部 13 个 `mpi-*.ts` 扩展起 `--mode rpc`，发 `get_state` → **成功返回**，
  stderr 无扩展加载错误（只有用户级扩展包的 `typebox` peerDependencies 警告，见下）。

### 真实 dev 实例（2026-11-03 21:00）

把归档解到 `<userData>/runtime/versions/1.5.0/{node,npm,pi}` 并把 `current.json` 指过去（旧值备份
`current.json.bak-1.3.0`），重启 dev 后实测：

| 检查 | 结果 |
|---|---|
| 实际加载的运行时 | `logs/dev-run.log` 出现 `[pi] runtime resolved -> …ersions.5.0
ode
ode.exe`；进程表里两个 pi 子进程都在 1.5.0 目录下 |
| 扩展加载 | 13 个 `mpi-*.ts` 全部加载，无 `extension_error` / `Failed to load extension` |
| 工具调用 | 本次会话本身就是带 bash/read/edit 的多轮工具调用，正常 |
| MCP | `pi mcp list` → `lark-mcp: connected, 19 tools`（配置解析正常） |
| 旧噪声 | 上一实例（1.3.0）有 13 次 `Error: AttachConsole failed`，新实例 **0 次** |

**回滚**：`cp current.json.bak-1.3.0 current.json` 后重启即可（1.3.0 目录未删）。

仍未覆盖：长会话触发压缩、MCP 工具的实际入参（类型强转）。

## 6. 已知噪声与遗留风险

- **新增 stderr 警告**：用户安装的 `pi-web-access` / `@juicesharp/rpiv-todo` 把 `typebox` 写成 dependencies，
  1.5 启动会打「Host-provided extension packages must be declared in peerDependencies with a \"*\" range」。
  是警告不是错误；要消掉只能改那两个扩展的 `package.json`（属上游/用户环境，不归 MPI 管）。
- **系统提示收紧**（1.5.0 已 Changed）：与 MPI 注入的画像/AGENTS 规则是否互相削弱，需要真实对话观察一轮。
- **模型目录升到 models.dev v2**：realtime / image-only 模型不再出现在 chat 列表；默认 OpenAI 模型改 `gpt-6.1-sol`。
  MPI 的模型选择器与「auto」选型都读这份目录，升级后建议看一眼常用 provider 的列表有没有少项。
- **MCP 参数强转**：见 §2。
