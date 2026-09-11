import { getConfig, updateConfig } from "../config";
import * as ilink from "../weixin/ilink";
import { ChannelBase, type ChannelServiceOptions } from "./channel-base";
import { buildChannelTexts } from "./channel-text";
import { ensureChannelProjectVisible } from "./service";
import { extractInboundText, isWeChatConfigured, sanitizeWeChatConfig } from "./wechat-text";
import type { WeChatChannelConfig, WeChatMessagingState } from "./types";

/**
 * Personal-WeChat (iLink bot) message channel. Messages sent to the bot in a
 * p2p chat are routed into one dedicated pi session in the bound project
 * folder; the agent's reply is delivered as a new text message (the iLink API
 * has no message-update primitive, unlike Feishu). A typing indicator is shown
 * while the job runs. Only text messages are handled (v1).
 *
 * Transport: long-poll `getUpdates` — no public endpoint required. The
 * get_updates_buf cursor is persisted in config so restarts don't re-deliver
 * old messages; a stale token (-14) stops the channel and asks for re-login.
 * Session commands, thread resolution and job execution live in ChannelBase —
 * this class keeps only the long-poll transport and fresh-message delivery.
 */

const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;

export function wechatSessionName(language: "en" | "zh"): string {
  return language === "zh" ? "微信接入" : "WeChat bridge";
}

/** Re-exported for callers that import it from the service module. */
export { sanitizeWeChatConfig };

const T = buildChannelTexts({
  titleZh: "微信接入",
  titleEn: "WeChat bridge",
  thinkingZh: "🤔 收到，正在处理，完成后会发送结果…",
  thinkingEn: "🤔 Got it — working on this, the result will arrive as a new message…",
  deliveryZh: "直接发送文本 = 在当前会话中提问，完成后会单独发一条结果消息。",
  deliveryEn: "Plain text = ask the current session; the result arrives as a new message.",
});

export interface WeChatMessagingServiceOptions extends ChannelServiceOptions<WeChatMessagingState> {}

export class WeChatMessagingService extends ChannelBase<WeChatMessagingState> {
  private abortController: AbortController | null = null;

  constructor(options: WeChatMessagingServiceOptions) {
    super(options, T);
  }

  protected get logTag(): string {
    return "[wechat]";
  }

  protected loadConfig() {
    return sanitizeWeChatConfig(getConfig().wechatChannel);
  }

  protected mergeChannelConfig(patch: Record<string, unknown>): void {
    updateConfig({ wechatChannel: { ...sanitizeWeChatConfig(getConfig().wechatChannel), ...patch } });
  }

  protected sessionName(language: "en" | "zh"): string {
    return wechatSessionName(language);
  }

  protected get channelKind(): "wechat" {
    return "wechat";
  }

  getState(): WeChatMessagingState {
    const cfg = sanitizeWeChatConfig(getConfig().wechatChannel);
    return {
      status: this.status,
      lastError: this.lastError,
      configured: isWeChatConfigured(cfg),
      botIdMasked: maskBotId(cfg.botId),
      projectCwd: cfg.projectCwd,
      permission: cfg.permission,
    };
  }

  async start(config: WeChatChannelConfig): Promise<void> {
    this.stop();
    if (!isWeChatConfigured(config)) throw new Error("WeChat credentials are missing — scan the QR code first");
    if (!config.projectCwd) throw new Error("No project folder bound to the channel");
    this.lastError = null;
    this.setActiveThread(null);
    this.setStatus("connecting");

    const controller = new AbortController();
    this.abortController = controller;
    void this.monitorLoop(config, controller.signal).catch((err) => {
      if (controller.signal.aborted) return;
      console.error("[wechat] monitor loop crashed:", err);
      this.lastError = err instanceof Error ? err.message : String(err);
      this.setStatus("error");
    });
  }

  stop(): void {
    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch {
        // best effort
      }
      this.abortController = null;
    }
    this.setActiveThread(null);
    if (this.job) {
      this.job.cancelled = true;
      this.job.settleNow?.();
      this.job = null;
    }
    const cfg = sanitizeWeChatConfig(getConfig().wechatChannel);
    void ilink.notifyLifecycle({ baseUrl: cfg.baseUrl, token: cfg.botToken, start: false });
    this.setStatus("off");
  }

  // ---- long-poll monitor ----------------------------------------------------

  private async monitorLoop(cfg: WeChatChannelConfig, signal: AbortSignal): Promise<void> {
    let buf = cfg.getUpdatesBuf ?? "";
    let nextTimeoutMs = ilink.DEFAULT_LONG_POLL_TIMEOUT_MS;
    let consecutiveFailures = 0;
    this.lastError = null;

    await ilink.notifyLifecycle({ baseUrl: cfg.baseUrl, token: cfg.botToken, start: true });
    this.setStatus("connected");

    while (!signal.aborted) {
      try {
        const resp = await ilink.getUpdates({
          baseUrl: cfg.baseUrl,
          token: cfg.botToken,
          getUpdatesBuf: buf,
          timeoutMs: nextTimeoutMs,
          abortSignal: signal,
        });

        if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
          nextTimeoutMs = resp.longpolling_timeout_ms;
        }

        const code = resp.errcode ?? resp.ret;
        if (code === -14) {
          // Stale token — retrying won't help; the user must re-scan.
          this.lastError = "登录已过期，请重新扫码连接微信。";
          this.setStatus("error");
          return;
        }
        if (code !== undefined && code !== 0) {
          consecutiveFailures++;
          console.warn(`[wechat] getUpdates error ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg}`);
          await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, signal);
          continue;
        }

        consecutiveFailures = 0;
        if (this.status !== "connected") this.setStatus("connected");
        if (resp.get_updates_buf && resp.get_updates_buf !== buf) {
          buf = resp.get_updates_buf;
          this.persistBuf(buf);
        }
        for (const msg of resp.msgs ?? []) {
          void this.handleIncoming(msg).catch((err) => console.error("[wechat] handleIncoming failed:", err));
        }
      } catch (err) {
        if (signal.aborted) return;
        consecutiveFailures++;
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[wechat] getUpdates network error (${consecutiveFailures}):`, message);
        this.lastError = message;
        this.setStatus("reconnecting");
        await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, signal);
      }
    }
  }

  private persistBuf(buf: string): void {
    try {
      this.mergeChannelConfig({ getUpdatesBuf: buf });
    } catch (err) {
      console.error("[wechat] persist getUpdatesBuf failed:", err);
    }
  }

  // ---- incoming messages ---------------------------------------------------

  private async handleIncoming(msg: ilink.WeixinMessage): Promise<void> {
    if (!msg || typeof msg.message_id !== "string") return;
    if (this.seen.has(msg.message_id)) return;
    this.rememberSeen(msg.message_id);

    // v1: p2p only, user messages only.
    if (msg.message_type !== 1) return;
    if (msg.group_id) return;

    const cfg = sanitizeWeChatConfig(getConfig().wechatChannel);
    const lang = T[this.options.language()];
    const toUserId = msg.from_user_id ?? cfg.userId;
    // Fresh-message delivery: every reply is a new text message in the p2p chat.
    const reply = (t: string) => this.send(cfg, toUserId, t, msg.context_token);

    const { text, hasMedia } = extractInboundText(msg);
    if (!text && !hasMedia) return;
    if (!text) {
      await reply(lang.unsupported);
      return;
    }

    if (await this.dispatchCommand(text, reply)) return;

    if (this.job) {
      await reply(lang.busy);
      return;
    }
    void this.runJob(msg).catch((err) => console.error("[wechat] runJob failed:", err));
  }

  // ---- job execution -------------------------------------------------------

  private async runJob(msg: ilink.WeixinMessage): Promise<void> {
    const cfg = sanitizeWeChatConfig(getConfig().wechatChannel);
    const toUserId = msg.from_user_id ?? cfg.userId;

    // Typing indicator (best-effort — never blocks the job).
    const ticket = await ilink.getTypingTicket({ baseUrl: cfg.baseUrl, token: cfg.botToken, userId: toUserId, contextToken: msg.context_token });
    if (ticket) void ilink.sendTyping({ baseUrl: cfg.baseUrl, token: cfg.botToken, userId: toUserId, ticket, status: 1 });

    await this.runAgentTurn({
      ack: () => this.send(cfg, toUserId, T[this.options.language()].thinking, msg.context_token),
      text: extractInboundText(msg).text,
      deliver: async (payload) => {
        // Final result as a NEW message (iLink has no message-update primitive);
        // also stops the typing indicator so it can't get stuck on errors.
        await this.send(cfg, toUserId, payload, msg.context_token);
        if (ticket) void ilink.sendTyping({ baseUrl: cfg.baseUrl, token: cfg.botToken, userId: toUserId, ticket, status: 2 });
      },
    });
  }

  // ---- outbound ------------------------------------------------------------

  protected async notifyUser(text: string): Promise<void> {
    const cfg = sanitizeWeChatConfig(getConfig().wechatChannel);
    await this.send(cfg, cfg.userId, text);
  }

  private async send(cfg: WeChatChannelConfig, toUserId: string, text: string, contextToken?: string): Promise<void> {
    if (!text || !toUserId) return;
    try {
      await ilink.sendTextMessage({ baseUrl: cfg.baseUrl, token: cfg.botToken, toUserId, text, contextToken });
    } catch (err) {
      console.error("[wechat] send failed:", err instanceof Error ? err.message : err);
    }
  }
}

function maskBotId(botId: string): string | null {
  if (!botId) return null;
  if (botId.length <= 8) return `${botId.slice(0, 3)}****`;
  return `${botId.slice(0, 4)}…${botId.slice(-4)}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(t);
      done();
    };
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---- module lifecycle -------------------------------------------------------

let service: WeChatMessagingService | null = null;

/** Called once from ipc.ts after the remote backend exists. */
export function initWeChatMessaging(options: WeChatMessagingServiceOptions): void {
  if (service) return;
  service = new WeChatMessagingService(options);
  const cfg = sanitizeWeChatConfig(getConfig().wechatChannel);
  if (cfg.projectCwd) ensureChannelProjectVisible(cfg.projectCwd);
  if (cfg.enabled && isWeChatConfigured(cfg) && cfg.projectCwd) {
    void service.start(cfg).catch((err) => console.error("[wechat] auto-start failed:", err));
  }
}

/** Persists a sanitized config patch and restarts/stops the channel. */
export function wechatSetConfig(patch: Partial<WeChatChannelConfig>): WeChatMessagingState {
  if (!service) throw new Error("WeChat messaging service is not initialized");
  const current = sanitizeWeChatConfig(getConfig().wechatChannel);
  const next = sanitizeWeChatConfig({ ...current, ...patch });
  updateConfig({ wechatChannel: next });
  ensureChannelProjectVisible(next.projectCwd);
  if (next.enabled && isWeChatConfigured(next) && next.projectCwd) {
    void service.start(next).catch((err) => console.error("[wechat] start failed:", err));
  } else {
    service.stop();
  }
  return service.getState();
}

export function getWeChatState(): WeChatMessagingState | null {
  return service ? service.getState() : null;
}

/** App-quit cleanup (index.ts). */
export function stopWeChatMessaging(): void {
  if (!service) return;
  try {
    service.stop();
  } catch (err) {
    console.error("[wechat] stop failed:", err);
  }
  service = null;
}
