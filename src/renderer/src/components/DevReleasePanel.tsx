import { useCallback, useEffect, useState } from "react";
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
 *
 * 两段式流程：点击「发起发版评审」→ 打开一个以新版本号命名的新会话，展示
 * changelog Unreleased 待发布内容；用户在对话中审阅并明确确认后，由该会话的
 * agent 运行 scripts/dev-release.mjs（bump → changelog → commit → push origin
 * → npm run dist → publish-release.mjs）。未提交改动由脚本自动 stash/pop。
 * dev-only 工具面板，文案与日志均为中文（与 publish-release.mjs 输出一致），不走 i18n。
 */
export function DevReleasePanel() {
  const pushToast = useStore((s) => s.pushToast);
  const startReleaseReview = useStore((s) => s.startReleaseReview);
  const [status, setStatus] = useState<DevReleaseStatusInfo | null>(null);
  const [reviewing, setReviewing] = useState(false);

  const refresh = useCallback(() => {
    window.pi.app
      .devReleaseStatus()
      .then(setStatus)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // hooks 全部在前，early return 安全（Settings.tsx 的教训）。
  if (!status?.isDev) return null;

  const startReview = async () => {
    if (typeof window.pi.app.getReleaseReview !== "function") {
      pushToast("warning", "当前 dev 实例缺少发版评审接口，请完整重启 MPI（Ctrl+R 不够）");
      return;
    }
    setReviewing(true);
    try {
      const review: any = await window.pi.app.getReleaseReview();
      if (!review?.ok) {
        pushToast("error", review?.error || "获取发版评审数据失败");
        return;
      }
      const dirty = (review.dirtyFiles || []) as string[];
      const unreleased = String(review.unreleasedMarkdown || "").trim();
      const message = [
        `【发版评审 v${review.nextVersion}】（由 MPI「dev 一键发版」面板发起）`,
        "",
        review.hasEntries
          ? "本次待发布内容（changelog.md Unreleased 小节，将随本版本一起发布）："
          : "⚠ changelog.md 当前没有 Unreleased 条目——本次 Release 描述将为空。",
        "---",
        unreleased || "（无）",
        "---",
        "",
        `当前状态：工作区${dirty.length === 0 ? "干净" : `有 ${dirty.length} 个未提交文件`}${review.hasToken ? "；GitHub token 就绪" : "；⚠ GitHub token 缺失（需 env GITHUB_TOKEN 或仓库根 .gh-token）"}。`,
        ...(dirty.length > 0 ? ["", "未提交文件：", ...dirty.map((f: string) => `· ${f}`)] : []),
        "",
        "请你按以下流程协助我完成发版评审：",
        "1. 先用简洁中文总结本次发版内容（版本号 + 各条目要点），供我审阅。",
        "2. 在我明确确认之前，不要执行任何 git / npm / 构建命令。",
        '3. 当我明确确认后（例如回复"确认发布"），运行：node scripts/dev-release.mjs',
        "   该脚本会自动暂存未提交改动 → bump 版本 → 改 changelog → commit → push origin → npm run dist → 发布 GitHub Release，结束后自动恢复暂存；请把关键输出贴给我。",
        "4. 如果我提出修改意见（如调整 changelog 条目），先按我的要求修改并再次等待确认。",
      ].join("\n");
      const ok = await startReleaseReview({ cwd: review.cwd, nextVersion: review.nextVersion, message });
      if (ok) pushToast("success", `已打开 v${review.nextVersion} 发版评审会话，请在对话中确认后执行`);
      else pushToast("error", "打开发版评审会话失败");
    } catch (e: any) {
      pushToast("error", e?.message || String(e));
    } finally {
      setReviewing(false);
    }
  };

  return (
    <div className="set-card">
      <div className="set-card-title">dev 一键发版</div>
      <div className="set-hint" style={{ marginBottom: 12 }}>
        仅开发模式可用。点击后打开一个以新版本号命名的评审会话，展示待发布内容；你在对话中明确确认后，才由该会话执行
        scripts/dev-release.mjs（bump → changelog → commit → push origin → npm run dist → 发布 GitHub Release）。工作区有未提交改动时脚本会自动暂存、结束后自动恢复。
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
      {status.dirtyFiles.length > 0 && (
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
        <button className="set-btn primary" onClick={startReview} disabled={reviewing}>
          {reviewing ? "正在打开评审会话…" : `发起发版评审（v${status.nextVersion ?? "?"}）`}
        </button>
      </div>
    </div>
  );
}
