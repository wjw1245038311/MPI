import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { getSessionsDir } from "./session-store";

export interface RepairResult {
  ok: boolean;
  /** Number of entries changed or removed. */
  changed: number;
  details: string[];
  error?: string;
}

/**
 * Repairs the two known "permanently bricked" session conditions that pi cannot
 * recover from on its own (upstream #8720, #8667). Once one of these lands in a
 * session file, EVERY subsequent turn fails with the same provider 400 until the
 * file is edited.
 *
 * A. toolResult entries whose output is empty or whitespace-only — OpenAI-compatible
 *    providers reject them ("content string cannot be empty or only whitespace").
 *    Replaced with a "(no output)" placeholder, the same fallback pi uses for truly
 *    empty results.
 *
 * B. stale compaction entries sitting between an assistant toolCall and its
 *    toolResult — when a later compaction's kept range includes them they render as
 *    a user message mid-pair, orphaning the real result ("unexpected tool_use_id").
 *    Such entries are removed (their content is already folded into the latest
 *    summary) and their children re-linked to the grandparent. The LATEST compaction
 *    is never touched: pi renders it at the context head even when mid-pair.
 *
 * The file is rewritten only if something changed; a timestamped backup is kept in
 * <sessions>/mpi-repair-backups/ first.
 */
export function repairSessionFile(filePath: string): RepairResult {
  const fail = (error: string): RepairResult => ({ ok: false, changed: 0, details: [], error });

  // Safety: only touch files inside pi's sessions directory.
  const root = getSessionsDir();
  const resolved = resolve(filePath);
  if (!resolved.startsWith(root + sep)) return fail("not a session file under the sessions directory");

  let raw: string;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch (e: any) {
    return fail(`cannot read session file: ${e?.message || e}`);
  }

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return fail("session file is empty");

  const entries: any[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Never modify a file we cannot fully parse.
      return fail("session file contains unparseable lines; refusing to modify");
    }
  }

  const byId = new Map<string, any>();
  for (const e of entries) if (typeof e?.id === "string") byId.set(e.id, e);

  let changed = 0;
  const details: string[] = [];

  // --- Fix A: empty / whitespace-only tool results --------------------------
  for (const e of entries) {
    const m = e?.type === "message" ? e.message : null;
    if (!m || m.role !== "toolResult") continue;
    const texts = Array.isArray(m.content)
      ? m.content.filter((c: any) => c?.type === "text").map((c: any) => String(c.text ?? ""))
      : [];
    if (texts.length > 0 && texts.join("").trim().length > 0) continue; // has real content
    m.content = [{ type: "text", text: "(no output)" }];
    changed++;
    details.push(`toolResult ${e.id} (${m.toolName || "?"}): empty/whitespace-only output → "(no output)"`);
  }

  // --- Fix B: stale compaction entries mid tool-call pair --------------------
  const compactions = entries.filter((e) => e?.type === "compaction");
  if (compactions.length > 1) {
    const latestId = compactions.reduce((a, b) =>
      String(a.timestamp || "") >= String(b.timestamp || "") ? a : b,
    ).id;

    for (const c of compactions) {
      if (c.id === latestId) continue; // rendered at context head by pi — safe even mid-pair
      const parent = byId.get(c.parentId);
      const parentIsToolCallAssistant =
        parent?.type === "message" &&
        parent.message?.role === "assistant" &&
        (parent.message.content || []).some((b: any) => b?.type === "toolCall");
      if (!parentIsToolCallAssistant) continue; // not mid-pair — leave untouched
      const hasChildResult = entries.some(
        (e) => e.parentId === c.id && e.type === "message" && e.message?.role === "toolResult",
      );
      if (!hasChildResult) continue;

      // A later compaction whose kept range starts at this entry would lose its
      // anchor — leave it and report instead of risking a worse break.
      const referenced = compactions.some((l) => l.id !== c.id && l.firstKeptEntryId === c.id);
      if (referenced) {
        details.push(`compaction ${c.id} is mid-pair but referenced as firstKeptEntryId — needs manual fix`);
        continue;
      }

      const kids = entries.filter((e) => e.parentId === c.id);
      for (const k of kids) k.parentId = c.parentId ?? null;
      changed += 1 + kids.length;
      details.push(`compaction ${c.id} removed (stale, mid tool-call pair); re-linked ${kids.length} child(ren)`);
      // Mark for removal after the loop so kid lookups above stay valid.
      (c as any).__mpiDelete = true;
    }
  }

  if (changed === 0) return { ok: true, changed: 0, details };

  // Backup, then atomic rewrite (tmp + rename). Trailing newline is guaranteed —
  // a missing one corrupts the next appended entry (upstream #8345).
  const backupDir = join(root, "mpi-repair-backups");
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(resolved, join(backupDir, `${basename(resolved)}.${stamp}.bak`));

  const out = entries.filter((e) => !e.__mpiDelete).map((e) => JSON.stringify(e)).join("\n") + "\n";
  const tmp = resolved + ".mpi-repair.tmp";
  writeFileSync(tmp, out, "utf8");
  renameSync(tmp, resolved);

  return { ok: true, changed, details };
}
