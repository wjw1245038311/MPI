/** Pure helpers for interpreting tool-call arguments in the transcript view. */

export interface EditPair {
  old: string;
  next: string;
}

const OLD_NAMES = ["oldText", "old_text", "old", "before", "original"];
const NEW_NAMES = ["newText", "new_text", "new", "after", "replacement"];

/** Normalize a transcript value to display text (line endings, JSON-string and
 * transport-level escape decoding). */
export function normalizeTranscriptText(value: unknown): string {
  if (value == null) return "";
  let text = typeof value === "string" ? value : String(value);
  text = text.replace(/\r\n?/g, "\n");

  const trimmed = text.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") text = parsed.replace(/\r\n?/g, "\n");
    } catch {
      /* Keep the original text when it is not a complete JSON string. */
    }
  }

  // A partial toolcall or older transcript may still contain transport-level
  // escape sequences. Decode them only when there are no real line breaks, so
  // source code containing a literal "\\n" remains intact.
  if (!text.includes("\n") && /\\(?:r\\n|n|r|t|\")/.test(text)) {
    text = text
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"');
  }
  return text;
}

function pick(rec: Record<string, unknown> | null, names: string[]): unknown {
  if (!rec) return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(rec, name)) return rec[name];
  }
  return undefined;
}

/**
 * Extract before/after pairs from edit-tool arguments. pi's edit tool passes an
 * `edits` array of `{oldText,newText}` objects (one entry per replacement);
 * other agents may use flat top-level old/new fields — both shapes are handled.
 */
export function extractEditPairs(args: Record<string, unknown> | null): EditPair[] {
  const pairs: EditPair[] = [];
  if (!args) return pairs;

  const rawEdits = args.edits ?? args.edit;
  if (Array.isArray(rawEdits)) {
    for (const item of rawEdits) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      const old = normalizeTranscriptText(pick(rec, OLD_NAMES));
      const next = normalizeTranscriptText(pick(rec, NEW_NAMES));
      if (old || next) pairs.push({ old, next });
    }
  }

  if (!pairs.length) {
    const old = normalizeTranscriptText(pick(args, OLD_NAMES));
    const next = normalizeTranscriptText(pick(args, NEW_NAMES));
    if (old || next) pairs.push({ old, next });
  }

  return pairs;
}
