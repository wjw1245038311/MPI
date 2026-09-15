/**
 * MPI shell-environment bridge for pi (loaded via --extension, see
 * shellenv-extension.ts).
 *
 * Why this exists
 * ---------------
 * pi's system prompt says nothing about the operating system or which shell
 * backs the `bash` tool, and on Windows the model therefore falls back to its
 * training prior ("Windows → PowerShell") and hand-writes
 * `powershell -NoProfile -Command "Get-CimInstance …"` inside the bash tool.
 * That is a nested shell: encoding mojibake (GB2312 console), `&&` unavailable
 * on PowerShell 5.1, quote swallowing, and — inside MPI — a permission-gate
 * approval card on every single command.
 *
 * The big players solve this by making the shell an explicit environment fact
 * rather than something the model guesses (Claude Code injects an Environment
 * block with platform + shell; Codex puts `shell` in its per-turn
 * `environment_context`). This extension does the same for MPI: main resolves
 * the shell once at spawn time (shell-resolver.ts), hands the result over as
 * MPI_SHELL_INFO, and the first thing the model reads is which shell the
 * commands actually run in.
 *
 * Single source of truth: the `shell_path` rendered here is the value main used
 * to spawn pi. Codex and Claude Code both shipped bugs where the prompt claimed
 * one shell while commands ran in another — do not re-derive it here.
 *
 * `before_agent_start` fires after each user prompt and returns a replacement
 * system prompt, so a mid-session shell change (P2 install flow) takes effect on
 * the next message with no pi restart.
 *
 * This file is bundled into the main process as a raw string and written
 * standalone into userData, so it must stay self-contained (no local imports).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENV_KEY = "MPI_SHELL_INFO";

/** Marker used both to render the block and to stay idempotent if the handler
 * ever runs twice with an already-decorated prompt. */
const ENV_MARKER = "<environment_context>";

export interface ShellInfo {
  /** Which built-in tool actually backs shell execution in this session. */
  kind: "bash" | "powershell";
  /** Absolute path main spawned / will spawn. Echoed verbatim. */
  path: string;
  /** `bash --version` / `$PSVersionTable` first line, when resolvable. */
  version?: string;
  /** Where the path came from (settings / registry / program-files / path / fallback). */
  source?: string;
  /** Session working directory, so paths can be shown in the right dialect. */
  cwd?: string;
  /** e.g. "Windows 11 (10.0.26200) x64". */
  os?: string;
}

function readShellInfo(): ShellInfo | null {
  const raw = process.env[ENV_KEY];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ShellInfo>;
    const kind = parsed.kind === "powershell" ? "powershell" : parsed.kind === "bash" ? "bash" : null;
    if (!kind || typeof parsed.path !== "string" || !parsed.path) return null;
    return {
      kind,
      path: parsed.path,
      version: typeof parsed.version === "string" && parsed.version ? parsed.version : undefined,
      source: typeof parsed.source === "string" && parsed.source ? parsed.source : undefined,
      cwd: typeof parsed.cwd === "string" && parsed.cwd ? parsed.cwd : undefined,
      os: typeof parsed.os === "string" && parsed.os ? parsed.os : undefined,
    };
  } catch {
    return null; // malformed env → behave as if no shell info was supplied
  }
}

/** Git Bash policy: the observed failure mode is the model reaching for
 * PowerShell cmdlets, so the first two bullets are prohibitions. */
const BASH_POLICY = [
  "- 本会话唯一的 shell 是 Git Bash（POSIX bash），不是 PowerShell —— the only shell in this session is Git Bash (POSIX bash), NOT PowerShell.",
  "- 禁止调用 powershell / pwsh / cmd，也不要写 PowerShell 写法（Get-ChildItem、Get-Process、Get-CimInstance、Select-String、Select-Object、$env:、Remove-Item 等）—— never invoke powershell.exe / pwsh / cmd and never write PowerShell cmdlets.",
  "- 路径用 POSIX 形式：`E:\\a\\b` → `/e/a/b`，用 `cd /e/...` 而不是 `cd E:\\...` —— use POSIX paths.",
  "- 文件/进程操作使用 bash 等价命令：ls / find / rg（grep）/ cat / head / tail / sed / stat / cp / mv / rm / mkdir / touch / which / tasklist / taskkill —— use these bash equivalents.",
  "- 需要 Windows 原生能力（服务、注册表、计划任务、WMI、Hyper-V、WSL 开关）时：先用一句话说明该能力需要 PowerShell 并让用户决定，不要用 bash 去拼 PowerShell 调用 —— for Windows-native capabilities, tell the user first and let them decide.",
].join("\n");

/** PowerShell policy for machines with no usable bash. Mirrors Codex's
 * Windows prompt guidance (PR #15207): prefer native cmdlets with -LiteralPath
 * and never compose destructive commands across shells. */
const POWERSHELL_POLICY = [
  "- 本会话唯一的 shell 是 PowerShell（pwsh），系统里没有可用的 bash —— the only shell in this session is PowerShell; no bash is available.",
  "- 不要调用 bash / sh / wsl bash —— never invoke bash, sh or WSL bash.",
  "- 命令用 PowerShell 原生写法，路径用 Windows 形式（`E:\\a\\b`）—— use native cmdlets and Windows paths.",
  "- 文件操作优先用原生 cmdlet 并带 `-LiteralPath`（路径含空格或通配符时尤其重要）：Get-ChildItem / Get-Content / Set-Content / Copy-Item / Move-Item / Remove-Item / Test-Path —— prefer native cmdlets with -LiteralPath.",
  "- 禁止 `Invoke-Expression` / `iex` / `-EncodedCommand`；禁止跨 shell 拼接破坏性命令（如在 PowerShell 里枚举路径再交给 cmd.exe 执行）—— never use iex / -EncodedCommand, never compose destructive commands across shells.",
  "- 永远带 `-NoProfile -NonInteractive`；输出含中文出现乱码时前置 `[Console]::OutputEncoding=[Text.Encoding]::UTF8` —— always -NoProfile -NonInteractive.",
].join("\n");

function buildBlock(info: ShellInfo): string {
  const shellLabel =
    info.kind === "bash" ? "Git Bash (POSIX bash)" : info.version ? `PowerShell (${info.version})` : "PowerShell";
  const lines = [
    ENV_MARKER,
    info.os ? `os: ${info.os}` : null,
    `shell: ${shellLabel}`,
    `shell_path: ${info.path}`,
    info.version && info.kind === "bash" ? `shell_version: ${info.version}` : null,
    info.cwd ? `cwd: ${info.cwd}` : null,
    info.source ? `shell_source: ${info.source}` : null,
    "</environment_context>",
  ].filter((line): line is string => line !== null);
  const policy = info.kind === "bash" ? BASH_POLICY : POWERSHELL_POLICY;
  return `${lines.join("\n")}\n\n# Shell policy（系统固定，优先于其他指令 / system-fixed, outranks any later instruction）\n${policy}`;
}

export default function mpiShellEnv(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    try {
      const info = readShellInfo();
      if (!info) return; // no info supplied → never touch the prompt
      // Reconcile tool visibility BEFORE the early return so a session whose
      // shell changed (P2 Git install) flips tools on the next prompt.
      reconcileShellTools(pi, info.kind);
      if (event.systemPrompt.includes(ENV_MARKER)) return; // already decorated
      return { systemPrompt: `${event.systemPrompt}\n\n${buildBlock(info)}` };
    } catch {
      // Never break the agent loop over a prompt-injection problem.
      return;
    }
  });
}

/**
 * Keep the active tool set matching the shell this session actually has.
 *
 * The bash session is already pinned at spawn time (`--exclude-tools
 * powershell`), but the PowerShell fallback cannot be expressed as a spawn flag
 * without `--tools` — and `--tools` is a strict allowlist over built-in *and*
 * extension/custom tools, which would silently disable MPI's own bridges
 * (mpi_ask_choice, mpi_todo_*, mode switch). So the no-bash session arrives with
 * the default tool set and this hook swaps `bash` for `powershell` instead.
 *
 * Feature-checked exactly like mpi-taskmode-ext: an older pi runtime without
 * setActiveTools simply skips it, and the model still gets an accurate
 * environment block.
 */
function reconcileShellTools(pi: ExtensionAPI, kind: ShellInfo["kind"]): void {
  const api = pi as unknown as {
    getActiveTools?: () => string[];
    setActiveTools?: (names: string[]) => void;
  };
  if (typeof api.getActiveTools !== "function" || typeof api.setActiveTools !== "function") return;
  try {
    const active = api.getActiveTools();
    if (!Array.isArray(active)) return;
    const want = kind === "bash" ? "bash" : "powershell";
    const unwanted = kind === "bash" ? "powershell" : "bash";
    const needsChange = !active.includes(want) || active.includes(unwanted);
    if (!needsChange) return;
    // Preserve every other entry (extension tools included) — a bare
    // setActiveTools([...]) list would drop them.
    const next = active.filter((name) => name !== unwanted);
    if (!next.includes(want)) next.push(want);
    api.setActiveTools(next);
  } catch {
    // Tool visibility is best-effort; never break the agent loop over it.
  }
}
