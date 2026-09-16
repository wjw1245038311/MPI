import type { ProjectSummary } from "./types";

/** One row of the "@" mention menu's 对话 (sessions) group. */
export interface MentionSessionItem {
  kind: "session";
  title: string;
  projectName: string;
  /** Absolute path to the session .jsonl — inserted verbatim so the agent can read it with its file tools. */
  file: string;
  updatedAt: number;
}

/**
 * Flatten + filter recent sessions for the "@" mention menu (对话 group).
 * Pure function (no React) so it is unit-testable. Matches the query against
 * both the session title and the project name, case-insensitively; an empty
 * query returns the most recent sessions overall. The current conversation is
 * excluded — referencing yourself inserts a useless path.
 */
export function sessionMentionItems(
  projects: ProjectSummary[],
  query: string,
  excludeFile?: string | null,
  limit = 10,
): MentionSessionItem[] {
  const q = (query || "").trim().toLowerCase();
  const items: MentionSessionItem[] = [];
  for (const p of projects || []) {
    for (const t of p.threads || []) {
      if (!t?.file) continue;
      if (excludeFile && t.file === excludeFile) continue;
      if (q && !t.title.toLowerCase().includes(q) && !(p.name || "").toLowerCase().includes(q)) continue;
      items.push({
        kind: "session",
        title: t.title || "(untitled)",
        projectName: p.name,
        file: t.file,
        updatedAt: t.updatedAt || 0,
      });
    }
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items.slice(0, limit);
}
