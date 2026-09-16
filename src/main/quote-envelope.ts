import type { QuoteMeta } from "../renderer/src/lib/types";

/**
 * Conversation-quote envelope (right-click → 引用到输入框).
 *
 * A quote is inlined into the prompt as a <quote> block that carries BOTH the
 * selected text and its location inside this conversation: the stable session
 * entry id plus the .jsonl transcript path. That lets the model point back at
 * where the passage was said (and recover surrounding context with file tools
 * after compaction) instead of seeing an anonymous paste.
 *
 * The renderer's parseUserMessage() strips these blocks out of user bubbles —
 * keep the two sides in sync (scripts/test-quote.mjs round-trips both).
 */

/** Quotes longer than this are truncated; the transcript still holds the rest. */
export const QUOTE_MAX_CHARS = 4000;

const attr = (s: string) => s.replace(/"/g, "&quot;");

/** Build the <quote>…</quote> block for one quote attachment. */
export function buildQuoteEnvelope(q: QuoteMeta): string {
  const body = String(q?.text || "").slice(0, QUOTE_MAX_CHARS);
  let attrs = "";
  if (q.entryId) attrs += ` message="${attr(q.entryId)}"`;
  if (q.role === "user" || q.role === "assistant") attrs += ` role="${q.role}"`;
  if (q.sessionFile) attrs += ` transcript="${attr(q.sessionFile)}"`;
  const note = q.sessionFile
    ? "quoted from this conversation; use file tools on the transcript to read surrounding context"
    : "quoted from this conversation";
  return `<quote${attrs} note="${note}">\n${body}\n</quote>`;
}
