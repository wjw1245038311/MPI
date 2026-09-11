/**
 * Pure helpers for normalizing Feishu message payloads. Kept dependency-free
 * (type-only imports) so they can be unit-tested without the SDK via
 * `node --experimental-strip-types` (scripts/test-messaging.mjs).
 */
import type { FeishuChannelConfig } from "./types";

export interface FeishuMention {
  key?: string;
  name?: string;
}

/**
 * Feishu delivers `message.content` as a JSON-encoded string, e.g.
 * {"text":"@_user_1 hello"}. Returns the plain text or "" when unparseable.
 */
export function parseTextContent(content: unknown): string {
  if (typeof content !== "string") return "";
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).text === "string") {
      return String((parsed as Record<string, unknown>).text);
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * Removes @-mention placeholder tokens (@_user_1 …) from message text. The
 * server only pushes group messages that mention the bot (scope
 * im:message.group_at_msg), so any remaining token is ours to strip.
 */
export function stripMentions(text: string, mentions?: FeishuMention[]): string {
  let out = text;
  const keys = (mentions || [])
    .map((m) => m?.key)
    .filter((k): k is string => typeof k === "string" && k.length > 0);
  for (const key of keys) {
    out = out.split(key).join(" ");
  }
  // Fallback: strip any leftover placeholder tokens not covered by the list.
  out = out.replace(/@_user_\d+/g, " ");
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

/** Coerces arbitrary input (IPC boundary / persisted config) into a safe
 * channel config. Lives here — not in service.ts — so it stays importable by
 * the strip-types test runner (no parameter properties in this file). */
export function sanitizeFeishuConfig(raw?: Partial<FeishuChannelConfig> | null): FeishuChannelConfig {
  const str = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const out: FeishuChannelConfig = {
    enabled: raw?.enabled === true,
    appId: str(raw?.appId, 256),
    appSecret: str(raw?.appSecret, 512),
    projectCwd: str(raw?.projectCwd, 4096),
    permission: raw?.permission === "full" ? "full" : "sandbox",
  };
  const activeThreadId = str(raw?.activeThreadId, 128);
  if (activeThreadId) out.activeThreadId = activeThreadId; // keep the key absent when unset
  return out;
}
