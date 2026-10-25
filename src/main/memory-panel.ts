/**
 * 记忆池面板的数据层（P4）
 *
 * 为什么单独一层：面板要的东西（条目视图 / 提案 / 状态 / 过滤）与"写者"是两件事，
 * 放这里就能**不带 electron 单测**（ipc.ts 那层只做转发）。
 * 所有写操作都复用已验证的执行器（memory-promote / memory-ops），不另写一套。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { knowledgeLessonsDir } from "./knowledge-dir";
import {
  deleteProjectRule,
  digestProjectRules,
  groupRulesForPanel,
  isLessonEntry,
  listProjectRules,
  writeProjectRule,
  PROJECT_MEMORY_DIR,
  type DigestStats,
  type ProjectGroupView,
  type ProjectRule,
  type RuleStatus,
} from "./zhiya/project-memory";
import { listEntries, type PoolEntry } from "./zhiya/pool";
import { listProposals, pendingProposals, type ProposalList } from "./zhiya/proposals";
import type { Proposal } from "./zhiya/triage";
import { applyProposal } from "./memory-promote";
import { setProposalStatus } from "./zhiya/proposals";
import { consolidationDue } from "./zhiya/consolidation";
import { CONSOLIDATION_THRESHOLD } from "./zhiya/triage";

/** 面板里一条记忆的展示视图（正文截断，全文按需再取）。 */
export interface PoolEntryView {
  id: string;
  createdAt: string;
  type: PoolEntry["type"];
  temporal: PoolEntry["temporal"];
  importance: number;
  recurrence: number;
  project: string;
  projectRoot: string | null;
  status: PoolEntry["status"];
  promotedTo: string | null;
  tags: string[];
  /** 正文摘要（用于列表，避免一次传几万字） */
  summary: string;
  /** 正文长度，列表里可提示"全文更长" */
  length: number;
  /** 有证据/复现记录时提示可展开 */
  evidenceCount: number;
  recurrenceCount: number;
  warnings: string[];
  path: string | null;
}

export interface MemoryStats {
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  projects: { name: string; count: number }[];
  pendingProposals: number;
  /** 巩固累加器：还剩多少分到阈值、是否已到点 */
  consolidation: { remaining: number; threshold: number; due: boolean; writes: number; lastRunAt: string | null };
  archiveDir: string | null;
  poolDir: string;
}

export interface MemorySnapshot {
  entries: PoolEntryView[];
  proposals: Proposal[];
  broken: ProposalList["broken"];
  stats: MemoryStats;
  /** 实际返回的条目数 / 命中过滤前的总数 */
  shown: number;
  matched: number;
}

export interface SnapshotQuery {
  /** 关键词（正文/项目/标签，字面包含，大小写不敏感） */
  q?: string;
  status?: PoolEntry["status"] | "all";
  type?: PoolEntry["type"] | "all";
  project?: string;
  /** 排序：时间倒序（默认）/ 重要性 / 复现次数 */
  sort?: "recent" | "importance" | "recurrence";
  /** 时间范围（按写入日期）：全部 / 今天 / 近 7 天 / 近 30 天 */
  range?: "all" | "today" | "7d" | "30d";
  /**
   * 自定义时间区间（优先级高于 range）：`YYYY-MM-DD` 或 `YYYY-MM-DDTHH:mm`。
   * 只给日期时，起止都按**本地日历**算（起点当天零点、终点当天 23:59:59.999）；
   * 带时分时按精确时刻。任一端非法就忽略那一端。
   */
  from?: string;
  to?: string;
  limit?: number;
}

export function toView(e: PoolEntry, summaryChars = 160): PoolEntryView {
  const text = (e.text ?? "").replace(/\s+/g, " ").trim();
  return {
    id: e.id,
    createdAt: e.createdAt,
    type: e.type,
    temporal: e.temporal,
    importance: e.importance,
    recurrence: e.recurrence,
    project: e.project,
    projectRoot: e.projectRoot,
    status: e.status,
    promotedTo: e.promotedTo,
    tags: e.tags ?? [],
    summary: text.slice(0, summaryChars),
    length: text.length,
    // 防御：字段缺失不能把整个面板带崩（老条目/手改文件都可能缺）
    evidenceCount: (e.evidence ?? []).length,
    recurrenceCount: (e.recurrences ?? []).length,
    warnings: e.warnings ?? [],
    path: e.path,
  };
}

/** 本地日期键（YYYY-MM-DD）——按"写作那天的本地日历"分组，而不是 UTC 日界。 */
export function dayKey(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "未知日期";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 范围起点（本地零点算）。today = 今天零点；7d/30d = 今天零点往前推。 */
export function rangeStart(range: "all" | "today" | "7d" | "30d", now = Date.now()): number {
  if (range === "all") return 0;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const midnight = d.getTime();
  if (range === "today") return midnight;
  if (range === "7d") return midnight - 6 * 24 * 3600 * 1000; // 含今天共 7 天
  return midnight - 29 * 24 * 3600 * 1000; // 含今天共 30 天
}

/**
 * 解析时间边界。
 * `edge="start"` → 只给日期时取本地零点；`edge="end"` → 取当天最后一毫秒。
 * 为什么要区分：用户填「到 2026-09-20」的直觉是"包含 20 号这一天"，
 * 如果按零点算就会把 20 号的条目全滤掉（差一天，最容易踩的坑）。
 */
export function parseBound(value: string | undefined, edge: "start" | "end"): number | null {
  const v = (value || "").trim();
  if (!v) return null;
  // 带时分：按精确时刻
  const withTime = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(v);
  if (withTime) {
    const [, y, mo, d, h, mi] = withTime.map(Number) as unknown as number[];
    const t = new Date(y, mo - 1, d, h, mi, edge === "end" ? 59 : 0, edge === "end" ? 999 : 0).getTime();
    return Number.isFinite(t) ? t : null;
  }
  // 只有日期：本地日历
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly.map(Number) as unknown as number[];
    const t =
      edge === "start"
        ? new Date(y, mo - 1, d, 0, 0, 0, 0).getTime()
        : new Date(y, mo - 1, d, 23, 59, 59, 999).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null; // 认不出来就当没填，而不是把面板滤空
}

/** 过滤 + 排序（纯函数，面板与 CLI 共用；也方便单测）。 */
export function filterEntries(entries: PoolEntry[], q: SnapshotQuery = {}): PoolEntryView[] {
  const needle = (q.q || "").trim().toLowerCase();
  const status = q.status && q.status !== "all" ? q.status : null;
  const type = q.type && q.type !== "all" ? q.type : null;
  const project = q.project && q.project !== "all" ? q.project : null;
  // 自定义区间优先于预设范围（面板上两者可以同时存在，以具体日期为准）
  const fromTs = parseBound(q.from, "start");
  const toTs = parseBound(q.to, "end");
  const custom = fromTs !== null || toTs !== null;
  const since = custom ? 0 : q.range && q.range !== "all" ? rangeStart(q.range) : 0;

  let out = entries.filter((e) => {
    if (status && e.status !== status) return false;
    if (type && e.type !== type) return false;
    if (project && e.project !== project) return false;
    const t = Date.parse(e.createdAt);
    if (custom) {
      if (!Number.isFinite(t)) return false; // 时间戳坏掉的条目在自定义区间里排除（不然会莫名其妙混进来）
      if (fromTs !== null && t < fromTs) return false;
      if (toTs !== null && t > toTs) return false;
    } else if (since) {
      if (!Number.isFinite(t) || t < since) return false;
    }
    if (!needle) return true;
    return (
      (e.text ?? "").toLowerCase().includes(needle) ||
      (e.project ?? "").toLowerCase().includes(needle) ||
      (e.tags ?? []).some((t) => t.toLowerCase().includes(needle)) ||
      (e.id ?? "").toLowerCase().startsWith(needle)
    );
  });

  const sort = q.sort || "recent";
  out = out.sort((a, b) => {
    if (sort === "importance") return b.importance - a.importance || (a.createdAt < b.createdAt ? 1 : -1);
    if (sort === "recurrence") return b.recurrence - a.recurrence || (a.createdAt < b.createdAt ? 1 : -1);
    return a.createdAt < b.createdAt ? 1 : -1;
  });
  return out.map((e) => toView(e));
}

export interface SnapshotDeps {
  poolDir: string;
  archiveDir?: string | null;
  /** 条目上限（默认 200：面板一次别塞太多） */
  limit?: number;
  query?: SnapshotQuery;
}

/**
 * 面板一次性要的全部数据（条目 + 提案 + 统计）。
 * 故意一次给全：面板打开后大多数交互都是本地过滤，不该每次都往返主进程。
 */
export function buildSnapshot(deps: SnapshotDeps): MemorySnapshot {
  const { entries, broken: entryBroken } = listEntries(deps.poolDir);
  const { proposals, broken } = listProposals(deps.poolDir);
  const filtered = filterEntries(entries, deps.query);
  const limit = deps.limit ?? 200;
  const views = filtered.slice(0, limit);
  const matched = filtered.length;

  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const projectCount = new Map<string, number>();
  for (const e of entries) {
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    projectCount.set(e.project, (projectCount.get(e.project) ?? 0) + 1);
  }

  const consolidated = readConsolidationSafe(deps.poolDir);
  return {
    entries: views,
    proposals: proposals.filter((p) => p.status === "pending" || p.status === "failed" || isRecent(p)),
    broken: [...broken, ...entryBroken.map((b) => ({ path: b.path, reason: b.reason }))],
    stats: {
      total: entries.length,
      byStatus,
      byType,
      projects: [...projectCount.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      pendingProposals: pendingProposals(deps.poolDir).length,
      consolidation: {
        remaining: consolidated.remaining,
        threshold: CONSOLIDATION_THRESHOLD,
        due: consolidationDue(deps.poolDir),
        writes: consolidated.writes,
        lastRunAt: consolidated.lastRunAt,
      },
      archiveDir: deps.archiveDir ?? null,
      poolDir: deps.poolDir,
    },
    shown: views.length,
    matched,
  };
}

/** 已落地/已拒绝的提案只保留最近一段时间的（面板里作为历史，不必全量）。 */
function isRecent(p: Proposal, days = 14): boolean {
  const t = Date.parse(p.decidedAt ?? p.createdAt);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < days * 24 * 3600 * 1000;
}

/** 读巩固累加器（读失败当满额，与 consolidation.loadConsolidation 的约定一致）。 */
function readConsolidationSafe(poolDir: string) {
  try {
    const raw = JSON.parse(readFileSync(`${poolDir}/.consolidation.json`, "utf8")) as {
      remaining?: number;
      writes?: number;
      lastRunAt?: string | null;
    };
    return {
      remaining: typeof raw.remaining === "number" ? raw.remaining : CONSOLIDATION_THRESHOLD,
      writes: typeof raw.writes === "number" ? raw.writes : 0,
      lastRunAt: typeof raw.lastRunAt === "string" ? raw.lastRunAt : null,
    };
  } catch {
    return { remaining: CONSOLIDATION_THRESHOLD, writes: 0, lastRunAt: null };
  }
}

/**
 * 解析一个 kb 提案该往哪个 lessons 目录落。
 * 兜底链（按可靠性从高到低）：
 *   ① 提案自带 target（dream 解析出来的确切路径）
 *   ② 提案依据条目的 projectRoot
 *   ③ **同项目其它条目**的 projectRoot（老条目没有 root 字段时的现实解）
 *   ④ 拿不到 → null，让调用方给出可操作的提示（而不是写到一个瞎猜的目录里）
 */
export function resolveLessonsDirFor(poolDir: string, p: Proposal): string | null {
  const { entries } = listEntries(poolDir);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const picked = p.entries.map((id) => byId.get(id)).filter((e): e is PoolEntry => !!e);
  const own = picked.find((e) => e.projectRoot)?.projectRoot;
  if (own) return joinForLessons(own);
  // 同项目其它条目兜底：老条目没 root，但同项目的较新条目有
  for (const e of picked) {
    const sibling = entries.find((x) => x.project === e.project && x.projectRoot);
    if (sibling?.projectRoot) return joinForLessons(sibling.projectRoot);
  }
  const anyWithRoot = entries.find((e) => e.projectRoot);
  return anyWithRoot?.projectRoot ? joinForLessons(anyWithRoot.projectRoot) : null;
}

/** 知识库 lessons 目录：优先显式配置的 knowledgeDir，否则 <项目根>/.alexandria/knowledge/lessons。 */
function joinForLessons(root: string): string | null {
  return knowledgeLessonsDir(root);
}

export interface ActionResult {
  ok: boolean;
  detail: string;
  files?: string[];
}

/** 从面板归档一条（归档≠删除，走与 /memory-forget 相同的执行路径）。 */
export async function archiveEntryFromPanel(
  poolDir: string,
  id: string,
  deps: { archiveDir?: string; index?: { upsert(es: PoolEntry[]): Promise<void>; remove(ids: string[]): Promise<void> } },
): Promise<ActionResult> {
  const entry = listEntries(poolDir).entries.find((e) => e.id === id || e.id.endsWith(id));
  if (!entry) return { ok: false, detail: `找不到条目：${id}` };
  if (!entry.path || !existsSync(entry.path)) return { ok: false, detail: "条目文件不存在（可能已被归档）" };
  // 复用提案执行器：构造一个"只归档这一条"的临时提案语义 → 保持行为一致（moveFileSafe + 索引移除）
  const tmp: Proposal = {
    id: entry.id,
    createdAt: new Date().toISOString(),
    kind: "archive",
    status: "approved",
    outlet: "archive",
    entries: [entry.id],
    reason: "面板直接归档",
    title: entry.text.slice(0, 30),
    body: "",
    target: null,
    decidedAt: new Date().toISOString(),
    result: null,
  };
  const r = await applyProposal(tmp, {
    poolDir,
    archiveDir: deps.archiveDir,
    index: deps.index as never,
  });
  return { ok: r.ok, detail: r.detail, files: r.files };
}

/** 批量操作的结果（逐条回报：哪些成功、哪些为什么失败）。 */
export interface BatchResult {
  ok: number;
  failed: { id: string; reason: string }[];
}

/**
 * 批量归档。
 * 逐条独立处理：**一条失败不影响其它条**（面板上批量操作最怕"全有或全无"，
 * 一条坏数据把所有选择都卡住）。
 */
export async function archiveManyFromPanel(
  poolDir: string,
  ids: string[],
  deps: { archiveDir?: string; index?: { upsert(es: PoolEntry[]): Promise<void>; remove(ids: string[]): Promise<void> } },
): Promise<BatchResult> {
  const failed: { id: string; reason: string }[] = [];
  let ok = 0;
  for (const id of ids) {
    const r = await archiveEntryFromPanel(poolDir, id, deps);
    if (r.ok) ok++;
    else failed.push({ id, reason: r.detail });
  }
  return { ok, failed };
}

/** 批量批准/拒绝（同样逐条独立）。 */
export async function decideManyFromPanel(
  poolDir: string,
  ids: string[],
  decision: "approve" | "reject",
  deps: {
    archiveDir?: string;
    kbLessonsDir?: string | null;
    index?: { upsert(es: PoolEntry[]): Promise<void>; remove(ids: string[]): Promise<void> };
  } = {},
): Promise<BatchResult> {
  const failed: { id: string; reason: string }[] = [];
  let ok = 0;
  for (const id of ids) {
    const r = await decideProposalFromPanel(poolDir, id, decision, deps as never);
    if (r.ok) ok++;
    else failed.push({ id, reason: r.detail });
  }
  return { ok, failed };
}

/** 批准/拒绝提案（面板按钮；与命令行走同一条执行路径）。 */
export async function decideProposalFromPanel(
  poolDir: string,
  id: string,
  decision: "approve" | "reject",
  deps: { archiveDir?: string; kbLessonsDir?: string | null; index?: never } = {},
): Promise<ActionResult> {
  const p = listProposals(poolDir).proposals.find((x) => x.id === id || x.id.endsWith(id));
  if (!p) return { ok: false, detail: `找不到提案：${id}` };
  if (decision === "reject") {
    const done = setProposalStatus(poolDir, p.id, "rejected");
    return done ? { ok: true, detail: `已拒绝：${p.title}` } : { ok: false, detail: `状态是 ${p.status}，不能拒绝` };
  }
  if (p.status !== "pending" && p.status !== "failed") {
    return { ok: false, detail: `状态是 ${p.status}，不能批准` };
  }
  const approved = setProposalStatus(poolDir, p.id, "approved");
  if (!approved) return { ok: false, detail: `状态流转被拒绝：${p.status} → approved` };
  // kb 提案：提案没带 target（老条目没有 projectRoot）时**兜底解析**
  const kbLessonsDir =
    deps.kbLessonsDir ?? (p.kind === "promote-kb" && !p.target ? resolveLessonsDirFor(poolDir, p) : null);
  const r = await applyProposal(approved, {
    poolDir,
    archiveDir: deps.archiveDir,
    kbLessonsDir,
    index: deps.index,
  });
  return { ok: r.ok, detail: r.detail, files: r.files };
}

// ---------------------------------------------------------------------------
// 项目记忆（L2）— 面板数据层
// ---------------------------------------------------------------------------

export interface ProjectMemoryStats {
  /** 规则总数 / 待审 / 已批准 / 已停用。 */
  total: number;
  draft: number;
  approved: number;
  muted: number;
  /** 项目分组数。 */
  groups: number;
  /** 池子里可当原料的教训候选条数（提示「还有多少没挖」）。 */
  candidates: number;
  /** 最近的挖簇结果（读 .digest.json；没跑过为 null）。 */
  lastDigest: { at: string; rules: number; clusters: number; dropped: number; embedError?: string } | null;
}

export interface ProjectMemorySnapshot {
  groups: ProjectGroupView[];
  stats: ProjectMemoryStats;
  broken: { path: string; reason: string }[];
  poolDir: string;
}

/**
 * 项目记忆快照：按项目聚合规则 + 统计。
 * 不触发挖簇（挖簇要 embedding，12~20s，必须由面板显式点按钮触发）。
 */
export function buildProjectSnapshot(deps: { poolDir: string; limitGroups?: number }): ProjectMemorySnapshot {
  const { entries } = listEntries(deps.poolDir);
  const { rules, broken } = listProjectRules(deps.poolDir);
  const groups = groupRulesForPanel(rules, entries).map((g) => ({
    ...g,
    // 落点文件此刻存在与否：面板要提示「将新建文件」还是「追加到已有文件」
    targetExists: !!g.root && existsSync(join(g.root, g.targetRel)),
  }));
  const limited = deps.limitGroups ? groups.slice(0, deps.limitGroups) : groups;
  const stat = (s: string) => rules.filter((r) => r.status === s).length;
  return {
    groups: limited,
    stats: {
      total: rules.length,
      draft: stat("draft"),
      approved: stat("approved"),
      muted: stat("muted"),
      groups: groups.length,
      candidates: entries.filter((e) => e.status === "inbox" && isLessonEntry(e)).length,
      lastDigest: readDigestMeta(deps.poolDir),
    },
    broken,
    poolDir: deps.poolDir,
  };
}

/** 挖簇元信息（`.digest.json`）：记录上次跑的时间与统计，面板用来显示「上次挖簇」。 */
export interface DigestMeta {
  at: string;
  rules: number;
  clusters: number;
  dropped: number;
  candidates: number;
  embedError?: string;
}

export function digestMetaPath(poolDir: string): string {
  return join(poolDir, PROJECT_MEMORY_DIR, ".digest.json");
}

export function writeDigestMeta(poolDir: string, meta: DigestMeta): void {
  const p = digestMetaPath(poolDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(meta, null, 2), "utf8");
}

export function readDigestMeta(poolDir: string): DigestMeta | null {
  try {
    const raw = JSON.parse(readFileSync(digestMetaPath(poolDir), "utf8")) as DigestMeta;
    return raw && typeof raw.at === "string" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 挖簇并落盘（面板「挖簇」按钮）。
 *
 * 三步都在这里：读 L1 → digestProjectRules → 只写有变化的文件。
 * 已批准 / 人工编辑过的正文不会被覆盖（由 digestProjectRules 保证）。
 */
export async function runProjectDigest(
  poolDir: string,
  deps: {
    embed?: (texts: string[]) => Promise<number[][]>;
    now?: () => string;
    persist?: boolean;
    /** 透传给 digestProjectRules（面板用默认值；测试用小门槛）。 */
    minEvidence?: number;
    minCosine?: number;
  } = {},
): Promise<{ ok: boolean; detail: string; stats?: DigestStats; rules?: number }> {
  const { entries } = listEntries(poolDir);
  const { rules: existing } = listProjectRules(poolDir);
  const { rules, stats } = await digestProjectRules(
    { entries, existing, minEvidence: deps.minEvidence, minCosine: deps.minCosine },
    { embed: deps.embed, now: deps.now },
  );
  if (deps.persist !== false) {
    for (const r of rules) {
      const p = writeProjectRule(poolDir, r);
      r.path = p;
    }
    writeDigestMeta(poolDir, {
      at: deps.now?.() ?? new Date().toISOString(),
      rules: rules.length,
      clusters: stats.clusters,
      dropped: stats.droppedSmall,
      candidates: stats.candidates,
      embedError: stats.embedError,
    });
  }
  return {
    ok: true,
    detail: `挖出 ${stats.clusters} 条（丢弃 ${stats.droppedSmall} 条证据不足），共 ${rules.length} 条规则`,
    stats,
    rules: rules.length,
  };
}

/** 改一条规则的正文/标题/状态（面板编辑与批准走这里）。 */
export function updateProjectRule(
  poolDir: string,
  id: string,
  patch: { title?: string; body?: string; status?: RuleStatus; targetRel?: string; edited?: boolean },
): { ok: boolean; detail: string; rule?: ProjectRule } {
  const { rules } = listProjectRules(poolDir);
  const r = rules.find((x) => x.id === id || x.id.endsWith(id));
  if (!r) return { ok: false, detail: `找不到规则：${id}` };
  if (patch.title !== undefined) r.title = patch.title.slice(0, 200);
  if (patch.body !== undefined) r.body = patch.body.slice(0, 4000);
  if (patch.targetRel !== undefined && patch.targetRel.trim()) r.targetRel = patch.targetRel.trim();
  if (patch.status !== undefined) r.status = patch.status;
  if (patch.edited !== undefined) r.edited = patch.edited;
  else if (patch.title !== undefined || patch.body !== undefined) r.edited = true;
  r.updatedAt = new Date().toISOString();
  const p = writeProjectRule(poolDir, r);
  return { ok: true, detail: `已保存：${r.title}`, rule: { ...r, path: p } };
}

/** 删一条规则（面板「丢弃」）。只允许删草稿与停用的。 */
export function deleteProjectRuleFromPanel(poolDir: string, id: string): { ok: boolean; detail: string } {
  const { rules } = listProjectRules(poolDir);
  const r = rules.find((x) => x.id === id || x.id.endsWith(id));
  if (!r) return { ok: false, detail: `找不到规则：${id}` };
  if (r.status === "approved") return { ok: false, detail: "已批准的规则不能直接删，先停用" };
  const done = deleteProjectRule(poolDir, r);
  return done ? { ok: true, detail: `已丢弃：${r.title}` } : { ok: false, detail: "文件已不存在" };
}
