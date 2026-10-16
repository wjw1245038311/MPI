import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { Diagnostics } from "../lib/types";
import { cleanOutput, hasLibuvAssertion, lastLine, stripAnsi } from "../lib/update";
import { translateUiText } from "../lib/i18n";

/* 应用更新卡片里对外给的地址（旧规约：不展示“从哪儿拿到这个版本”，直接给 GitHub 地址）。 */
const RELEASES_URL = "https://github.com/wjw1245038311/MPI/releases/latest";

/* Map each updater stage onto a slice of one continuous 0–100 bar, so the
 * fill never jumps backwards when a new stage starts. Stages without a
 * per-stage pct (checking / pruning / activating) render indeterminate. */
const UPDATE_STAGE_SPANS: Record<string, [number, number]> = {
  checking: [0, 6],
  downloading: [6, 50],
  installing: [50, 88],
  pruning: [88, 94],
  activating: [94, 100],
  done: [100, 100],
};
function overallUpdatePct(stage: string, pct?: number): number | null {
  const span = UPDATE_STAGE_SPANS[stage];
  if (!span) return null;
  if (stage === "done") return 100;
  if (pct == null) return null;
  return Math.min(100, Math.round(span[0] + ((span[1] - span[0]) * pct) / 100));
}

/** MPI application update card. Self-contained: owns its state and IPC
 * subscriptions. Used by Settings「关于 MPI」and the Help-menu about panel alike.
 * The changelog opens in a standalone native window (app:openChangelogWindow),
 * not a nested modal — fixed-position modals inside Settings get trapped by
 * ancestor containing blocks (.set-card:hover transform) and flicker. */
export function AppUpdatePanel() {
  const language = useStore((s) => s.config?.language || "en");
  const appConfig = useStore((s) => s.config);
  const setAppUpdateSource = useStore((s) => s.setAppUpdateSource);
  const pushToast = useStore((s) => s.pushToast);

  const zh = language === "zh";
  const [updateSourceDraft, setUpdateSourceDraft] = useState<"github" | "ecs">("github");
  const [ecsUrlDraft, setEcsUrlDraft] = useState("");
  const [ecsTokenDraft, setEcsTokenDraft] = useState("");
  const [savingSource, setSavingSource] = useState(false);

  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [appUpdating, setAppUpdating] = useState(false);
  const [appUpdateStatus, setAppUpdateStatus] = useState<{
    current: string;
    latest: string | null;
    hasUpdate: boolean;
    source: string | null;
    releaseUrl: string | null;
    assetName: string | null;
    supported: boolean;
    packaged: boolean;
    installable: boolean;
    downloaded: boolean;
    error?: string;
  } | null>(null);
  const [appUpdateProgress, setAppUpdateProgress] = useState<{ stage: string; message: string; pct?: number } | null>(null);
  const [appUpdateError, setAppUpdateError] = useState<string | null>(null);
  const [appUpdateReady, setAppUpdateReady] = useState(false);

  useEffect(() => {
    window.pi.app
      .getVersion()
      .then((v: any) => setAppVersion(typeof v === "string" ? v : null))
      .catch(() => undefined);
    // Version check is network-bound; don't block first paint.
    window.pi.app
      .checkAppUpdate()
      .then((s: any) => {
        setAppUpdateStatus(s);
        setAppUpdateReady(Boolean(s?.downloaded));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    return window.pi.on.appUpdate((p) => {
      setAppUpdateProgress(p);
      if (p.stage === "error") setAppUpdateError(p.message);
    });
  }, []);

  // 更新源草稿从配置回填（令牌不回填：渲染层拿不到它的值）。
  useEffect(() => {
    if (!appConfig) return;
    setUpdateSourceDraft(appConfig.appUpdateSource === "ecs" ? "ecs" : "github");
    setEcsUrlDraft(appConfig.appUpdateEcsUrl || "");
  }, [appConfig?.appUpdateSource, appConfig?.appUpdateEcsUrl]);

  /** 保存更新源。令牌只在用户填了/明确清除时才上传（留空 = 保持现有）。 */
  const saveUpdateSource = async (patch?: { appUpdateEcsToken: string }) => {
    setSavingSource(true);
    try {
      const token = patch ?? (ecsTokenDraft.trim() ? { appUpdateEcsToken: ecsTokenDraft.trim() } : undefined);
      await setAppUpdateSource({
        appUpdateSource: updateSourceDraft,
        appUpdateEcsUrl: ecsUrlDraft.trim(),
        ...(token ?? {}),
      });
      if (!patch) setEcsTokenDraft("");
      pushToast("success", zh ? "更新源已保存" : "Update source saved");
    } catch {
      // store 已经弹过错误提示了。
    } finally {
      setSavingSource(false);
    }
  };

  // dev 实例若在新增该 IPC 前启动，preload 里没有此方法——明确提示重启而不是静默失败。
  const openChangelog = () => {
    if (typeof window.pi.app.openChangelogWindow !== "function") {
      pushToast("warning", language === "zh" ? "当前实例缺少更新日志窗口接口，请完整重启 MPI（Ctrl+R 不够）" : "This build is missing the changelog window API — fully restart MPI (Ctrl+R is not enough)");
      return;
    }
    void window.pi.app.openChangelogWindow().catch(() => pushToast("error", language === "zh" ? "打开更新日志窗口失败" : "Could not open the changelog window"));
  };

  const checkAppRelease = async () => {
    setAppUpdating(true);
    setAppUpdateError(null);
    setAppUpdateProgress({ stage: "checking", message: language === "zh" ? "正在检查最新版本…" : "Checking for updates…" });
    try {
      const status: any = await window.pi.app.checkAppUpdate();
      setAppUpdateStatus(status);
      setAppUpdateReady(Boolean(status?.downloaded));
      if (status?.error) {
        setAppUpdateError(status.error);
        pushToast("error", language === "zh" ? `检查更新失败：${status.error}` : `Update check failed: ${status.error}`);
      } else if (!status?.packaged) {
        // Dev runs (npm run dev) cannot reach the GitHub Releases feed — say so
        // instead of leaving the click without any feedback.
        pushToast("info", language === "zh" ? "开发模式不支持应用内更新检查（仅已安装版本可用）" : "App update checks are only available in installed builds");
      } else if (status?.hasUpdate) {
        pushToast("success", language === "zh" ? `发现新版本 v${status.latest}` : `New version v${status.latest} found`);
      } else if (status?.latest) {
        pushToast("info", language === "zh" ? `MPI 已是最新版本（v${status.current}）` : `MPI is up to date (v${status.current})`);
      } else {
        pushToast("warning", language === "zh" ? "未能获取最新版本信息，请稍后重试" : "Could not determine the latest version — please retry");
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      setAppUpdateError(msg);
      pushToast("error", language === "zh" ? `检查更新失败：${msg}` : `Update check failed: ${msg}`);
    } finally {
      setAppUpdating(false);
    }
  };

  const downloadAppRelease = async () => {
    setAppUpdating(true);
    setAppUpdateProgress(null);
    setAppUpdateError(null);
    try {
      const result: any = await window.pi.app.downloadAppUpdate();
      if (result?.ok && result?.downloaded) {
        setAppUpdateReady(true);
        pushToast("success", language === "zh" ? result.message : `MPI v${result.version || ""} is ready to install.`);
      } else if (result?.ok) {
        pushToast("info", language === "zh" ? result.message : "MPI is already up to date.");
      } else {
        setAppUpdateError(result?.message || (language === "zh" ? "应用更新失败" : "App update failed"));
      }
      const status: any = await window.pi.app.checkAppUpdate();
      setAppUpdateStatus(status);
      setAppUpdateReady(Boolean(result?.downloaded || status?.downloaded));
    } catch (e: any) {
      setAppUpdateError(e?.message || String(e));
    } finally {
      setAppUpdating(false);
    }
  };

  const installAppRelease = async () => {
    setAppUpdateError(null);
    try {
      const result: any = await window.pi.app.installAppUpdate();
      if (!result?.ok) setAppUpdateError(result?.message || (language === "zh" ? "启动安装程序失败" : "Could not start the installer"));
    } catch (e: any) {
      setAppUpdateError(e?.message || String(e));
    }
  };

  return (
    <div className="set-card">
      <div className="set-card-title">{language === "zh" ? "MPI 应用更新" : "MPI app update"}</div>
      {/* 更新源（2026-10-16）：以前它藏在「手机远程控制」的中继通道里，两件事互相拖着；
          现在独立成一项：选 ECS = 这台机器已授权，5s 预探测不通就回退 GitHub。 */}
      <div className="set-row wide" style={{ marginBottom: 12 }}>
        <label className="set-label">{language === "zh" ? "更新源" : "Update source"}</label>
        <div className="set-control">
          <select
            className="set-input"
            value={updateSourceDraft}
            onChange={(e) => setUpdateSourceDraft(e.target.value === "ecs" ? "ecs" : "github")}
          >
            <option value="github">{language === "zh" ? "GitHub Releases（默认）" : "GitHub Releases (default)"}</option>
            <option value="ecs">{language === "zh" ? "我的 ECS 中继镜像（需授权令牌）" : "My ECS relay mirror (token required)"}</option>
          </select>
          {updateSourceDraft === "ecs" && (
            <>
              <input
                className="set-input"
                style={{ marginTop: 6 }}
                placeholder="http://47.97.28.110:10445/download/app/"
                value={ecsUrlDraft}
                onChange={(e) => setEcsUrlDraft(e.target.value)}
              />
              <input
                className="set-input"
                style={{ marginTop: 6 }}
                type="password"
                autoComplete="off"
                placeholder={
                  appConfig?.appUpdateEcsTokenSet
                    ? language === "zh"
                      ? "令牌已设置，留空则保持不变"
                      : "token set; leave empty to keep"
                    : language === "zh"
                      ? "准入令牌（中继开通校验后必填）"
                      : "access token (required once the relay enforces it)"
                }
                value={ecsTokenDraft}
                onChange={(e) => setEcsTokenDraft(e.target.value)}
              />
            </>
          )}
          <div className="set-hint">
            {language === "zh"
              ? "选 ECS 后，检查更新先探测中继镜像（5 秒超时），不通才回退 GitHub——小版本只发中继镜像，所以需要小版本更新的机器要选它。地址留空 = 用内置 ECS 地址。"
              : "With ECS selected the app probes the relay mirror first (5s timeout) and only then falls back to GitHub. Patch releases are mirrored there only, so machines that need them should use this source. Empty address = built-in ECS address."}
          </div>
          <div className="set-diag-btns" style={{ marginTop: 8 }}>
            <button className="set-btn ghost" onClick={() => void saveUpdateSource()} disabled={savingSource}>
              {savingSource ? (language === "zh" ? "保存中…" : "Saving…") : language === "zh" ? "保存更新源" : "Save update source"}
            </button>
            {appConfig?.appUpdateEcsTokenSet && (
              <button className="set-btn ghost" onClick={() => void saveUpdateSource({ appUpdateEcsToken: "" })} disabled={savingSource}>
                {language === "zh" ? "清除令牌" : "Clear token"}
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="set-diag-grid" style={{ marginBottom: 12 }}>
        <div className="set-diag-k">{language === "zh" ? "当前版本" : "Current version"}</div>
        <div className="set-diag-v">{appUpdateStatus?.current ? `v${appUpdateStatus.current}` : appVersion ? `v${appVersion}` : "—"}</div>
        <div className="set-diag-k">{language === "zh" ? "最新版本" : "Latest version"}</div>
        <div className="set-diag-v">
          {appUpdateStatus?.error ? (
            <span className="set-diag-err" style={{ display: "inline-block", margin: 0 }}>
              {language === "zh" ? "检查失败：" : "Check failed: "}{appUpdateStatus.error}
            </span>
          ) : (
            <>
              {appUpdateStatus?.latest ? `v${appUpdateStatus.latest}` : "—"}
              {appUpdateStatus?.hasUpdate && <span className="set-tag-new">{language === "zh" ? "可更新" : "Update available"}</span>}
            </>
          )}
        </div>
        <div className="set-diag-k">GitHub</div>
        <div className="set-diag-v">
          <a href={appUpdateStatus?.releaseUrl || RELEASES_URL} target="_blank" rel="noreferrer">
            {language === "zh" ? "打开发布页" : "Open releases"}
          </a>
        </div>
        <div className="set-diag-k">{language === "zh" ? "本次来源" : "Last source"}</div>
        <div className="set-diag-v">
          {appUpdateStatus?.source === "relay"
            ? language === "zh"
              ? "ECS 中继镜像"
              : "ECS relay mirror"
            : appUpdateStatus?.source === "github"
              ? "GitHub"
              : "—"}
        </div>
      </div>
      {appUpdateStatus && !appUpdateStatus.packaged && (
        <div className="set-hint" style={{ marginBottom: 12 }}>
          {language === "zh"
            ? "当前为开发模式（npm run dev），应用更新检查仅在已安装版本中可用。"
            : "Running in development mode — app update checks are only available in installed builds."}
        </div>
      )}
      <div className="set-diag-btns">
        <button className="set-btn ghost" onClick={checkAppRelease} disabled={appUpdating}>
          {appUpdating && appUpdateProgress?.stage === "checking"
            ? language === "zh"
              ? "检查中…"
              : "Checking…"
            : language === "zh"
              ? "检查最新版本"
              : "Check for updates"}
        </button>
        <button className="set-btn ghost" onClick={openChangelog}>
          {language === "zh" ? "查看更新日志" : "View changelog"}
        </button>
        {appUpdateStatus?.hasUpdate && !appUpdateReady && (
          <button
            className="set-btn primary"
            onClick={downloadAppRelease}
            disabled={appUpdating || !appUpdateStatus.supported || !appUpdateStatus.installable}
          >
            {appUpdating && appUpdateProgress?.stage === "downloading"
              ? language === "zh"
                ? "下载中…"
                : "Downloading…"
              : language === "zh"
                ? `下载 v${appUpdateStatus.latest}`
                : `Download v${appUpdateStatus.latest}`}
          </button>
        )}
        {appUpdateReady && (
          <button className="set-btn primary" onClick={installAppRelease} disabled={!appUpdateStatus?.installable}>
            {language === "zh" ? "安装并重启" : "Install and restart"}
          </button>
        )}
      </div>
      {appUpdateProgress && (appUpdating || appUpdateReady) && (
        <div className="upd-progress">
          <div className="upd-progress-head">
            <span className="upd-progress-label">{translateUiText(appUpdateProgress.message, language)}</span>
            {appUpdateProgress.pct != null && <span className="upd-progress-pct">{appUpdateProgress.pct}%</span>}
          </div>
          <div className={"upd-bar" + (appUpdateProgress.pct == null ? " indeterminate" : "")}>
            <div className="upd-bar-fill" style={appUpdateProgress.pct != null ? { width: `${appUpdateProgress.pct}%` } : undefined} />
          </div>
        </div>
      )}
      {appUpdateError && !appUpdating && <div className="set-diag-err">⚠ {translateUiText(appUpdateError, language)}</div>}

    </div>
  );
}

/** Pi core update card. Self-contained like AppUpdatePanel. */
export function PiCoreUpdatePanel() {
  const language = useStore((s) => s.config?.language || "en");
  const pushToast = useStore((s) => s.pushToast);

  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<{
    current: string | null;
    latest: string | null;
    hasUpdate: boolean;
    note?: string | null;
    source: string | null;
    error?: string;
  } | null>(null);
  const [progress, setProgress] = useState<{ stage: string; message: string; pct?: number } | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updatedTo, setUpdatedTo] = useState<string | null>(null);

  useEffect(() => {
    window.pi.settings.getDiagnostics().then((d: any) => setDiag(d)).catch(() => undefined);
    // Version check is network-bound; don't block first paint.
    window.pi.app.checkCoreUpdate().then((s: any) => setUpdateStatus(s)).catch(() => undefined);
  }, []);

  // Track the in-app core updater with a single state object so the progress
  // bar updates in place instead of appending one line per percentage point.
  useEffect(() => {
    if (!updating) return;
    const off = window.pi.on.coreUpdate((p) => {
      setProgress(p);
      if (p.stage === "error") setUpdateError(p.message);
    });
    return off;
  }, [updating]);

  const runUpdate = async () => {
    setUpdating(true);
    setProgress(null);
    setUpdateError(null);
    setUpdatedTo(null);
    try {
      const res: any = await window.pi.app.updatePi();

      if (res?.managed) {
        // In-app updater for the bundled / app-managed runtime.
        if (res.ok && res.updated) {
          pushToast("success", res.output);
          setUpdatedTo(res.to);
        } else if (res.ok) {
          pushToast("info", res.output);
        } else if (res.cancelled) {
          pushToast("info", "已取消");
        } else {
          pushToast("error", res.output);
        }
      } else if (!res?.ok && res.cancelled) {
        pushToast("info", "已取消");
      } else {
        // System-installed pi (npm/pnpm global) updated itself via `pi update`.
        const raw = stripAnsi(res?.output || "");
        const text = cleanOutput(raw);
        const assertion = hasLibuvAssertion(raw);

        if (res?.ok) {
          if (/already up to date/i.test(text)) pushToast("info", "Pi 已是最新版本。");
          else pushToast("success", "Pi 已更新到最新版本。");
        } else if (assertion) {
          if (/already up to date/i.test(text)) {
            pushToast("info", "Pi 已是最新版本。");
          } else if (/Updating/i.test(text)) {
            pushToast("warning", "Pi 更新命令已执行，但进程退出时出现已知 Windows 兼容问题。请重启 MPI 以使用新版本。");
          } else {
            pushToast("warning", "Pi 更新状态不确定（进程退出异常）。请重启 MPI 后检查版本。");
          }
        } else {
          pushToast("error", "Pi 更新失败：" + (lastLine(text) || "未知错误"));
        }
      }
      // Refresh both the version status and diagnostics (bundled flag may change).
      const [d, s] = await Promise.all([window.pi.settings.getDiagnostics(), window.pi.app.checkCoreUpdate()]);
      setDiag(d as any);
      setUpdateStatus(s as any);
    } catch (e: any) {
      pushToast("error", "Pi 更新失败：" + (e?.message || String(e)));
    } finally {
      setUpdating(false);
    }
  };

  const liveUpdatePct = progress ? overallUpdatePct(progress.stage, progress.pct) : null;

  return (
    <div className="set-card">
      <div className="set-card-title">更新 Pi 核心</div>
      <div className="set-hint" style={{ marginBottom: 12 }}>
        {diag?.bundled ? (
          <>Pi 核心由 MPI 统一管理（内置副本不可被 <code>pi update</code> 原地更新）。点击下方按钮后，MPI 会自行下载并安装新版本到应用数据目录，更新完成后新开的会话使用新版本。扩展请在「扩展功能」面板更新。</>
        ) : (
          <>运行 <code>pi update</code> 更新 pi CLI 本体（不含扩展，扩展请在「扩展功能」面板更新）。会先检查是否为最新版本，结果以提示呈现。更新完成后新开的会话使用新版本。</>
        )}
      </div>
      <div className="set-diag-grid" style={{ marginBottom: 12 }}>
        <div className="set-diag-k">当前版本</div>
        <div className="set-diag-v">{updateStatus?.current || diag?.piVersion || "—"}</div>
        <div className="set-diag-k">最新版本</div>
        <div className="set-diag-v">
          {updateStatus?.error ? (
            <span className="set-diag-err" style={{ display: "inline-block", margin: 0 }}>检查失败：{updateStatus.error}</span>
          ) : (
            <>
              {updateStatus?.latest || "—"}
              {updateStatus?.hasUpdate && <span className="set-tag-new">可更新</span>}
            </>
          )}
        </div>
      </div>
      {updateStatus?.note && <div className="set-hint" style={{ marginBottom: 12 }}>{updateStatus.note}</div>}
      <div>
        <button className="set-btn primary" onClick={runUpdate} disabled={updating}>
          {updating ? (
            <>
              <span className="spinner" /> 检查并更新中…
            </>
          ) : updateStatus?.hasUpdate && updateStatus.latest ? (
            `更新到 v${updateStatus.latest}`
          ) : (
            "检查并更新 Pi"
          )}
        </button>
        {updatedTo && (
          <button className="set-btn" style={{ marginLeft: 8 }} onClick={() => window.pi.app.relaunch()}>
            立即重启 MPI
          </button>
        )}
      </div>
      {updating && progress && (
        <div className="upd-progress">
          <div className="upd-progress-head">
            <span className="upd-progress-label">{translateUiText(progress.message, language)}</span>
            {liveUpdatePct != null && <span className="upd-progress-pct">{liveUpdatePct}%</span>}
          </div>
          <div className={"upd-bar" + (liveUpdatePct == null ? " indeterminate" : "")}>
            <div className="upd-bar-fill" style={liveUpdatePct != null ? { width: `${liveUpdatePct}%` } : undefined} />
          </div>
        </div>
      )}
      {updateError && !updating && <div className="set-diag-err">⚠ {translateUiText(updateError, language)}</div>}
    </div>
  );
}
