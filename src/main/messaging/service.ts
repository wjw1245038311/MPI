import * as Lark from "@larksuiteoapi/node-sdk";
import { getConfig, updateConfig } from "../config";
import { ChannelBase, MAX_REPLY_CHARS, type ChannelServiceOptions } from "./channel-base";
import { buildChannelTexts, truncateForChat } from "./channel-text";
import {
  parseTextContent,
  sanitizeFeishuConfig,
  stripMentions,
  type FeishuMention,
} from "./feishu-text";
import type { FeishuChannelConfig, MessagingState } from "./types";

/**
 * Feishu (Lark) message channel: a self-built app bot connected over the
 * official WebSocket long-connection mode (no public IP required). Messages
 * sent to the bot are routed into one dedicated pi session in the bound
 * project folder; the agent's reply streams back by updating the ack
 * message. Only text messages are handled (v1).
 *
 * The Feishu server re-pushes events not acknowledged within ~3s, so the
 * event handler returns immediately and all work runs asynchronously with a
 * single in-flight job per channel. Session commands, thread resolution and
 * job execution live in ChannelBase — this class keeps only the WebSocket
 * transport and the in-place message-update delivery.
 */

const STREAM_UPDATE_INTERVAL_MS = 2500;

export function feishuSessionName(language: "en" | "zh"): string {
  return language === "zh" ? "飞书接入" : "Feishu bridge";
}

/** Re-exported for callers that import it from the service module. */
export { sanitizeFeishuConfig };

const T = buildChannelTexts({
  titleZh: "飞书接入",
  titleEn: "Feishu bridge",
  thinkingZh: "🤔 正在处理，完成后会更新这条消息…",
  thinkingEn: "🤔 Working on it — this message will update when done…",
  deliveryZh: "直接发送文本 = 在当前会话中提问，回复会流式更新这条消息。",
  deliveryEn: "Plain text = ask the current session; the reply streams into this message.",
});

export interface MessagingServiceOptions extends ChannelServiceOptions<MessagingState> {}

export class FeishuMessagingService extends ChannelBase<MessagingState> {
  private wsClient: Lark.WSClient | null = null;
  private client: Lark.Client | null = null;
  /** Last user message id — approval notices reply to it so they land in-chat. */
  private lastSourceMessageId: string | null = null;

  constructor(options: MessagingServiceOptions) {
    super(options, T);
  }

  protected get logTag(): string {
    return "[messaging]";
  }

  protected loadConfig() {
    return sanitizeFeishuConfig(getConfig().feishuChannel);
  }

  protected mergeChannelConfig(patch: Record<string, unknown>): void {
    updateConfig({ feishuChannel: { ...sanitizeFeishuConfig(getConfig().feishuChannel), ...patch } });
  }

  protected sessionName(language: "en" | "zh"): string {
    return feishuSessionName(language);
  }

  protected get channelKind(): "feishu" {
    return "feishu";
  }

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
    this.setActiveThread(null);
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
        if (this.wsClient === wsClient) {
          this.lastError = null;
          this.setStatus("connected");
        }
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
    this.setActiveThread(null);
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
    this.lastSourceMessageId = msg.message_id;

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

    // Commands reply to the exact message that triggered them (threaded in-chat);
    // the returned ack message id is irrelevant here.
    const reply = async (t: string) => {
      await this.reply(msg.message_id, t);
    };
    if (await this.dispatchCommand(text, reply)) return;

    if (this.job) {
      await reply(lang.busy);
      return;
    }
    void this.runJob(msg.message_id, text).catch((err) => console.error("[messaging] runJob failed:", err));
  }

  // ---- job execution -------------------------------------------------------

  private async runJob(sourceMessageId: string, text: string): Promise<void> {
    let replyMessageId: string | null = null;
    let lastPushAt = Date.now();
    // Serialized pipeline for the ack message: every write is queued behind the
    // previous one, so a slow in-flight update can never land after (and
    // overwrite) a newer snapshot — that race made replies look "swallowed".
    let updateChain: Promise<void> = Promise.resolve();
    const queueUpdate = (fn: () => Promise<void>) => {
      updateChain = updateChain.then(fn).catch((err) => console.error("[messaging] queued update failed:", err instanceof Error ? err.message : err));
    };

    await this.runAgentTurn({
      ack: async () => {
        replyMessageId = await this.reply(sourceMessageId, T[this.options.language()].thinking);
      },
      text,
      onSnapshot: (buffer) => {
        const now = Date.now();
        if (replyMessageId && now - lastPushAt >= STREAM_UPDATE_INTERVAL_MS) {
          lastPushAt = now;
          const id = replyMessageId;
          queueUpdate(() => this.updateReply(id, truncateForChat(buffer, MAX_REPLY_CHARS)));
        }
      },
      deliver: async (payload) => {
        if (!this.client) return; // stopped meanwhile — nothing to update
        if (replyMessageId) {
          const id = replyMessageId;
          let finalLanded = false;
          queueUpdate(async () => {
            finalLanded = await this.updateReplyFinal(id, payload);
          });
          await updateChain; // make sure the complete result actually landed
          if (!finalLanded) {
            // The ack message could not be finalized (persistent Feishu error) —
            // deliver the complete result as a fresh message so nothing is lost.
            console.error("[messaging] final update failed after retries; sending fresh message");
            await this.reply(sourceMessageId, payload);
          }
        } else {
          await this.reply(sourceMessageId, payload);
        }
      },
    });
  }

  // ---- outbound ------------------------------------------------------------

  protected async notifyUser(text: string): Promise<void> {
    if (!this.lastSourceMessageId || !text) return;
    await this.reply(this.lastSourceMessageId, text);
  }

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

  /** Single attempt; throws on failure. */
  private async updateReplyOnce(messageId: string, text: string): Promise<void> {
    const client = this.client;
    if (!client || !messageId || !text) return;
    const res: any = await client.im.v1.message.update({
      path: { message_id: messageId },
      data: { msg_type: "text", content: JSON.stringify({ text }) },
    });
    if (res?.code !== undefined && res.code !== 0) throw new Error(res.msg || `Feishu error ${res.code}`);
  }

  /** Best-effort update for streaming snapshots. */
  private async updateReply(messageId: string, text: string): Promise<void> {
    try {
      await this.updateReplyOnce(messageId, text);
    } catch (err) {
      console.error("[messaging] update failed:", err instanceof Error ? err.message : err);
    }
  }

  /** Final write with retries — the user must see the complete result.
   * Returns true when the update landed. */
  private async updateReplyFinal(messageId: string, text: string): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.updateReplyOnce(messageId, text);
        return true;
      } catch (err) {
        if (attempt >= 2) {
          console.error(`[messaging] final update failed after ${attempt + 1} attempts:`, err instanceof Error ? err.message : err);
          return false;
        }
        await new Promise((r) => setTimeout(r, 800));
      }
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
 * user sees in the sidebar where channel chats land). Shared by all channels. */
export function ensureChannelProjectVisible(cwd: string): void {
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
