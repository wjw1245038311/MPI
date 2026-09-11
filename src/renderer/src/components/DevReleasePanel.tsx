import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store";

interface DevReleaseStatusInfo {
  isDev: boolean;
  running: boolean;
  currentVersion: string | null;
  nextVersion: string | null;
  dirtyFiles: string[];
  hasToken: boolean;
}

/**
 * dev 一键发版面板（仅开发模式渲染；打包版里 status.isDev=false → 返回 null）。
 * 流水线在 main 进程 src/main/dev-release.ts：bump patch → changelog Unreleased
 * 改名 → commit → push origin → npm run dist → publish-release.mjs。
 * dev-only 工具面板，文案与日志均为中文（与 publish-release.mjs 输出一致），不走 i18n。
 */
export function DevReleasePanel() {
  const pushToast = useStore((s) => s.pushToast);
  const [status, setStatus] = useState<DevReleaseStatusInfo | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement | null>(null);

  const refresh = useCallback(() => {
    window.pi.app
      .devReleaseStatus()
      .then(setStatus)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // main 进程逐行推送流水线日志（pi:devReleaseLog）；保留最近 2000 行防内存膨胀。
  useEffect(() => {
    return window.pi.on.devReleaseLog((line) => {
      setLogLines((prev) => [...prev.slice(-1999), line]);
    });
  }, []);

  // 新日志自动滚到底部（用户手动上翻时不强制拉回：仅当已在底部附近才跟随）。
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (nearBottom || logLines.length === 1) el.scrollTop = el.scrollHeight;
  }, [logLines]);

  // hooks 全部在前，early return 安全（Settings.tsx 的教训）。
  if (!status?.isDev) return null;

  const running = status.running;
  const blocked = !running && (status.dirtyFiles.length > 0 || !status.hasToken);

  const start = async () => {
    setLogLines([]);
    refresh(); // 立即反映 running 状态（IPC 返回前按钮靠本地乐观更新）
    try {
      const res: any = await window.pi.app.devReleaseStart();
      if (res?.ok) pushToast("success", `v${res.version} 发版完成`);
      else if (!res?.cancelled) pushToast("error", res?.error || "发版失败");
    } catch (e: any) {
      pushToast("error", e?.message || String(e));
    } finally {
      refresh();
    }
  };

  const cancel = async () => {
    try {
      await window.pi.app.devReleaseCancel();
    } catch {
      /* 取消失败不影响主流程 */
    }
  };

  // dev 实例若在新增该 IPC 前启动，preload 里没有此方法——明确提示重启而不是静默失败。
  const openLogWindow = () => {
    if (typeof window.pi.app.openDevReleaseLogWindow !== "function") {
      pushToast("warning", "当前 dev 实例缺少日志窗口接口，请完整重启 MPI（Ctrl+R 不够）");
      return;
    }
    void window.pi.app.openDevReleaseLogWindow().catch(() => pushToast("error", "打开日志窗口失败"));
  };

  return (
    <div className="set-card">
      <div className="set-card-title">dev 一键发版</div>
      <div className="set-hint" style={{ marginBottom: 12 }}>
        仅开发模式可用：bump patch → changelog Unreleased 改名 → commit → push origin → npm run dist →
        发布到 GitHub Release。要求工作区干净（有未提交改动会中止，不会自动提交别人的 WIP）。
      </div>
      <div className="set-diag-grid" style={{ marginBottom: 12 }}>
        <div className="set-diag-k">版本</div>
        <div className="set-diag-v">
          {status.currentVersion ? `v${status.currentVersion} → v${status.nextVersion}` : "—"}
        </div>
        <div className="set-diag-k">工作区</div>
        <div className="set-diag-v">{status.dirtyFiles.length === 0 ? "干净" : `${status.dirtyFiles.length} 个未提交文件`}</div>
        <div className="set-diag-k">GitHub token</div>
        <div className="set-diag-v">{status.hasToken ? "就绪" : "缺失（env GITHUB_TOKEN 或仓库根 .gh-token）"}</div>
      </div>
      {status.dirtyFiles.length > 0 && !running && (
        <pre
          style={{
            margin: "0 0 12px", maxHeight: 96, overflowY: "auto", padding: 8, borderRadius: 8,
            background: "var(--code-bg)", border: "1px solid var(--border)", color: "var(--text-dim)",
            fontFamily: "var(--mono)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}
        >
          {status.dirtyFiles.join("\n")}
        </pre>
      )}
      <div className="set-diag-btns">
        <button className="set-btn primary" onClick={start} disabled={blocked || running}>
          {running ? "发版进行中…" : `发布新版本（v${status.nextVersion ?? "?"}）`}
        </button>
        {running && (
          <button className="set-btn ghost" onClick={cancel}>
            取消
          </button>
        )}
        {(logLines.length > 0 || running) && (
          <button className="set-btn ghost" onClick={openLogWindow} title="在独立窗口查看完整流水线日志">
            独立窗口查看完整日志
          </button>
        )}
      </div>
      {logLines.length > 0 && (
        <pre
          ref={logRef}
          style={{
            margin: "12px 0 0", maxHeight: 260, overflowY: "auto", padding: 10, borderRadius: 8,
            background: "var(--code-bg)", border: "1px solid var(--border)", color: "var(--text-dim)",
            fontFamily: "var(--mono)", fontSize: 12, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}
        >
          {logLines.join("\n")}
        </pre>
      )}
    </div>
  );
}
