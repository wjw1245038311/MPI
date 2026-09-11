import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { getChannelThread, type ChannelCommandAction, type ChannelCommandResult } from "./channel-threads";

/**
 * Main-process side of the channel session command bridge.
 *
 * The pi extension (channel-command-ext.ts) drops one JSON request file per
 * tool call into <userData>/channel-cmd-inbox/; we ingest them here and write
 * a "<id>.resp.json" next to each request, which the extension polls for. The
 * main process stays the single writer of channel state — same inbox pattern
 * as the todo bridge (todo-store.ts). Requests are routed by sessionId via the
 * channel-thread registry, so WeChat and Feishu never cross-wire even when
 * both are bound to the same project.
 */

export function channelCommandInboxDir(): string {
  return join(getConfigDir(), "channel-cmd-inbox");
}

/** Ensure the inbox exists at its current location and return it. */
export function ensureChannelCommandInbox(): string {
  const dir = channelCommandInboxDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface ChannelCommandRequest {
  sessionId: string;
  action: ChannelCommandAction;
  target?: string | null;
}

/** Guards against double-processing the same file (watch + poll overlap). */
const inflight = new Set<string>();
/** Orphaned responses (the extension drops its request on timeout) are pruned. */
const STALE_RESP_MS = 60 * 60 * 1000;

/** Consume pending request files. Idempotent — safe from watch and poll. */
export function ingestChannelCommands(): void {
  const dir = channelCommandInboxDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // no inbox yet — normal before the first spawn
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    if (name.endsWith(".resp.json")) {
      try {
        if (Date.now() - statSync(join(dir, name)).mtimeMs > STALE_RESP_MS) unlinkSync(join(dir, name));
      } catch {
        /* ignore */
      }
      continue;
    }
    if (inflight.has(name)) continue;
    inflight.add(name);
    void handleRequestFile(name)
      .catch((err) => console.error("[channel-cmd] ingest failed:", err))
      .finally(() => inflight.delete(name));
  }
}

async function handleRequestFile(name: string): Promise<void> {
  const dir = channelCommandInboxDir();
  const reqPath = join(dir, name);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(reqPath, "utf8"));
  } catch {
    return; // corrupt file — leave in place for inspection
  }
  const req = sanitizeRequest(raw);
  if (!req) return;

  let result: ChannelCommandResult;
  try {
    const entry = getChannelThread(req.sessionId);
    if (!entry || typeof entry.handleCommand !== "function") {
      // Thread is not (currently) owned by a chat channel — e.g. a desktop
      // session asking for channel operations, or the app restarted mid-chat.
      result = { ok: false, error: "not_channel_session" };
    } else {
      result = await entry.handleCommand(req.action, req.target ?? null);
    }
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Response first, then delete the request. A crash in between can only make
  // a list/switch re-run once on next ingest — both are idempotent enough.
  const respPath = join(dir, name.replace(/\.json$/, ".resp.json"));
  try {
    writeFileSync(respPath, JSON.stringify(result));
  } catch (err) {
    console.error("[channel-cmd] response write failed:", err);
    return; // keep the request so a later ingest can retry
  }
  try {
    unlinkSync(reqPath);
  } catch {
    /* already gone — fine */
  }
}

function sanitizeRequest(raw: unknown): ChannelCommandRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.sessionId !== "string" || !o.sessionId) return null;
  if (o.action !== "list" && o.action !== "switch" && o.action !== "new") return null;
  const target = typeof o.target === "string" ? o.target.slice(0, 200) : null;
  return { sessionId: o.sessionId.slice(0, 100), action: o.action, target };
}

/** Watch + poll wiring (mirrors the todo inbox in ipc.ts). Call once at startup. */
export function startChannelCommandInboxWatcher(): void {
  const dir = ensureChannelCommandInbox();
  try {
    watch(dir, () => ingestChannelCommands());
  } catch {
    /* the poll below still covers it */
  }
  const poll = setInterval(() => {
    try {
      ingestChannelCommands();
    } catch {
      /* ignore transient fs errors */
    }
  }, 2000);
  poll.unref?.();
}
