/**
 * Extension-UI handling for unattended automation runs (scheduled tasks).
 *
 * Kept in its own module so it can be unit-tested without loading the rest of
 * the main-process graph. Mirrors the renderer's queueing rule (store.ts
 * handleExtUi): only select/confirm/input/editor become dialogs; everything
 * else pi sends over extension_ui_request is display-only / fire-and-forget
 * and must NOT fail an unattended run — e.g. pi-mcp-adapter emits
 * `setStatus("mcp", …)` at session init whenever mcp.json lists a server, even
 * for lazy ones that never connect (regression: every scheduled run failed
 * with 定时任务需要人工交互（setStatus）).
 */
import { isLikelyModelSelect } from "./web-search-config";

const textValue = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** Extension-UI methods that require user input (dialogs). Unattended runs
 * cannot answer them, so they are cancelled and remembered — the run then
 * fails with a clear error once the agent settles. */
const INTERACTIVE_EXT_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

export function isInteractiveExtUiMethod(method: unknown): boolean {
  return typeof method === "string" && INTERACTIVE_EXT_UI_METHODS.has(method);
}

/** Extension-UI handler for unattended automation runs. */
export interface AutomationExtUiHandler {
  handle(r: any): void;
  /** First interactive (user-input) method encountered, or null if none. */
  cancelledMethod(): string | null;
}

export function createAutomationExtUiHandler(opts: {
  respondExtUi: (id: string, payload: Record<string, unknown>) => void;
  autoPickModel?: boolean;
  answerModelSelect?: (r: any) => Promise<boolean>;
}): AutomationExtUiHandler {
  let cancelled: string | null = null;
  const cancelUi = (req: any): void => {
    // Unattended runs cannot answer dialogs. Cancel it immediately and
    // surface a failure after the agent settles instead of reporting a
    // misleading success.
    const method = textValue(req?.method) || "extension UI";
    if (isInteractiveExtUiMethod(method) && !cancelled) cancelled = method;
    opts.respondExtUi(String(req?.id ?? ""), { cancelled: true });
  };
  return {
    handle(r: any): void {
      // Model-picker dialogs are answered with the run's current model so
      // web searches don't fail headless; everything else still cancels.
      if (opts.autoPickModel !== false && opts.answerModelSelect && isLikelyModelSelect(r)) {
        void opts
          .answerModelSelect(r)
          .then((answered) => {
            if (!answered) cancelUi(r);
          })
          .catch(() => cancelUi(r));
        return;
      }
      cancelUi(r);
    },
    cancelledMethod: () => cancelled,
  };
}
