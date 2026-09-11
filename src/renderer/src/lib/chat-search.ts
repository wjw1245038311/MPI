import type { ViewMessage } from "./types";

/** One case-insensitive occurrence of the query inside one message. */
export interface ChatSearchOccurrence {
  /** Stable key of the matched message (ViewMessage.key). */
  messageKey: string;
}

/**
 * Visible prose of a single message, used as the in-conversation search
 * corpus: user/system/custom plain text, assistant text blocks. Thinking and
 * tool-call payloads are intentionally excluded — they are collapsed/hidden
 * by default and full of JSON noise.
 */
export function messageSearchText(message: ViewMessage): string {
  if (message.role === "assistant") {
    return (message.blocks || [])
      .filter((block) => block.type === "text")
      .map((block) => (block as { type: "text"; text: string }).text)
      .join("\n");
  }
  return message.text || "";
}

/**
 * All occurrences of `query` across the transcript, in display order.
 * Case-insensitive substring matching; each occurrence inside a message is a
 * separate entry so navigation can step through them one by one (browser
 * find-in-page semantics). Empty/whitespace-only queries yield no matches.
 */
export function findMessageOccurrences(messages: ViewMessage[], rawQuery: string): ChatSearchOccurrence[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];
  const out: ChatSearchOccurrence[] = [];
  for (const message of messages) {
    const text = messageSearchText(message);
    if (!text) continue;
    const lower = text.toLowerCase();
    let idx = lower.indexOf(query);
    while (idx !== -1) {
      out.push({ messageKey: message.key });
      idx = lower.indexOf(query, idx + query.length);
    }
  }
  return out;
}
