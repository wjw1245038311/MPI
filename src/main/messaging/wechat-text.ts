/**
 * Pure helpers for the WeChat (iLink) channel: config sanitization at the IPC /
 * persistence boundary and inbound message text extraction. Kept dependency-free
 * so it stays importable by the strip-types test runner (like feishu-text.ts).
 */
import type { WeixinMessage } from "../weixin/ilink";
import type { WeChatChannelConfig } from "./types";

/** Coerces arbitrary input into a safe channel config. */
export function sanitizeWeChatConfig(raw?: Partial<WeChatChannelConfig> | null): WeChatChannelConfig {
  const str = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const out: WeChatChannelConfig = {
    enabled: raw?.enabled === true,
    botToken: str(raw?.botToken, 2048),
    botId: str(raw?.botId, 128),
    baseUrl: /^https:\/\/[^\s]+$/i.test(str(raw?.baseUrl, 512)) ? str(raw?.baseUrl, 512) : "https://ilinkai.weixin.qq.com",
    userId: str(raw?.userId, 128),
    projectCwd: str(raw?.projectCwd, 4096),
    permission: raw?.permission === "full" ? "full" : "sandbox",
  };
  const activeThreadId = str(raw?.activeThreadId, 128);
  if (activeThreadId) out.activeThreadId = activeThreadId; // keep the key absent when unset
  const buf = str(raw?.getUpdatesBuf, 65536);
  if (buf) out.getUpdatesBuf = buf;
  return out;
}

/** True when credentials are present enough to attempt a connection. */
export function isWeChatConfigured(cfg: WeChatChannelConfig): boolean {
  return !!cfg.botToken && !!cfg.baseUrl;
}

export interface InboundText {
  /** Concatenated text of all text items ("" when none). */
  text: string;
  /** True when the message carries any non-text item (image/voice/file/video). */
  hasMedia: boolean;
}

/** Extracts plain text from an inbound iLink message's item_list. */
export function extractInboundText(msg?: WeixinMessage | null): InboundText {
  if (!msg || typeof msg !== "object") return { text: "", hasMedia: false };
  const items = Array.isArray(msg.item_list) ? msg.item_list : [];
  let text = "";
  let hasMedia = false;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.type === 1 && typeof item.text_item?.text === "string") {
      text += (text ? "\n" : "") + item.text_item.text;
    } else if (item.type === 2 || item.type === 3 || item.type === 4 || item.type === 5) {
      hasMedia = true;
    }
  }
  return { text: text.trim(), hasMedia };
}
