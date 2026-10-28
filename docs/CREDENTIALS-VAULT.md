# 凭据库与引用使用（P1 方案）

> 状态：方案（未实现） · 2026-10-27
> 关联：`docs/OPTIMIZATION-BACKLOG.md`、`docs/MOBILE-DESIGN.md`（远程 E2E）、`docs/SECURITY-AUDIT-2026-10-19-RELAY-MITM.md`
> 本文只写「怎么落地」，取舍理由在对话记录里；**密码不离开主机**是硬约束，任何阶段都不放宽。

## 1. 目标与非目标

**目标**

- 凭据（密码 / token / 私钥 passphrase）只存主机，加密落盘，**永不进对话、进日志、进快照、进中继**。
- agent 需要凭据时拿到的只是**引用**（占位符），值在真正执行的那一刻才由主进程展开。
- 用户「显示 / 复制明文」时要求一次验证（Windows Hello）。
- 手机 / PWA **不具备查看或获取明文的能力**；远程会话可在**分级策略**下使用凭据。
- 长期方向：能用 SSH 密钥 / 临时令牌的场合不用长期密码（见 §8）。

**非目标（本期明确不做）**

- 凭据跨设备同步（一旦同步，边界归零）。
- 把验证外包给客户端做「安全边界」（§7 的 P3 只作可选）。
- 原生 WinRT 模块（先走 WebAuthn；原生是备选，见 §6.3）。

## 2. 已验证事实（2026-10-27 实验，勿重复考证）

| 事实 | 证据 |
|---|---|
| Electron 33 下 `file://` 是 secure context，`isUserVerifyingPlatformAuthenticatorAvailable()` 返回 **true** | `Work/tempfile/2026-10-27-webauthn-probe/probe.log` |
| `file://` 调 `credentials.create()` → **SecurityError**，不弹 Hello | 同上 `create.log`（Chromium 原话：只允许 https / localhost http / 扩展） |
| 自定义安全协议 `mpi://`（`standard+secure`）**同样被拒** | `probe3.log` |
| `http://localhost:<port>` 下 `create()` 成功，`authenticatorAttachment: "platform"`、`transports: ["internal"]` | `probe5-result.json` |
| `get()` 断言 `flags.up=true, uv=true`、`signCount=1`、签名字节 256 | 同上；用户确认期间屏幕弹出 Windows Hello |

**由此固定的两条硬结论**

1. 要用 WebAuthn，渲染层 origin 必须是 `http://localhost`（打包态当前是 `loadFile` → `src/main/index.ts:253-255`）。
2. 主机锁屏 / 无人时 Hello 弹窗无人应答 → **远程授权模型不能依赖主机侧交互**。

## 3. 数据模型

落 `userData/credentials.json`（**不进工程目录**），值用 `safeStorage`（Windows=DPAPI）加密，复用 `src/main/remote/identity.ts` 已有的 `enc:` 前缀 + `isEncryptionAvailable()` 兜底写法。

> **已定（P1a，2026-10-27）**：放在应用配置目录根，与 `feedback.json` 同级（不另建 `security/` 子目录）；由 `credentials-store.ts` 的 `credentialsFilePath()` / `credentialsAuditPath()` 统一给出路径。

```jsonc
{
  "version": 1,
  "credentials": [
    {
      "id": "cred_01",
      "name": "aliyun-prod-root",           // 用户可读名，agent 用这个名字引用
      "kind": "password" | "token" | "passphrase" | "ssh-key",
      "level": "silent" | "confirm" | "local-only",   // 远程策略见 §7
      "scope": { "type": "global" } | { "type": "project", "root": "E:/MyWorkspace/Project/MPI" },
      "valueEnc": "enc:...",                 // 密文；kind=ssh-key 时存私钥或指向文件路径
      "hint": "阿里云 47.97.x 部署机，仅 sudo 用",     // 给人看的用途说明，不含值
      "createdAt": 0, "lastUsedAt": 0, "useCount": 0
    }
  ],
  "gate": { "mode": "webauthn" | "master-password" | "off", "credentialIdB64": "...", "publicKeyCoseB64": "..." },
  "audit": { "path": "credentials-audit.jsonl" }
}
```

**审计**（`credentials-audit.jsonl`，追加写，同样不进工程目录）：

```jsonc
{ "ts": 0, "credId": "cred_01", "name": "aliyun-prod-root", "action": "expand" | "deny" | "reveal" | "deny-remote",
  "sessionId": "...", "source": "desktop" | "remote:deviceId", "via": "env" | "file" | "tool",
  "cmdDigest": "sha256:...", "result": "ok" | "blocked" }
```

**禁止**：值、展开后的命令全文、任何密钥材料进 `mpi-diag.log` / `changelog.md` / 会话快照。

## 4. 三层机制

### 4.1 引用（agent 侧唯一可见物）

- 语法：`{{secret:<name>}}`，`name` 即凭据 `name` 字段。
- 系统提示中说明：需要密码时**不要问用户要明文**，用 `{{secret:name}}`（或 `mpi_request_secret` 先创建，见 4.3）。
- 未知名字 → 展开点阻断并回一句「没有该凭据」，不猜。

### 4.2 展开（真正执行的那一刻）

> **已查**：pi 的 `tool_call` hook（`src/main/permission-gate-ext.ts:939` 在用）只能 `{ block: true, reason }`，**没有改写入参的契约**（`pi/dist/core/agent-session.js` 的 `_beforeToolCall` 只把返回值当拦截用）。所以「改参数」这条路不通，展开只能落在执行环境侧。

三条可选路径。**实现状态（2026-10-27）**：P1b 已按 A 落地，但**只注入 `silent` 级**——`confirm` / `local-only` 需要逐次策略判断，提前注入等于绕过策略，它们留给 P2/P3 的 broker 工具：

| | 做法 | 优点 | 代价 | 
|---|---|---|---|
| **A env 注入（P1）** | 主进程在 spawn pi 前把**本次会话可能用到的**凭据解密进环境变量（`MPI_SECRET_<NAME>`）；命令里写 `$MPI_SECRET_ALIYUN_ROOT` | 展开点天然正确（bash 子进程环境）、零 hook 依赖、模型只看到变量名 | 值在 pi 进程环境里常驻；env 会传给命令的所有子进程 |
| **B 专用工具（P1.5/P2）** | 扩展注册 `secret_run({credName, argv})`，由扩展自己 spawn 子进程，值只走 env/stdin | 不进 bash 命令流、可单独审计 | 要自己接超时/截断/权限 gate |
| **C 文件注入（按需）** | 写临时 0600 文件（`sshpass -f` / `PGPASSFILE` / `--defaults-extra-file`），用完即删 | 适配 `sshpass`、`mysql`、`psql` 这类只认文件的工具 | 落盘窗口期有风险，需明确清理与崩溃兜底 |

具体做 A 时：

- 只注入 `level === "silent"` 且作用域匹配当前项目根的凭据（`secretEnvForScope()`）；
- 变量名规则 `MPI_SECRET_<NAME 大写、非字母数字转下划线>`（`src/shared/credentials.ts`，扩展端是拷贝：它要自包含）；
- 元信息 `MPI_SECRET_META` 只含「变量名 + 引用名 + 用途」，扩展据此写系统提示；
- **注意**：改凭据后已打开的会话不会自动拿到新变量（env 在 spawn 时固定）——新建会话或重启该会话才生效，UI 需在保存后提示这一点。

- 只解密**本会话首次引用到的**凭据（惰性），并在切换会话/结束时清理；
- 展开后立即把值从 `process.env` 移除（子进程已继承）——**未验证**能否干净移除并保证子进程已复制，需要小实验；
- 变量名大小写统一（Windows env 不区分大小写）；
- 命令文本里只留变量名，权限 gate（`classifyShellCommand`）照常判断，不受影响。

### 4.3 输入（值永远不进对话）

- 新增 pi 扩展工具 `mpi_request_secret({ name, kind, level, purpose, remember })` → 主进程弹 **Electron 模态**（不进对话流）→ 写库 → 只回 `{ ref: "{{secret:name}}", saved: true }`。
- 用户手动添加走设置页「凭据」面板，同一条写库路径。
- 模态里输入的值：不经过 renderer 的 React state 之外任何地方；不写剪贴板、不进 undo 历史。

## 5. 显示 / 复制明文 → 一次验证

按已定策略：**只有「显示明文」和「复制明文」验证**；填充/展开不验证。

- 验证方式：WebAuthn `get()`（§2 已证可用），`userVerification: "required"`；
- 主机侧验签：COSE → JWK/PEM（ES256 需 X9.62 坐标转换），校验 `signCount` 递增、challenge 一次性 —— **未实现、未验证**；
- 明文显示 15s 自动隐藏；复制后不自动清空剪贴板（Windows 剪贴板历史会留存，需在 UI 里提示）；
- 闸门三次失败 → 锁定 60s 并写审计。

### 5.1 前置改造：渲染层 origin（必须在闸门之前做）

| 步骤 | 内容 | 风险 |
|---|---|---|
| 1 | 打包态改为进程内 loopback http server 提供 `out/renderer`，`src/main/index.ts:253-255` 分支改 `loadURL` | 动加载方式 = 大改动，按 `AGENTS.md` 跑全量测试 + 真机冒烟 |
| 2 | **端口固定**（否则每次启动都是新 origin） | 端口占用需处理；占不到时回退 `file://` 并禁用闸门 |
| 3 | 3 项 localStorage 迁到主进程配置：`store.ts` 的 `LAST_ACTIVE_KEY`、`Sidebar.tsx` 的宽度与分区折叠 | 一次性迁移，丢了只影响观感 |
| 4 | 端口只绑 `127.0.0.1`、只服务白名单静态文件 | 新增本地攻击面（只读 UI，不含 IPC） |
| 5 | CSP：`default-src 'self'` + `todoatt:`/`pi-preview:`/`chatatt:` 等自定义 scheme 需复验 | **未验证** |

## 6. 验证方式的备选

1. **WebAuthn（推荐）**：零原生依赖，前提是 §5.1 的 origin 改造。
2. **主密码**：scrypt 派生密钥作为 DPAPI 的 `pOptionalEntropy`；零依赖、跨平台、便携；体验是输 MPI 口令。**兜底方案**（origin 改造不做时用它）。
3. **原生 WinRT**（`UserConsentVerifier`）：成本最高（MPI 现为零原生模块，见 `package.json`），仅在需要「真密码学边界」（DPAPI-NG UI 策略 / TPM 绑定）时才考虑。

## 7. 远程授权矩阵

**凭据等级**（存库时选，或按用途推默认）

| level | 远程会话可用？ | 典型用途 |
|---|---|---|
| `silent` | ✅ 直接展开，不问 | 只读查询、测试机、最小权限账号 |
| `confirm` | ⚠ 需一次**意图确认**（手机端卡片） | 生产机密码、重启服务 |
| `local-only` | ❌ 一律拒绝并写审计 | root 密码、云控制台主账号 |

**来源判定**：`desktop` / `remote:<deviceId>` / 未知。
> ⚠ 现状：`backend.prompt(threadId, text, images, files, videos, media)` **没有来源参数**（`src/main/ipc.ts:3969`、`src/main/remote/service.ts:46`）。必须新增 `source` 形参，并按 2026-09-28 的教训声明为**必填但可为 undefined**（`source: PromptSource | undefined`），让漏传在编译期爆掉。

**P2 手机确认卡片**：复用现有 `mpi_ask_choice` / 权限卡片通道（E2E 已加密），卡片文案要**诚实定位**为「确认这是你要执行的操作」，不写成「身份验证」；每次确认授权该凭据 30 分钟免重复；确认/拒绝都写审计。

**远程被拒时的用户体验**：不静默失败 —— agent 要回一句「该凭据标记为仅本机可用，远程无法使用」，并给出改等级或换密钥认证的建议。

## 8. SSH 密钥 + agent（用户选定的根治方向）

- 主机侧由 MPI 启动**专用 `ssh-agent`**（Git Bash 自带），密钥私钥从 vault 解密后 `ssh-add` 进去，passphrase 也来自 vault；pi 的 bash 只拿到 `SSH_AUTH_SOCK`。
- 好处：私钥与 passphrase 都不进命令文本；签名在 agent 进程内完成；`ssh` 可用 `-o IdentitiesOnly` 精确指定。
- 生效范围：所有 `ssh` / `scp` / `rsync` / `git@` 操作自动受益，无需改命令习惯。
- 待验证：Windows 上 MPI 自管 agent 与系统 OpenSSH Authentication Agent 的冲突、`SSH_AUTH_SOCK` 在 pi 的 bash 子进程里是否随之继承（`mpi-shelenv-ext.ts` 已有 env 注入通道，但**未实测**）。
- 阿里云侧配套：给部署账号只授最小权限，能上 RAM 子账号 STS 临时令牌就不用长期密码。

## 9. 阶段、验收与测试范围

| 阶段 | 内容 | 验收 | 要跑的测试 |
|---|---|---|---|
| **P1a** | vault（DPAPI）+ 设置页凭据面板（增/删/改/遮蔽显示、等级、作用域）+ 审计文件 | 重启后凭据仍在；`credentials.json` 里无明文；`strings` 搜不到原值 | `typecheck` + 新增 `test:credentials` |
| **P1b** | ✅ 已做：env 注入（**仅 silent 级**）+ 凭据扩展把变量名与禁令写进系统提示 | 会话里 `echo $MPI_SECRET_X` 能拿到值，而 transcript / `mpi-diag.log` / 快照里搜不到值 | `npm test -- credentials`（env 映射 / 作用域 / 提示块均含断言）+ `npm run check:ext` |
| **P1c** | 远程矩阵：`source` 必填贯通 + `silent/confirm/local-only` 判定 + 审计 | 手机发起的会话用 `local-only` 凭据被拒且留下审计；`silent` 可用 | `npm test -- remote` + `test:pwa` |
| **P2** | 手机端确认卡片（`confirm` 级）+ 30 分钟授权窗口 | 手机上点确认后命令才执行；拒绝则中止 | `test:pwa` + `test:remote` |
| **P3（可选）** | 设备绑定断言（手机生物识别签名，主机只验签不下发明文） | 需先解决 PWA 的 https/域名 或安卓原生 BiometricPrompt | — |
| **独立前置** | §5.1 origin 改造 → WebAuthn 闸门 | dev(localhost:5173) 先验通天体验，再改打包态 | 大改：`typecheck` + 全量 `npm test` + 真机冒烟 |

## 10. 未验证 / 已知风险

1. **主机侧 COSE 验签**（`signCount`、challenge 一次性、ES256 坐标转换）未实现未验证。
2. **env 展开的清理**：`process.env` 移除后子进程是否已复制 —— 未验证；若不干净，退路径 C（临时 0600 文件）。
3. **origin 改造的爆炸半径**：`loadFile` → loopback http 属大改动；端口固定、localStorage 迁移、CSP 三项都可能带来回归。
4. **同用户进程可枚举 env**：Windows 上比 Unix 麻烦但非不可能，**未实测**；这是 A 路径的固有弱点，路径 B/C 可缓解。
5. **锁屏态**：主机锁屏时 Hello 弹窗无人应答 → `local-only` 与「显示明文」在远程/无人场景必然失败（这是设计约束，不是 bug）。
6. **`models.json` 明文 API key**（实测 5 个 `sk-…`）：迁进 vault 取决于 pi 是否支持 env 兜底/引用，**未验证**；建议单列一节后续处理，不与 P1 混。
7. **中继 PWA 现为 `http://<IP>`**：WebAuthn 需要 https + 域名，P3 之前无法在 PWA 上做设备断言。

## 11. 待拍板

1. `silent` 级凭据是否允许**未配对**的远程来源使用（当前建议：不允许）。
2. 30 分钟授权窗口是否对所有 `confirm` 凭据统一。
3. ~~`credentials.json` 与审计文件放在 `userData` 还是 `userData/security/` 子目录~~ → **已定：应用配置目录根**（P1a 已按此实现）。
4. §5.1 的 origin 改造是否单独排一个版本（建议：是）。
