/**
 * 记忆池检索层 — 与具体引擎解耦。
 *
 * `MemoryIndex` 是唯一的对外契约；`ZvecIndex`（主实现：向量 + 中文 FTS + 标量过滤）
 * 与 `JsonIndex`（兜底：子串 + 字段过滤）都实现它。换引擎不动上层。
 *
 * 评分公式照抄 Stanford Generative Agents 的实测权重（见 MEMORY-MODEL.md §4.2）：
 *   总分 = 0.5×recency + 3×relevance + 2×importance   （三项各自归一化到 0-1）
 * 时间衰减按"半衰期"参数化：任务态 7 天、知识态 90 天。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listEntries, queryRelevance, type PoolEntry, type PoolStatus, type PoolType, type PoolTemporal } from "./pool";

/** 池目录默认位置（可用 `MPI_ZHIYA_POOL_DIR` 覆盖，便于测试与多实例）。 */
export function defaultPoolDir(): string {
  if (process.env.MPI_ZHIYA_POOL_DIR) return process.env.MPI_ZHIYA_POOL_DIR;
  const agentDir = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "zhiya", "pool");
}

export interface RecallFilter {
  project?: string;
  status?: PoolStatus[];
  type?: PoolType;
  temporal?: PoolTemporal;
  /** 只取该时间之后创建的（ISO 可解析）。 */
  since?: string;
}

export interface RecallQuery {
  /** 查询文本；为空表示"按时间/重要性取最近的"。 */
  text: string;
  topK?: number;
  filter?: RecallFilter;
}

export interface RecallParts {
  recency: number;
  relevance: number;
  importance: number;
}

export interface Hit {
  id: string;
  score: number;
  parts: RecallParts;
}

export interface MemoryIndex {
  /** 增量写入/更新（按 id 覆盖）。 */
  upsert(entries: PoolEntry[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
  recall(q: RecallQuery): Promise<Hit[]>;
  /** 从文件真相源全量重建（新目录 + 原子替换；见 IMPL-PLAN §2 纪律 3）。 */
  rebuild(fromDir: string): Promise<void>;
  /** 合并碎片/回收空间。索引是派生数据，失败不影响功能（JsonIndex 为空操作）。 */
  compact(): Promise<void>;
  close(): Promise<void>;
}

export const FUSE_WEIGHTS = { recency: 0.5, relevance: 3, importance: 2 } as const;
const WEIGHT_SUM = FUSE_WEIGHTS.recency + FUSE_WEIGHTS.relevance + FUSE_WEIGHTS.importance;

/** 任务态衰减快（7 天半衰期），知识态慢（90 天半衰期）。 */
export const HALF_LIFE_DAYS = { present: 7, other: 90 } as const;

export function halfLifeFor(temporal: PoolTemporal | undefined): number {
  return temporal === "present" ? HALF_LIFE_DAYS.present : HALF_LIFE_DAYS.other;
}

/** 时间衰减：0.5^(ageDays / halfLife)，返回 0-1。 */
export function recencyScore(createdAt: string, now: number = Date.now(), halfLifeDays: number = HALF_LIFE_DAYS.other): number {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return 0;
  const ageDays = Math.max(0, (now - t) / 86_400_000);
  return Math.pow(0.5, ageDays / Math.max(0.001, halfLifeDays));
}

/** 融合三项（每项 0-1）→ 0-1 总分。 */
export function fuseScore(p: RecallParts): number {
  const s =
    FUSE_WEIGHTS.recency * clamp01(p.recency) +
    FUSE_WEIGHTS.relevance * clamp01(p.relevance) +
    FUSE_WEIGHTS.importance * clamp01(p.importance);
  return s / WEIGHT_SUM;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** 重要性 1-10 → 0-1。 */
export function importanceNorm(importance: number): number {
  return clamp01((importance - 1) / 9);
}

export function matchesFilter(e: { project: string; status: PoolStatus; type: PoolType; temporal: PoolTemporal; createdAt: string }, f?: RecallFilter): boolean {
  if (!f) return true;
  if (f.project && e.project !== f.project) return false;
  if (f.status?.length && !f.status.includes(e.status)) return false;
  if (f.type && e.type !== f.type) return false;
  if (f.temporal && e.temporal !== f.temporal) return false;
  if (f.since) {
    const a = Date.parse(e.createdAt);
    const b = Date.parse(f.since);
    if (Number.isFinite(a) && Number.isFinite(b) && a < b) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 索引记录（索引里只放检索需要的字段；正文真相源在文件里）
// ---------------------------------------------------------------------------

export interface IndexRecord {
  id: string;
  text: string;
  project: string;
  status: PoolStatus;
  type: PoolType;
  temporal: PoolTemporal;
  importance: number;
  createdAt: string;
}

export function toRecord(e: PoolEntry): IndexRecord {
  return {
    id: e.id,
    text: e.text,
    project: e.project,
    status: e.status,
    type: e.type,
    temporal: e.temporal,
    importance: e.importance,
    createdAt: e.createdAt,
  };
}

// ---------------------------------------------------------------------------
// JsonIndex — 零依赖兜底（zvec 不可用 / 终端 pi 无索引 / 测试对照）
// ---------------------------------------------------------------------------

/**
 * `.index.json` 形式的索引。刻意保持极简：
 *   - 检索用"子串 + 字面相似度"，不具备语义能力（那是 zvec 的活）；
 *   - 读多写少；写入用 tmp + rename 原子替换；
 *   - **多进程同时写同一个 JSON 会互相覆盖** → 它只适合单写者场景（CLI、
 *     离线重建、单机），这也是它只做兜底的原因。
 */
export class JsonIndex implements MemoryIndex {
  private records: IndexRecord[] = [];
  private readonly file: string;

  constructor(poolDir: string) {
    this.file = join(poolDir, ".index.json");
  }

  load(): void {
    if (!existsSync(this.file)) {
      this.records = [];
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as IndexRecord[];
      this.records = Array.isArray(parsed) ? parsed.filter((r) => r && typeof r.id === "string") : [];
    } catch {
      // 索引坏了不算事故（它是编译产物）：置空，等 rebuild
      this.records = [];
    }
  }

  private flush(): void {
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.records, null, 1), "utf8");
    renameSync(tmp, this.file);
  }

  async upsert(entries: PoolEntry[]): Promise<void> {
    this.load();
    const byId = new Map(this.records.map((r) => [r.id, r]));
    for (const e of entries) byId.set(e.id, toRecord(e));
    this.records = [...byId.values()];
    this.flush();
  }

  async remove(ids: string[]): Promise<void> {
    this.load();
    const drop = new Set(ids);
    this.records = this.records.filter((r) => !drop.has(r.id));
    this.flush();
  }

  async recall(q: RecallQuery): Promise<Hit[]> {
    this.load();
    const now = Date.now();
    const text = q.text.trim();
    const cands = this.records.filter((r) => matchesFilter(r, q.filter));
    const hits: Hit[] = cands.map((r) => {
      const relevance = text ? queryRelevance(text, r.text) : 0;
      const parts: RecallParts = {
        recency: recencyScore(r.createdAt, now, halfLifeFor(r.temporal)),
        relevance,
        importance: importanceNorm(r.importance),
      };
      return { id: r.id, score: fuseScore(parts), parts };
    });
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, q.topK ?? 5);
  }

  async rebuild(fromDir: string): Promise<void> {
    const { entries } = listEntries(fromDir);
    this.records = entries.map(toRecord);
    this.flush();
  }

  /** JSON 索引就是一个 JSON 文件，没有碎片可合 —— 空操作（接口一致性）。 */
  async compact(): Promise<void> {
    /* 无操作 */
  }

  async close(): Promise<void> {
    /* 无持久句柄 */
  }
}
