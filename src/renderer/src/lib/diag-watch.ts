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

// ---- choices 围栏解析结果（面板到底有没有出来） ------------------------------
//
// 「面板没弹出来、只剩一坨 JSON」这类反馈没法靠截图归因：模型写坏的形态
// （裸引号 / 少括号 / 丢 {} / 超限）需要看到原文才能判。现在把失败与「修复救回」
// 都写一行进诊断日志（头部 240 + 尾部 120 字符），下次再遇到直接读日志定位。
// 同一条消息只记一次（组件重渲染会反复跑）。

const loggedChoiceFences = new Set<string>();

/** 去重集不能无限长（长会话里反复渲染会给每个失败围栏各留一条）。 */
function rememberChoiceFence(key: string): boolean {
  if (loggedChoiceFences.has(key)) return false;
  if (loggedChoiceFences.size > 500) loggedChoiceFences.clear();
  loggedChoiceFences.add(key);
  return true;
}

function choiceFenceKey(threadId: string, messageKey: string, index: number, raw: string): string {
  let hash = 5381;
  for (let i = 0; i < raw.length; i++) hash = ((hash << 5) + hash + raw.charCodeAt(i)) | 0;
  return `${threadId}:${messageKey}:${index}:${raw.length}:${hash}`;
}

/** choices 围栏降级成代码块（真的没救回来）。 */
export function logChoiceFenceFailure(detail: {
  threadId: string;
  messageKey: string;
  index: number;
  reason?: string;
  raw: string;
}): void {
  const key = `fail:${choiceFenceKey(detail.threadId, detail.messageKey, detail.index, detail.raw)}`;
  if (!rememberChoiceFence(key)) return;
  const flat = detail.raw.replace(/\s+/g, " ");
  send("choice-fence-fail", {
    thread: detail.threadId,
    message: detail.messageKey,
    index: detail.index,
    reason: detail.reason ?? "unknown",
    len: detail.raw.length,
    head: flat.slice(0, 240),
    tail: flat.slice(-120),
  });
}

/** choices 围栏靠修复链救回来了（以后收紧规则时可据此判断哪些修复还在用）。 */
export function logChoiceFenceRepaired(detail: {
  threadId: string;
  messageKey: string;
  index: number;
  raw: string;
}): void {
  const key = `repair:${choiceFenceKey(detail.threadId, detail.messageKey, detail.index, detail.raw)}`;
  if (!rememberChoiceFence(key)) return;
  const flat = detail.raw.replace(/\s+/g, " ");
  send("choice-fence-repaired", {
    thread: detail.threadId,
    message: detail.messageKey,
    index: detail.index,
    len: detail.raw.length,
    head: flat.slice(0, 240),
    tail: flat.slice(-120),
  });
}

/** ```choices 围栏出现在**工具结果**里（模型放错位置）：两端都只在助手正文块上跑面板升级，
 *  工具结果永远只是原样文本（手机端是一个 <pre>）。这不是 bug 而是有意设计，但用户看到的是
 *  「刚才那个面板怎么变成一坨 JSON 了」——所以记一行，下次几秒钟就能判出是位置问题。
 *  （2026-10-16 真实发生：agent 用 codemode 发围栏，用户以为手机端坏了。） */
export function logChoiceFenceInTool(detail: {
  threadId: string;
  messageKey: string;
  index: number;
  tool: string;
  raw: string;
}): void {
  const key = `intool:${choiceFenceKey(detail.threadId, detail.messageKey, detail.index, detail.raw)}`;
  if (!rememberChoiceFence(key)) return;
  const flat = detail.raw.replace(/\s+/g, " ");
  send("choice-fence-in-tool", {
    thread: detail.threadId,
    message: detail.messageKey,
    index: detail.index,
    tool: detail.tool,
    len: detail.raw.length,
    head: flat.slice(0, 240),
  });
}

/** 开围栏的 info string 不是标准 `choices`（`choices>` / `Choices` / `choicesjson`）但已按
 *  面板渲染。以前这种形态会静默降级成代码块（既无面板也无提示），现在记一行笔误形态，
 *  便于以后判断容错规则该放宽还是该收紧。 */
export function logChoiceFenceInfoString(detail: {
  threadId: string;
  messageKey: string;
  index: number;
  info: string;
  raw: string;
}): void {
  const key = `info:${choiceFenceKey(detail.threadId, detail.messageKey, detail.index, detail.raw)}`;
  if (!rememberChoiceFence(key)) return;
  send("choice-fence-info", {
    thread: detail.threadId,
    message: detail.messageKey,
    index: detail.index,
    info: detail.info,
    len: detail.raw.length,
  });
}
