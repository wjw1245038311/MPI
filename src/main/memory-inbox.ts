/**
 * 记忆池落地管道（主进程侧）—— 唯一写者。
 *
 * 分工（与待办任务同构）：
 *   pi 扩展（mpi-memory-ext，跑在 pi 进程里）
 *       捕获对话 → 本机模型抽取候选 → 打分 → 每条一个 JSON 丢进 <userData>/zhiya-memory-inbox/
 *   主进程（本模块）
 *       watch + 轮询 inbox → 校验 → 阈值/判重（decideIngest）→ 写池文件 → 更新 zvec 索引
 *
 * 为什么不让扩展直接写池：①扩展是以 `?raw` 源码写进 userData 的，import 不到本仓模块，
 * 复制一份池逻辑会漂移（choice 扩展的三处同步就是前车之鉴）②主进程独占写入，天然无跨进程竞态。
 * 扩展侧的抽取质量不足、或本机模型不可用，都不影响池子的完整性（fail-open：宁少不假）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { decideIngestIn, lexicalSimilarity, listEntries, openIngestCtx, THRESHOLD, type Candidate, type IngestCtx, type PoolEntry, type PoolTemporal, type PoolType } from "./zhiya/pool";
import { defaultPoolDir, JsonIndex, type MemoryIndex } from "./zhiya/memory-index";
import { zhiyaMasterDir } from "./zhiya";

export const MEMORY_INBOX_DIRNAME = "zhiya-memory-inbox";

export function ensureMemoryInbox(userDataDir: string): string {
  const dir = join(userDataDir, MEMORY_INBOX_DIRNAME);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 扩展写进 inbox 的候选形状（扩展侧必须保持同步——这是唯一的跨进程契约）。 */
export interface MemoryCandidateFile {
  text: string;
  type?: PoolType;
  temporal?: PoolTemporal;
  importance?: number;
  relevance?: number;
  project?: string;
  /** 采集时的项目根目录（绝对路径） */
  projectRoot?: string;
  source?: string;
  tags?: string[];
  evidence?: string[];
  /** 抽取端自己标注的"为什么值得记"（仅留档，不参与判定）。 */
  reason?: string;
  capturedAt?: string;
  /** 抽取成功但打分失败时置 true → fail-open 走默认分。 */
  scoringFailed?: boolean;
}

/**
 * 非写入类操作（扩展发起的，由主进程执行）。
 * 为什么不让扩展直接动手：主进程是唯一写者（池文件 + 索引），
 * 扩展只能“提请求”，否则两个进程会同时改池子。
 */
export interface MemoryOpFile {
  op: "forget" | "dream" | "approve" | "reject";
  /** 目标条目 id（forget 支持前缀；approve/reject 为提案 id） */
  id?: string;
  /** 或者按正文精确/包含匹配（仅 forget） */
  match?: string;
  /** dream：只分诊不落盘 */
  dryRun?: boolean;
  /** dream：会话工作目录（兜底项目根，用于给老条目算 lesson 落点） */
  cwd?: string;
  reason?: string;
}

/** 重活（dream/审批）由调用方注入，inbox 只管协议与回执。 */
export interface OpHandlers {
  dream?: (op: MemoryOpFile) => Promise<{ detail: string; files?: string[] }>;
  approve?: (id: string) => Promise<{ detail: string; files?: string[] }>;
  reject?: (id: string) => Promise<{ detail: string; files?: string[] }>;
  /** 回执落盘（<池>/ops.jsonl）；不注入则不写 */
  logResult?: (r: OpLogEntry) => void;
}

/** 一次 op 处理的回执（扩展/面板可读）。 */
export interface OpLogEntry {
  at: string;
  op: string;
  id: string | null;
  ok: boolean;
  detail: string;
}

/** 归档目录：优先进私有仓的 archive/（跨设备可见），没配母版则落在池内 archived/。 */
export function archiveDirFor(poolDir: string): string {
  // 显式覆盖优先（测试隔离 / 多实例；不给才按母版配置推导）
  const override = (process.env.MPI_ZHIYA_ARCHIVE_DIR || "").trim();
  if (override) return override;
  try {
    const master = zhiyaMasterDir();
    if (master) return join(master, "archive", "zhiya-pool");
  } catch {
    /* 探测失败就当没配 */
  }
  return join(poolDir, "archived");
}

/** 执行 "遗忘" = **归档而非删除**（MEMORY-MODEL 出口④：留痕、可追溯）。 */
function forgetOne(poolDir: string, op: MemoryOpFile, log: (m: string) => void, archiveDir?: string): IngestOutcome {
  const { entries } = listEntries(poolDir);
  const target = op.id
    ? entries.find((e) => e.id === op.id || e.id.startsWith(String(op.id)))
    : op.match
      ? entries.find((e) => e.text.includes(String(op.match)))
      : undefined;
  if (!target || !target.path) {
    return { file: "", action: "invalid", detail: `找不到目标条目（id=${op.id ?? "-"} match=${op.match ?? "-"}）` };
  }
  const dest = join(archiveDir ?? archiveDirFor(poolDir), basename(target.path));
  try {
    mkdirSync(dirname(dest), { recursive: true });
    moveFileSafe(target.path, dest);
  } catch (e) {
    return { file: target.path, action: "error", detail: `归档失败：${(e as Error).message}` };
  }
  log(`[memory] 已归档：${target.text.slice(0, 40)} → ${dest}`);
  return { file: target.path, action: "forget", id: target.id, detail: dest };
}

const TYPES: PoolType[] = ["semantic", "episodic", "procedural"];
const TEMPORALS: PoolTemporal[] = ["retrospective", "present", "prospective"];

/** 校验候选（fail-closed：形状不对就拒，不猜）。 */
export function validateCandidate(raw: unknown): { ok: true; cand: Candidate } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "不是对象" };
  const o = raw as Record<string, unknown>;
  const text = typeof o.text === "string" ? o.text.trim() : "";
  if (!text) return { ok: false, reason: "缺少 text" };
  if (text.length > 2000) return { ok: false, reason: `text 过长（${text.length} 字）` };

  const type = typeof o.type === "string" && TYPES.includes(o.type as PoolType) ? (o.type as PoolType) : "semantic";
  const temporal =
    typeof o.temporal === "string" && TEMPORALS.includes(o.temporal as PoolTemporal) ? (o.temporal as PoolTemporal) : "retrospective";
  const importance = Number(o.importance);
  const relevance = Number(o.relevance);

  return {
    ok: true,
    cand: {
      text,
      type,
      temporal,
      importance: Number.isFinite(importance) ? importance : 5,
      relevance: Number.isFinite(relevance) ? relevance : 0.5,
      project: typeof o.project === "string" && o.project ? o.project : "global",
      projectRoot: typeof o.projectRoot === "string" && o.projectRoot ? o.projectRoot : undefined,
      source: typeof o.source === "string" ? o.source : "",
      tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === "string") : [],
      evidence: Array.isArray(o.evidence) ? o.evidence.filter((t): t is string => typeof t === "string") : [],
      scoringFailed: o.scoringFailed === true || !Number.isFinite(importance) || !Number.isFinite(relevance),
    },
  };
}

export interface IngestOutcome {
  file: string;
  action: "add" | "bump" | "drop" | "invalid" | "error" | "forget";
  detail?: string;
  id?: string;
}

export interface IngestDeps {
  poolDir?: string;
  /** 写索引（可选：失败不影响池文件写入）。 */
  index?: MemoryIndex | null;
  /** 判重用的相似度函数（默认字面相似度；P2 起可用向量）。 */
  similarity?: (a: string, b: string) => number;
  log?: (msg: string) => void;
  /** 归档目录（可注入，便于测试跨卷场景；不给则按配置推导） */
  archiveDir?: string;
  /** 重活处理器（dream/审批）；未注入时这类 op 判为不支持 */
  ops?: OpHandlers;
  /** 每写入/累加一条后的回调（巩固累加器记账用） */
  onIngested?: (e: PoolEntry) => void;
  /**
   * 批量摄入上下文（一次读池）。
   * 批处理时**必须**传：否则每条都重读全池 → O(n²)。
   * 实测：池内 300→600 条时单次写入 153.5ms；用上下文后读盘只发生一次。
   */
  ctx?: IngestCtx;
}

/**
 * 处理一个候选文件：校验 → 阈值/判重 → 写池 →（尽力）更新索引。
 * 无论成败都把源文件移走（成功 → 删除；失败 → `.failed/`），避免重复摄入。
 */
export async function ingestOne(file: string, deps: IngestDeps = {}): Promise<IngestOutcome> {
  const poolDir = deps.poolDir ?? defaultPoolDir();
  const log = deps.log ?? (() => {});
  const similarity = deps.similarity ?? lexicalSimilarity;

  // 保险：绝不消费扩展的内部状态文件（调用方万一漏了过滤）。
  // ⚠️ 但要放行 `.processing-`：那是**我们自己**认领过的文件（见 claimFile），
  //    不然认领完就被这个守卫当成内部文件丢掉（测试当场抳到过）。
  const base = file.split(/[\\/]/).pop() || "";
  if (base.startsWith(".") && !base.startsWith(".processing-")) {
    return { file, action: "invalid", detail: "点号开头的文件是扩展内部状态，不当候选处理" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    moveAside(file, poolDir, "failed");
    return { file, action: "error", detail: `JSON 解析失败：${(e as Error).message}` };
  }

  const v = validateCandidate(parsed);
  // 操作类（forget/dream/approve/reject）：形状与候选不同，先分辨再处理
  const maybeOp = parsed as MemoryOpFile;
  if (maybeOp && typeof maybeOp === "object" && typeof maybeOp.op === "string") {
    const opName = maybeOp.op;
    const report = (ok: boolean, detail: string): void => {
      deps.ops?.logResult?.({ at: new Date().toISOString(), op: opName, id: maybeOp.id ?? null, ok, detail });
    };

    // 先校验操作名再校验参数：否则未知 op 会先撞上"缺少提案 id"，报错信息误导人（测试抳到过）
    if (opName !== "forget" && opName !== "dream" && opName !== "approve" && opName !== "reject") {
      moveAside(file, poolDir, "failed");
      const detail = `不支持的操作：${opName}`;
      report(false, detail);
      return { file, action: "invalid", detail };
    }

    if (opName === "forget") {
      const out = forgetOne(poolDir, maybeOp, log, deps.archiveDir);
      if (out.action === "forget") {
        // 索引是派生数据：归档后从索引里移掉（失败只记日志）
        if (deps.index && out.id) {
          try {
            await deps.index.remove([out.id]);
          } catch (e) {
            log(`[memory] 索引移除失败（下次 rebuild 会纠正）：${(e as Error).message}`);
          }
        }
        rmSync(file, { force: true });
        report(true, `已归档 ${out.id ?? ""}`);
        return { ...out, file };
      }
      moveAside(file, poolDir, "failed");
      report(false, out.detail ?? "归档失败");
      return { ...out, file };
    }

    // dream / approve / reject：交给注入的处理器（重活由调用方决定是否后台跑）
    if (opName !== "dream" && !maybeOp.id) {
      moveAside(file, poolDir, "failed");
      const detail = `${opName} 缺少提案 id`;
      report(false, detail);
      return { file, action: "invalid", detail };
    }
    let r: { detail: string; files?: string[] };
    try {
      if (opName === "dream") {
        if (!deps.ops?.dream) {
          moveAside(file, poolDir, "failed");
          const detail = deps.ops ? `不支持的操作：${opName}` : `操作未启用：${opName}（未注入处理器）`;
          report(false, detail);
          return { file, action: "invalid", detail };
        }
        r = await deps.ops.dream(maybeOp);
      } else {
        const fn = opName === "approve" ? deps.ops?.approve : deps.ops?.reject;
        if (!fn) {
          moveAside(file, poolDir, "failed");
          const detail = deps.ops ? `不支持的操作：${opName}` : `操作未启用：${opName}（未注入处理器）`;
          report(false, detail);
          return { file, action: "invalid", detail };
        }
        r = await fn(String(maybeOp.id));
      }
      rmSync(file, { force: true });
      report(true, r.detail);
      return { file, action: "add", id: maybeOp.id, detail: r.detail };
    } catch (e) {
      moveAside(file, poolDir, "failed");
      const detail = `${opName} 失败：${(e as Error).message}`;
      log(`[memory] ${detail}`);
      report(false, detail);
      return { file, action: "error", detail };
    }
  }

  if (!v.ok) {
    moveAside(file, poolDir, "failed");
    return { file, action: "invalid", detail: v.reason };
  }

  // 用上下文判定（一次读池）；单条调用时现开一个（等价于原行为）
  const ctx = deps.ctx ?? openIngestCtx(poolDir);
  const decision = decideIngestIn(ctx, v.cand, similarity);
  if (decision.action === "drop") {
    log(`[memory] 丢弃（${decision.reason}）：${v.cand.text.slice(0, 40)}`);
    rmSync(file, { force: true });
    return { file, action: "drop", detail: decision.reason };
  }

  const entry: PoolEntry = decision.entry;
  // 索引是编译产物：失败只记日志，不影响真相源（下次 rebuild 会补上）
  if (deps.index) {
    try {
      await deps.index.upsert([entry]);
    } catch (e) {
      log(`[memory] 索引更新失败（不影响池文件）：${(e as Error).message}`);
    }
  }

  rmSync(file, { force: true });
  deps.onIngested?.(entry);
  if (decision.action === "bump") {
    log(`[memory] 判重累加 → 复现 ${entry.recurrence}：${entry.text.slice(0, 40)}`);
    return { file, action: "bump", id: entry.id };
  }
  log(`[memory] 已写入池：${entry.text.slice(0, 40)}（重要性 ${entry.importance}）`);
  return { file, action: "add", id: entry.id };
}

/**
 * 跨卷安全的移动。
 * ⚠️ 真事故：池在 C:、归档在 E:（不同卷）时 `renameSync` 直接抛 EXDEV。
 * Node 在 Windows 上不会自动降级成“复制 + 删除”，必须自己处理。
 */
export function moveFileSafe(src: string, dest: string): void {
  try {
    renameSync(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    copyFileSync(src, dest);
    if (!existsSync(dest)) throw new Error(`复制后目标不存在：${dest}`);
    rmSync(src, { force: true });
  }
}

function moveAside(file: string, poolDir: string, sub: string): void {
  try {
    // 统一收到 <池>/.failed/：不放在候选来的那个月目录里，否则失败件散落各处、很难找
    const dir = join(poolDir, `.${sub}`);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    moveFileSafe(file, join(dir, `${Date.now()}-${file.split(/[\\/]/).pop()}`));
  } catch {
    try {
      rmSync(file, { force: true });
    } catch {
      /* 实在处理不掉就留在原地，下次再试 */
    }
  }
}

/**
 * 认领一个待处理文件：改名成点号开头的 `.processing-…`。
 *
 * 为什么必须认领：摄入批处理每 2 秒跑一次，上一轮没结束（比如审批要写文件+更新索引）
 * 下一轮会**重叠**，两个 run 会同时读到同一个文件并各执行一遍。
 * 真事故：同一份 approve 请求被执行两次，ops.jsonl 里出现两条 ok 回执。
 * 改名后另一个 run 会把它当点号文件跳过（摄入只扫非点号 `*.json`）。
 * 返回 null 表示已被别人先认领（或文件已不存在）。
 */
function claimFile(file: string): string | null {
  const base = file.split(/[\\/]/).pop() || "";
  const dir = file.slice(0, file.length - base.length);
  const claimed = join(dir, `.processing-${process.pid}-${Date.now()}-${base}`);
  try {
    renameSync(file, claimed);
    return claimed;
  } catch {
    return null;
  }
}

/** 清掉被遗弃的认领文件（进程崩了会留下）；默认 10 分钟前的算遗弃。 */
export function sweepAbandonedClaims(dir: string, olderThanMs = 10 * 60 * 1000): number {
  let n = 0;
  const walk = (d: string): void => {
    let items: string[] = [];
    try {
      items = readdirSync(d);
    } catch {
      return;
    }
    for (const name of items) {
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      if (!name.startsWith(".processing-")) continue;
      if (Date.now() - st.mtimeMs < olderThanMs) continue;
      try {
        rmSync(p, { force: true });
        n++;
      } catch {
        /* 清不掉就算了 */
      }
    }
  };
  walk(dir);
  return n;
}

/** 扫描并摄入 inbox 里的全部候选。返回逐条结果（空则等于没变化）。
 *  ⚠️ 只看**非点号开头**的 `*.json`：inbox 里还住着扩展自己的内部状态
 *  （`.cursor-<key>.json` / `.pending-<key>.json`）。第一版把点号文件也当候选收了，
 *  结果扩展的抽取根本没机会跑、真候选一个也没落池（真事故，已加回归测试）。 */
export async function ingestMemoryInbox(inboxDir: string, deps: IngestDeps = {}): Promise<IngestOutcome[]> {
  if (!existsSync(inboxDir)) return [];
  // 先清掉被遗弃的认领文件（进程崩了会留下）——只动 10 分钟前的
  sweepAbandonedClaims(inboxDir);
  const files = readdirSync(inboxDir)
    .filter((f) => !f.startsWith(".") && f.endsWith(".json"))
    .map((f) => join(inboxDir, f));
  if (!files.length) return [];
  const out: IngestOutcome[] = [];
  // 同一批的索引写入攒起来一次 flush。
  // 为什么必须这样：zvec 每次 upsert 的开销是**按调用**计的（实测 20 条：
  // 逐条 250ms/条 = 5.0s，一次批量 11ms/条 = 0.22s，23× 差距）。
  const pending: PoolEntry[] = [];
  // 一次读池：整批共用上下文，避免逐条 listEntries（O(n²)，见 pool.ts 的 IngestCtx 注释）
  const ctx = deps.ctx ?? openIngestCtx(deps.poolDir ?? defaultPoolDir());
  const batchDeps: IngestDeps = {
    ...deps,
    ctx,
    index:
      deps.index && typeof deps.index.upsert === "function"
        ? {
            ...deps.index,
            upsert: async (entries: PoolEntry[]) => {
              pending.push(...entries);
            },
          }
        : deps.index,
  };
  try {
    for (const f of files) {
      // ⚠️ 先认领再处理：批处理每 2 秒一轮，上一轮没结束时下一轮会重叠，
      // 不认领会导致同一份请求被执行两次（真事故，见 claimFile 注释）
      const claimed = claimFile(f);
      if (!claimed) continue;
      const outcome = await ingestOne(claimed, batchDeps);
      out.push(outcome);
      // forget 会把条目移出池子。上下文里若留着旧副本，本轮后续候选可能把它"匹配"上
      // 并重新写回——那等于把已归档的记忆复活。罕见路径（同批 forget + 相似文本），
      // 但代价只有一次全池重读，故直接刷新（不做增量记账，少一处出错可能）。
      if (outcome.action === "forget") ctx.entries = listEntries(ctx.poolDir).entries;
    }
  } finally {
    if (pending.length && deps.index) {
      try {
        await deps.index.upsert(pending);
      } catch (e) {
        deps.log?.(`[memory] 批量索引写入失败（池文件已是真相源，下次 rebuild 会补）：${(e as Error).message}`);
      }
    }
  }
  return out;
}

/** 主进程启动时调一次：watch + 轮询兜底（与待办 inbox 同一模式）。 */
export function startMemoryInboxWatcher(opts: {
  inboxDir: string;
  poolDir?: string;
  onChanged?: (outcomes: IngestOutcome[]) => void;
  log?: (msg: string) => void;
  /** 索引由调用方管理（主进程可复用同一个 ZvecIndex 实例）。 */
  getIndex?: () => MemoryIndex | null | Promise<MemoryIndex | null>;
  /** 重活处理器（dream/审批）：转发给 ingestMemoryInbox */
  ops?: OpHandlers;
  /** 每写入一条后的回调（巩固记账） */
  onIngested?: (e: PoolEntry) => void;
}): () => void {
  const poolDir = opts.poolDir ?? defaultPoolDir();
  let inFlight = false;
  const run = async () => {
    // 单飞：上一轮没跑完就不要开下一轮（重活如审批会超过 2 秒的轮询间隔）
    if (inFlight) return;
    inFlight = true;
    try {
      const outcomes = await ingestMemoryInbox(opts.inboxDir, {
        poolDir,
        index: (await opts.getIndex?.()) ?? null,
        log: opts.log,
        ops: opts.ops,
        onIngested: opts.onIngested,
      });
      if (outcomes.length) opts.onChanged?.(outcomes);
    } catch (e) {
      opts.log?.(`[memory] inbox 摄入异常：${(e as Error).message}`);
    } finally {
      inFlight = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), 2000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** 兜底索引的便捷构造（主进程/CLI 共用）。 */
export function fallbackIndex(poolDir: string = defaultPoolDir()): MemoryIndex {
  const idx = new JsonIndex(poolDir);
  return idx;
}

export { THRESHOLD };
