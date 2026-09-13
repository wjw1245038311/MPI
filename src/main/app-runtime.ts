/**
 * App runtime — the thin host layer that lets an app ship a main-process
 * service module (manifest v2 `service`). Design: docs/APP-PLUGIN-DESIGN.md.
 *
 * Responsibilities (deliberately minimal — complexity lives in the app):
 *   - load the app's service module from inside its install directory
 *   - expose a small AppHost (status / log / field values / managed spawn)
 *   - run activate()/deactivate() with error containment (never crash main)
 *   - track managed child processes so they can be reaped on disable/quit
 *
 * The module NEVER writes config: activate() returns `{ voice }` and the caller
 * (app-store) applies it through the field-fingerprint rollback used by v1.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AppManifest,
  AppRuntimeStatus,
  AppServiceState,
} from "../renderer/src/lib/types";
import { isSafeAppRelPath } from "./app-store-core";

export const LOG_TAIL = 200;

/** What an app's service module may export. */
export interface ServiceModule {
  activate?: (host: AppHost) => Promise<{ voice?: Record<string, string> } | void> | { voice?: Record<string, string> } | void;
  deactivate?: (host: AppHost) => Promise<void> | void;
}

export interface AppHost {
  app: { id: string; dir: string; dataDir: string; version: string };
  env: { userData: string; platform: string; arch: string };
  /** Absolute path of the running executable (Electron or node). Apps can run
   *  a bundled runtime with ELECTRON_RUN_AS_NODE + `execPath`. */
  execPath: string;
  /** Saved form values (defaults included). */
  getFieldValues(): Record<string, string>;
  /** Report service state; persisted and pushed to the UI. */
  status(state: AppServiceState, detail?: string): void;
  /** Append one line to the app's rolling log. */
  log(line: string): void;
  /** Spawn a managed child process (requires the "process" capability). Returns pid or null.
   *  The child's stdout/stderr are forwarded to the app log when available. */
  spawn(command: string, args?: string[], opts?: { cwd?: string; env?: Record<string, string>; shell?: boolean }): number | null;
}

/** Injectable side-effect boundary so orchestration can be unit-tested. */
export interface RuntimeDeps {
  loadModule(absPath: string): Promise<ServiceModule>;
  spawnProcess(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    shell?: boolean,
    onOutput?: (line: string) => void,
  ): number | null;
  killProcess(pid: number): void;
  now(): string;
}

/** Kill a process and (on Windows) its whole tree — mirrors plugins.ts behavior. */
function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // already gone / not permitted — best effort
  }
}

/** Does the nearest package.json at/above `from` declare ESM ("type": "module")? */
function isEsmContext(from: string): boolean {
  let dir = dirname(from);
  for (;;) {
    try {
      const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { type?: unknown };
      return pj.type === "module";
    } catch {
      // no readable package.json here — keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) return false; // filesystem root
    dir = parent;
  }
}

export const defaultRuntimeDeps: RuntimeDeps = {
  loadModule: async (absPath) => {
    // An app reinstall/update replaces the service files IN PLACE, so a plain
    // import() would keep serving the module cached from the previous version
    // until MPI restarts. Load fresh every time:
    const ext = extname(absPath).toLowerCase();
    if (ext !== ".cjs" && isEsmContext(absPath)) {
      // True ESM: the cache is keyed by URL, so a changing query re-evaluates.
      const url = pathToFileURL(absPath);
      url.searchParams.set("mpiReload", String(Date.now()));
      return import(url.href) as Promise<ServiceModule>;
    }
    // CJS (.cjs / .js without type:module): require() with cache invalidation
    // (import()-ing a replaced .cjs still returns the cached evaluation).
    const req = createRequire(absPath);
    delete req.cache[req.resolve(absPath)];
    return Promise.resolve(req(absPath) as ServiceModule);
  },
  spawnProcess: (command, args, cwd, env, shell, onOutput) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: onOutput ? ["ignore", "pipe", "pipe"] : "ignore",
      shell: shell !== false,
      windowsHide: true,
    });
    if (onOutput && (child.stdout || child.stderr)) {
      const forward = (buf: Buffer): void => {
        for (const line of buf.toString("utf8").split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) onOutput(trimmed);
        }
      };
      child.stdout?.on("data", forward);
      child.stderr?.on("data", forward);
    }
    child.on("error", () => {
      /* surfaced via status by the caller's health polling */
    });
    return typeof child.pid === "number" ? child.pid : null;
  },
  killProcess: killTree,
  now: () => new Date().toISOString(),
};

/** Normalize a CJS/ESM module namespace into `{ activate, deactivate }`. */
export function normalizeServiceModule(mod: unknown): ServiceModule {
  const candidates = [mod, (mod as { default?: unknown } | null)?.default];
  for (const c of candidates) {
    if (c && typeof c === "object" && typeof (c as ServiceModule).activate === "function") {
      return c as ServiceModule;
    }
  }
  // A module with only deactivate is still valid (nothing to activate).
  for (const c of candidates) {
    if (c && typeof c === "object" && typeof (c as ServiceModule).deactivate === "function") {
      return c as ServiceModule;
    }
  }
  return {};
}

/** Path to the app's log file (logs/<id>.log under userData/apps). */
export function appLogPath(appsRoot: string, id: string): string {
  return join(appsRoot, "logs", `${id}.log`);
}

/** Append a line, keeping the file to the last LOG_TAIL lines. */
export function appendAppLog(appsRoot: string, id: string, line: string): void {
  const file = appLogPath(appsRoot, id);
  const dir = join(appsRoot, "logs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let existing: string[] = [];
  try {
    existing = readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
  } catch {
    // no log yet
  }
  existing.push(line);
  if (existing.length > LOG_TAIL) existing = existing.slice(existing.length - LOG_TAIL);
  writeFileSync(file, existing.join("\n") + "\n", "utf8");
}

/** Read the rolling log (empty when none). */
export function readAppLog(appsRoot: string, id: string): string[] {
  try {
    return readFileSync(appLogPath(appsRoot, id), "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

export interface ActivateOptions {
  manifest: AppManifest;
  /** Installed app directory. */
  dir: string;
  /** App-owned data dir (<userData>/apps/data/<id>). */
  dataDir: string;
  userData: string;
  fieldValues: Record<string, string>;
  /** Live set of managed pids (shared with the caller so it can reap on quit). */
  processes: Set<number>;
  deps: RuntimeDeps;
  setStatus(status: AppRuntimeStatus): void;
  log(line: string): void;
}

export interface ActivateResult {
  ok: boolean;
  /** Voice config fields the service wants applied (may be empty). */
  voice?: Record<string, string>;
  error?: string;
}

/** Resolve the service entry, refusing anything outside the app directory. */
export function resolveServiceEntry(dir: string, entry: string): string | null {
  if (!isSafeAppRelPath(entry)) return null;
  const abs = resolve(dir, entry);
  const rel = relative(dir, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
}

/** Build the host object handed to a service module. */
export function createAppHost(opts: {
  manifest: AppManifest;
  dir: string;
  dataDir: string;
  userData: string;
  fieldValues: Record<string, string>;
  processes: Set<number>;
  deps: RuntimeDeps;
  setStatus(status: AppRuntimeStatus): void;
  log(line: string): void;
}): AppHost {
  const { manifest, dir, dataDir, userData, fieldValues, processes, deps, setStatus, log } = opts;
  const capabilities = new Set(manifest.capabilities || []);
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  return {
    app: { id: manifest.id, dir, dataDir, version: manifest.version },
    env: { userData, platform: process.platform, arch: process.arch },
    execPath: process.execPath,
    getFieldValues: () => ({ ...fieldValues }),
    status: (state, detail) => setStatus({ state, detail, updatedAt: deps.now() }),
    log: (line) => log(typeof line === "string" ? line : String(line)),
    spawn: (command, args = [], spawnOpts = {}) => {
      if (!capabilities.has("process")) {
        log(`[host] spawn denied: app did not declare the "process" capability`);
        return null;
      }
      const cwd = spawnOpts.cwd && !isAbsolute(spawnOpts.cwd) ? join(dir, spawnOpts.cwd) : spawnOpts.cwd || dir;
      const pid = deps.spawnProcess(
        command,
        args,
        cwd,
        { ...process.env, ...(spawnOpts.env || {}) },
        spawnOpts.shell,
        (line) => log(`[child] ${line}`),
      );
      if (pid != null) processes.add(pid);
      return pid;
    },
  };
}

/**
 * Load + activate an app's service module. Never throws: failures are reported
 * as `{ ok:false, error }` and `status: error`.
 */
export async function activateService(opts: ActivateOptions): Promise<ActivateResult> {
  const { manifest, dir, dataDir, userData, fieldValues, processes, deps, setStatus, log } = opts;
  const spec = manifest.service;
  if (!spec) return { ok: true };

  const entryAbs = resolveServiceEntry(dir, spec.entry);
  if (!entryAbs || !existsSync(entryAbs)) {
    const error = `service entry not found: ${spec.entry}`;
    log(`[host] ${error}`);
    setStatus({ state: "error", detail: error, updatedAt: deps.now() });
    return { ok: false, error };
  }

  setStatus({ state: "starting", updatedAt: deps.now() });
  log(`[host] activating ${manifest.id} via ${spec.entry}`);
  // Record what the module reports so we don't clobber a deliberate error/ready
  // status with a blanket "ready" (the module owns readiness semantics).
  let lastStatus: AppRuntimeStatus | null = null;
  const recordStatus = (s: AppRuntimeStatus): void => {
    lastStatus = s;
    setStatus(s);
  };
  const host = createAppHost({
    manifest,
    dir,
    dataDir,
    userData,
    fieldValues,
    processes,
    deps,
    setStatus: recordStatus,
    log,
  });

  try {
    const mod = normalizeServiceModule(await deps.loadModule(entryAbs));
    const result = await mod.activate?.(host);
    const voice = result && typeof result === "object" ? result.voice : undefined;
    const reported = (lastStatus as AppRuntimeStatus | null)?.state;
    if (!reported || reported === "starting") setStatus({ state: "ready", updatedAt: deps.now() });
    log(`[host] ${manifest.id} activate finished (state=${(lastStatus as AppRuntimeStatus | null)?.state ?? "ready"})`);
    return { ok: true, ...(voice ? { voice } : {}) };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log(`[host] activate failed: ${error}`);
    setStatus({ state: "error", detail: error, updatedAt: deps.now() });
    return { ok: false, error };
  }
}

/** Run a service's deactivate hook, then reap its managed processes. */
export async function deactivateService(opts: {
  manifest: AppManifest;
  dir: string;
  dataDir: string;
  userData: string;
  fieldValues: Record<string, string>;
  processes: Set<number>;
  deps: RuntimeDeps;
  setStatus(status: AppRuntimeStatus): void;
  log(line: string): void;
}): Promise<void> {
  const { manifest, processes, deps, setStatus, log } = opts;
  const spec = manifest.service;
  if (spec) {
    const entryAbs = resolveServiceEntry(opts.dir, spec.entry);
    if (entryAbs && existsSync(entryAbs)) {
      try {
        const mod = normalizeServiceModule(await deps.loadModule(entryAbs));
        const host = createAppHost(opts);
        await mod.deactivate?.(host);
      } catch (e) {
        log(`[host] deactivate failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  for (const pid of processes) deps.killProcess(pid);
  processes.clear();
  if (spec) {
    setStatus({ state: "stopped", updatedAt: deps.now() });
    log(`[host] ${manifest.id} stopped`);
  }
}
