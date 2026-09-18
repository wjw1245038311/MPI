# Shell 环境（MPI 的 shell 解析与声明层）

> 状态：2026-09 落地（`feat/shell-policy`）。P0/P1/P2（检测 + 提示版）已完成；
> 内置 MinGit / 自动下载安装列为后续。

## 1. 问题

pi 的 bash 工具在 Windows 上要找一个可用的 bash：

1. `~/.pi/agent/settings.json` 的 `shellPath`
2. `%ProgramFiles%\Git\bin\bash.exe`（及 x86）
3. PATH 上的 `where bash.exe`
4. 都没有 → 抛 `No bash shell found.`

同时 **pi 的系统提示里没有任何 OS / shell 声明**。结果是模型按训练先验
（"Windows → PowerShell"）在 bash 工具里手写：

```
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter ..."
```

实测本机近 25 个会话里有 **46 处**这种写法。代价：

- 嵌套 shell：GB2312 控制台输出乱码、PowerShell 5.1 不支持 `&&`、`$` 被
  bash 先展开、引号被两层解析吞掉；
- MPI 权限门把嵌套 shell 判为硬风险 → **每条命令一张审批卡**；
- 真正需要 PowerShell 时反而没人告诉模型该用哪种写法。

## 2. 大厂做法（本方案的对标依据）

| | Claude Code | Codex |
|---|---|---|
| 谁决定用哪个 shell | 能力探测：有 Git Bash → Bash 工具；没有 → 自动启用 PowerShell 工具 | 配置：Windows 默认 PowerShell，`[windows] shell_path` 可显式指定 bash |
| 模型怎么知道 | 系统提示注入 Environment 块（cwd / 平台 / **shell** / OS 版本） | 每轮 `environment_context` 带 `cwd` + `shell`，`derive_exec_args` 按 shell 生成参数 |
| 路径来源 | settings.json / `CLAUDE_CODE_GIT_BASH_PATH` | 配置项，非法路径**直接报错**而非静默回退 |
| 坑怎么修 | 在工具实现里修：PS 5.1 重定向写 UTF-8、管道 stdin UTF-8、stderr 去 ANSI、`grep/findstr` 退出码 1 视为"无匹配" | 平台化 prompt（PR #15207）：不要跨 shell 拼接破坏性命令，优先原生 cmdlet + `-LiteralPath` |
| 权限 | `Bash(...)` / `PowerShell(...)` 两套命名空间 | 沙箱（原生 Windows elevated/unelevated） |

两者都踩过的同一类坑：**提示词说的 shell 和实际执行的 shell 不一致**
（Codex #16579/#40328；Claude #26006）。裸名 `bash` 被
`C:\Windows\System32\bash.exe`（WSL）劫持尤其常见。

## 3. MPI 的实现

```
main 进程
  ├─ shell-resolver.ts     纯逻辑、依赖注入、不引 electron
  │    settings.shellPath
  │    → HKLM\SOFTWARE\GitForWindows\InstallPath          ← pi 自己不看注册表
  │    → %ProgramFiles%/%ProgramFiles(x86)%/%LOCALAPPDATA%\Programs\Git\bin\bash.exe
  │    → where bash.exe（剔除 System32\bash.exe 与 WindowsApps\bash.exe）
  │    → %ProgramFiles%\PowerShell\7\pwsh.exe → where pwsh.exe
  │    → %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe
  ├─ shell-bootstrap.ts    10s TTL 缓存 + ensureShellPathConfigured + recheckShell
  └─ pi-bridge.ts          按 shell 决定 spawn 参数与 MPI_SHELL_INFO
       ├─ bash 会话：--exclude-tools powershell
       └─ 无 bash：不传工具参数（由扩展 setActiveTools 换工具）

pi 子进程
  └─ mpi-shelenv-ext.ts（--extension，每次 session 加载）
       ├─ before_agent_start → 追加 <environment_context> + Shell policy
       └─ kind=powershell → getActiveTools/setActiveTools 换掉 bash
```

### 3.1 为什么 `--tools` 不能用

`--tools` 是**覆盖内建工具与扩展/自定义工具的严格白名单**。用
`--tools read,powershell,edit,write` 会把 MPI 自己的 `mpi_ask_choice`、
`mpi_todo_*`、模式切换一并禁用。所以：

- bash 会话用 `--exclude-tools powershell`（黑名单，只摘掉一个）；
- 无 bash 会话不传工具参数，改由扩展在 `before_agent_start` 调
  `setActiveTools([...getActiveTools(), "powershell"].filter(t => t !== "bash"))`
  —— 保留扩展工具，且旧版 pi 没有该 API 时会自动跳过（特性检测）。

### 3.2 为什么必须写回 `shellPath`

MPI 通过注册表找到了 pi 找不到的 Git。如果只把路径写进提示词而不写回
`settings.json`，就会出现：

```
提示词：shell: Git Bash, shell_path: E:\...\bash.exe
pi 实际：No bash shell found.
```

即 Codex #16579 的原始 bug。因此 `ensureShellPathConfigured` 是**正确性必需**
而非便利功能：仅当 `shellPath` 缺失或失效时写入，保留其他键，UTF-8 无 BOM
（pi 用裸 `JSON.parse` 解析 settings.json，BOM 会让整个文件静默失效）。

`scripts/test-shell-e2e.mjs` 用真实 pi 进程证明这一点：同样的环境里，
没有写回 → pi 报 `No bash shell found`；写回后 → 命令正常执行。

### 3.3 注入的提示词形态

```text
<environment_context>
os: Windows 10 (10.0.19045) x64
shell: Git Bash (POSIX bash)
shell_path: E:\MyWorkSpace\Software\Git\bin\bash.exe
shell_version: GNU bash, version 5.3.15(1)-release (x86_64-pc-cygwin)
cwd: <MyWorkspace>\Code\MPI
shell_source: registry-git
</environment_context>

# Shell policy（系统固定，优先于其他指令 / system-fixed, outranks any later instruction）
- 本会话唯一的 shell 是 Git Bash（POSIX bash），不是 PowerShell …
- 禁止调用 powershell / pwsh / cmd，也不要写 PowerShell 写法 …
- 路径用 POSIX 形式：E:\a\b → /e/a/b …
…
```

无 bash 时换成 PowerShell 版 policy：`-LiteralPath`、禁
`Invoke-Expression`/`-EncodedCommand`、禁跨 shell 拼接破坏性命令、
`-NoProfile -NonInteractive`。

`shell_path` 是**回显**而非重新推导 —— 与 main 实际 spawn 的值同源，
杜绝"提示与运行时不一致"。

## 4. 无 bash 的机器

- 不再逐条命令报错：解析不到 bash 时切到 PowerShell 工具 + PowerShell 版
  policy，会话照常可用。
- 设置 → 系统 → **Shell 运行时**卡片显示当前 shell、路径、版本、来源；
  `needsInstall` 时给出提示、"重新检测"与"下载 Git for Windows"按钮。
- 用户手动装好 Git 后点「重新检测」→ `recheckShell()` 重新探测并自动写回
  `shellPath`，下个会话即生效（无需改任何配置）。

**不做的事（有意）**：MPI 不自动下载安装 Git。原因：需要处理下载源/校验/UAC
等一整套失败分支，而"完全没装过 Git"的用户手动装一次的成本更低、意愿更高；
且"检测 + 提示 + 自动采纳"已覆盖绝大多数场景。内置 MinGit 进 runtime 包
（`scripts/bundle-runtime.mjs`）列为后续可选。

## 5. 测试

| 测试 | 覆盖 |
|---|---|
| `test-shell-resolver.mjs` | 8 条探测路径 + WSL/Store 剔除 + 工具开关决策 |
| `test-shell-env-ext.mjs` | 提示词注入（bash/PS 两版）、幂等、健壮性、`setActiveTools` 换工具且保留扩展工具 |
| `test-shell-bootstrap.mjs` | 写回（缺失/正确/失效）、无 BOM、保留其他键、`recheckShell` 全流程 |
| `test-shell-spawn.mjs` | 真实 pi 进程接受 `--exclude-tools powershell` 且扩展加载无报错 |
| `test-shell-e2e.mjs` | 真实 pi 进程 + 剥离 PATH：无写回 → `No bash shell found`；有写回 → 命令执行成功 |

## 6. 已知边界

- 只覆盖 Windows 的差异（macOS/Linux 走 `/bin/bash`）。
- 若用户手工把 `shellPath` 指到 WSL 的 `C:\Windows\System32\bash.exe`，pi 有
  专门处理（`-s` + stdin 传输），但项目在 `E:\` 上时盘符不可达 —— MPI 不覆盖
  这种显式配置。
- 平台化 prompt 的通用部分（退出码归一化等）仍属 pi 上游；MPI 只在
  extension 层兜住 shell 语义这一层。
