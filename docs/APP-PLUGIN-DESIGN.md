# 应用商店 —「应用加载平台」设计（Phase 3）

> 状态：已实现。代码见 `src/main/app-store.ts`（安装/生命周期）、`src/main/app-store-core.ts`（纯逻辑校验）、
> `src/main/app-runtime.ts`（服务宿主）、`src/main/zip.ts`（自研 zip 读取器）。
> 开发者侧参考实现与打包脚本：`examples/apps/local-voice/`、`scripts/build-app-pack.mjs`。

## 0. 定位：类微信小程序的加载平台

应用商店的定位是**加载平台**：MPI 只提供「导入 → 校验 → 安装 → 托管 → 卸载」的框架，
**不在安装包里随附任何应用载荷**。所有应用文件（清单、服务代码、运行时依赖、模型）由
第三方开发者自行准备，打成一个**自包含 zip 包**（或已解压目录）后导入。

Phase 演进：

- Phase 1：纯声明式功能包（`mpi-app.json` + 配置表单），启用即把配置模板写进 `config.voice`。
- Phase 2：可编程插件包（包内可含主进程服务模块 + pi 扩展 + 能力声明），MPI 增加薄宿主。
- **Phase 3（本文）**：应用**自包含**——把运行时与模型也装进包里，导入 zip 即装即用；
  MPI 移除了内置目录 `resources/apps`，不再随包发布任何应用。

获取方式（本轮）：**从 zip 安装** + **加载已解压目录**。明确不做远程在线商店 / 签名校验。

## 1. 应用包布局

```
local-voice/                     ← 包根（恰好一个 mpi-app.json）
  mpi-app.json                   ← 清单（v2 规则）
  service/
    index.cjs                    ← 服务模块（activate/deactivate）
    server.cjs                   ← 应用自带的常驻服务（可选）
  runtime/
    node_modules/                ← 随包运行时（当前平台的原生依赖）
  model/
    model.json                   ← 模型描述（type/model/tokens/name…）
    model.int8.onnx
    tokens.txt
```

- `runtime/` 与 `model/` 是**约定目录**（供参考实现使用；MPI 不强制、也不解析它们）。
- 服务模块用 `host.execPath` + `ELECTRON_RUN_AS_NODE` 拉起 `runtime` 里的 Node 服务，
  因此**不需要**外部 node/python。
- 包内不要放 `resources/`、`dist/`、`.git/` 等无关内容。

## 2. 清单 v2 字段

v1 字段全部保留、语义不变；v2 新增三个可选顶层键。

```jsonc
{
  "id": "local-voice",
  "name": { "zh": "本地语音服务", "en": "Local Voice Service" },
  "version": "3.0.0",
  "category": "voice",
  "description": { "zh": "…", "en": "…" },
  "guide": { "zh": "…", "en": "…" },

  // v1：配置表单
  "config": {
    "fields": [
      { "key": "baseUrl", "label": { "zh": "外部服务地址（留空=用内置）" }, "type": "url", "default": "" },
      { "key": "port",    "label": { "zh": "内置服务端口" }, "type": "text", "default": "8800" },
      { "key": "modelName", "label": { "zh": "模型名" }, "type": "text", "default": "SenseVoiceSmall" }
    ]
  },

  // v1：声明式接线（无 service 时走这条；有 service 时作为兜底模板）
  "integrations": { "voiceStt": { "sttBackend": "openai", "sttBaseUrl": "{{baseUrl}}", "sttModel": "{{modelName}}" } },

  // v2：主进程服务模块
  "service": {
    "entry": "service/index.cjs",       // 必须位于 app 目录内
    "autostart": true,                   // 默认 true
    "startCommandField": "startCommand"  // 可选：探测失败时用该字段拉起服务
  },

  // v2：自带 pi 扩展
  "pi": { "extensions": ["pi/extension.ts"] },

  // v2：能力声明（安装时展示，需用户确认）
  "capabilities": ["process", "network"]
}
```

**校验规则**（`app-store-core.ts`）：

- `service.entry` / `pi.extensions[]` 必须是 app 目录内的**相对路径**：拒绝绝对路径、
  拒绝含 `..` 或 `~` 的穿越、拒绝 `\0`；服务模块只接受 `.js` / `.cjs` / `.mjs`。
- `capabilities` 只允许 `process` / `network` / `fs`。
- v1 清单（无 v2 字段）必须继续校验通过。

## 3. 安装流水线

```
从 zip 安装
  ├─ listZipEntries 找包根 / 单层包裹目录下的 mpi-app.json（取层级最浅者）
  ├─ 读取并校验清单
  ├─ extractZip 到暂存目录（流式，恒内存；stripPrefix 剥离包裹目录）
  ├─ rename 原子替换到 <userData>/apps/<id>
  └─ 注册为 installed+disabled（重装重置状态，但保留 configs/<id>.json）

加载已解压目录
  ├─ 校验目录下的 mpi-app.json
  ├─ cpSync 到 <userData>/apps/<id>
  └─ 注册为 installed+disabled
```

**zip 读取器**（`src/main/zip.ts`，零依赖）：解析中央目录（stored/deflate + zip64 尺寸/偏移）、
`readZipEntry` 按名读取、`extractZip` 逐条流式解压；`safeZipDest` 拒绝 `../`、绝对路径、
盘符、空路径——**含穿越条目的归档整体拒绝**且不落任何越权文件。

## 4. 宿主 API 契约

服务模块是 CommonJS 或 ESM 模块，导出 `activate` / `deactivate`：

```js
module.exports = {
  async activate(host) {
    // host.execPath / host.spawn() / host.getFieldValues() / host.status() / host.log() ...
    // 返回 { voice?: Record<string,string> } → MPI 用字段指纹回滚机制写入 config.voice
    return { voice: { sttBackend: "openai", sttBaseUrl: baseUrl, sttModel: model } };
  },
  async deactivate(host) {
    // 额外清理；host 托管的子进程由 MPI 统一回收
  },
};
```

### AppHost（`src/main/app-runtime.ts`）

| 成员 | 说明 |
| --- | --- |
| `app: { id, dir, dataDir, version }` | 应用 id、安装目录、专属数据目录（`<userData>/apps/data/<id>`）、版本 |
| `execPath: string` | `process.execPath`——配合 `ELECTRON_RUN_AS_NODE` 用 Electron 自身当 Node 跑 |
| `getFieldValues(): Record<string,string>` | 已保存的表单值（含默认值） |
| `status(state, detail?)` | 上报状态 `starting` / `ready` / `error` / `stopped`；持久化并推送到 UI |
| `log(line: string)` | 追加一行日志（带时间戳；滚动保留最近 N 行） |
| `spawn(command, args?, opts?)` | 声明了 `process` 能力时可用；`opts = { cwd?, env?, shell? }`，env 与 `process.env` 合并；`shell:false` 可安全传含空格路径 |
| `env: { userData, platform, arch }` | 只读环境信息 |

**返回语义**：`activate()` 返回 `{ voice?: Record<string,string> }`。MPI 用既有的
`computeRestorePlan` 指纹机制写入——停用时只回滚**仍等于应用所写值**的字段，用户手改优先。
服务模块**不需要**、也**不能**直接写 config。

**异常兜底**：`activate` 抛错 → 记录日志、`status("error", msg)`，主进程不崩；应用保持
`enabled=true` 但状态为 error，用户可在面板重试。模块若自行 `status("error", …)`，
宿主不会用 ready 覆盖它。

## 5. 生命周期时序

```
启用 enable
  ├─ 清空上一次 status / lastError
  ├─ activate(host)            （status: starting）
  │    ├─ 探测外部服务 / 拉起包内服务
  │    └─ 返回 voice patch
  ├─ 写 config.voice（指纹机制，快照旧值）
  ├─ 把 pi.extensions 注入 bridge 扩展列表（指向安装目录，不复制）
  └─ status: ready

停用 disable
  ├─ deactivate(host)
  ├─ kill 所有托管子进程
  ├─ 还原 config.voice（computeRestorePlan）
  ├─ 从扩展列表移除该应用的 pi 扩展（运行中的线程保留到下次 spawn）
  └─ status: stopped

MPI 启动 → 对 installed && enabled && autostart 的应用自动 activate（只拉起服务，不重写 config、不重建快照）
MPI 退出 → 统一 deactivate + kill 托管子进程
```

**状态机**：`stopped → starting → ready | error`；`ready|error → stopped`（停用）。
启用是幂等的：重复 enable 不会重复写 config（已有 `applied` 则先按停用回滚再重放）。

## 6. 安全模型

- **无沙箱**：service 模块与 pi 扩展一样运行在主进程，拥有完整权限（同一信任模型）。
- **知情同意**：安装时展示 `capabilities`（「此应用可启动本地进程 / 访问网络」），用户确认后才安装。
- **来源**：本地 zip / 目录，用户显式选择。不做远程商店与签名（本轮）。
- **路径守卫**：zip 条目经 `safeZipDest` 校验，entry 必须落在 app 目录内。
- **宿主守卫**：未声明 `process` 能力调用 `host.spawn` 会被拒绝并记日志。
- **回收保证**：托管子进程由 MPI 统一登记与回收（复用 `killProcessTree`），应用崩溃/退出不留野进程。

## 7. 存储布局

```
<userData>/apps/
  registry.json                { apps: { <id>: { installed, enabled, status, lastError, snapshot?, applied? } } }
  configs/<id>.json            表单值
  data/<id>/                   应用专属数据目录（模型、缓存等，卸载时清理）
  logs/<id>.log                滚动日志（最近 200 行）
  <id>/                        应用文件（含 service/、runtime/、model/）
```

## 8. 开发者打包

`scripts/build-app-pack.mjs` 把应用源码目录组装成自包含 zip：

```
node scripts/build-app-pack.mjs --app=examples/apps/local-voice
  → 复制源码（排除 runtime/model/node_modules/.git）
  → runtime/node_modules：npm 安装当前平台 sherpa-onnx-node（或 --runtime-dir 复用）
  → model/：下载 .tar.bz2 用系统 bsdtar 解压（或 --model-dir 复用）并写 model.json
  → 系统 tar 打成 <id>-<platform>-<arch>.zip
```

生成物是**开发者产物**，通过应用商店「从 zip 安装」导入；**不进入 MPI 安装包**。

## 9. 明确不做（本轮）

- 远程在线商店 / 包签名 / 自动更新。
- 沙箱 / 权限隔离（服务代码与 pi 插件同一信任模型）。
- 渲染层任意 UI 代码加载（面板仍由 MPI 声明式渲染 + 状态/日志区组成）。
- `voice.stt` 之外的集成接线（TTS / MCP / skill）。
- 跨平台通用包（当前 zip 只含单一平台运行时；换平台需重新打包）。
