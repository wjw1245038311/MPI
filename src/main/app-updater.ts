import { app } from "electron";
import { autoUpdater, type ProgressInfo, type UpdateCheckResult, type UpdateInfo } from "electron-updater";
import { getConfig } from "./config";
import { relayAppUpdateFeedUrl } from "../shared/app-update-feed";
import { beginTransfer, endTransfer, updateTransfer } from "./transfer-monitor";

const OWNER = "wjw1245038311";
const REPO = "MPI";
const REPOSITORY = OWNER + "/" + REPO;
const RELEASES_LATEST_URL = "https://github.com/" + REPOSITORY + "/releases/latest";
// 应用自更新：**中继镜像优先、GitHub 回退**。中继（用户的 ECS）在国内比 GitHub 快得多，
// 但可能没部署/挂了，所以逐源探测，第一源成功就用它（下载也走同一源）。
// 未配置中继（`remoteRelayUrl` 为空，例如别人装这台机器）时直接走 GitHub。
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
 * 中继镜像的 feed 地址（`<中继 http(s) 源>/download/app/`）；没有可用中继时返回 null。
 *
 * 从 `remoteRelayUrl`（wss://host/ws）推出来：把 ws(s) 换成 http(s)、丢掉路径。
 * `MPI_APP_UPDATE_URL` 可覆盖（测试/临时换源用）。
 */
function relayUpdateFeedUrl(): string | null {
  const override = (process.env.MPI_APP_UPDATE_URL || "").trim();
  if (override) return override.endsWith("/") ? override : override + "/";
  return relayAppUpdateFeedUrl(getConfig().remoteRelayUrl);
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

/** Map electron-updater's raw errors to user-readable Chinese (no releases yet / GitHub unreachable). */
function friendlyUpdaterError(message: unknown): string {
  const m = String(message || "");
  if (/404|not found|no release/i.test(m)) return "GitHub 仓库还没有发布版本（或无法访问该仓库）";
  if (/(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network)/i.test(m)) return "无法连接 GitHub，请检查网络后重试";
  return m;
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

/** 把 provider 切到指定源并检查一次。返回 null 表示该源不可用（没配中继）。 */
async function checkOnFeed(source: AppUpdateSource): Promise<UpdateCheckResult | null> {
  if (source === "relay") {
    const url = relayUpdateFeedUrl();
    if (!url) return null;
    // GenericProvider 会读 `<url>/latest.yml`（windows 的 channel 文件名）。
    autoUpdater.setFeedURL({ provider: "generic", url, channel: "latest" });
  } else {
    autoUpdater.setFeedURL({ provider: "github", owner: OWNER, repo: REPO });
  }
  return await checkWithUpdater();
}

/**
 * 逐源探测：中继镜像 → GitHub，用第一个成功的结果。
 *
 * 为什么不用 electron-updater 自带的回退：它没有多源概念（provider 只有一个），
 * 「中继挂了再回 GitHub」必须自己写。探测期的 error 事件被 `probing` 抑制。
 */
async function checkWithFallback(): Promise<UpdateCheckResult | null> {
  configureUpdater();
  const current = normalizeVersion(app.getVersion());
  const order: AppUpdateSource[] = relayUpdateFeedUrl() ? ["relay", "github"] : ["github"];
  let firstError: string | null = null;
  let staleRelay: UpdateCheckResult | null = null;
  for (const source of order) {
    probing = true;
    try {
      const result = await checkOnFeed(source);
      if (result === null) continue; // 该源没配（理论上只有 relay 会这样）
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
      if (!firstError) firstError = friendlyUpdaterError(error?.message || String(error));
    }
  }
  if (staleRelay) {
    // 回中继源，使 check 与后续 downloadUpdate 的 provider 一致。
    const url = relayUpdateFeedUrl();
    if (url) autoUpdater.setFeedURL({ provider: "generic", url, channel: "latest" });
    activeSource = "relay";
    lastUpdaterError = null;
    return staleRelay;
  }
  throw new Error(firstError || "更新服务不可用");
}

export async function checkForAppUpdate(): Promise<AppUpdateStatus> {
  configureUpdater();
  const current = normalizeVersion(app.getVersion());
  lastUpdaterError = null;
  latestUpdateInfo = null;

  if (!isPackagedInstallable()) {
    return emptyStatus(current);
  }

  try {
    const result = await checkWithFallback();
    const info = result?.updateInfo || latestUpdateInfo;
    return info ? statusFromInfo(current, info) : emptyStatus(current, lastUpdaterError || undefined);
  } catch (error: any) {
    const message = friendlyUpdaterError(error?.message || String(error));
    lastUpdaterError = message;
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
