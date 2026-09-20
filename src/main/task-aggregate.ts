/**
 * 「当前任务」聚合（P4）——把"现在时"的信息集中到一处
 *
 * 为什么需要：项目状态散在三个地方（待办面板、HANDOFF、changelog），
 * 每次开工都要分别翻。这里只做**读取与摘要**，不改任何文件。
 *
 * 三层来源与它们的分工：
 *   待办    —— 我说要做的事（有日期，到点激活）
 *   HANDOFF —— 上一个会话/设备交接时的完整状态（留给"人"读，这里只给锚点）
 *   changelog —— 已经做完的事（Unreleased + 最近版本标题）
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface HandoffRef {
  path: string;
  name: string;
  /** 文件最后修改时间（ISO） */
  mtime: string;
  /** 摘要：首个非空标题行 */
  title: string;
}

export interface ChangelogSummary {
  path: string;
  /** 是否还有 Unreleased 小节（没有说明当前改动都已发版） */
  hasUnreleased: boolean;
  /** 最近若干条的标题（去掉 markdown 标记） */
  recent: { version: string; items: string[] }[];
}

export interface TaskAggregate {
  handoffs: HandoffRef[];
  changelog: ChangelogSummary | null;
  /** 扫描过的目录（面板显示"从哪找的"，找不到时好排查） */
  searched: string[];
}

/** 按文件名找 HANDOFF：`HANDOFF-*.md` / `HANDOFF.md`（大小写不敏感）。 */
function isHandoff(name: string): boolean {
  return /^handoff.*\.md$/i.test(name);
}

/**
 * 列出一个目录直下的 HANDOFF 文件（按修改时间倒序）。
 * 只扫一层：HANDOFF 是"放在手边给人看"的文件，深层递归找反而容易把归档里的旧文件翻出来。
 */
export function listHandoffs(dir: string): HandoffRef[] {
  if (!existsSync(dir)) return [];
  const out: HandoffRef[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!isHandoff(name)) continue;
    const path = join(dir, name);
    let mtime = 0;
    let title = name;
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      mtime = st.mtimeMs;
      title = firstHeading(readFileSync(path, "utf8")) || name;
    } catch {
      continue; // 读不到就当没有，不炸面板
    }
    out.push({ path, name, mtime: new Date(mtime).toISOString(), title });
  }
  return out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

/** 取第一个非空行当标题（去掉 markdown 标记；frontmatter 跳过）。 */
function firstHeading(raw: string): string {
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  for (const line of body.split(/\r?\n/)) {
    const t = line.replace(/^#+\s*/, "").trim();
    if (t) return t.slice(0, 120);
  }
  return "";
}

/**
 * 解析 changelog：是否有 Unreleased、最近两个版本的条目标题。
 * 只做浅解析（标题 + 编号条目首句），不为渲染整篇 markdown 服务。
 */
export function readChangelog(path: string): ChangelogSummary | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const sections: { version: string; items: string[] }[] = [];
  let current: { version: string; items: string[] } | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const head = /^##\s+(.+)$/.exec(line);
    if (head) {
      current = { version: head[1].trim(), items: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const item = /^\d+\.\s+(.*)$/.exec(line.trim());
    if (item) {
      // 条目首句：截掉后续细节，标题行给面板用
      const first = item[1].split(/[。；;：:]/)[0].replace(/\*\*/g, "").trim();
      if (first) current.items.push(first.slice(0, 160));
    }
  }
  const hasUnreleased = sections.some((s) => /^unreleased$/i.test(s.version));
  return { path, hasUnreleased, recent: sections.slice(0, 2) };
}

export interface AggregateInput {
  /** HANDOFF 可能出现的目录（母版 zhiya 目录、当前项目根……） */
  handoffDirs: (string | null | undefined)[];
  /** changelog 路径（当前项目的 changelog.md） */
  changelogPath?: string | null;
}

/** 聚合三层来源（纯读，不改任何文件）。 */
export function aggregateTasks(input: AggregateInput): TaskAggregate {
  const searched: string[] = [];
  const handoffs: HandoffRef[] = [];
  const seen = new Set<string>();
  for (const dir of input.handoffDirs) {
    if (!dir) continue;
    searched.push(dir);
    for (const h of listHandoffs(dir)) {
      if (seen.has(h.path)) continue;
      seen.add(h.path);
      handoffs.push(h);
    }
  }
  handoffs.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  const changelog = input.changelogPath ? readChangelog(input.changelogPath) : null;
  if (input.changelogPath) searched.push(input.changelogPath);
  return { handoffs, changelog, searched };
}
