import * as Lark from "@larksuiteoapi/node-sdk";
import { getConfig, updateConfig } from "../config";
import type { RemoteBackend } from "../remote/service";
import {
  parseTextContent,
  sanitizeFeishuConfig,
  stripMentions,
  truncateForChat,
  type FeishuMention,
} from "./feishu-text";
import type { FeishuChannelConfig, MessagingState, MessagingStatus } from "./types";

/**
 * Feishu (Lark) message channel: a self-built app bot connected over the
 * official WebSocket long-connection mode (no public IP required). Messages
 * sent to the bot are routed into one dedicated pi session in the bound
 * project folder; the agent's reply streams back by updating the ack
 * message. Only text messages are handled (v1).
 *
 * The Feishu server re-pushes events not acknowledged within ~3s, so the
 * event handler returns immediately and all work runs asynchronously with a
 * single in-flight job per channel.
 */

const MAX_REPLY_CHARS = 4000;
const STREAM_UPDATE_INTERVAL_MS = 2500;
const DEDUP_CAP = 1000;
/** Hard cap for one agent turn driven from chat (watchdog). */
const JOB_TIMEOUT_MS = 30 * 60 * 1000;

export function feishuSessionName(language: "en" | "zh"): string {
  return language === "zh" ? "飞书接入" : "Feishu bridge";
}

/** Re-exported for callers that import it from the service module. */
export { sanitizeFeishuConfig };

const T = {
  zh: {
    thinking: "🤔 正在处理，完成后会更新这条消息…",
    busy: "⏳ 上一条消息还在处理中，请稍后再发。",
    unsupported: "目前只支持文本消息（图片/文件暂不支持）。",
    errorPrefix: "出错了：",
    noOutput: "（任务已完成，但没有产生文字输出）",
    timeoutNote: "等待超时（30 分钟），结果可能仍在 MPI 中生成。",
    truncatedNote: "已截断，完整内容见 MPI",
    newDone: "✅ 已新建会话，后续消息将进入新会话。",
    help: [
      "MPI 飞书接入 · 可用命令：",
      "/new — 新建一个会话（旧会话保留）",
      "/help — 显示本帮助",
      "直接发送文本 = 在当前会话中提问，回复会流式更新这条消息。",
    ].join("\n"),
  },
  en: {
    thinking: "🤔 Working on it — this message will update when done…",
    busy: "⏳ The previous message is still being processed, please wait.",
    unsupported: "Only text messages are supported for now (no images/files).",
    errorPrefix: "Error: ",
    noOutput: "(Task finished but produced no text output)",
    timeoutNote: "Timed out after 30 minutes; the result may still be finishing in MPI.",
    truncatedNote: "truncated — full content in MPI",
    newDone: "✅ New session created. Further messages go to it.",
    help: [
      "MPI Feishu bridge · commands:",
      "/new — start a fresh session (the old one is kept)",
      "/help — show this help",
      "Plain text = ask the current session; the reply streams into this message.",
    ].join("\n"),
  },
} as const;

export interface MessagingServiceOptions {
  backend: RemoteBackend;
  /** Maps a project cwd to the opaque remote project id (see ipc.ts). */
  resolveProjectId: (cwd: string) => string;
  language: () => "en" | "zh";
  onStateChange: (state: MessagingState) => void;
}

interface JobRef {
  cancelled: boolean;
  /** Resolves the in-flight job's settle promise immediately (used by stop()). */
  settleNow?: () => void;
}

export class FeishuMessagingService {
  private wsClient: Lark.WSClient | null = null;
  private client: Lark.Client | null = null;
  private status: MessagingStatus = "off";
  private lastError: string | null = null;
  /** message_id dedup (Feishu may re-push); insertion-ordered. */
  private readonly seen = new Map<string, true>();
  private currentThreadId: string | null = null;
  private job: JobRef | null = null;

  constructor(private readonly options: MessagingServiceOptions) {}

  getState(): MessagingState {
    const cfg = sanitizeFeishuConfig(getConfig().feishuChannel);
    return {
      status: this.status,
      lastError: this.lastError,
      configured: !!cfg.appId && !!cfg.appSecret,
      appIdMasked: maskAppId(cfg.appId),
      projectCwd: cfg.projectCwd,
      permission: cfg.permission,
    };
  }

  async start(config: FeishuChannelConfig): Promise<void> {
    this.stop();
    if (!config.appId || !config.appSecret) throw new Error("Feishu App ID / Secret is missing");
    if (!config.projectCwd) throw new Error("No project folder bound to the channel");
    this.lastError = null;
    this.currentThreadId = null;
    this.setStatus("connecting");

    const appId = config.appId.trim();
    const appSecret = config.appSecret.trim();
    this.client = new Lark.Client({ appId, appSecret });
    const wsClient = new Lark.WSClient({
      appId,
      appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
      onReady: () => {
        if (this.wsClient !== wsClient) return;
        this.lastError = null;
        this.setStatus("connected");
      },
      onError: (err: Error) => {
        if (this.wsClient !== wsClient) return;
        this.lastError = err?.message || String(err);
        this.setStatus("error");
      },
      onReconnecting: () => {
        if (this.wsClient === wsClient) this.setStatus("reconnecting");
      },
      onReconnected: () => {
        if (this.wsClient !== wsClient) return;
        this.lastError = null;
        this.setStatus("connected");
      },
    });
    this.wsClient = wsClient;

    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => {
        // Must return within ~3s or Feishu re-pushes the event. Never await work here.
        void this.handleIncoming(data).catch((err) => console.error("[messaging] handleIncoming failed:", err));
        return {};
      },
    });

    try {
      await wsClient.start({ eventDispatcher: dispatcher });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      this.setStatus("error");
      throw new Error(message);
    }
  }

  stop(): void {
    if (this.wsClient) {
      try {
        this.wsClient.close({ force: true });
      } catch {
        // best effort
      }
      this.wsClient = null;
    }
    this.client = null;
    this.currentThreadId = null;
    if (this.job) {
      this.job.cancelled = true;
      // Unhang the in-flight job so runJob exits instead of waiting on its watchdog.
      this.job.settleNow?.();
      this.job = null;
    }
    this.setStatus("off");
  }

  // ---- incoming messages ---------------------------------------------------

  private async handleIncoming(data: unknown): Promise<void> {
    const event = data as { sender?: { sender_type?: string }; message?: Record<string, any> } | null;
    const msg = event?.message;
    if (!msg || typeof msg.message_id !== "string") return;

    // Feishu may re-push the same message (reconnect / slow ack).
    if (this.seen.has(msg.message_id)) return;
    this.rememberSeen(msg.message_id);

    const senderType = event?.sender?.sender_type;
    if (senderType && senderType !== "user") return; // ignore bot-to-bot traffic

    const lang = T[this.options.language()];
    const messageType: string = typeof msg.message_type === "string" ? msg.message_type : "";
    if (messageType !== "text") {
      await this.reply(msg.message_id, lang.unsupported);
      return;
    }

    let text = parseTextContent(msg.content);
    text = stripMentions(text, Array.isArray(msg.mentions) ? (msg.mentions as FeishuMention[]) : undefined);
    if (!text) return;

    const cmd = text.toLowerCase();
    if (cmd === "/new" || cmd === "新建") {
      await this.handleNewCommand(msg.message_id);
      return;
    }
    if (cmd === "/help" || cmd === "帮助") {
      await this.reply(msg.message_id, lang.help);
      return;
    }

    if (this.job) {
      await this.reply(msg.message_id, lang.busy);
      return;
    }
    void this.runJob(msg.message_id, text).catch((err) => console.error("[messaging] runJob failed:", err));
  }

  private async handleNewCommand(sourceMessageId: string): Promise<void> {
    const cfg = sanitizeFeishuConfig(getConfig().feishuChannel);
    try {
      this.currentThreadId = await this.createThread(cfg);
      await this.reply(sourceMessageId, T[this.options.language()].newDone);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[messaging] /new failed:", message);
      await this.reply(sourceMessageId, `${T[this.options.language()].errorPrefix}${message.slice(0, 300)}`);
    }
  }

  // ---- job execution -------------------------------------------------------

  private async runJob(sourceMessageId: string, text: string): Promise<void> {
    const cfg = sanitizeFeishuConfig(getConfig().feishuChannel);
    const lang = T[this.options.language()];
    const ref: JobRef = { cancelled: false };
    this.job = ref;

    let replyMessageId: string | null = null;
    let unsubscribe: (() => void) | null = null;
    let buffer = "";
    let lastPushAt = Date.now();
    let settledResolve: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settledResolve = resolve;
    });
    ref.settleNow = settledResolve;
    let watchdog: ReturnType<typeof setTimeout> | null = null;

    try {
      // Ack first so the user always gets feedback in Feishu — even if thread
      // resolution or prompting fails below. Never fail silently.
      replyMessageId = await this.reply(sourceMessageId, lang.thinking);

      let threadId: string;
      try {
        threadId = this.currentThreadId || (await this.ensureThread(cfg));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[messaging] ensureThread failed:", message);
        await this.deliver(replyMessageId, sourceMessageId, `${lang.errorPrefix}${message.slice(0, 300)}`);
        return; // finally still clears the job
      }

      // Subscribe before prompting so no delta is missed.
      // NOTE: remotePublish sets event.kind to pi's own event type
      // ("message_update", "agent_settled", …) — not a constant wrapper kind.
      unsubscribe = this.options.backend.subscribeThread(threadId, (event) => {
        if (ref.cancelled) return;
        const ev: any = event.data?.event || {};
        if (event.kind === "message_update") {
          const ame = ev.assistantMessageEvent;
          if (ame?.type === "text_delta" && typeof ame.delta === "string") {
            buffer += ame.delta;
            const now = Date.now();
            if (replyMessageId && now - lastPushAt >= STREAM_UPDATE_INTERVAL_MS) {
              lastPushAt = now;
              void this.updateReply(replyMessageId, truncateForChat(buffer, MAX_REPLY_CHARS)).catch(() => undefined);
            }
          }
        } else if (event.kind === "message_end") {
          // agent_settled fires even when the turn errored (pi's finally block) —
          // annotate the buffer with the failure reason when there is one.
          const m = ev.message;
          if (m?.role === "assistant" && m.stopReason === "error") {
            const detail = typeof m.errorMessage === "string" ? ` ${m.errorMessage}` : "";
            buffer += `\n${lang.errorPrefix}${detail.trim()}`;
          }
        } else if (event.kind === "agent_settled") {
          settledResolve();
        } else if (event.kind === "thread.error" || event.kind === "thread.exit") {
          const detail = typeof event.data?.message === "string" ? ` ${event.data.message}` : "";
          buffer += `\n${lang.errorPrefix}${detail.trim()}`;
          settledResolve();
        }
      });

      watchdog = setTimeout(() => {
        if (!ref.cancelled) buffer += `\n${lang.timeoutNote}`;
        settledResolve();
      }, JOB_TIMEOUT_MS);

      try {
        await this.options.backend.prompt(threadId, text);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(message);
      }

      await settled;
    } finally {
      ref.cancelled = true;
      if (watchdog) clearTimeout(watchdog);
      unsubscribe?.();
      this.job = null;
    }

    // Final content: full reply text, truncated for chat delivery.
    const finalText = buffer.trim() || lang.noOutput;
    if (!ref.cancelled && this.client) {
      await this.deliver(
        replyMessageId,
        sourceMessageId,
        truncateForChat(finalText, MAX_REPLY_CHARS, lang.truncatedNote),
      ).catch(() => undefined);
    }
  }

  /** Updates the ack message when possible; falls back to a fresh reply. */
  private async deliver(replyMessageId: string | null, sourceMessageId: string, text: string): Promise<void> {
    if (replyMessageId) await this.updateReply(replyMessageId, text);
    else await this.reply(sourceMessageId, text);
  }

  /** Reuses the channel's dedicated session (matched by title) or creates it. */
  private async ensureThread(cfg: FeishuChannelConfig): Promise<string> {
    const projectId = this.options.resolveProjectId(cfg.projectCwd);
    try {
      const threads = await this.options.backend.listThreads(projectId);
      // Match either language variant so a UI-language switch doesn't fork a second session.
      const names = [feishuSessionName("zh"), feishuSessionName("en")];
      const found = (Array.isArray(threads) ? threads : []).find((t: any) => names.includes(t?.title) || names.includes(t?.name));
      if (found && typeof found.id === "string") {
        this.currentThreadId = found.id;
        return found.id;
      }
    } catch (err) {
      console.error("[messaging] listThreads failed:", err);
    }
    return this.createThread(cfg);
  }

  private async createThread(cfg: FeishuChannelConfig): Promise<string> {
    const projectId = this.options.resolveProjectId(cfg.projectCwd);
    const snapshot: any = await this.options.backend.createThread(
      projectId,
      feishuSessionName(this.options.language()),
      cfg.permission === "full" ? "full" : "sandbox",
    );
    if (!snapshot || typeof snapshot.id !== "string") throw new Error("Failed to create the channel session");
    this.currentThreadId = snapshot.id;
    return snapshot.id;
  }

  // ---- outbound ------------------------------------------------------------

  private async reply(sourceMessageId: string, text: string): Promise<string | null> {
    const client = this.client;
    if (!client || !text) return null;
    try {
      const res: any = await client.im.v1.message.reply({
        path: { message_id: sourceMessageId },
        data: { msg_type: "text", content: JSON.stringify({ text }) },
      });
      if (res?.code !== undefined && res.code !== 0) throw new Error(res.msg || `Feishu error ${res.code}`);
      return typeof res?.data?.message_id === "string" ? res.data.message_id : null;
    } catch (err) {
      console.error("[messaging] reply failed:", err instanceof Error ? err.message : err);
      return null;
    }
  }

  private async updateReply(messageId: string, text: string): Promise<void> {
    const client = this.client;
    if (!client || !messageId || !text) return;
    try {
      const res: any = await client.im.v1.message.update({
        path: { message_id: messageId },
        data: { msg_type: "text", content: JSON.stringify({ text }) },
      });
      if (res?.code !== undefined && res.code !== 0) throw new Error(res.msg || `Feishu error ${res.code}`);
    } catch (err) {
      console.error("[messaging] update failed:", err instanceof Error ? err.message : err);
    }
  }

  // ---- bookkeeping ---------------------------------------------------------

  private rememberSeen(messageId: string): void {
    this.seen.set(messageId, true);
    if (this.seen.size > DEDUP_CAP) {
      const keys = this.seen.keys();
      for (let i = 0; i < DEDUP_CAP / 2; i++) {
        const next = keys.next();
        if (next.done) break;
        this.seen.delete(next.value);
      }
    }
  }

  /** Emits the new state to the renderer. Called after every status or
   * lastError transition; the payload is cheap, so no dedup needed. */
  private setStatus(status: MessagingStatus): void {
    this.status = status;
    try {
      this.options.onStateChange(this.getState());
    } catch (err) {
      console.error("[messaging] onStateChange failed:", err);
    }
  }
}

function maskAppId(appId: string): string | null {
  if (!appId) return null;
  if (appId.length <= 6) return `${appId.slice(0, 2)}****`;
  return `${appId.slice(0, 4)}…${appId.slice(-2)}`;
}

// ---- module lifecycle -------------------------------------------------------

/** Makes sure the bound folder is visible to MPI: if it has no sessions yet
 * and isn't pinned, pin it so thread creation can resolve the project (and the
 * user sees in the sidebar where Feishu chats land). */
function ensureChannelProjectVisible(cwd: string): void {
  const trimmed = typeof cwd === "string" ? cwd.trim() : "";
  if (!trimmed) return;
  try {
    const cfg = getConfig();
    const pinned = cfg.pinnedProjects || [];
    if (pinned.some((path: string) => path.toLowerCase() === trimmed.toLowerCase())) return;
    updateConfig({ pinnedProjects: [...pinned, trimmed] });
  } catch (err) {
    console.error("[messaging] failed to pin channel project:", err);
  }
}

let service: FeishuMessagingService | null = null;

/** Called once from ipc.ts after the remote backend exists. */
export function initMessaging(options: MessagingServiceOptions): void {
  if (service) return;
  service = new FeishuMessagingService(options);
  const cfg = sanitizeFeishuConfig(getConfig().feishuChannel);
  if (cfg.projectCwd) ensureChannelProjectVisible(cfg.projectCwd);
  if (cfg.enabled && cfg.appId && cfg.appSecret && cfg.projectCwd) {
    void service.start(cfg).catch((err) => console.error("[messaging] auto-start failed:", err));
  }
}

/** Persists a sanitized config patch and restarts/stops the channel. */
export function messagingSetConfig(patch: Partial<FeishuChannelConfig>): MessagingState {
  if (!service) throw new Error("Messaging service is not initialized");
  const current = sanitizeFeishuConfig(getConfig().feishuChannel);
  const next = sanitizeFeishuConfig({ ...current, ...patch });
  updateConfig({ feishuChannel: next });
  ensureChannelProjectVisible(next.projectCwd);
  if (next.enabled && next.appId && next.appSecret && next.projectCwd) {
    void service.start(next).catch((err) => console.error("[messaging] start failed:", err));
  } else {
    service.stop();
  }
  return service.getState();
}

export function getMessagingState(): MessagingState | null {
  return service ? service.getState() : null;
}

/** App-quit cleanup (index.ts). */
export function stopMessaging(): void {
  if (!service) return;
  try {
    service.stop();
  } catch (err) {
    console.error("[messaging] stop failed:", err);
  }
  service = null;
}
