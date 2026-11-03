import { app, net } from "electron";
import { autoUpdater, type ProgressInfo, type UpdateCheckResult, type UpdateInfo } from "electron-updater";
import { getConfig, updateConfig } from "./config";
import { builtinServer } from "../shared/builtin-server";
import {
  APP_UPDATE_ECS_PROBE_TIMEOUT_MS,
  resolveAppUpdateFeed,
  type AppUpdateFeedTarget,
} from "../shared/app-update-feed";
import { beginTransfer, endTransfer, updateTransfer } from "./transfer-monitor";

const OWNER = "wjw1245038311";
const REPO = "MPI";
const REPOSITORY = OWNER + "/" + REPO;
const RELEASES_LATEST_URL = "https://github.com/" + REPOSITORY + "/releases/latest";
// 应用自更新：**自建中继镜像优先、GitHub 回退**，但只对「已授权」的机器（见下）。
// 中继（用户的 ECS）在国内比 GitHub 快得多，但可能没部署/挂了，所以一律先做一次短超时
// 预探测（5s），通了才把它交给 electron-updater（check 与下载都走同一个源）。
//
// 2026-10-16 改造：**更新源不再从「手机远程控制」的通道列表推导**（那个耦合的后果是：
// 没配中继通道的机器永远只查 GitHub，而小版本按发版铁律不推 GitHub → 永远查不到更新）。
// 现在更新源有自己的配置（`appUpdateSource` / `appUpdateEcsUrl` / `appUpdateEcsToken`，
// 见 shared/app-update-feed.ts）；默认 GitHub，**在这台机器上显式选过 ECS 的才算授权**，
// 所以别人的安装仍然不会碰这台 ECS。旧机器由 config.ts 做一次性迁移。
// 发布流程：CI 把 dist/ 的 MPI-Setup-x.y.z.exe + latest.yml（+ .blockmap）挂到 GitHub Release，
// 同时把同样三份文件推上中继的静态目录（路径见 shared/app-update-feed.ts，脚本见 scripts/publish-release.mjs）。
// Pi 核心更新（core-updater.ts，走 npm registry）不受影响。

export type AppUpdateStage = "checking" | "downloading" | "ready" | "installing" | "error";

/** 本次检查/下载实际用的源：中继镜像还是 GitHub。 */
export type AppUpdateSource = "relay" | "github";

export interface AppUpdateProgress {
  stage: AppUpdateStage;
  message: string;
  /** 0..100 while electron-updater reports download progress. */
  pct?: number;
}

export interface AppUpdateStatus {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  source: AppUpdateSource | null;
  releaseUrl: string | null;
  assetName: string | null;
  /** Whether this platform has a supported installer asset. */
  supported: boolean;
  /** Whether the current process is a packaged (installed) build. Dev runs
   * cannot check GitHub Releases, so the renderer explains that instead of
   * silently returning an empty status with no feedback. */
  packaged: boolean;
  /** Whether the current process can install and restart the packaged app. */
  installable: boolean;
  downloaded: boolean;
  /** 用户点过「跳过此版本」，且跳过的正是当前 latest。 */
  skipped: boolean;
  /** 发布说明（Markdown，取自 Release body）；无说明或不可用时为 null。 */
  notes: string | null;
  error?: string;
}

export interface AppUpdateResult {
  ok: boolean;
  downloaded: boolean;
  version?: string | null;
  message: string;
}

let configured = false;
let latestUpdateInfo: UpdateInfo | null = null;
let downloadedVersion: string | null = null;
let lastUpdaterError: string | null = null;
let checkPromise: Promise<UpdateCheckResult | null> | null = null;
let downloadPromise: Promise<Array<string>> | null = null;
let progressSink: ((progress: AppUpdateProgress) => void) | null = null;
/** Active long-task-monitor entry for the in-flight app update download. */
let appDownloadTransferId: string | null = null;
/** 当前正在探测的源；探测失败时的 error 事件不报给 UI（否则中继挂了会先弹一次错，回退成功后又消失）。 */
let probing = false;
/** 上次成功的源（statusFromInfo 用它回填 source）。 */
let activeSource: AppUpdateSource = "github";

/**
 * 本次要用的自更新源（读配置 + `MPI_APP_UPDATE_URL` 覆盖；纯函数在 shared/app-update-feed.ts）。
 *
 * 源**跟随「服务器」配置**（2026-10-16 定稿，不再有独立的更新源设置）：选了内置服务器
 * 且填了授权码 → 走它的镜像（5s 预探测，不通回 GitHub）；自定义服务器不镜像安装包 → GitHub。
 * 每次检查都重算：用户在设置里改了服务器，不需要重启应用就能生效。
 */
function updateFeedTarget(): AppUpdateFeedTarget {
  const cfg = getConfig();
  return resolveAppUpdateFeed({
    overrideUrl: process.env.MPI_APP_UPDATE_URL,
    customRelayUrl: cfg.customRelayUrl,
    authCode: cfg.serverAuthCode,
    // 地址来自混淆内置的描述（shared/builtin-server.ts）；没授权码时上面那个纯函数直接返回 GitHub。
    mirrorUrl: builtinServer()?.mirrorUrl,
  });
}

/**
 * ECS 镜像的**短超时预探测**（关键：不这样做就得等 electron-updater 的 60s 默认超时）。
 *
 * 只取 `<feed>latest.yml`（generic provider 检查更新时读的就是它），带授权令牌：
 * 2xx = 可用；401/403（中继开了硬门控而令牌不对）/超时/网络错误/非 2xx 一律当作不可用，
 * 直接回退 GitHub（探测失败不报给 UI，否则会先闪一下错）。
 */
async function probeRelayFeed(target: AppUpdateFeedTarget): Promise<boolean> {
  if (target.source !== "relay" || !target.url) return false;
  let url: string;
  try {
    url = new URL("latest.yml", target.url).toString();
  } catch {
    return false;
  }
  try {
    const response = await net.fetch(url, {
      method: "GET",
      headers: {
        ...(target.token ? { authorization: `Bearer ${target.token}` } : {}),
        "cache-control": "no-cache",
      },
      signal: AbortSignal.timeout(APP_UPDATE_ECS_PROBE_TIMEOUT_MS),
    });
    // 体不要了：探测只关心可达性与授权结果。
    try {
      await response.body?.cancel();
    } catch {
      /* bodyless response */
    }
    return response.ok;
  } catch {
    return false;
  }
}

/** 把 provider 切到指定源（relay 时同时带上授权令牌，check 与差量下载共用它）。 */
function applyFeed(source: AppUpdateSource, target: AppUpdateFeedTarget): void {
  if (source === "relay" && target.url) {
    // GenericProvider 会读 `<url>/latest.yml`（windows 的 channel 文件名）。
    autoUpdater.setFeedURL({ provider: "generic", url: target.url, channel: "latest" });
    autoUpdater.requestHeaders = target.token ? { Authorization: `Bearer ${target.token}` } : null;
    return;
  }
  autoUpdater.setFeedURL({ provider: "github", owner: OWNER, repo: REPO });
  autoUpdater.requestHeaders = null;
}

/** 用户点过「跳过此版本」的版本号；空串 = 未跳过。 */
export function appUpdateSkipVersion(): string {
  const value = getConfig().appUpdateSkipVersion;
  return normalizeVersion(typeof value === "string" ? value : "");
}

/** 把某个版本标记为「跳过」。只影响后台提示与卡片上的提示，不阻止手动更新。 */
export function skipAppUpdateVersion(version: string): void {
  const normalized = normalizeVersion(version);
  updateConfig({ appUpdateSkipVersion: normalized });
}

/** 取消跳过（用户反悔 / 想重新收到提示）。 */
export function clearAppUpdateSkip(): void {
  if (appUpdateSkipVersion()) updateConfig({ appUpdateSkipVersion: "" });
}

/**
 * 发布说明 → Markdown。electron-updater 的 releaseNotes 可能是纯文本，也可能是
 * GitHub 的 release body；两种都归一到 Markdown（Markdown 渲染器只认 md）。
 * 上限 4000 字：更新弹窗不是文档阅读器，长文请点「查看更新日志」。
 */
function updateNotes(info: UpdateInfo): string | null {
  const raw = (info as { releaseNotes?: unknown }).releaseNotes;
  let text = "";
  if (typeof raw === "string") {
    text = raw;
  } else if (Array.isArray(raw)) {
    text = raw
      .map((item) => (item && typeof item === "object" && typeof (item as { note?: unknown }).note === "string"
        ? ((item as { note: string }).note)
        : ""))
      .filter(Boolean)
      .join("\n\n");
  }
  if (!text.trim()) return null;
  const normalized = text
    .replace(/<h3[^>]*>/gi, "\n### ")
    .replace(/<\/h3>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|ul|ol|li|div|strong|b|em|i|code)[^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalized.length > 4000 ? normalized.slice(0, 4000) + "\n\n…" : normalized;
}

function normalizeVersion(raw: string): string {
  const value = String(raw || "").trim().replace(/^v/i, "");
  const match = /^(\d+(?:\.\d+){0,2})(?:[-+].*)?$/.exec(value);
  return match?.[1] || value;
}

function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = normalizeVersion(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const delta = (pa[i] || 0) - (pb[i] || 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

/** Map electron-updater's raw errors to user-readable Chinese (no releases yet / GitHub unreachable).
 *
 * `noRelay`：这台机器没有可用的中继镜像（未激活 / 自定义服务器 / 上游没配置），
 * 更新检查只能走 GitHub。国内网络常见 `net::ERR_CONNECTION_RESET`（连接被重置），
 * 这种时候必须告诉用户「打开发布页手动下载」，而不是只丢一句「无法连接」。 */
function friendlyUpdaterError(message: unknown, noRelay = false): string {
  const m = String(message || "");
  if (/404|not found|no release/i.test(m)) return "GitHub 仓库还没有发布版本（或无法访问该仓库）";
  const reset = /ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_ABORTED/i.test(m);
  const networkIssue = reset
    || /(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE|ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_SSL_|net::ERR_|fetch failed|network)/i.test(m);
  if (!networkIssue) return m;
  const base = reset
    ? "连接 GitHub 被中断（net::ERR_CONNECTION_RESET，常见于国内网络）"
    : "无法连接 GitHub，请检查网络后重试";
  return noRelay
    ? `${base}。未激活内置服务器时，更新检查只能走 GitHub：可以点「打开发布页」手动下载安装包，或先激活服务器再重试。`
    : base;
}

function isWindowsInstallerSupported(): boolean {
  return process.platform === "win32";
}

function isPackagedInstallable(): boolean {
  return isWindowsInstallerSupported() && app.isPackaged;
}

function emitProgress(progress: AppUpdateProgress): void {
  try {
    progressSink?.(progress);
  } catch {
    // A renderer can disappear while the updater is still downloading.
    progressSink = null;
  }
}

function updateAssetName(info: UpdateInfo): string | null {
  const exeFile = info.files?.find((file) => /\.exe(?:$|\?)/i.test(file.url) && !/\.blockmap/i.test(file.url));
  const raw = info.path || exeFile?.url || "";
  if (!raw) return null;
  const withoutQuery = raw.split(/[?#]/, 1)[0];
  return decodeURIComponent(withoutQuery.split(/[\\/]/).pop() || withoutQuery);
}

function releaseUrl(version: string): string {
  return "https://github.com/" + REPOSITORY + "/releases/tag/v" + encodeURIComponent(version);
}

function isWindowsUpdateInfo(info: UpdateInfo): boolean {
  return Boolean(updateAssetName(info) && /\.exe$/i.test(updateAssetName(info) || ""));
}

function statusFromInfo(current: string, info: UpdateInfo): AppUpdateStatus {
  const latest = normalizeVersion(info.version);
  const supported = isWindowsInstallerSupported() && isWindowsUpdateInfo(info);
  const installable = supported && app.isPackaged;
  const hasUpdate = compareVersions(latest, current) > 0;

  return {
    current,
    latest,
    hasUpdate,
    source: activeSource,
    releaseUrl: releaseUrl(latest),
    assetName: updateAssetName(info),
    supported,
    packaged: app.isPackaged,
    installable,
    downloaded: downloadedVersion === latest,
    skipped: latest === appUpdateSkipVersion(),
    notes: updateNotes(info),
    ...(lastUpdaterError ? { error: lastUpdaterError } : {}),
  };
}

function emptyStatus(current: string, error?: string): AppUpdateStatus {
  return {
    current,
    latest: null,
    hasUpdate: false,
    source: null,
    releaseUrl: RELEASES_LATEST_URL,
    assetName: null,
    supported: isWindowsInstallerSupported(),
    packaged: app.isPackaged,
    installable: isPackagedInstallable(),
    downloaded: false,
    skipped: false,
    notes: null,
    ...(error ? { error } : {}),
  };
}

function configureUpdater(): void {
  if (configured) return;
  configured = true;

  // The settings page explicitly controls when to download/install.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = {
    info: (message?: unknown) => console.info("[electron-updater]", message),
    warn: (message?: unknown) => console.warn("[electron-updater]", message),
    error: (message?: unknown) => console.error("[electron-updater]", message),
  };

  autoUpdater.on("checking-for-update", () => {
    emitProgress({ stage: "checking", message: "正在检查最新版本…" });
  });

  autoUpdater.on("update-available", (info) => {
    latestUpdateInfo = info;
    lastUpdaterError = null;
    const version = normalizeVersion(info.version);
    if (downloadedVersion && downloadedVersion !== version) downloadedVersion = null;
  });

  autoUpdater.on("update-not-available", (info) => {
    latestUpdateInfo = info;
    lastUpdaterError = null;
  });

  autoUpdater.on("download-progress", (info: ProgressInfo) => {
    const pct = Number.isFinite(info.percent) ? Math.max(0, Math.min(100, Math.round(info.percent))) : undefined;
    emitProgress({
      stage: "downloading",
      message: "正在下载 MPI v" + normalizeVersion(latestUpdateInfo?.version || "") + "…",
      ...(pct === undefined ? {} : { pct }),
    });
    if (appDownloadTransferId) {
      updateTransfer(appDownloadTransferId, {
        doneBytes: info.transferred,
        totalBytes: info.total,
        speedBps: Number.isFinite(info.bytesPerSecond) ? info.bytesPerSecond : undefined,
      });
    }
  });

  autoUpdater.on("update-downloaded", (info) => {
    latestUpdateInfo = info;
    downloadedVersion = normalizeVersion(info.version);
    if (appDownloadTransferId) endTransfer(appDownloadTransferId);
    appDownloadTransferId = null;
    emitProgress({
      stage: "ready",
      message: "MPI v" + downloadedVersion + " 已下载，可以安装并重启",
      pct: 100,
    });
  });

  autoUpdater.on("error", (error, message) => {
    // 探测期的失败不上报：中继挂了本来就要回退 GitHub，报出去只会在 UI 里闪一下错。
    if (probing) return;
    lastUpdaterError = friendlyUpdaterError(message || error?.message || String(error));
    if (appDownloadTransferId) endTransfer(appDownloadTransferId);
    appDownloadTransferId = null;
    emitProgress({ stage: "error", message: lastUpdaterError });
  });
}

async function checkWithUpdater(): Promise<UpdateCheckResult | null> {
  configureUpdater();
  if (checkPromise) return checkPromise;
  checkPromise = autoUpdater.checkForUpdates().finally(() => {
    checkPromise = null;
  });
  return checkPromise;
}

/** 把 provider 切到指定源并检查一次。源不可用（relay 但没授权）时返回 null。 */
async function checkOnFeed(source: AppUpdateSource, target: AppUpdateFeedTarget): Promise<UpdateCheckResult | null> {
  if (source === "relay" && !target.url) return null;
  applyFeed(source, target);
  return await checkWithUpdater();
}

/**
 * 逐源探测：中继镜像 → GitHub，用第一个成功的结果。
 *
 * 为什么不用 electron-updater 自带的回退：它没有多源概念（provider 只有一个），
 * 「中继挂了再回 GitHub」必须自己写。探测期的 error 事件被 `probing` 抑制。
 *
 * **中继源先过 5s 预探测**（`probeRelayFeed`）：这一步是 2026-10-16 修「ECS 不通时干等
 * 60s 才回退」的关键，也顺带把「中继开了硬门控而令牌不对（401）」直接当不可用。
 */
async function checkWithFallback(): Promise<UpdateCheckResult | null> {
  configureUpdater();
  const current = normalizeVersion(app.getVersion());
  const target = updateFeedTarget();
  const useRelay = target.source === "relay" && (await probeRelayFeed(target));
  const order: AppUpdateSource[] = useRelay ? ["relay", "github"] : ["github"];
  let firstError: string | null = null;
  let staleRelay: UpdateCheckResult | null = null;
  for (const source of order) {
    probing = true;
    try {
      const result = await checkOnFeed(source, target);
      if (result === null) continue; // 该源没配/没授权（理论上只有 relay 会这样）
      probing = false;
      // 防「镜像落后」：中继上的 latest.yml 比当前版本还旧，说明镜像没跟上（发版时推送失败 /
      // 手工回滚过）。这份结果不能信——继续问 GitHub，两边都答不上来才用它兜底。
      if (source === "relay" && compareVersions(normalizeVersion(result.updateInfo?.version || ""), current) < 0) {
        staleRelay = result;
        continue;
      }
      activeSource = source;
      lastUpdaterError = null;
      return result;
    } catch (error: any) {
      probing = false;
      lastUpdaterError = null; // 探测期的错误不进 UI，两源都失败才报
      // noRelay：只有 GitHub 一条路（没配中继 / 中继探测不通）——错误文案要给出下载页兜底。
      if (!firstError) firstError = friendlyUpdaterError(error?.message || String(error), target.source !== "relay");
    }
  }
  if (staleRelay) {
    // 回中继源，使 check 与后续 downloadUpdate 的 provider 一致。
    applyFeed("relay", target);
    activeSource = "relay";
    lastUpdaterError = null;
    return staleRelay;
  }
  throw new Error(firstError || "更新服务不可用");
}

export async function checkForAppUpdate(options: { silent?: boolean } = {}): Promise<AppUpdateStatus> {
  configureUpdater();
  const silent = options.silent === true;
  const current = normalizeVersion(app.getVersion());
  // 后台静默检查不碰 lastUpdaterError / latestUpdateInfo：否则一次网络失败会把用户
  // 手动检查看到的「最新版本」抹成错误态（两处共享同一个模块状态）。
  if (!silent) {
    lastUpdaterError = null;
    latestUpdateInfo = null;
  }

  if (!isPackagedInstallable()) {
    return emptyStatus(current);
  }

  try {
    const result = await checkWithFallback();
    const info = result?.updateInfo || latestUpdateInfo;
    return info ? statusFromInfo(current, info) : emptyStatus(current, lastUpdaterError || undefined);
  } catch (error: any) {
    const message = friendlyUpdaterError(error?.message || String(error), updateFeedTarget().source !== "relay");
    if (!silent) lastUpdaterError = message;
    return emptyStatus(current, message);
  }
}

export async function downloadAppUpdate(onProgress?: (progress: AppUpdateProgress) => void): Promise<AppUpdateResult> {
  configureUpdater();
  const previousSink = progressSink;
  progressSink = onProgress || null;
  lastUpdaterError = null;

  try {
    if (!isPackagedInstallable()) {
      throw new Error("当前环境不能自动安装应用更新，请使用已安装的 MPI");
    }

    // 同一源检查 + 下载：checkWithFallback 会把 provider 留在选中的那个源上。
    const result = await checkWithFallback();
    const info = result?.updateInfo || latestUpdateInfo;
    if (!info) throw new Error("更新服务没有返回版本信息");

    latestUpdateInfo = info;
    const current = normalizeVersion(app.getVersion());
    const status = statusFromInfo(current, info);
    if (!status.hasUpdate) {
      return {
        ok: true,
        downloaded: false,
        version: status.current,
        message: "MPI 已经是最新版本（v" + status.current + "）",
      };
    }
    if (!status.supported) throw new Error("更新服务没有返回 Windows 安装包");

    const version = normalizeVersion(info.version);
    if (downloadedVersion === version) {
      emitProgress({ stage: "ready", message: "MPI v" + version + " 已下载，可以安装并重启", pct: 100 });
      return {
        ok: true,
        downloaded: true,
        version,
        message: "MPI v" + version + " 已下载，可以安装并重启",
      };
    }

    emitProgress({ stage: "downloading", message: "正在下载 MPI v" + version + "…", pct: 0 });
    // electron-updater has no cancel API, so the monitor shows progress only.
    appDownloadTransferId = beginTransfer({ kind: "download", label: "正在下载 MPI v" + version + "…", cancellable: false });
    if (!downloadPromise) {
      downloadPromise = autoUpdater.downloadUpdate().finally(() => {
        downloadPromise = null;
      });
    }
    try {
      await downloadPromise;
    } finally {
      if (appDownloadTransferId) endTransfer(appDownloadTransferId);
      appDownloadTransferId = null;
    }

    if (downloadedVersion !== version) {
      throw new Error("更新下载完成但没有收到 update-downloaded 事件");
    }
    return {
      ok: true,
      downloaded: true,
      version,
      message: "MPI v" + version + " 已下载，可以安装并重启",
    };
  } catch (error: any) {
    const message = friendlyUpdaterError(error?.message || String(error));
    lastUpdaterError = message;
    emitProgress({ stage: "error", message });
    return { ok: false, downloaded: false, message: "MPI 更新失败：" + message };
  } finally {
    if (progressSink === onProgress) progressSink = previousSink;
  }
}

export function installAppUpdate(): AppUpdateResult {
  configureUpdater();
  if (!downloadedVersion) {
    return { ok: false, downloaded: false, message: "请先下载应用更新" };
  }
  if (!isPackagedInstallable()) {
    return {
      ok: false,
      downloaded: true,
      version: downloadedVersion,
      message: "当前环境不能自动安装应用更新",
    };
  }

  const version = downloadedVersion;
  lastUpdaterError = null;
  emitProgress({ stage: "installing", message: "正在安装 MPI v" + version + "，应用将自动重启" });
  try {
    // electron-updater invokes the NSIS updater, waits for this process to
    // exit, installs the downloaded package, and relaunches the app.
    autoUpdater.quitAndInstall(true, true);
    if (lastUpdaterError) {
      return { ok: false, downloaded: true, version, message: "启动安装程序失败：" + lastUpdaterError };
    }
    return {
      ok: true,
      downloaded: true,
      version,
      message: "正在安装 MPI v" + version + "，应用将自动重启",
    };
  } catch (error: any) {
    const message = friendlyUpdaterError(error?.message || String(error));
    lastUpdaterError = message;
    emitProgress({ stage: "error", message });
    return { ok: false, downloaded: true, version, message: "启动安装程序失败：" + message };
  }
}

/* --------------------- 后台自动检查（启动 + 每 6 小时） --------------------- */

/** 启动后多久跑第一次：避开首屏与 pi 运行时启动高峰。 */
const AUTO_CHECK_INITIAL_DELAY_MS = 30_000;
/** 之后每 6 小时一次（DSH Desktop 同量级；比每小时查 GitHub 省心，也比一天一次及时）。 */
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let autoCheckStarted = false;
/** 同一个版本只提醒一次（本次运行内）；否则每 6 小时弹一次同样的通知。 */
let autoNotifiedVersion: string | null = null;

/**
 * 启动后台自动检查。**只查不下载**：发现新版本发一条系统通知，下载/安装仍由用户决定
 * （`autoUpdater.autoDownload = false` 的既有约定不变）。
 *
 * `notify` 由 ipc.ts 注入系统通知中心——本模块不直接碰 Electron 的 Notification，
 * 以便测试与「通知中心」保持单点。
 */
export function startAppUpdateAutoCheck(notify: (status: AppUpdateStatus) => void): void {
  if (autoCheckStarted) return;
  autoCheckStarted = true;

  const run = async () => {
    try {
      if (getConfig().appUpdateAutoCheck === false) return;
      const status = await checkForAppUpdate({ silent: true });
      if (!status.hasUpdate || !status.latest) return;
      if (!status.supported || !status.installable) return;
      if (status.skipped) return;
      if (autoNotifiedVersion === status.latest) return;
      autoNotifiedVersion = status.latest;
      notify(status);
    } catch (error: any) {
      // 后台检查失败保持安静：网络抖动不该弹任何东西（手动检查时才报错）。
      console.warn("[app-updater] 后台检查失败:", error?.message || String(error));
    }
  };

  const initial = setTimeout(() => void run(), AUTO_CHECK_INITIAL_DELAY_MS);
  const timer = setInterval(() => void run(), AUTO_CHECK_INTERVAL_MS);
  // 定时器不该拖着进程不退出。
  initial.unref?.();
  timer.unref?.();
}
