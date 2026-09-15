import { useStore } from "../store";

/**
 * Field diagnostics for intermittent UI issues — currently hunting the
 * "composer greyed out / can't type" report (thinkbook16p 2026-09-14).
 *
 * Emits low-frequency JSON lines to userData/logs/mpi-diag.log (main process,
 * see src/main/diag-log.ts) so the NEXT reproduction is diagnosable:
 *
 * - `extui-queue` — every change of the extension-UI dialog queue. A pending
 *   input/editor item means a full-screen ExtUiModal backdrop is up; if one
 *   stays in the log without a matching removal, that's the stuck-overlay path.
 * - `streaming` — per-thread isStreaming flips (start/end of agent runs).
 * - `window-focus` / `window-blur` / `visibility` — window-level liveness.
 *   A GAP across all line types during the greyed-out period means the renderer
 *   itself was unresponsive (event-loop block), not an overlay.
 */

let started = false;

function send(kind: string, detail?: Record<string, unknown>): void {
  try {
    const line = JSON.stringify({ t: new Date().toISOString(), kind, ...(detail || {}) });
    window.pi?.diag?.log(line);
  } catch {
    /* diagnostics must never break the UI */
  }
}

export function startDiagWatch(): void {
  if (started) return;
  started = true;

  const queueSig = (q: { threadId: string; request: { id?: unknown; method?: unknown } }[]): string =>
    JSON.stringify(q.map((item) => `${item.threadId}:${String(item.request.id ?? "")}`));

  let prevQueue = queueSig(useStore.getState().extuiQueue);
  const lastStreaming: Record<string, boolean> = {};

  useStore.subscribe((s) => {
    const sig = queueSig(s.extuiQueue);
    if (sig !== prevQueue) {
      send("extui-queue", {
        items: s.extuiQueue.map((q) => ({ thread: q.threadId, id: String(q.request.id ?? ""), method: String(q.request.method ?? "") })),
      });
      prevQueue = sig;
    }
    for (const [id, t] of Object.entries(s.threads)) {
      const streaming = !!t.isStreaming;
      if (lastStreaming[id] !== undefined && lastStreaming[id] !== streaming) send("streaming", { thread: id, to: streaming });
      lastStreaming[id] = streaming;
    }
  });

  window.addEventListener("focus", () => send("window-focus"));
  window.addEventListener("blur", () => send("window-blur"));
  document.addEventListener("visibilitychange", () => send("visibility", { state: document.visibilityState }));
}
