import { useEffect, useRef, useState } from "react";
import { Copy } from "./icons";

/** Keep in sync with LOG_BUFFER_MAX in src/main/dev-release.ts. */
const MAX_LINES = 5000;

/** Merge a pulled history snapshot with lines already received live: drop the
 * leading live lines that are still at the tail of the snapshot (they were
 * emitted between listener registration and the snapshot read). Finds the
 * largest overlap where live's prefix equals the snapshot's tail. */
function mergeSnapshot(snapshot: string[], live: string[]): string[] {
  if (live.length === 0) return snapshot;
  // Largest k with live[0..k) === snapshot[tail k]; live only ever holds the
  // few lines emitted during one IPC round-trip, so this is cheap.
  let skip = 0;
  for (let k = Math.min(live.length, snapshot.length); k > 0; k--) {
    let ok = true;
    for (let i = 0; i < k; i++) {
      if (live[i] !== snapshot[snapshot.length - k + i]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      skip = k;
      break;
    }
  }
  return [...snapshot, ...live.slice(skip)];
}

/** Full-window pipeline log viewer for the standalone window opened from the
 * dev release panel (#dev-release-log). The panel keeps only a short tail
 * inline; this window shows everything with follow-scroll. Dev-only tooling —
 * copy is Chinese by design (same as DevReleasePanel), no i18n. */
export function StandaloneDevLog() {
  const [lines, setLines] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement | null>(null);
  // Live lines received before the history snapshot resolves (dedup input).
  const liveRef = useRef<string[]>([]);

  useEffect(() => {
    // Follow the app theme; this window has no store bootstrap.
    window.pi.app
      .getConfig()
      .then((cfg: any) => {
        const theme = cfg?.theme || "light";
        if (theme !== "system") document.documentElement.dataset.theme = theme;
      })
      .catch(() => {});

    // Register the live listener FIRST, then pull history — lines emitted in
    // between land in both and mergeSnapshot() dedups them.
    const offLive = window.pi.on.devReleaseLog((line: string) => {
      liveRef.current.push(line);
      setLines((prev) => [...prev.slice(-(MAX_LINES - 1)), line]);
    });
    let cancelled = false;
    void window.pi.app
      .getDevReleaseLog()
      .then((snapshot: string[]) => {
        if (cancelled || !Array.isArray(snapshot)) return;
        setLines(mergeSnapshot(snapshot, liveRef.current).slice(-MAX_LINES));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      offLive();
    };
  }, []);

  // Auto-scroll to the bottom unless the user scrolled up (same rule as the
  // panel's inline box: only follow when already near the bottom).
  useEffect(() => {
    const el = preRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (nearBottom || lines.length === 1) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — ignore */
    }
  };

  return (
    <div className="devlog-window">
      <div className="devlog-head">
        <span className="devlog-title">MPI dev 发版日志</span>
        <span className="devlog-count">{lines.length} 行</span>
        <button className="devlog-copy" onClick={copyAll} disabled={lines.length === 0} title="复制全部日志">
          {copied ? "✓ 已复制" : (
            <>
              <Copy size={13} /> 复制全部
            </>
          )}
        </button>
      </div>
      <pre ref={preRef} className="devlog-body">
        {lines.length === 0 ? "（暂无日志——在「设置 → 关于 MPI」的 dev 面板点击发版后，输出会实时显示在这里）" : lines.join("\n")}
      </pre>
    </div>
  );
}
