import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { ToolRun, TransferInfo } from "../lib/types";
import { normalizeTranscriptText } from "../lib/tool-args";
import { translateUiText } from "../lib/i18n";
import { useOutsideClose } from "../lib/useOutsideClose";
import { Download, Stop, Terminal } from "./icons";

/**
 * Global monitor for long-running operations, styled after the composer's
 * context-usage ring: a small 30px button (bottom-left, above every overlay)
 * that appears once an operation has been running longer than SHOW_AFTER_MS.
 * Clicking it opens a popover with live progress — no floating card covers
 * any UI while idle or while tasks run.
 *
 * Two sources:
 * 1. Agent tool calls (bash/shell/exec/…): read from the store's per-thread
 *    `toolRuns`; pi streams partial output via `tool_execution_update`, so we
 *    tail what the command is doing. Intervention = abort the thread turn.
 * 2. MPI shell transfers (extension install, Pi core / app update downloads):
 *    pushed from main via `window.pi.transfers` with byte/speed detail and a
 *    real cancel where supported.
 */

const SHOW_AFTER_MS = 10_000;
const RING_R = 7.5;
const RING_C = 2 * Math.PI * RING_R;

interface AgentTask {
  key: string;
  threadKey: string;
  name: string;
  command?: string;
  startedAt: number;
  partialText?: string;
}

function extractCommand(run: ToolRun): string | undefined {
  const a = run.args;
  if (a && typeof a === "object") {
    for (const k of ["command", "cmd", "script"]) {
      const v = (a as Record<string, unknown>)[k];
      if (typeof v === "string" && v.trim()) return normalizeTranscriptText(v);
    }
  }
  return undefined;
}

function collectAgentTasks(): AgentTask[] {
  const s = useStore.getState();
  const out: AgentTask[] = [];
  // Runs on every store change (incl. LLM token events): keep it allocation-free.
  for (const threadKey in s.threads) {
    const t = s.threads[threadKey];
    if (!t || !t.toolRuns) continue;
    for (const runId in t.toolRuns) {
      const run = t.toolRuns[runId];
      if (!run.running) continue;
      out.push({
        key: threadKey + "::" + runId,
        threadKey,
        name: run.name,
        command: extractCommand(run),
        startedAt: run.startedAt ?? Date.now(),
        partialText: run.partialText,
      });
    }
  }
  out.sort((a, b) => a.startedAt - b.startedAt);
  return out;
}

function sameAgentTasks(a: AgentTask[], b: AgentTask[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.key !== y.key || x.startedAt !== y.startedAt || x.partialText !== y.partialText) return false;
  }
  return true;
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Last non-empty lines of a (possibly large) output blob. */
function tailLines(text: string | undefined, max = 3): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0);
  return lines.slice(-max);
}

function firstLine(text: string, maxLen = 64): string {
  const line = (text.split(/\r?\n/)[0] || "").trim();
  return line.length > maxLen ? line.slice(0, maxLen - 1) + "…" : line;
}

export function LongTaskMonitor() {
  const language = useStore((s) => s.config?.language || "en");
  const zh = language === "zh";
  const [agentTasks, setAgentTasks] = useState<AgentTask[]>([]);
  const [transfers, setTransfers] = useState<TransferInfo[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Agent tool calls: the store already receives every tool event for chat
  // rendering; we only mirror the compact running list into local state and
  // skip updates that did not change it (LLM token streaming never touches
  // toolRuns, so this does not re-render per token).
  useEffect(() => {
    let prev = collectAgentTasks();
    setAgentTasks(prev);
    return useStore.subscribe(() => {
      const next = collectAgentTasks();
      if (!sameAgentTasks(prev, next)) {
        prev = next;
        setAgentTasks(next);
      }
    });
  }, []);

  // MPI shell transfers from main (guarded: older dev preloads lack the API).
  useEffect(() => {
    const api = window.pi?.transfers;
    if (!api || typeof api.on !== "function") return;
    let alive = true;
    void api
      .getSnapshot()
      .then((list) => {
        if (alive && Array.isArray(list)) setTransfers(list);
      })
      .catch(() => undefined);
    const off = api.on((list: TransferInfo[]) => setTransfers(Array.isArray(list) ? list : []));
    return () => {
      alive = false;
      off();
    };
  }, []);

  // One-second clock, only while something is actually running.
  const activeCount = agentTasks.length + transfers.length;
  useEffect(() => {
    if (!activeCount) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [activeCount]);

  useOutsideClose(wrapRef, open, () => setOpen(false));

  const visibleAgent = agentTasks.filter((t) => now - t.startedAt >= SHOW_AFTER_MS);
  const visibleTransfers = transfers.filter((t) => now - t.startedAt >= SHOW_AFTER_MS);
  const count = visibleAgent.length + visibleTransfers.length;

  // Close the popover once everything settles.
  useEffect(() => {
    if (!count) setOpen(false);
  }, [count]);

  if (!count) return null;

  // Ring fill: first transfer with a known total wins; otherwise spin.
  let ringPct: number | null = null;
  for (const t of visibleTransfers) {
    if (t.totalBytes && t.totalBytes > 0) {
      ringPct = Math.min(99, Math.floor(((t.doneBytes || 0) / t.totalBytes) * 100));
      break;
    }
  }
  // Ring color escalates with the longest-running task: a glance tells you
  // whether something is merely slow or possibly stuck.
  const maxElapsed = Math.max(
    ...visibleAgent.map((t) => now - t.startedAt),
    ...visibleTransfers.map((t) => now - t.startedAt),
  );
  const band = maxElapsed >= 180_000 ? "hi" : maxElapsed >= 60_000 ? "warn" : "low";

  const stopTask = (threadKey: string) => {
    void useStore.getState().abortThread(threadKey);
  };
  const cancelTransfer = (id: string) => {
    const api = window.pi?.transfers;
    if (api && typeof api.cancel === "function") void api.cancel(id).catch(() => undefined);
  };

  return (
    <div className="ltm-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`ctx-ring-btn ${open ? "on" : ""}`}
        title={zh ? "运行中的长任务（点击查看详情）" : "Long-running tasks (click for details)"}
        aria-label={zh ? "运行中的长任务" : "Long-running tasks"}
        onClick={() => setOpen((o) => !o)}
      >
        <svg className={`ctx-ring ${band} ${ringPct == null ? "spin" : ""}`} width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
          <circle className="track" cx="10" cy="10" r={RING_R} />
          {ringPct != null ? (
            <circle
              className="fill"
              cx="10"
              cy="10"
              r={RING_R}
              strokeDasharray={`${(ringPct / 100) * RING_C} ${RING_C}`}
              transform="rotate(-90 10 10)"
            />
          ) : (
            <circle className="fill spin-arc" cx="10" cy="10" r={RING_R} />
          )}
        </svg>
        {count > 1 && <span className="ltm-badge">{count}</span>}
      </button>

      {open && (
        <div className="ltm-pop">
          <div className="ltm-pop-head">
            <span>{zh ? "运行中的长任务" : "Long-running tasks"}</span>
            <span className="ltm-pop-count">{count}</span>
          </div>

          {visibleAgent.map((t) => {
            const tail = tailLines(t.partialText, 3);
            const title = t.command ? firstLine(t.command) : t.name;
            return (
              <div key={t.key} className="ltm-card">
                <div className="ltm-head">
                  <span className="ltm-icon">
                    <Terminal size={14} />
                  </span>
                  <span className="ltm-title" title={t.command || t.name}>
                    {title}
                  </span>
                  <span className="ltm-elapsed">{formatElapsed(now - t.startedAt)}</span>
                  <button
                    className="iconbtn ltm-btn"
                    title={zh ? "停止该会话当前轮次（中断正在执行的任务）" : "Stop this session's current turn (interrupts the running task)"}
                    onClick={() => stopTask(t.threadKey)}
                  >
                    <Stop size={13} />
                  </button>
                </div>
                <div className="upd-bar indeterminate">
                  <div className="upd-bar-fill" />
                </div>
                {tail.length > 0 && <pre className="ltm-tail">{tail.join("\n")}</pre>}
              </div>
            );
          })}

          {visibleTransfers.map((t) => {
            const pct = t.totalBytes ? Math.min(99, Math.floor(((t.doneBytes || 0) / t.totalBytes) * 100)) : null;
            const speed = (t.speedBps && t.speedBps > 0 ? formatBytes(t.speedBps) + "/s" : null);
            return (
              <div key={t.id} className="ltm-card">
                <div className="ltm-head">
                  <span className="ltm-icon">
                    {t.kind === "upload" ? <Download size={14} style={{ transform: "rotate(180deg)" }} /> : <Download size={14} />}
                  </span>
                  <span className="ltm-title">{translateUiText(t.label, language)}</span>
                  <span className="ltm-elapsed">{formatElapsed(now - t.startedAt)}</span>
                  {t.cancellable && (
                    <button
                      className="iconbtn ltm-btn"
                      title={zh ? "取消该操作" : "Cancel this operation"}
                      onClick={() => cancelTransfer(t.id)}
                    >
                      <Stop size={13} />
                    </button>
                  )}
                </div>
                {pct != null ? (
                  <>
                    <div className="upd-bar">
                      <div className="upd-bar-fill" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="ltm-stats">
                      <span>
                        {formatBytes(t.doneBytes || 0)} / {formatBytes(t.totalBytes!)} · {pct}%
                      </span>
                      {speed && <span>{speed}</span>}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="upd-bar indeterminate">
                      <div className="upd-bar-fill" />
                    </div>
                    {(t.doneBytes || speed) && (
                      <div className="ltm-stats">
                        {t.doneBytes ? <span>{formatBytes(t.doneBytes)}</span> : null}
                        {speed && <span>{speed}</span>}
                      </div>
                    )}
                  </>
                )}
                {t.detail && <pre className="ltm-tail">{tailLines(t.detail, 2).join("\n")}</pre>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
