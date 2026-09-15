import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describeOs, resolveShell, shellToolFlags, type ResolvedShell, type ResolveShellOptions } from "./shell-resolver";

/**
 * Session-start shell state for MPI.
 *
 * Resolves which shell pi's bash tool will actually spawn, once per session
 * spawn, and packages it for two consumers:
 *
 *  1. the pi child process — `--exclude-tools powershell` keeps the model on
 *     bash (and MPI_SHELL_INFO lets mpi-shelenv-ext tell the model so);
 *  2. the desktop UI — so an unusable environment can be reported up front
 *     instead of failing as `No bash shell found` inside the transcript.
 *
 * The resolution spawns a couple of probe processes (`reg`, `where`,
 * `bash --version`), so it is cached briefly; `resetShellState()` forces a
 * re-probe when settings change or Git is installed from the UI.
 */

/** Payload handed to the extension via MPI_SHELL_INFO. */
export interface ShellInfoPayload {
  kind: ResolvedShell["kind"];
  path: string;
  version?: string;
  source: ResolvedShell["source"];
  cwd: string;
  os: string;
}

/** Read-only shell view for the Settings panel (no write-back). */
export interface ShellDiagnosticsView {
  kind: ResolvedShell["kind"];
  path: string;
  version: string | null;
  source: string;
  needsInstall: boolean;
  configuredPath: string | null;
  configuredPathStale: boolean;
  os: string;
}

export interface ShellState {
  shell: ResolvedShell;
  /** True when no usable bash exists — the UI offers to install Git for Windows. */
  needsInstall: boolean;
  /** `shellPath` from pi's settings.json when it points at a real file, else null. */
  configuredPath: string | null;
  /** True when shellPath was set but no longer exists (stale config). */
  configuredPathStale: boolean;
  /** os string rendered into the model's environment block. */
  os: string;
}

const CACHE_TTL_MS = 10_000;
let cache: { key: string; at: number; state: ShellState } | null = null;

/** Read pi's `shellPath` setting. Returns null for a missing/corrupt file. */
export function readShellPathFromSettings(settingsPath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    const value = parsed.shellPath;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/** Resolve (and briefly cache) the shell state for this machine. */
export function getShellState(settingsPath: string, options: { deps?: ResolveShellOptions["deps"] } = {}): ShellState {
  const key = settingsPath;
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS && !options.deps) return cache.state;

  const configuredPath = readShellPathFromSettings(settingsPath);
  const shell = resolveShell({ settingsShellPath: configuredPath, deps: options.deps });
  const state: ShellState = {
    shell,
    needsInstall: shell.kind !== "bash",
    configuredPath: shell.source === "settings" ? shell.path : null,
    configuredPathStale: !!configuredPath && shell.source !== "settings",
    os: describeOs(),
  };
  if (!options.deps) cache = { key, at: Date.now(), state };
  return state;
}

/**
 * Re-probe the shell after the user installed (or uninstalled) Git, for the
 * Settings → 系统 → 「重新检测」 button.
 *
 * Adopts the result via ensureShellPathConfigured and re-resolves afterwards so
 * the returned view reports the path that was just written — otherwise the UI
 * would keep showing "not configured" right after fixing it.
 */
export function recheckShell(settingsPath: string, deps?: ResolveShellOptions["deps"]): ShellDiagnosticsView {
  resetShellState();
  const before = getShellState(settingsPath, { deps });
  if (!ensureShellPathConfigured(settingsPath, before)) return shellDiagnostics(before);
  resetShellState();
  return shellDiagnostics(getShellState(settingsPath, { deps }));
}

/** Read-only view for the Settings panel — reports without writing shellPath. */
export function shellDiagnostics(state: ShellState): ShellDiagnosticsView {
  return {
    kind: state.shell.kind,
    path: state.shell.path,
    version: state.shell.version ?? null,
    source: state.shell.source,
    needsInstall: state.needsInstall,
    configuredPath: state.configuredPath,
    configuredPathStale: state.configuredPathStale,
    os: state.os,
  };
}

/** Drop the cached state (settings changed, Git installed, …). */
export function resetShellState(): void {
  cache = null;
}

/**
 * Persist the resolved bash path into pi's settings.json so pi's own
 * `getShellConfig()` finds the SAME shell we told the model about.
 *
 * This is not an optional convenience. MPI's resolver knows locations pi does
 * not (the Git for Windows registry key), so without this write-back a session
 * could be told "shell: Git Bash, shell_path: E:\...\bash.exe" while pi itself
 * still fails with `No bash shell found.` — precisely the prompt-vs-runtime
 * mismatch Codex (openai/codex#16579) and Claude Code both shipped.
 *
 * Writes only when a real bash was found and `shellPath` is missing or stale,
 * preserving every other key. UTF-8 without BOM (pi parses settings.json with a
 * plain JSON.parse, and a BOM makes the whole file silently fail to load).
 */
export function ensureShellPathConfigured(settingsPath: string, state: ShellState): boolean {
  if (state.shell.kind !== "bash") return false;
  if (state.configuredPath) return false; // already points at a real file

  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or unreadable settings → start from an empty object; a fresh
    // file with just shellPath is valid for pi.
  }

  settings.shellPath = state.shell.path;
  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    const tmp = join(dirname(settingsPath), `.settings.json.tmp-${process.pid}`);
    writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
    renameSync(tmp, settingsPath);
    return true;
  } catch {
    // A read-only agent dir must not break session startup — pi will just fall
    // back to its own (possibly failing) bash lookup.
    return false;
  }
}

/** Payload for the pi child process's MPI_SHELL_INFO. */
export function shellInfoPayload(shell: ResolvedShell, cwd: string): ShellInfoPayload {
  return {
    kind: shell.kind,
    path: shell.path,
    version: shell.version,
    source: shell.source,
    cwd,
    os: describeOs(),
  };
}

/** Everything a pi spawn needs, resolved and reconciled in one call. */
export interface PreparedShell {
  shell: ResolvedShell;
  /** MPI_SHELL_INFO payload for mpi-shelenv-ext. */
  info: ShellInfoPayload;
  /** pi spawn flags keeping exactly one shell tool available. */
  toolFlags: { tools?: string[]; excludeTools?: string[] };
  /** No usable bash → the UI should offer Git for Windows. */
  needsInstall: boolean;
  /** shellPath was (re)written into pi's settings.json before this spawn. */
  shellPathWritten: boolean;
}

/**
 * Resolve the shell for a session spawn and make pi agree with it.
 *
 * Shared by every spawn site (interactive threads and scheduled automation) so
 * the resolved path, the `--exclude-tools` flag and the model-facing
 * environment block can never drift apart.
 */
export function prepareShellForSpawn(settingsPath: string, cwd: string): PreparedShell {
  const state = getShellState(settingsPath);
  const shellPathWritten = ensureShellPathConfigured(settingsPath, state);
  return {
    shell: state.shell,
    info: shellInfoPayload(state.shell, cwd),
    toolFlags: shellToolFlags(state.shell),
    needsInstall: state.needsInstall,
    shellPathWritten,
  };
}
