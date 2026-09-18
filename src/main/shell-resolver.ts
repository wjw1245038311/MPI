import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { arch, release, type } from "node:os";
import { join } from "node:path";

/**
 * Resolve which shell backs pi's command execution on this machine.
 *
 * Why MPI needs its own resolver instead of trusting pi
 * ----------------------------------------------------
 * pi's `getShellConfig()` (dist/utils/shell.js) searches:
 *   1. settings.json `shellPath`
 *   2. %ProgramFiles%\Git\bin\bash.exe (and the x86 variant)
 *   3. `where bash.exe` on PATH
 * and throws `No bash shell found.` when none matches. Two gaps matter on real
 * Windows machines:
 *
 * - **Only the default install location is probed.** A Git installed elsewhere
 *   (this workstation: `E:\MyWorkSpace\Software\Git`) is invisible unless the
 *   user happened to set `shellPath`. The registry key Git for Windows itself
 *   stamps (`HKLM\SOFTWARE\GitForWindows` → `InstallPath`) covers that case.
 * - **`where bash.exe` can resolve to a WSL or Store shim.** Both
 *   `C:\Windows\System32\bash.exe` (the WSL launcher) and the
 *   `...\WindowsApps\bash.exe` app-execution alias exist on a stock Windows 11
 *   box; picking either silently runs commands in a Linux userland with a
 *   different PATH and no access to the project's drive-letter paths. Codex hit
 *   exactly this (openai/codex#40328, #16579) and Claude Code reports the same
 *   WSL aliasing problem (anthropics/claude-code#26006).
 *
 * The resolver is deliberately dependency-injected and free of Electron
 * imports so it can be unit-tested with a fake filesystem/PATH/registry.
 */

export type ShellKind = "bash" | "powershell";

export type ShellSource =
  | "settings" // ~/.pi/agent/settings.json → shellPath
  | "registry-git" // HKLM\SOFTWARE\GitForWindows → InstallPath
  | "program-files" // %ProgramFiles%\Git\bin\bash.exe & friends
  | "path" // `where bash.exe`, filtered
  | "fallback-pwsh" // PowerShell 7
  | "fallback-powershell"; // Windows PowerShell 5.1

export interface ResolvedShell {
  kind: ShellKind;
  /** Absolute path, always echoed into the model's environment block. */
  path: string;
  version?: string;
  source: ShellSource;
}

export interface ShellResolverDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  fileExists: (path: string) => boolean;
  /** All PATH matches for an executable, in `where`/`which` order. */
  where: (exe: string) => string[];
  /** Git for Windows install root from the registry, if present. */
  registryGitRoot: () => string | null;
  /** First line of the shell's `--version` (or PowerShell equivalent). */
  probeVersion: (path: string, kind: ShellKind) => string | null;
}

/** `C:\Windows\System32\bash.exe` — the WSL launcher, not a real bash for our
 * purposes: it maps to a Linux userland where `E:\...` cwd is unreachable. */
export function isWslBashPath(path: string): boolean {
  const normalized = path.replace(/\//g, "\\").toLowerCase();
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

/** `...\WindowsApps\bash.exe` — a zero-byte Store app-execution alias that
 * either opens the Store or forwards into WSL. Never a usable agent shell. */
export function isStoreAliasBashPath(path: string): boolean {
  const normalized = path.replace(/\//g, "\\").toLowerCase();
  return normalized.includes("\\windowsapps\\") && normalized.endsWith("\\bash.exe");
}

/** True when a `bash.exe` candidate is a shim we must not adopt. */
export function isRejectedBashPath(path: string): boolean {
  return isWslBashPath(path) || isStoreAliasBashPath(path);
}

/** Git ships two bash binaries; `bin\bash.exe` is the documented entry point
 * that also sets up the MSYS environment, so prefer it over `usr\bin`. */
function gitBashCandidates(root: string): string[] {
  return [join(root, "bin", "bash.exe"), join(root, "usr", "bin", "bash.exe")];
}

function windowsBashBashCandidates(deps: ShellResolverDeps, settingsShellPath?: string | null): {
  path: string;
  source: ShellSource;
}[] {
  const candidates: { path: string; source: ShellSource }[] = [];
  const push = (path: string, source: ShellSource) => {
    if (isRejectedBashPath(path)) return;
    if (!deps.fileExists(path)) return;
    candidates.push({ path, source });
  };

  if (settingsShellPath) push(settingsShellPath, "settings");

  const gitRoot = deps.registryGitRoot();
  if (gitRoot) for (const p of gitBashCandidates(gitRoot)) push(p, "registry-git");

  const roots = [deps.env.ProgramFiles, deps.env["ProgramFiles(x86)"], deps.env.LOCALAPPDATA
    ? join(deps.env.LOCALAPPDATA, "Programs")
    : undefined];
  for (const root of roots) {
    if (!root) continue;
    for (const p of gitBashCandidates(join(root, "Git"))) push(p, "program-files");
  }

  for (const p of deps.where("bash.exe")) push(p, "path");

  return candidates;
}

/** PowerShell 7 first (matches pi's own preference and fixes `&&`, UTF-8 and
 * quote handling), then the built-in 5.1. `%ProgramFiles%\PowerShell\7` is
 * probed before PATH because Store/MSIX installs expose a `WindowsApps` alias
 * that some launchers cannot exec (openai/codex#16579 comment 6). */
function windowsPowerShellCandidates(deps: ShellResolverDeps): { path: string; source: ShellSource }[] {
  const out: { path: string; source: ShellSource }[] = [];
  const seen = new Set<string>();
  const push = (path: string, source: ShellSource) => {
    const key = path.toLowerCase();
    if (seen.has(key)) return;
    if (!deps.fileExists(path)) return;
    seen.add(key);
    out.push({ path, source });
  };

  if (deps.env.ProgramFiles) {
    push(join(deps.env.ProgramFiles, "PowerShell", "7", "pwsh.exe"), "fallback-pwsh");
  }
  for (const p of deps.where("pwsh.exe")) push(p, "fallback-pwsh");

  const systemRoot = deps.env.SystemRoot ?? "C:\\Windows";
  push(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "fallback-powershell");
  for (const p of deps.where("powershell.exe")) push(p, "fallback-powershell");

  return out;
}

export interface ResolveShellOptions {
  /** `shellPath` from ~/.pi/agent/settings.json, read by the caller. */
  settingsShellPath?: string | null;
  deps?: Partial<ShellResolverDeps>;
}

/**
 * Resolve the shell for this machine. Resolution order mirrors the big players:
 * an explicit user setting wins (Claude Code's `CLAUDE_CODE_GIT_BASH_PATH`,
 * Codex's `windows.shell_path`), then a validated absolute Git Bash, and only
 * then PowerShell as an explicit, reported fallback — never a silent one.
 */
export function resolveShell(options: ResolveShellOptions = {}): ResolvedShell {
  const deps = { ...defaultDeps(), ...options.deps };

  if (deps.platform !== "win32") {
    const bash = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"].find((p) => deps.fileExists(p))
      ?? deps.where("bash")[0];
    if (bash) {
      return { kind: "bash", path: bash, source: "path", version: deps.probeVersion(bash, "bash") ?? undefined };
    }
    return { kind: "powershell", path: "pwsh", source: "fallback-pwsh" };
  }

  const bash = windowsBashBashCandidates(deps, options.settingsShellPath ?? null)[0];
  if (bash) {
    return { kind: "bash", path: bash.path, source: bash.source, version: deps.probeVersion(bash.path, "bash") ?? undefined };
  }

  const ps = windowsPowerShellCandidates(deps)[0];
  if (ps) {
    return {
      kind: "powershell",
      path: ps.path,
      source: ps.source,
      version: deps.probeVersion(ps.path, "powershell") ?? undefined,
    };
  }

  // Nothing on this machine can run a command. Report it instead of pretending;
  // the caller surfaces this as an install prompt.
  return { kind: "powershell", path: "powershell.exe", source: "fallback-powershell" };
}

/**
 * Spawn flags that keep exactly one shell available to the model.
 *
 * The bash case uses `--exclude-tools` (a denylist) rather than `--tools`
 * (a strict allowlist for built-ins *and* extension/custom tools) because the
 * allowlist would silently disable MPI's own bridge tools (mpi_todo_*,
 * mode switch). The PowerShell case passes no flag at all: the
 * shell-env extension reconciles the active tool set at runtime, which cannot
 * be expressed as a spawn flag without the same allowlist problem.
 */
export function shellToolFlags(shell: ResolvedShell): { tools?: string[]; excludeTools?: string[] } {
  return shell.kind === "bash" ? { excludeTools: ["powershell"] } : {};
}

/** PowerShell reported as the fallback while a real bash might be installable. */
export function needsBashInstall(shell: ResolvedShell): boolean {
  if (shell.kind !== "powershell") return false;
  // Windows PowerShell 5.1 present but no Git Bash at all → worth offering.
  return shell.source === "fallback-powershell" || shell.source === "fallback-pwsh";
}

/** e.g. "Windows 11 (10.0.26200) x64" — rendered into the environment block. */
export function describeOs(): string {
  const platform = type();
  const friendly =
    platform === "Windows_NT" ? /^10\.0\.26/.test(release()) ? "Windows 11" : "Windows 10" : platform;
  return `${friendly} (${release()}) ${arch()}`;
}

/** Read `HKLM\SOFTWARE\GitForWindows` → `InstallPath` via reg.exe. */
function readRegistryGitRoot(): string | null {
  const keys = ["HKLM\\SOFTWARE\\GitForWindows", "HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows"];
  for (const key of keys) {
    try {
      const res = spawnSync("reg.exe", ["query", key, "/v", "InstallPath"], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      });
      if (res.status !== 0 || !res.stdout) continue;
      for (const line of res.stdout.split(/\r?\n/)) {
        const m = /REG_SZ\s+(.+?)\s*$/.exec(line);
        if (m && m[1]) return m[1];
      }
    } catch {
      // ignore: registry lookup is best-effort
    }
  }
  return null;
}

/** Probe the shell's version. Best-effort and bounded — never throws. */
function probeVersion(path: string, kind: ShellKind): string | null {
  try {
    const args =
      kind === "bash"
        ? ["--version"]
        : ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"];
    const res = spawnSync(path, args, { encoding: "utf8", timeout: 8000, windowsHide: true });
    if (res.status !== 0 || !res.stdout) return null;
    const first = res.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

/** Real filesystem/PATH/registry bindings. */
export function defaultDeps(): ShellResolverDeps {
  return {
    platform: process.platform,
    env: process.env,
    fileExists: (path) => {
      try {
        return existsSync(path);
      } catch {
        return false;
      }
    },
    where: (exe) => {
      const cmd = process.platform === "win32" ? "where.exe" : "which";
      try {
        const res = spawnSync(cmd, process.platform === "win32" ? [exe] : ["-a", exe], {
          encoding: "utf8",
          timeout: 5000,
          windowsHide: true,
        });
        if (res.status !== 0 || !res.stdout) return [];
        return res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      } catch {
        return [];
      }
    },
    registryGitRoot: process.platform === "win32" ? readRegistryGitRoot : () => null,
    probeVersion,
  };
}
