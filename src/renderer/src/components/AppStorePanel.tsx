import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { AppConfigField, AppLocalizedText, AppStoreEntry } from "../lib/types";
import { sttTranscribeErrorText } from "../lib/stt";
import { AppStore as AppStoreIcon, Check, ChevronRight, Close, Copy, Info, Refresh, Trash } from "./icons";

/** Pick localized manifest text for the UI language (fallback to the other). */
function pickLoc(value: AppLocalizedText | undefined, lang: "zh" | "en"): string {
  if (!value) return "";
  const primary = (lang === "zh" ? value.zh : value.en) || "";
  if (primary.trim()) return primary.trim();
  const fallback = (lang === "zh" ? value.en : value.zh) || "";
  return fallback.trim();
}

/** Category id → display label. */
function categoryLabel(category: string, zh: boolean): string {
  switch (category) {
    case "voice":
      return zh ? "语音" : "Voice";
    default:
      return category;
  }
}

/** Capability id → plain-language label shown in the install consent dialog. */
const CAP_LABELS: Record<string, { zh: string; en: string }> = {
  process: { zh: "启动与管理子进程（可能在本机运行服务）", en: "Start and manage child processes (may run a local service)" },
  network: { zh: "访问网络", en: "Make network requests" },
  fs: { zh: "读写应用数据目录", en: "Read/write the app's data directory" },
};

function capLabel(cap: string, zh: boolean): string {
  const l = CAP_LABELS[cap];
  return l ? (zh ? l.zh : l.en) : cap;
}

function confirmTrust(zh: boolean): boolean {
  const msg = zh
    ? "应用代码以 MPI 主进程权限运行（与 pi 插件同一信任模型），可访问网络、读写文件并启动子进程。\n\n请仅安装你信任来源的应用。是否继续？"
    : "App code runs with MPI main-process privileges (same trust model as pi plugins) and may access the network, read/write files and start child processes.\n\nOnly install apps from sources you trust. Continue?";
  return window.confirm(msg);
}

/** Service state → display label. */
function stateLabel(state: string | undefined, zh: boolean): string {
  switch (state) {
    case "starting":
      return zh ? "启动中" : "Starting";
    case "ready":
      return zh ? "运行中" : "Running";
    case "error":
      return zh ? "异常" : "Error";
    case "stopped":
      return zh ? "已停止" : "Stopped";
    default:
      return zh ? "已停止" : "Stopped";
  }
}

/* ------------------------------ detail view ------------------------------ */

interface DetailProps {
  entry: AppStoreEntry;
  zh: boolean;
  onBack: () => void;
}

function AppDetail({ entry, zh, onBack }: DetailProps) {
  const language = useStore((s) => s.config?.language || "en");
  const lang: "zh" | "en" = language === "zh" ? "zh" : "en";
  const uninstallApp = useStore((s) => s.uninstallApp);
  const setAppEnabled = useStore((s) => s.setAppEnabled);
  const restartAppService = useStore((s) => s.restartAppService);
  const pushToast = useStore((s) => s.pushToast);

  const [values, setValues] = useState<Record<string, string>>({});
  const [loadingCfg, setLoadingCfg] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);

  const hasService = !!entry.service;
  const status = entry.status;
  const statusDetail = status?.detail;

  const refreshLogs = async () => {
    if (typeof window.pi.apps?.logs !== "function") return;
    try {
      setLogs(await window.pi.apps.logs(entry.id));
    } catch {
      // log read is best-effort
    }
  };

  // Refresh the log whenever the app or its reported service status changes.
  useEffect(() => {
    if (entry.installed) void refreshLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, entry.installed, status?.state, status?.updatedAt]);

  // Load saved form values (merged over manifest defaults) when the app changes.
  useEffect(() => {
    let cancelled = false;
    setLoadingCfg(true);
    setTestResult(null);
    window.pi.apps
      .getConfig(entry.id)
      .then((v) => {
        if (!cancelled) setValues(v);
      })
      .catch(() => {
        // fall back to manifest defaults below
        const fallback: Record<string, string> = {};
        for (const f of entry.config.fields) fallback[f.key] = f.default ?? "";
        if (!cancelled) setValues(fallback);
      })
      .finally(() => {
        if (!cancelled) setLoadingCfg(false);
      });
    return () => {
      cancelled = true;
    };
    // Key on id only: the panel remounts per app, and store refreshes after
    // install/enable must not clobber values the user is currently editing.
  }, [entry.id]);

  // Copy the live endpoint out of the ready status detail ("<base> · <model>" → just the base),
  // so a fresh-machine install can paste it straight into any STT config.
  const copyStatusDetail = async (detail: string) => {
    const target = detail.split(" · ")[0].trim() || detail;
    try {
      await navigator.clipboard.writeText(target);
      pushToast("success", zh ? `已复制：${target}` : `Copied: ${target}`);
    } catch {
      pushToast("error", zh ? "复制失败" : "Copy failed");
    }
  };

  const hasVoiceIntegration = !!entry.integrations?.voiceStt;

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await window.pi.apps.testVoice(entry.id, values);
      if (res.ok) {
        setTestResult({ ok: true, message: zh ? "连接成功，服务可用" : "Connection OK — the service is reachable" });
      } else if (res.error === "voice.stt.app-bundled") {
        // Blank endpoint + bundled service: informational, not a failure.
        setTestResult({ ok: true, message: sttTranscribeErrorText(res.error, zh) });
      } else {
        setTestResult({ ok: false, message: sttTranscribeErrorText(res.error || "", zh) });
      }
    } catch (e: any) {
      setTestResult({ ok: false, message: String(e?.message || e) });
    } finally {
      setTesting(false);
    };
  };

  const enable = async () => {
    setBusy(true);
    try {
      await window.pi.apps.saveConfig(entry.id, values);
      await setAppEnabled(entry.id, true);
      await refreshLogs();
    } catch {
      // the store action already surfaced a toast
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      await setAppEnabled(entry.id, false);
      await refreshLogs();
    } catch {
      // the store action already surfaced a toast
    } finally {
      setBusy(false);
    }
  };

  const restart = async () => {
    setBusy(true);
    try {
      await restartAppService(entry.id);
      await refreshLogs();
    } finally {
      setBusy(false);
    }
  };

  const uninstall = () => {
    const question = zh
      ? `确定卸载「${pickLoc(entry.name, lang)}」吗？已写入的设置会被还原。`
      : `Uninstall “${pickLoc(entry.name, lang)}”? Settings it wrote will be restored.`;
    if (window.confirm(question)) void uninstallApp(entry.id);
  };

  const renderField = (field: AppConfigField) => {
    const value = values[field.key] ?? "";
    const set = (v: string) => setValues((prev) => ({ ...prev, [field.key]: v }));
    return (
      <label className="appstore-field" key={field.key}>
        <span className="appstore-field-label">{pickLoc(field.label, lang)}</span>
        {field.type === "select" && field.options ? (
          <select className="set-input appstore-select" value={value} onChange={(e) => set(e.target.value)}>
            {!field.options.some((o) => o.value === value) && <option value="">{zh ? "（未选择）" : "(none)"}</option>}
            {field.options.map((o) => (
              <option key={o.value} value={o.value}>
                {pickLoc(o.label, lang)}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="set-input"
            type={field.type === "password" ? "password" : field.type === "url" ? "text" : "text"}
            value={value}
            placeholder={pickLoc(field.placeholder, lang)}
            onChange={(e) => set(e.target.value)}
          />
        )}
        {field.hint && <span className="appstore-field-hint">{pickLoc(field.hint, lang)}</span>}
      </label>
    );
  };

  return (
    <div className="appstore-detail">
      <header className="appstore-detail-head">
        <button type="button" className="set-iconbtn appstore-back" onClick={onBack} title={zh ? "返回" : "Back"}>
          <ChevronRight size={16} style={{ transform: "rotate(180deg)" }} />
        </button>
        <div className="appstore-detail-title">
          <span className="set-brand-mark appstore-app-icon">
            <AppStoreIcon size={17} />
          </span>
          <div>
            <div className="set-brand-title">
              {pickLoc(entry.name, lang)} <span className="appstore-version">v{entry.version}</span>
            </div>
            <div className="set-brand-sub">{categoryLabel(entry.category, zh)}</div>
          </div>
        </div>
      </header>

      <div className="appstore-detail-body">
        <p className="appstore-desc">{pickLoc(entry.description, lang)}</p>

        {entry.guide && (
          <div className="appstore-guide">
            <div className="appstore-guide-title">
              <Info size={13} /> {zh ? "部署指引" : "Setup guide"}
            </div>
            <pre className="appstore-guide-text">{pickLoc(entry.guide, lang)}</pre>
          </div>
        )}

        {entry.installed && hasService && (
          <div className="appstore-status">
            <div className="appstore-status-head">
              <span className={`appstore-status-dot ${status?.state || "stopped"}`} />
              <span className="appstore-status-text">
                {zh ? "服务状态：" : "Service: "}
                {stateLabel(status?.state, zh)}
              </span>
              {statusDetail && (
                <>
                  <span className="appstore-status-detail" title={statusDetail}>
                    {statusDetail}
                  </span>
                  {status?.state === "ready" && (
                    <button
                      type="button"
                      className="set-btn ghost appstore-status-copy"
                      title={zh ? "复制服务地址" : "Copy base URL"}
                      onClick={() => void copyStatusDetail(statusDetail)}
                    >
                      <Copy size={12} /> {zh ? "复制" : "Copy"}
                    </button>
                  )}
                </>
              )}
              <button
                type="button"
                className="set-btn ghost appstore-status-btn"
                onClick={() => setShowLogs((v) => !v)}
                disabled={!entry.enabled}
              >
                {showLogs ? (zh ? "隐藏日志" : "Hide log") : zh ? "查看日志" : "Show log"}
              </button>
            </div>
            {showLogs && (
              <pre className="appstore-log">
                {logs.length > 0 ? logs.join("\n") : zh ? "（暂无日志）" : "(no log yet)"}
              </pre>
            )}
          </div>
        )}

        {entry.config.fields.length > 0 && (
          <div className="appstore-form">
            {loadingCfg ? (
              <span className="appstore-muted">{zh ? "加载配置…" : "Loading settings…"}</span>
            ) : (
              entry.config.fields.map(renderField)
            )}
          </div>
        )}

        {hasVoiceIntegration && (
          <div className="appstore-test-row">
            <button type="button" className="set-btn ghost" onClick={() => void runTest()} disabled={testing || loadingCfg}>
              {testing ? (zh ? "测试中…" : "Testing…") : zh ? "测试连接" : "Test connection"}
            </button>
            {testResult && (
              <span className={`appstore-test-result ${testResult.ok ? "ok" : "fail"}`}>
                {testResult.ok ? <Check size={13} /> : <Close size={13} />} {testResult.message}
              </span>
            )}
          </div>
        )}

        {(entry.capabilities || []).length > 0 && (
          <div className="appstore-caps">
            <div className="appstore-guide-title">
              <Info size={13} /> {zh ? "声明能力" : "Declared capabilities"}
            </div>
            <ul className="appstore-caps-list">
              {(entry.capabilities || []).map((c) => (
                <li key={c}>{capLabel(c, zh)}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="appstore-actions">
          {entry.installed && !entry.enabled && (
            <button type="button" className="set-btn primary" onClick={() => void enable()} disabled={busy || loadingCfg}>
              {zh ? "启用应用" : "Enable app"}
            </button>
          )}
          {entry.installed && entry.enabled && (
            <button type="button" className="set-btn ghost" onClick={() => void disable()} disabled={busy}>
              {zh ? "停用（还原设置）" : "Disable (restore settings)"}
            </button>
          )}
          {entry.installed && entry.enabled && hasService && (
            <button type="button" className="set-btn ghost" onClick={() => void restart()} disabled={busy}>
              <Refresh size={13} /> {status?.state === "error" ? (zh ? "重试" : "Retry") : zh ? "重启服务" : "Restart"}
            </button>
          )}
          {entry.installed && (
            <button type="button" className="set-btn danger appstore-uninstall" onClick={uninstall}>
              <Trash size={13} /> {zh ? "卸载" : "Uninstall"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- grid view ------------------------------- */

function AppCard({ entry, zh, onOpen }: { entry: AppStoreEntry; zh: boolean; onOpen: () => void }) {
  const language = useStore((s) => s.config?.language || "en");
  const lang: "zh" | "en" = language === "zh" ? "zh" : "en";
  return (
    <div className={`appstore-card${entry.enabled ? " enabled" : ""}`} onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen()}>
      <div className="appstore-card-head">
        <span className="set-brand-mark appstore-app-icon">
          <AppStoreIcon size={16} />
        </span>
        <div className="appstore-card-name">
          {pickLoc(entry.name, lang)}
          <span className="appstore-version">v{entry.version}</span>
        </div>
      </div>
      <p className="appstore-card-desc">{pickLoc(entry.description, lang)}</p>
      <div className="appstore-card-foot">
        <span className="appstore-category">{categoryLabel(entry.category, zh)}</span>
        {entry.enabled ? (
          <span className="appstore-badge on">
            <Check size={11} /> {zh ? "已启用" : "Enabled"}
          </span>
        ) : (
          <span className="appstore-badge">{zh ? "已安装" : "Installed"}</span>
        )}
      </div>
    </div>
  );
}

/* --------------------------------- panel --------------------------------- */

export function AppStorePanel() {
  const open = useStore((s) => s.appsOpen);
  const close = useStore((s) => s.closeAppStore);
  const entries = useStore((s) => s.appStoreEntries);
  const loading = useStore((s) => s.appsLoading);
  const loadAppStore = useStore((s) => s.loadAppStore);
  const language = useStore((s) => s.config?.language || "en");
  const zh = language === "zh";

  const [selectedId, setSelectedId] = useState<string | null>(null);
  if (!open) return null;

  const installZip = () => {
    if (confirmTrust(zh)) void useStore.getState().installAppFromZip();
  };
  const installDir = () => {
    if (confirmTrust(zh)) void useStore.getState().installAppFromDir();
  };

  const selected = entries.find((e) => e.id === selectedId) || null;

  return (
    <div className="settings-backdrop" onMouseDown={close}>
      <div className="set-modal appstore-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        {selected ? (
          <AppDetail entry={selected} zh={zh} onBack={() => setSelectedId(null)} />
        ) : (
          <>
            <header className="appstore-head">
              <div className="plugins-head-title">
                <span className="set-brand-mark">
                  <AppStoreIcon size={18} />
                </span>
                <div>
                  <div className="set-brand-title">{zh ? "应用商店" : "App Store"}</div>
                  <div className="set-brand-sub">
                    {zh ? "加载第三方应用包（zip / 目录）" : "Load third-party app packages (zip / folder)"}
                  </div>
                </div>
              </div>
              <div className="plugins-head-actions">
                <button className="set-btn ghost appstore-import-btn" onClick={installZip} title={zh ? "从 zip 安装" : "Install from zip"}>
                  {zh ? "从 zip 安装" : "Install zip"}
                </button>
                <button className="set-btn ghost appstore-import-btn" onClick={installDir} title={zh ? "加载已解压目录" : "Load unpacked folder"}>
                  {zh ? "加载目录" : "Load folder"}
                </button>
                <button className="set-iconbtn" title={zh ? "刷新" : "Refresh"} onClick={() => void loadAppStore()}>
                  <Refresh size={15} />
                </button>
                <button className="set-iconbtn" title={zh ? "关闭" : "Close"} onClick={close}>
                  <Close size={16} />
                </button>
              </div>
            </header>

            {loading && entries.length === 0 ? (
              <div className="appstore-empty">{zh ? "加载中…" : "Loading…"}</div>
            ) : entries.length === 0 ? (
              <div className="appstore-empty">
                {zh
                  ? "还没有应用。点击右上角「从 zip 安装」加载应用包，或用「加载目录」调试未打包的应用。"
                  : "No apps yet. Use “Install zip” (top right) to load a package, or “Load folder” to debug an unpacked app."}
              </div>
            ) : (
              <div className="appstore-grid">
                {entries.map((entry) => (
                  <AppCard key={entry.id} entry={entry} zh={zh} onOpen={() => setSelectedId(entry.id)} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
