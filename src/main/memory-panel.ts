/**
 * 记忆池面板的数据层（P4）
 *
 * 为什么单独一层：面板要的东西（条目视图 / 提案 / 状态 / 过滤）与"写者"是两件事，
 * 放这里就能**不带 electron 单测**（ipc.ts 那层只做转发）。
 * 所有写操作都复用已验证的执行器（memory-promote / memory-ops），不另写一套。
 */
import { existsSync, readFileSync } from "node:fs";
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
  limit?: number;
}

export function toView(e: PoolEntry, summaryChars = 160): PoolEntryView {
  const text = e.text.replace(/\s+/g, " ").trim();
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
    tags: e.tags,
    summary: text.slice(0, summaryChars),
    length: text.length,
    evidenceCount: e.evidence.length,
    recurrenceCount: e.recurrences.length,
    warnings: e.warnings,
    path: e.path,
  };
}

/** 过滤 + 排序（纯函数，面板与 CLI 共用；也方便单测）。 */
export function filterEntries(entries: PoolEntry[], q: SnapshotQuery = {}): PoolEntryView[] {
  const needle = (q.q || "").trim().toLowerCase();
  const status = q.status && q.status !== "all" ? q.status : null;
  const type = q.type && q.type !== "all" ? q.type : null;
  const project = q.project && q.project !== "all" ? q.project : null;

  let out = entries.filter((e) => {
    if (status && e.status !== status) return false;
    if (type && e.type !== type) return false;
    if (project && e.project !== project) return false;
    if (!needle) return true;
    return (
      e.text.toLowerCase().includes(needle) ||
      e.project.toLowerCase().includes(needle) ||
      e.tags.some((t) => t.toLowerCase().includes(needle)) ||
      e.id.toLowerCase().startsWith(needle)
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
  const r = await applyProposal(approved, {
    poolDir,
    archiveDir: deps.archiveDir,
    kbLessonsDir: deps.kbLessonsDir,
    index: deps.index,
  });
  return { ok: r.ok, detail: r.detail, files: r.files };
}
