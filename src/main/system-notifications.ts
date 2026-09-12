import { BrowserWindow, Notification } from "electron";
import { isChoiceTitle } from "./choice-logic.ts";

export type NotificationLanguage = "en" | "zh";

export interface TaskCompletionNotification {
  language: NotificationLanguage;
  prompt?: string;
  reply?: string;
}

export interface SystemNotificationCenter {
  notifySandboxApproval(threadId: string, language: NotificationLanguage, operation?: string): void;
  /** A plan-choice card (mpi_ask_choice) is waiting for the user's click. */
  notifyChoicePending(threadId: string, language: NotificationLanguage, question?: string): void;
  notifyTaskComplete(threadId: string, details: TaskCompletionNotification): void;
}

type WindowGetter = () => BrowserWindow | null;

/** Keep native notification content compact enough for both Windows and macOS banners. */
export function truncateNotificationText(value: unknown, maxLength: number): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1))}…`;
}

/** The permission gate identifies its actionable prompts through this stable title prefix.
 * Newer builds use the generic “权限确认 / Permission required” prefix for all gated
 * modes; older sandbox prefixes are kept so in-flight requests still match. */
const GATE_TITLE_PREFIX = /^(?:Permission\s+required|权限确认|Sandbox\s+authorization|Sandbox\s+请求授权|沙盒\s*请求授权|请求授权)\s*[:：]/i;

export function isSandboxApprovalRequest(request: unknown): boolean {
  if (!request || typeof request !== "object") return false;
  const value = request as { method?: unknown; title?: unknown };
  if (value.method !== "select" || typeof value.title !== "string") return false;
  return GATE_TITLE_PREFIX.test(value.title.trim());
}

/** The choice extension identifies its dialogs through the stable
 * “方案选择 / Plan choice” title prefix (see src/main/choice-logic.ts). */
export function isChoiceRequest(request: unknown): boolean {
  if (!request || typeof request !== "object") return false;
  const value = request as { method?: unknown; title?: unknown };
  if (value.method !== "select" || typeof value.title !== "string") return false;
  return isChoiceTitle(value.title);
}

/** Extract only the operation label; the full command remains inside MPI. */
export function sandboxOperationFromTitle(title: unknown, language: NotificationLanguage = "en"): string {
  if (typeof title !== "string") return language === "zh" ? "命令行" : "Shell";
  const firstLine = title.split(/\r?\n/, 1)[0] || "";
  const operation = firstLine.replace(GATE_TITLE_PREFIX, "").trim();
  return truncateNotificationText(operation || (language === "zh" ? "命令行" : "Shell"), 80);
}

function revealThread(getWindow: WindowGetter, threadId: string): void {
  const window = getWindow();
  if (!window || window.isDestroyed()) return;

  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();

  const sendFocus = () => {
    if (!window.isDestroyed()) window.webContents.send("app:focus-thread", { threadId });
  };
  if (window.webContents.isLoading()) window.webContents.once("did-finish-load", sendFocus);
  else sendFocus();
}

export function createSystemNotificationCenter(getWindow: WindowGetter): SystemNotificationCenter {
  // Keeping a reference until close makes the click handler reliable on Windows,
  // where the native toast can outlive the JavaScript call stack.
  const active = new Set<Notification>();

  const show = (
    threadId: string,
    language: NotificationLanguage,
    options: { title: string; subtitle?: string; body: string; persistent?: boolean },
  ) => {
    if (!Notification.isSupported()) return;
    const window = getWindow();
    // The in-app confirmation card and transcript are already visible when Pi
    // MPI owns the foreground. Native banners are for other apps/desktops.
    if (window && !window.isDestroyed() && window.isFocused()) return;

    let notification: Notification;
    try {
      notification = new Notification({
        title: options.title,
        subtitle: options.subtitle,
        body: options.body,
        silent: false,
        timeoutType: options.persistent ? "never" : "default",
      });
    } catch {
      return;
    }

    active.add(notification);
    notification.once("click", () => revealThread(getWindow, threadId));
    notification.once("close", () => active.delete(notification));
    notification.once("failed", (_event, error) => {
      active.delete(notification);
      // eslint-disable-next-line no-console
      console.warn(`[notification] native notification failed: ${error}`);
    });
    notification.show();
  };

  return {
    notifySandboxApproval(threadId, language, operation) {
      const label = truncateNotificationText(operation || (language === "zh" ? "命令行" : "Shell"), 80);
      show(threadId, language, {
        title: language === "zh" ? "MPI · 需要确认" : "MPI · Approval required",
        subtitle: label,
        body:
          language === "zh"
            ? `操作正在等待确认（${label}）。点击此提醒返回 MPI。`
            : `A gated operation is waiting for approval (${label}). Click to return to MPI.`,
        persistent: true,
      });
    },

    notifyChoicePending(threadId, language, question) {
      const label = truncateNotificationText(question || (language === "zh" ? "方案选择" : "Plan choice"), 80);
      show(threadId, language, {
        title: language === "zh" ? "MPI · 等待你的选择" : "MPI · Awaiting your choice",
        subtitle: label,
        body:
          language === "zh"
            ? `有方案正在等你点击选择（${label}）。点击此提醒返回 MPI。`
            : `A plan-choice card is waiting for you (${label}). Click to return to MPI.`,
        persistent: true,
      });
    },

    notifyTaskComplete(threadId, details) {
      const language = details.language;
      const prompt = truncateNotificationText(details.prompt, 72);
      const reply = truncateNotificationText(details.reply, 220);
      const body = reply || (language === "zh" ? "点击此提醒查看完整回复。" : "Click to view the completed reply.");
      show(threadId, language, {
        title: language === "zh" ? "MPI · 任务完成" : "MPI · Task completed",
        subtitle: prompt || undefined,
        body,
      });
    },
  };
}
