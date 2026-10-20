/**
 * MPI 图片引用 bridge for pi（经 --extension 加载，见 image-ref-extension.ts）。
 *
 * 为什么存在
 * ---------
 * pi 每发一次请求，都会把整段对话重发一遍。对话里带着几十张图时（作图会话、读过很多截图的会话），
 * 每轮上行就是十几 MB 的 base64 —— 2026-10-19 实测一条 19 万 token 的作图会话：
 * `tailnet rx 1.59 MB/s 持续 25 秒、累计 39.0 MB` 才开始生成，服务端那一刻 `waiting=0 holding=False`，
 * 也就是说等待全在上行，不在模型、不在调度。
 *
 * Strata serve（`Vision.encode`）早就按图片**原始字节的 sha256** 缓存了编码结果——同一个客户端每轮重发
 * 同一张图它只编码一次；缺的只是「别重发」。本扩展补上这一半：
 *
 *   1. 每次 LLM 调用前问服务端一次 `GET <baseUrl>/vision/refs`（只回 hash 列表）；
 *   2. 命中的历史图片，把内容块从 `{type:"image", data:<base64>}` 换成
 *      `{type:"image", data:<hash>, mimeType:"image/x-strata-ref"}`；
 *   3. pi 的 provider 序列化会把它写成 `data:image/x-strata-ref;base64,<hash>`，服务端按引用取缓存，
 *      字节不再上路。
 *
 * 自愈：服务端重启后缓存为空 → 探到的 refs 变少 → 图片自动回落到 base64 重发一次，不会卡死。
 * 服务端没有这个端点（老版本/别的 provider）→ 探测失败按空集处理，扩展等于不存在。
 *
 * 只改 `context` 深拷贝出来的那一份 messages：会话存档里仍是原图，TUI 显示也不受影响。
 * 本文件以 raw 字符串打进主进程、独立写入 userData，必须自包含（不 import 本地模块）。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 引用块的 mimeType：它与 hash 一起决定 provider 序列化出的 data URL。 */
const REF_MIME = "image/x-strata-ref";
/** 探测结果的缓存时长：图片编码是上一轮完成的，下一轮就能命中，30 秒足够新。 */
const TTL_MS = 30_000;
/** 探测超时：跨 tailnet 也只有几十毫秒，3 秒还拿不到就当作没有这个能力。 */
const TIMEOUT_MS = 3_000;

interface ProviderCfg {
  baseUrl: string;
  apiKey: string;
}

interface RefState extends ProviderCfg {
  refs: Set<string>;
  at: number;
}

let state: RefState | null = null;
/** 这些 provider 已经验证过「没有 /vision/refs」，不必每轮都问一遍。 */
const unsupported = new Set<string>();

/** mi 的 provider 配置（baseUrl / apiKey）。读不到就是没有这个能力。 */
function providerConfig(provider: string | undefined): ProviderCfg | null {
  if (!provider) return null;
  try {
    const file = join(homedir(), ".pi", "agent", "models.json");
    const json = JSON.parse(readFileSync(file, "utf8")) as {
      providers?: Record<string, { baseUrl?: unknown; apiKey?: unknown }>;
    };
    const p = json.providers?.[provider];
    if (typeof p?.baseUrl !== "string" || !p.baseUrl) return null;
    return {
      baseUrl: p.baseUrl.replace(/\/+$/, ""),
      apiKey: typeof p.apiKey === "string" ? p.apiKey : "",
    };
  } catch {
    return null;
  }
}

/** 服务端已缓存的图片 hash（原始字节的 sha256 前 32 位）。拿不到 → 空集。 */
async function refsFor(provider: string | undefined): Promise<Set<string> | null> {
  if (provider && unsupported.has(provider)) return null;
  const cfg = providerConfig(provider);
  if (!cfg) return null;
  const now = Date.now();
  if (state && state.baseUrl === cfg.baseUrl && now - state.at < TTL_MS) return state.refs;
  try {
    const res = await fetch(`${cfg.baseUrl}/vision/refs`, {
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) {
      // 老服务端（没有这个端点）：本会话不再打扰它
      if (provider) unsupported.add(provider);
      state = { ...cfg, refs: new Set(), at: now };
      return null;
    }
    if (!res.ok) {
      state = { ...cfg, refs: new Set(), at: now };
      return new Set();
    }
    const json = (await res.json()) as { refs?: unknown };
    const refs = new Set<string>(
      Array.isArray(json.refs) ? json.refs.filter((r): r is string => typeof r === "string") : [],
    );
    state = { ...cfg, refs, at: now };
    return refs;
  } catch {
    state = { ...cfg, refs: new Set(), at: now };
    return new Set();
  }
}

/** 与服务端 `Vision.encode` 同一口径：图片**原始字节**的 sha256 前 32 位十六进制。 */
function hashOf(data: string): string {
  return createHash("sha256").update(Buffer.from(data, "base64")).digest("hex").slice(0, 32);
}

export default function (pi: ExtensionAPI) {
  pi.on("context", async (event, ctx) => {
    const provider = (ctx as { model?: { provider?: string } }).model?.provider;
    const refs = await refsFor(provider);
    if (!refs || refs.size === 0) return;

    let changed = false;
    const messages = event.messages.map((message) => {
      if (!Array.isArray(message.content)) return message;
      let touched = false;
      const content = message.content.map((part) => {
        const p = part as { type?: string; data?: unknown; mimeType?: unknown };
        if (p?.type !== "image" || typeof p.data !== "string" || p.mimeType === REF_MIME) return part;
        let hash: string;
        try {
          hash = hashOf(p.data);
        } catch {
          return part;
        }
        if (!refs.has(hash)) return part;          // 服务端没有这张图：照常发原图
        touched = true;
        return { ...p, data: hash, mimeType: REF_MIME };
      });
      if (!touched) return message;
      changed = true;
      return { ...message, content };
    });

    return changed ? { messages } : undefined;
  });
}
