import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { getBundledRuntime, resetPiRuntime, resolvePiRuntime } from "./pi-bridge";
import {
  cleanupRuntimeVersions,
  getActiveRuntimeRoot,
  getRuntimePackageManifest,
  installRuntimePackage,
  runtimeBaseDir as managedRuntimeBaseDir,
} from "./runtime-package";

/**
 * In-app updater for the pi core that MPI manages itself.
 *
 * The runtime managed by MPI is NOT a global npm/pnpm install, so
 * `pi update` refuses to touch it (detectInstallMethod returns "unknown").
 *
 * 只有一条可用路线：**安装发行包里内置的 standalone 运行时归档**。
 *   1. Ask https://pi.dev/api/latest-version for the latest release
 *      (the same endpoint pi's own version check uses).
 *   2. 设备上的 pi 低于内置版本（或就是要内置那一版）→ 直接装内置归档
 *      （离线、带 size/sha512 校验、不需要装依赖）。
 *   3. 上游比内置更新 → **应用内做不到**：pi 1.x 的 npm 包不再随包发布
 *      `npm-shrinkwrap.json`（也没有 bundleDependencies），原来「下载 tarball
 *      → 按锁逐个装依赖」的 registry 路线建不出可用的树，2026-10 起已删除。
 *      这种情况在下载之前就明确报错并指向「升级 MPI 本体」，见
 *      `coreUpdateBlockedMessage()`；新版本随 MPI 发行包内置。
 *   4. Activate by switching `<userData>/runtime/current.json` to a versioned
 *      tree. The pointer takes precedence over the legacy bundled copy and
 *      avoids fighting file locks on the running app's own resources.
 *
 * 旧的运行时树由 `cleanupRuntimeVersions()` 在启动时清理（运行中的会话可能还
 * 占着原生模块，Windows 不允许删）。
 */

const VERSION_URL = "https://pi.dev/api/latest-version";
const FETCH_TIMEOUT_MS = 30_000;

export type UpdateStage = "checking" | "downloading" | "installing" | "pruning" | "activating" | "done" | "error";

export interface CoreUpdateProgress {
  stage: UpdateStage;
  message: string;
  /** 0..100 within the current stage, when known. */
  pct?: number;
}

export interface CoreUpdateStatus {
  current: string | null;
  latest: string | null;
  hasUpdate: boolean;
  note?: string | null;
  /** Where the active app-managed runtime lives (legacy bundled dir or userData runtime). */
  source: "userData" | "bundled" | null;
  /** 发行包内置的运行时版本（dev 模式 / 旧安装包为 null）。 */
  embedded?: string | null;
  /** 「更新 Pi」按钮是否真能到达 latest（能装内置归档才算）。 */
  inAppUpdatable?: boolean;
  error?: string;
}

export interface CoreUpdateResult {
  ok: boolean;
  updated: boolean;
  from?: string | null;
  to?: string;
  /** 上游比内置新（或没有内置归档）⇒ 应用内装不了，需要升级 MPI 本体。 */
  blocked?: boolean;
  message: string;
}

type ProgressFn = (p: CoreUpdateProgress) => void;

/* ------------------------------ locations ------------------------------ */

/** Root of the updatable runtime area under Electron's userData dir. */
export function runtimeBaseDir(): string {
  return managedRuntimeBaseDir();
}

/** Version of the runtime the app currently uses (userData copy wins over bundled). */
export function readManagedPiStatus(): { version: string | null; source: "userData" | "bundled" | null } {
  const activeRoot = getActiveRuntimeRoot();
  const activePkg = activeRoot
    ? existsSync(join(activeRoot, "pi", "package.json"))
      ? join(activeRoot, "pi", "package.json")
      : join(activeRoot, "package.json")
    : null;
  if (activePkg && existsSync(activePkg)) {
    try {
      const v = (JSON.parse(readFileSync(activePkg, "utf8")) as { version?: string }).version;
      if (v) return { version: v, source: "userData" };
    } catch {
      /* fall through to bundled */
    }
  }
  const bundled = getBundledRuntime();
  if (bundled) {
    try {
      const pkgPath = join(dirname(dirname(bundled.cli)), "package.json");
      const v = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version;
      if (v) return { version: v, source: "bundled" };
    } catch {
      /* ignore */
    }
  }
  return { version: null, source: null };
}

/* ------------------------------- helpers ------------------------------- */

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function fetchJson<T>(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<T> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "mpi-updater" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

/**
 * rmSync that tolerates Windows file-lock races: antivirus/indexers
 * transiently hold handles on freshly written files, making plain recursive
 * rmSync fail with ENOTEMPTY/EBUSY. maxRetries makes Node back off and retry;
 * the outer try keeps cleanup paths from ever taking down the update flow —
 * leftovers are swept by cleanupOldRuntimes() on next launch.
 */
function rmSafe(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  } catch {
    /* best effort */
  }
}

/* ------------------------------ public API ------------------------------ */

/** Version from the package.json that owns a cli.js (same layout as diagnostics). */
function readVersionFromCli(cli: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(dirname(cli)), "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** Check pi.dev for the latest release and compare with the runtime MPI will
 * actually use. The comparison must follow the same resolution as diagnostics
 * and app:updatePi: dev mode and a custom piCliPath point at a system install,
 * where the managed copy is absent — comparing only it made every check report
 * an update even when the running Pi was already latest (the panel then showed
 * current = latest with a stale「可更新」tag). */
export async function checkForCoreUpdate(cliOverride?: string): Promise<CoreUpdateStatus> {
  const { version: managedVersion, source } = readManagedPiStatus();
  let current: string | null = managedVersion;
  try {
    const rt = await resolvePiRuntime(cliOverride);
    current = readVersionFromCli(rt.cli) || current;
  } catch {
    /* no resolvable pi at all — keep the managed value (possibly null) */
  }
  // 发行包内置的运行时版本：决定「更新 Pi」按钮能不能真的到达 latest。
  const embedded = getRuntimePackageManifest()?.runtimeVersion ?? null;
  try {
    const rel = await fetchJson<{ version?: string; packageName?: string; note?: string | null }>(VERSION_URL);
    const latest = typeof rel.version === "string" ? rel.version.trim() : "";
    if (!latest) {
      return { current, latest: null, hasUpdate: false, source, embedded, inAppUpdatable: false, error: "版本检查返回为空" };
    }
    if (!current) {
      return {
        current: null,
        latest,
        hasUpdate: false,
        source,
        embedded,
        inAppUpdatable: canUpdateInApp(null, embedded, latest),
        error: "无法确定当前 Pi 版本（未找到可用的 pi）",
      };
    }
    const hasUpdate = compareVersions(latest, current) > 0;
    return {
      current,
      latest,
      hasUpdate,
      note: rel.note || null,
      source,
      embedded,
      inAppUpdatable: canUpdateInApp(current, embedded, latest),
    };
  } catch (e: any) {
    return { current, latest: null, hasUpdate: false, source, embedded, inAppUpdatable: false, error: e?.message || String(e) };
  }
}

/**
 * 「更新 Pi」该不该直接装 MPI 自带的运行时归档（而不是去 registry 拿）。
 *
 * 规则（按用户的决定）：**设备上的 pi 低于本安装包内置的版本，就直接装内置那份**。
 * 内置归档是打包时生成、带 size/sha512 校验的完整树（node + pi + 依赖），不需要再装
 * 依赖——而 pi 1.x 的 npm 包已不再随包发布 `npm-shrinkwrap.json`，registry 路线建不出
 * 可用的树。因此这里只在「设备比内置旧」或「要的就是内置这一版」时返回 true。
 */
export function shouldInstallEmbeddedRuntime(current: string | null, embedded: string | null, targetVersion: string): boolean {
  if (!embedded) return false; // 没有内置归档（dev / 旧发行版）⇒ 应用内装不了
  if (embedded === targetVersion) return true; // 要的就是这一版：一个归档解决
  return !current || compareVersions(current, embedded) < 0; // 设备比内置旧 ⇒ 先吃内置（离线、快）
}

/**
 * 「更新 Pi」能不能到达目标版本？只有两种情况能：
 *   · 设备版本已经 ≥ 上游最新（无需安装）；
 *   · 目标版本（或比设备新的版本）就在 MPI 内置归档里 —— 直接装内置那份。
 *
 * 上游比内置更新时**应用内做不到**：pi 1.x 的 npm 包不再随包发布
 * `npm-shrinkwrap.json`，registry 路线建不出可用的运行时树（2026-10 已删除该路径）。
 * 内置归档是打包时生成、带 size/sha512 校验的完整树（node + pi + 依赖），不需要装依赖。
 */
export function canUpdateInApp(current: string | null, embedded: string | null, latest: string | null): boolean {
  if (!latest) return false;
  if (current && compareVersions(latest, current) <= 0) return true; // 已是最新，无需安装
  return shouldInstallEmbeddedRuntime(current, embedded, latest);
}

/** 上游超前、应用内装不了时的说明（设置面板与更新按钮共用同一段文案）。 */
export function coreUpdateBlockedMessage(latest: string, embedded: string | null, current?: string | null): string {
  const now = current ? `当前 v${current}` : "当前版本";
  if (embedded) {
    return `上游 Pi 已发布 v${latest}，但 MPI 只能安装自己内置的运行时（本版内置 v${embedded}）。`
      + "pi 1.x 的 npm 包不再提供依赖锁文件，应用内无法从 registry 拼出完整运行时；"
      + `请在「MPI 应用更新」里升级 MPI 本体（新版本会内置更新的 Pi 运行时），${now} 保持可用。`;
  }
  return `上游 Pi 已发布 v${latest}，但当前 MPI 没有内置 Pi 运行时（开发模式或旧安装包），无法在应用内更新。`
    + `请安装带内置运行时的 MPI 发行版（${now}）。`;
}

/** Download and activate the latest pi core. Safe to call when already latest
 * (resolves with updated=false). Progress is reported via onProgress. */
export async function installCoreUpdate(onProgress?: ProgressFn): Promise<CoreUpdateResult> {
  const progress: ProgressFn = onProgress || (() => undefined);

  try {
    // ---- check -----------------------------------------------------------
    progress({ stage: "checking", message: "正在检查最新版本…" });
    const status = await checkForCoreUpdate();
    if (status.error) throw new Error(`检查更新失败：${status.error}`);
    if (!status.latest) throw new Error("无法获取最新版本信息");
    if (!status.hasUpdate) {
      return { ok: true, updated: false, from: status.current, message: `Pi 已是最新版本（v${status.current}）` };
    }
    const targetVersion = status.latest;
    progress({ stage: "checking", message: `发现新版本 v${targetVersion}（当前 v${status.current || "?"}）` });

    // 只有发行包内置的运行时归档可以装。设备比内置旧就装它（离线、有校验），
    // 这样「更新 Pi」在断网/上游超前时也仍然可用。
    // 上游比内置更新的情况在**下载之前**就明确失败：旧实现会先下载整个 tarball，
    // 才发现 pi 1.x 不带 npm-shrinkwrap.json（registry 路线已删除）。
    const standalone = getRuntimePackageManifest();
    const embedded = standalone?.runtimeVersion || null;
    if (standalone && embedded && shouldInstallEmbeddedRuntime(status.current, embedded, targetVersion)) {
      const root = await installRuntimePackage(standalone, (p) => progress({ stage: p.stage, message: p.message, pct: p.pct }));
      resetPiRuntime();
      const upstreamAhead = embedded !== targetVersion;
      return {
        ok: true,
        updated: true,
        from: status.current,
        to: embedded,
        message: upstreamAhead
          ? `已安装 MPI 自带的 Pi 运行时 v${embedded}（当前 v${status.current || "?"} 更旧）到：${root}。`
            + `上游最新版是 v${targetVersion}，要拿到它请升级 MPI 本体（内置运行时会跟着发版）。`
          : `Pi 运行时 v${embedded} 已作为独立包安装到应用数据目录：${root}`,
      };
    }

    const blocked = coreUpdateBlockedMessage(targetVersion, embedded, status.current);
    progress({ stage: "error", message: blocked });
    return { ok: false, updated: false, blocked: true, from: status.current, message: blocked };
  } catch (e: any) {
    const message = e?.message || String(e);
    progress({ stage: "error", message });
    return { ok: false, updated: false, message: `Pi 更新失败：${message}` };
  }
}

/**
 * Best-effort removal of superseded runtime trees and stale staging dirs.
 * Called at startup, when no pi child process can hold files open.
 */
export function cleanupOldRuntimes(): void {
  let base: string;
  try {
    base = runtimeBaseDir();
  } catch {
    return;
  }
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return; // runtime dir never created
  }
  for (const name of entries) {
    if (/^pi\.old-/.test(name) || /^\.staging-/.test(name)) {
      rmSafe(join(base, name)); // still locked → silently retried next launch
    }
  }
  cleanupRuntimeVersions();
}
