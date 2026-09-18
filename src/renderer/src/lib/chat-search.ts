import type { ViewMessage } from "./types";
import { choiceFenceToVisibleText } from "./choice-block";
import { parseHtmlReferenceText } from "./html-reference";
import { parseSkillBlock } from "./skill-block";

/** One case-insensitive occurrence of the query inside one rendered text unit. */
export interface ChatSearchOccurrence {
  /** Stable key of the matched message (ViewMessage.key) — scroll/flash/dim anchor. */
  messageKey: string;
  /** Key of the rendered text unit containing this occurrence (see messageSearchUnits). */
  unitKey: string;
}

/**
 * Rendered prose units of a single message, in display order. This mirrors
 * EXACTLY what MessageGroup renders, so every counted occurrence is visible:
 * - assistant: one unit per text block (key `${message.key}:${blockIndex}`,
 *   matching the .msg-item key in renderAssistantBlocks); thinking and
 *   tool-call payloads are excluded — collapsed/hidden by default and full of
 *   JSON noise.
 * - user/system/custom: the visible bubble text only — HTML reference blocks
 *   are rendered as cards (not prose) and /skill:name messages show just the
 *   trailing user message, so both are stripped here too.
 */
export function messageSearchUnits(message: ViewMessage): { key: string; text: string }[] {
  if (message.role === "assistant") {
    const units: { key: string; text: string }[] = [];
    (message.blocks || []).forEach((block, index) => {
      // A valid ```choices fence renders as an interactive panel — count only
      // its visible equivalent (titles + labels), not the JSON body. Invalid
      // fences render as code blocks and stay in the corpus untouched.
      if (block.type === "text" && block.text)
        units.push({ key: `${message.key}:${index}`, text: choiceFenceToVisibleText(block.text) });
    });
    return units;
  }
  const parsedHtml = message.text ? parseHtmlReferenceText(message.text) : { text: "", references: [] };
  const skillBlock = parsedHtml.text ? parseSkillBlock(parsedHtml.text) : null;
  const text = skillBlock ? (skillBlock.userMessage || "") : parsedHtml.text;
  return text ? [{ key: message.key, text }] : [];
}

/**
 * All occurrences of `query` across the transcript, in display order.
 * Case-insensitive substring matching; each occurrence inside a unit is a
 * separate entry so navigation can step through them one by one (browser
 * find-in-page semantics). Empty/whitespace-only queries yield no matches.
 */
export function findMessageOccurrences(messages: ViewMessage[], rawQuery: string): ChatSearchOccurrence[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];
  const out: ChatSearchOccurrence[] = [];
  for (const message of messages) {
    for (const unit of messageSearchUnits(message)) {
      const lower = unit.text.toLowerCase();
      let idx = lower.indexOf(query);
      while (idx !== -1) {
        out.push({ messageKey: message.key, unitKey: unit.key });
        idx = lower.indexOf(query, idx + query.length);
      }
    }
  }
  return out;
}
