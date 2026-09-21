/**
 * ZvecIndex — 记忆池的 zvec 索引实现（主实现）。
 *
 * 三条纪律（IMPL-PLAN §2，全部有实测依据）：
 *   1. **读者一律 `{ readOnly: true }`**：zvec 默认是读写模式，多个读者会互相抢独占锁。
 *   2. **写者短持有 + 20ms 重试退避**：写者与读者双向互斥；持有时间越短冲突越少。
 *   3. **重建不原地做**：先建到 `<root>.rebuild-<ts>`，再原子换名（读者只持有毫秒级）。
 *
 * 职责边界：zvec 负责**候选生成与语义相关性**（向量 + 中文 FTS，multiQuery 融合），
 * 本模块再叠加模型自己的两项（时间衰减 + 重要性）算总分——引擎不认识的维度不硬塞给它。
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  fuseScore, halfLifeFor, importanceNorm, matchesFilter, recencyScore,
  type Hit, type MemoryIndex, type RecallFilter, type RecallQuery,
} from "./memory-index";
import { listEntries, type PoolEntry, type PoolStatus, type PoolTemporal, type PoolType } from "./pool";

const DIM = 768;
const COLLECTION_DIR = ".zvec";

/** 写者重试策略（纪律 2）。实测 3 读 + 1 写下零失败、最长等待约 400ms。
 * 窗口要 ≥ 读者的**空闲释放**时间：读者会短暂持有句柄复用，写者需要等它让出。
 * 读者侧空闲释放默认 2s（MPI_ZHIYA_READ_IDLE_MS），所以预算放到 8s，避免“读者空闲中但还没放锁”
 * 被当成写失败。 */
const WRITE_RETRY = { attempts: Number(process.env.MPI_ZHIYA_WRITE_ATTEMPTS || 400), delayMs: 20 };
/** 读者重试（读也有极小概率撞上写者窗口）。 */
const READ_RETRY = { attempts: 40, delayMs: 20 };
/**
 * 只读句柄**空闲**多久再释放（把锁还给写者）。
 *
 * ⚠️ 这个 TTL **不再承担“感知索引变化”的职责**——那是代际标记（`.zvec-generation`）的事。
 * 它现在只是一张“礼貌”：长时间没人检索就别占着锁。
 *
 * 历史：以前 TTL=300ms 且带“失效”语义，于是**两次召回只要隔了 300ms 就要重开索引
 * （实测 ~216ms）**——而应用里真实召回的间隔几乎都超过 300ms，等于每次召回都在付这笔钱。
 * 实测（修前/修后，池内 126 条）：
 *   间隔 500ms 调用 216ms/次  →  现在 ~2ms/次（无人写时直接复用句柄）
 *   连续调用 7-14ms           →  不变
 * 索引真被改过时靠代际变化重开（见 acquireRead），所以读到的不会除旧。
 */
const READ_IDLE_MS = Number(process.env.MPI_ZHIYA_READ_IDLE_MS || process.env.MPI_ZHIYA_READ_TTL_MS || 2000);
/** 写入意向标记的新鲜度：写者崩溃留下的陈旧标记要能被忽略。写操作是短持有的（<1s），2s 足够。 */
const INTENT_FRESH_MS = Number(process.env.MPI_ZHIYA_INTENT_FRESH_MS || 2000);
/** 读者见到写入意向时最多等多久（等它清掉再读）。
 *  关键是“**停下来等**”而不是“放下又立即抢回”——后者每次重开占锁 ~208ms，
 *  实测会把写者拖到 3〜4s（见 IMPL-PLAN §2 纪律补充）。 */
const READ_WAIT_MS = Number(process.env.MPI_ZHIYA_READ_WAIT_MS || 2500);
const READ_WAIT_STEP_MS = 30;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isLockError = (e: unknown) => /lock/i.test(String((e as Error)?.message ?? e));

/** embedding 端点（OpenAI 兼容）。默认用本机 llama-server。 */
function embedUrl(): string {
  return process.env.MPI_ZHIYA_EMBED_URL || "http://127.0.0.1:1235/v1/embeddings";
}
function embedTimeoutMs(): number {
  return Number(process.env.MPI_ZHIYA_EMBED_TIMEOUT_MS || 20000);
}

/** jieba 词典目录随 binding 包分发（`@zvec/bindings-<platform>-<arch>/jieba_dict`）。
 *
 * 不能直接 resolve `@zvec/zvec/package.json`：它的 `exports` 没暴露 package.json 子路径
 * （实测报 “Package subpath './package.json' is not defined by exports”）。
 * 所以改成 resolve 包的主入口（这个一定允许），再向上找到 `@zvec` scope 目录。 */
export function jiebaDictDir(): string | null {
  try {
    const req = createRequire(import.meta.url);
    let dir = dirname(req.resolve("@zvec/zvec"));
    for (let i = 0; i < 6 && dir && basename(dir) !== "@zvec"; i++) dir = dirname(dir);
    if (!dir || basename(dir) !== "@zvec") return null;
    const cand = join(dir, `bindings-${process.platform}-${process.arch}`, "jieba_dict");
    return existsSync(cand) ? cand : null;
  } catch {
    return null;
  }
}

/**
 * embedding 进程内缓存（LRU）。
 * 作用：同一进程内重复查询、以及重复 rebuild 时免掉重复推理（单价约 14ms）。
 * 不做磁盘持久化：CLI 是一次性进程，收益低而文件会无限长大；
 * 长驻进程（pi 扩展 / MPI 主进程）靠进程内缓存已经吃满收益。
 */
const EMBED_CACHE_MAX = Number(process.env.MPI_ZHIYA_EMBED_CACHE_MAX || 512);
const embedCache = new Map<string, number[]>();

export async function embedText(text: string, opts: { noCache?: boolean } = {}): Promise<number[]> {
  const key = `${embedUrl()}::${text}`;
  if (!opts.noCache) {
    const hit = embedCache.get(key);
    if (hit) {
      // LRU：命中后移到末尾
      embedCache.delete(key);
      embedCache.set(key, hit);
      return hit;
    }
  }
  const res = await fetch(embedUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: text }),
    signal: AbortSignal.timeout(embedTimeoutMs()),
  });
  if (!res.ok) throw new Error(`embedding HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { embedding?: number[] }[] };
  const vec = json.data?.[0]?.embedding;
  if (!Array.isArray(vec) || !vec.length) throw new Error("embedding 返回为空");
  if (vec.length !== DIM) throw new Error(`embedding 维度 ${vec.length} ≠ ${DIM}（模型与索引不匹配）`);
  embedCache.set(key, vec);
  while (embedCache.size > EMBED_CACHE_MAX) {
    const oldest = embedCache.keys().next().value;
    if (oldest === undefined) break;
    embedCache.delete(oldest);
  }
  return vec;
}

/**
 * 向量路：**score 是距离，不是相似度**（实测 engine = 1 − 手算余弦，逐条吻合），越小越好。
 * 所以这里做 1 − score。这是本轮踩过的坑：按越大越好处理会直接把排序反转。
 */
function vectorSimFromScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, 1 - score));
}

/**
 * 全文路：BM25 分值的软饱和（0-1）。
 * ⚠️ 不要直接拿它当 relevance——BM25 量纲与查询长度相关，一个普通共用词就能让它虚高。
 * 调用方要先用**本次查询内的最大值**归一，再乘一个小于 1 的权重（见 recall 里的注释）。
 */
function ftsSoft(score: number): number {
  if (!Number.isFinite(score) || score <= 0) return 0;
  return score / (score + 1);
}

interface ZvecModule {
  ZVecCreateAndOpen: (path: string, schema: unknown) => ZvecCollection;
  ZVecOpen: (path: string, opts?: { readOnly?: boolean }) => ZvecCollection;
  ZVecCollectionSchema: new (p: unknown) => unknown;
  ZVecDataType: Record<string, unknown>;
  ZVecIndexType: Record<string, unknown>;
  ZVecMetricType: Record<string, unknown>;
  ZVecSetDefaultJiebaDictDir?: (dir: string) => void;
}

interface ZvecCollection {
  insertSync(docs: unknown): unknown;
  upsertSync(docs: unknown): unknown;
  deleteSync(ids: string | string[]): unknown;
  querySync(params: unknown): ZvecDoc[];
  multiQuerySync?(params: unknown): ZvecDoc[];
  createIndexSync(params: unknown): void;
  optimizeSync?(opts?: unknown): void;
  iterDocsSync?(options?: { outputFields?: string[]; includeVector?: boolean }): { next(): IteratorResult<ZvecDoc>; closeSync?(): void } | undefined;
  closeSync(): void;
}

interface ZvecDoc {
  id: string;
  fields: Record<string, unknown>;
  score: number;
}

interface Row {
  id: string;
  engine: number;
  created: string;
  temporal: PoolTemporal;
  importance: number;
  project: string;
  status: PoolStatus;
  type: PoolType;
  /** 原文（用于“字面包含”判断） */
  fullText: string;
}

export class ZvecIndex implements MemoryIndex {
  private z: ZvecModule | null = null;
  private readonly root: string;
  /** 写入意向标记：写者创建、成功后删除；读者见到就让锁（见 withRead）。 */
  private readonly intentPath: string;
  /** 写者代际标记：写者每次成功变更后更新；读者据此决定是否重开句柄。 */
  private readonly generationPath: string;

  private constructor(poolDir: string) {
    this.root = join(poolDir, COLLECTION_DIR);
    this.intentPath = join(poolDir, ".zvec-write-intent");
    this.generationPath = join(poolDir, ".zvec-generation");
  }

  /**
   * 写者代际：**任何**成功变更索引的写入都必须调用（统一放在 withWrite 里）。
   * 内容取时间戳+pid+计数，只要求“变了就行”；写成小文件，读者读一次 ~0.1ms。
   */
  private bumpGeneration(): void {
    this.genCounter += 1;
    try {
      writeFileSync(this.generationPath, `${Date.now()}-${process.pid}-${this.genCounter}\n`, "utf8");
    } catch {
      /* 标记写不了不影响写入本身；读者至多退化为“靠空闲 TTL 重开” */
    }
  }

  /** 当前代际（读不到返回 null，代表“没有代际信息”）。 */
  private currentGeneration(): string | null {
    try {
      return readFileSync(this.generationPath, "utf8");
    } catch {
      return null;
    }
  }

  private genCounter = 0;

  /** 打开（必要时创建集合并建中文 FTS 索引）。
   *
   * 自愈：如果集合是**刚新建**的（或被人删了）而池里已有条目，就从文件真相源重建。
   * 这是“索引是编译产物”的具体体现——索引丢了不该丢记忆。
   * 实测踩过：zvec 在 Electron 里加载失败期间落的条目只进了 JsonIndex，
   * 后来 zvec 能用了，那批条目在 zvec 里就是缺失的。 */
  static async open(poolDir: string): Promise<ZvecIndex> {
    const idx = new ZvecIndex(poolDir);
    const created = !existsSync(idx.root);
    idx.z = (await import("@zvec/zvec")) as unknown as ZvecModule;
    const jieba = jiebaDictDir();
    if (jieba && idx.z.ZVecSetDefaultJiebaDictDir) idx.z.ZVecSetDefaultJiebaDictDir(jieba);
    await idx.ensureCollection();
    // 一致性核对：索引里的条目数应与池文件数一致（索引是编译产物，少了就重建）
    const poolCount = listEntries(poolDir).entries.length;
    if (poolCount > 0) {
      const idxCount = idx.idCount();
      if (created || idxCount !== poolCount) {
        // eslint-disable-next-line no-console
        console.log(
          `[memory] 索引与池不一致（索引 ${idxCount} 条 / 池 ${poolCount} 条）→ 从文件重建`,
        );
        await idx.rebuild(poolDir);
        // eslint-disable-next-line no-console
        console.log("[memory] 索引重建完成");
      }
    }
    return idx;
  }

  /** 索引里的条目数（用迭代器数，不依赖未验证的过滤器语法）。 */
  private idCount(): number {
    let n = 0;
    try {
      const c = this.z!.ZVecOpen(this.root, { readOnly: true });
      try {
        const it = c.iterDocsSync?.({ includeVector: false, outputFields: [] });
        if (!it) return -1;
        while (!it.next().done) n++;
        it.closeSync?.();
      } finally {
        c.closeSync();
      }
    } catch {
      return -1; // 数不出来就当成不一致，宁重建不静默缺失
    }
    return n;
  }

  private schema(): unknown {
    const z = this.z!;
    return new z.ZVecCollectionSchema({
      name: "pool",
      vectors: {
        name: "embedding",
        dataType: z.ZVecDataType.VECTOR_FP32,
        dimension: DIM,
        indexParams: { indexType: z.ZVecIndexType.HNSW, metricType: z.ZVecMetricType.COSINE, m: 16, efConstruction: 200 },
      },
      fields: [
        { name: "text", dataType: z.ZVecDataType.STRING },
        { name: "project", dataType: z.ZVecDataType.STRING },
        { name: "status", dataType: z.ZVecDataType.STRING },
        { name: "type", dataType: z.ZVecDataType.STRING },
        { name: "temporal", dataType: z.ZVecDataType.STRING },
        { name: "importance", dataType: z.ZVecDataType.INT64 },
        { name: "created_at", dataType: z.ZVecDataType.STRING },
      ],
    });
  }

  private createFts(col: ZvecCollection): void {
    const z = this.z!;
    col.createIndexSync({
      fieldName: "text",
      fieldSchema: { name: "text", dataType: z.ZVecDataType.STRING },
      indexParams: { indexType: z.ZVecIndexType.FTS, tokenizer: "jieba" },
    });
  }

  private async ensureCollection(): Promise<void> {
    if (existsSync(this.root)) return;
    await this.withWrite((col) => {
      this.createFts(col);
    });
  }

  /** 写会话：短持有 + 重试退避（纪律 2）。写之前先放掉只读句柄，并挂出写入意向。 */
  private async withWrite<T>(fn: (col: ZvecCollection) => T): Promise<T> {
    this.dropRead();
    this.raiseWriteIntent();
    let lastErr: unknown;
    try {
      for (let i = 0; i < WRITE_RETRY.attempts; i++) {
        let col: ZvecCollection | null = null;
        try {
          col = existsSync(this.root)
            ? this.z!.ZVecOpen(this.root)
            : this.z!.ZVecCreateAndOpen(this.root, this.schema());
          const out = fn(col);
          // 成功变更 → 推进代际（读者据此重开句柄，不会读到旧数据）
          this.bumpGeneration();
          return out;
        } catch (e) {
          lastErr = e;
          if (!isLockError(e)) throw e;
          await sleep(WRITE_RETRY.delayMs);
        } finally {
          try {
            col?.closeSync();
          } catch {
            /* 关闭失败不影响结果 */
          }
        }
      }
    } finally {
      this.clearWriteIntent();
    }
    throw new Error(`写入等待超时（重试 ${WRITE_RETRY.attempts} 次）：${(lastErr as Error)?.message}`);
  }

  // ---- 读者/写者协调：写入意向标记 ---------------------------------------------
  //
  // 问题：读者为了省掉 ~214ms 的开合成本而复用句柄，但只要它持续检索，TTL 就会被不断
  // 重置 → 写者永远拿不到独占锁（饿死）。
  // 办法：写者落一个 `<pool>/.zvec-write-intent` 标记，读者每次检索前看一眼，见到就让锁。
  // 陈旧标记（写者崩溃）用 mtime 新鲜度忽略。
  private raiseWriteIntent(): void {
    try {
      writeFileSync(this.intentPath, `${process.pid} ${new Date().toISOString()}\n`, "utf8");
    } catch {
      /* 标记写不了也要能续写，只是退化为“读者不让锁” */
    }
  }

  private clearWriteIntent(): void {
    try {
      rmSync(this.intentPath, { force: true });
    } catch {
      /* 忽略 */
    }
  }

  /** 是否有写者正在等锁（且标记新鲜）。 */
  private writerPending(): boolean {
    try {
      if (!existsSync(this.intentPath)) return false;
      const age = Date.now() - statSync(this.intentPath).mtimeMs;
      if (age > INTENT_FRESH_MS) return false; // 陈旧标记（写者崩了）
      return true;
    } catch {
      return false;
    }
  }

  // ---- 只读句柄复用（延迟优化的关键）--------------------------------------
  //
  // 实测：zvec 的 open 不是免费操作——带 FTS 索引的集合，只读开+关要 ~214ms（向量查
  // 询本身 <1ms）。而每次 recall 都开合 → p50 239ms；复用句柄后降到 <1ms。
  //
  // 复用的**正确性依据是代际**：写者每次成功写入都会更新 `<池>/.zvec-generation`，
  // 读者在取句柄前比一下代际——**没变就不重开**，变了（或没有会话）才丢句柄重开。
  // 这样“隔了一会儿再查”不再白白付 214ms，而“有人在写”也不会读到旧索引。
  // 另外还有两条保险：① writerPending() 见到写入意向就让锁（防写者饿死）；
  // ② 空闲超过 READ_IDLE_MS 主动释放（长时间没人用就不该占着锁）。
  private readSession: { col: ZvecCollection; timer: NodeJS.Timeout | null; gen: string | null } | null = null;

  private dropRead(): void {
    const s = this.readSession;
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    this.readSession = null;
    try {
      s.col.closeSync();
    } catch {
      /* 已经关掉/被换掉，忽略 */
    }
  }

  private armIdleTtl(): void {
    const s = this.readSession;
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    const t = setTimeout(() => this.dropRead(), READ_IDLE_MS);
    t.unref?.(); // 不要因为它把进程吊住
    s.timer = t;
  }

  /** 取一个只读句柄（代际未变则复用，否则重开）。抛错的语义与之前一致（锁冲突可重试）。 */
  private acquireRead(): ZvecCollection {
    const gen = this.currentGeneration();
    if (this.readSession && this.readSession.gen === gen) {
      this.armIdleTtl();
      return this.readSession.col;
    }
    // 代际变了（或有别的写者动过索引而本进程不知道）→ 必须重开，否则会读到旧数据
    if (this.readSession) this.dropRead();
    const col = this.z!.ZVecOpen(this.root, { readOnly: true });
    this.readSession = { col, timer: null, gen };
    this.armIdleTtl();
    return col;
  }

  /** 读会话：**一律 readOnly**（纪律 1）+ 句柄复用 + 重试。 */
  private async withRead<T>(fn: (col: ZvecCollection) => T): Promise<T> {
    if (!existsSync(this.root)) throw new Error("索引尚未建立（先跑 memory:reindex）");
    let lastErr: unknown;
    for (let i = 0; i < READ_RETRY.attempts; i++) {
      // 有写者在等锁：停下来等它做完（不要让读者在写者等待时反复抢锁）
      for (let waited = 0; waited < READ_WAIT_MS && this.writerPending(); waited += READ_WAIT_STEP_MS) {
        this.dropRead();
        await sleep(READ_WAIT_STEP_MS);
      }
      try {
        const col = this.acquireRead();
        const out = fn(col);
        this.armIdleTtl();
        return out;
      } catch (e) {
        lastErr = e;
        // 锁冲突（或句柄已失效）→ 丢掉句柄重来
        this.dropRead();
        if (!isLockError(e)) throw e;
        await sleep(READ_RETRY.delayMs);
      }
    }
    throw new Error(`读取等待超时（重试 ${READ_RETRY.attempts} 次）：${(lastErr as Error)?.message}`);
  }

  private toDoc(e: PoolEntry, vector: number[]): unknown {
    return {
      id: e.id,
      vectors: { embedding: vector },
      fields: {
        text: e.text,
        project: e.project,
        status: e.status,
        type: e.type,
        temporal: e.temporal,
        importance: e.importance,
        created_at: e.createdAt,
      },
    };
  }

  /**
   * 增量写入。embedding 取不到时**不阻塞**：跳过该条并回报（真相源已在文件里，
   * 索引只是编译产物，下次 rebuild 会补上）——fail-open。
   */
  async upsert(entries: PoolEntry[], opts: { onEmbedFailure?: (id: string, err: string) => void } = {}): Promise<void> {
    if (!entries.length) return;
    const docs: unknown[] = [];
    for (const e of entries) {
      try {
        docs.push(this.toDoc(e, await embedText(e.text)));
      } catch (err) {
        opts.onEmbedFailure?.(e.id, (err as Error).message);
      }
    }
    if (!docs.length) return;
    await this.withWrite((col) => col.upsertSync(docs));
  }

  async remove(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.withWrite((col) => col.deleteSync(ids));
  }

  private filterExpr(f?: RecallFilter): string | undefined {
    if (!f) return undefined;
    const parts: string[] = [];
    if (f.project) parts.push(`project = ${JSON.stringify(f.project)}`);
    if (f.type) parts.push(`type = ${JSON.stringify(f.type)}`);
    if (f.temporal) parts.push(`temporal = ${JSON.stringify(f.temporal)}`);
    if (f.status?.length === 1) parts.push(`status = ${JSON.stringify(f.status[0])}`);
    // 多状态与 since 用后置过滤（表达式语法支持面未知，宁可少用）
    return parts.length ? parts.join(" AND ") : undefined;
  }

  /**
   * 检索 = 候选生成（引擎）+ 排序（本层公式）。
   *
   * 为什么不直接用引擎的 multiQuery 融合分数：实测加权融合把距离与BM25两种量纲混在
   * 一起（1.69 / 1.02 / …），无法解释成 0-1 的相关性，塞进 0.5/3/2 公式会把排序搞乱。
   * 所以这里**分别取**两条路的原始分数、各自归一化后再合并：
   *   relevance = max(向量相似度, 全文软饱和)   ← 取 max：精确词命中与语义命中都算命中
   *   recency   = 时间衰减（半衰期 任务态 7 天 / 知识态 90 天）
   *   importance= 写入时打分（1-10 → 0-1）
   * 三者再按 0.5 / 3 / 2 融合。
   */
  async recall(q: RecallQuery): Promise<Hit[]> {
    const topK = q.topK ?? 5;
    const text = q.text.trim();
    const pool = Math.max(topK * 4, 20);
    const FIELDS = ["text", "project", "status", "type", "temporal", "importance", "created_at"];
    let cands: Row[] = [];

    if (!text) {
      // 无查询文本：按过滤条件取最近的一批（relevance 一律 1，让时间与重要性决定排序）
      await this.withRead((col) => {
        const params: Record<string, unknown> = { topk: pool, outputFields: FIELDS };
        const expr = this.filterExpr(q.filter);
        if (expr) params.filter = expr;
        cands = (col.querySync(params) as ZvecDoc[]).map((d) => this.row(d, 1));
        return null;
      });
      return this.rank(cands, q, topK);
    }

    const expr = this.filterExpr(q.filter);
    let vector: number[] | null = null;
    try {
      vector = await embedText(text);
    } catch {
      vector = null; // embedding 不可用 → 只用全文路（不伪造向量分数）
    }

    await this.withRead((col) => {
      const vectorSim = new Map<string, Row>();
      const bm25 = new Map<string, Row>();

      if (vector) {
        const p: Record<string, unknown> = { fieldName: "embedding", vector, topk: pool, outputFields: FIELDS };
        if (expr) p.filter = expr;
        for (const d of col.querySync(p) as ZvecDoc[]) {
          vectorSim.set(d.id, this.row(d, vectorSimFromScore(d.score)));
        }
      }

      const pf: Record<string, unknown> = { fieldName: "text", fts: { matchString: text }, topk: pool, outputFields: FIELDS };
      if (expr) pf.filter = expr;
      for (const d of col.querySync(pf) as ZvecDoc[]) {
        bm25.set(d.id, this.row(d, d.score));
      }

      // 融合策略（由 10 题回归集实测选定，不是拍脑袋）：
      //   C) relevance = 0.75×向量相似度 + 0.25×min(软饱和BM25, 0.5)   → top1 命中 10/10
      //   B) relevance = max(向量, 0.75×本查询内归一BM25)                → top1 命中 4/10（被普通共用词顶掉）
      //   A) 只用向量                                                  → 9/10
      // 关键点是 BM25 必须**绝对封顶**且只占小权重：否则“查询里任何一个普通词”都能
      // 让无关条目靠词法分胜出（回归集里真发生过：同为“代码”的调用图条目抢了三道题的 top1）。
      const merged = new Map<string, Row>();
      for (const [id, row] of vectorSim) merged.set(id, row);
      for (const [id, row] of bm25) {
        const lexical = Math.min(ftsSoft(row.engine), 0.5);
        const prev = merged.get(id);
        if (prev) prev.engine = 0.75 * prev.engine + 0.25 * lexical;
        else merged.set(id, { ...row, engine: 0.25 * lexical }); // 仅词法命中：保守分
      }

      // 例外：**字面包含**是强信号（稀有标识符、代码符号）——给个下限，避免被上面压太低。
      const needle = text.replace(/\s+/g, "").toLowerCase();
      if (needle.length >= 4) {
        for (const row of merged.values()) {
          if (row.fullText.replace(/\s+/g, "").toLowerCase().includes(needle)) {
            row.engine = Math.max(row.engine, 0.8);
          }
        }
      }

      cands = [...merged.values()];
      return null;
    });
    return this.rank(cands, q, topK);
  }

  private row(d: ZvecDoc, engineScore?: number): Row {
    const f = d.fields ?? {};
    return {
      id: d.id,
      engine: engineScore ?? vectorSimFromScore(d.score),
      created: String(f.created_at ?? ""),
      temporal: String(f.temporal ?? "") as PoolTemporal,
      importance: Number(f.importance ?? 0),
      project: String(f.project ?? ""),
      status: String(f.status ?? "") as PoolStatus,
      type: String(f.type ?? "") as PoolType,
      fullText: String(f.text ?? ""),
    };
  }

  /** 引擎给语义相关性，本层叠加时间衰减与重要性 → 最终排序（模型自有公式）。 */
  private rank(
    cands: Row[],
    q: RecallQuery,
    topK: number,
  ): Hit[] {
    const now = Date.now();
    const hits: Hit[] = [];
    for (const c of cands) {
      if (!matchesFilter({ project: c.project, status: c.status, type: c.type, temporal: c.temporal, createdAt: c.created }, q.filter)) continue;
      const parts = {
        recency: recencyScore(c.created, now, halfLifeFor(c.temporal)),
        relevance: c.engine,
        importance: importanceNorm(c.importance),
      };
      hits.push({ id: c.id, score: fuseScore(parts), parts });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  }

  /** 全量重建到新目录 + 原子替换（纪律 3）。旧目录在替换后清理。 */
  async rebuild(fromDir: string): Promise<void> {
    // 关键：换名时本进程不能还持有旧目录的句柄（Windows 上会拒绝换名）
    this.dropRead();
    const { entries } = listEntries(fromDir);
    const staging = `${this.root}.rebuild-${Date.now()}`;
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });

    const col = this.z!.ZVecCreateAndOpen(staging, this.schema());
    try {
      this.createFts(col);
      for (const e of entries) {
        const vector = await embedText(e.text);
        col.insertSync(this.toDoc(e, vector));      }
      col.optimizeSync?.();
    } finally {
      col.closeSync();
    }

    // 原子替换：读者只持有毫秒级句柄，Windows 上换名失败就退避重试
    const backup = `${this.root}.old-${Date.now()}`;
    let lastErr: unknown;
    for (let i = 0; i < 40; i++) {
      try {
        if (existsSync(this.root)) renameSync(this.root, backup);
        renameSync(staging, this.root);
        rmSync(backup, { recursive: true, force: true });
        return;
      } catch (e) {
        lastErr = e;
        await sleep(50);
      }
    }
    throw new Error(`索引替换失败：${(lastErr as Error)?.message}`);
  }

  async close(): Promise<void> {
    // 释放复用的只读句柄（否则会把写者锁住）、清除空闲计时器
    this.dropRead();
  }

  /**
   * 压缩：zvec 每次写入落一个 ~5MB 段文件且**不会自动合并**，不压就会持续膨胀。
   * 实测 16 条条目跑一天 → 124MB，`optimizeSync()` 后 4.6MB。
   * 走写者锁纪律（短暂独占 + 重试），只在启动后/退出前调用，不进热路径。
   */
  async compact(): Promise<void> {
    if (!existsSync(this.root)) return;
    await this.withWrite((col) => {
      col.optimizeSync?.();
      return null;
    });
  }

  // 供 CLI/调试：绕过公式直接看引擎原始分数
  async rawScores(text: string, topK: number): Promise<{ id: string; score: number }[]> {
    const vector = await embedText(text);
    return this.withRead((col) => {
      const docs = col.querySync({ fieldName: "embedding", vector, topk: topK }) as ZvecDoc[];
      return docs.map((d) => ({ id: d.id, score: d.score }));
    });
  }

}
