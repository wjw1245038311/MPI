/**
 * 知芽记忆池（Zhiya memory pool）— 文件真相源层。
 *
 * 一条记忆 = 一个 Markdown 文件（frontmatter + 正文），目录即状态：
 *
 *   <poolDir>/inbox/YYYY-MM/<ulid>.md      待分诊
 *   <poolDir>/proposals/<ulid>.md          待审批的晋升提案（仅通用性教训）
 *   <poolDir>/.index.json                  兜底索引（可重建的编译产物）
 *
 * 设计约束（见 AgentSetting/zhiya/IMPL-PLAN.md）：
 *   - 本模块**纯文件 + 纯函数**：不依赖 electron、不依赖 zvec、不读全局配置
 *     （目录由调用方传入），所以可以被 MPI main、pi 扩展、CLI、测试共用。
 *   - **fail-closed 但不崩**：坏条目返回 warning 并跳过，绝不抛异常打断调用方
 *     （一条记忆坏了不该让整个池子不可用）。
 *   - 事实与推断分开：正文是"事实"，frontmatter 的评分字段是"写入时的判断"。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 内容类型（轴 A）。 */
export type PoolType = "semantic" | "episodic" | "procedural";
/** 时间指向（轴 B）。 */
export type PoolTemporal = "retrospective" | "present" | "prospective";
/** 状态。目录是权威，此字段冗余一份供检索过滤。 */
export type PoolStatus = "inbox" | "promoted" | "superseded" | "archived";

export interface PoolEntry {
  id: string;
  createdAt: string;
  type: PoolType;
  temporal: PoolTemporal;
  /** 写入时由本机模型打分，1-10（1=琐事，10=极重）。 */
  importance: number;
  /** 写入时与当前上下文的相似度，0-1。 */
  relevance: number;
  /** 复现计数：同一条经验重复出现时递增，≥3 触发晋升。 */
  recurrence: number;
  project: string;
  /**
   * 采集时的项目根目录（绝对路径）。
   * 为什么存在池里：晋升到项目知识库时要落 `<root>/.alexandria/knowledge/lessons/`，
   * 而 `project` 只是目录名（basename），无法反查路径。老条目没有这个字段 → null。
   */
  projectRoot: string | null;
  /** 来源，形如 session:<uuid>#<entryId>。 */
  source: string;
  status: PoolStatus;
  /** 晋升去向（相对路径或标识），未晋升为 null。 */
  promotedTo: string | null;
  tags: string[];
  /** 正文（不含 frontmatter，不含证据节）。 */
  text: string;
  /** 「## 证据」节下的行。 */
  evidence: string[];
  /** 复现记录（每次判重命中追加一行）。 */
  recurrences: string[];
  /** 解析时发现的问题（未知键、越界值等）；非空表示这条需要复核。 */
  warnings: string[];
  /** 文件绝对路径；未落盘时为 null。 */
  path: string | null;
}

/** 写入端的两维把关阈值（MEMORY-MODEL.md §2.2）。 */
export const THRESHOLD = {
  /** 重要性下限。 */
  minImportance: 4,
  /** 相关性下限：低于此判为无关，不写。 */
  minRelevance: 0.45,
  /** 相关性上限：高于此判为重复，不新增而是累加复现计数。 */
  dedupeRelevance: 0.82,
} as const;

/** 晋升触发次数（MEMORY-MODEL.md §5）。 */
export const PROMOTE_RECURRENCE = 3;

const TYPES: PoolType[] = ["semantic", "episodic", "procedural"];
const TEMPORALS: PoolTemporal[] = ["retrospective", "present", "prospective"];
const STATUSES: PoolStatus[] = ["inbox", "promoted", "superseded", "archived"];

// ---------------------------------------------------------------------------
// id 与时间
// ---------------------------------------------------------------------------

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 生成 ULID（26 字符，字典序=时间序，无需中心分配）。 */
export function newId(now: number = Date.now(), rand: () => number = Math.random): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = B32[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rnd = "";
  for (let i = 0; i < 16; i++) rnd += B32[Math.floor(rand() * 32)];
  return time + rnd;
}

/** ULID 前 10 字符解回毫秒时间戳（用于推导创建时间）。 */
export function idTimestamp(id: string): number | null {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return null;
  let t = 0;
  for (const ch of id.slice(0, 10)) t = t * 32 + B32.indexOf(ch);
  return t;
}

/** 本地时区 ISO（带偏移），便于人读；`Date.parse` 可正常解析。 */
export function nowIso(d: Date = new Date()): string {
  const p = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
  );
}

/** `YYYY-MM`（按年月分目录用）。 */
export function monthKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "0000-00";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// 序列化 / 解析（极简 YAML 子集：标量、null、字符串数组）
// ---------------------------------------------------------------------------

function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  // 需要引号的情形：含特殊字符、或看起来像数字/布尔/null
  if (s === "" || /^[\s]|[\s]$/.test(s) || /[:#\[\]{}",|>&*?%@`]/.test(s) || /^(true|false|null|\d+(\.\d+)?)$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

export function serializeEntry(e: PoolEntry): string {
  const fm: string[] = [
    "---",
    `id: ${yamlScalar(e.id)}`,
    `created_at: ${yamlScalar(e.createdAt)}`,
    `type: ${yamlScalar(e.type)}`,
    `temporal: ${yamlScalar(e.temporal)}`,
    `importance: ${e.importance}`,
    `relevance: ${e.relevance}`,
    `recurrence: ${e.recurrence}`,
    `project: ${yamlScalar(e.project)}`,
    `root: ${e.projectRoot ? yamlScalar(e.projectRoot) : "null"}`,
    `source: ${yamlScalar(e.source)}`,
    `status: ${yamlScalar(e.status)}`,
    `promoted_to: ${e.promotedTo === null ? "null" : yamlScalar(e.promotedTo)}`,
    `tags: [${e.tags.map(yamlScalar).join(", ")}]`,
    "---",
  ];
  const parts = [fm.join("\n"), "", e.text.trim()];
  if (e.recurrences.length) {
    parts.push("", "## 复现记录", ...e.recurrences.map((r) => `- ${r}`));
  }
  if (e.evidence.length) {
    parts.push("", "## 证据", ...e.evidence.map((r) => (r.startsWith("- ") ? r : `- ${r}`)));
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function parseScalar(raw: string): string | number | boolean | null {
  const s = raw.trim();
  if (s === "" || s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const body = s.slice(1, -1);
    if (s.startsWith('"')) {
      try {
        return JSON.parse(s) as string;
      } catch {
        return body;
      }
    }
    return body;
  }
  return s;
}

function parseArray(raw: string): string[] {
  const s = raw.trim();
  if (!s.startsWith("[") || !s.endsWith("]")) return [];
  const inner = s.slice(1, -1).trim();
  if (!inner) return [];
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ",") {
      out.push(String(parseScalar(cur) ?? ""));
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(String(parseScalar(cur) ?? ""));
  return out.filter((x) => x !== "");
}

const KNOWN_KEYS = new Set([
  "id", "created_at", "type", "temporal", "importance", "relevance",
  "recurrence", "project", "source", "status", "promoted_to", "tags", "root",
]);

export type ParseResult = { ok: true; entry: PoolEntry } | { ok: false; reason: string };

/**
 * 解析一个池条目的原始文本。**不抛异常**：任何结构问题返回 { ok:false }。
 * 字段值不合法只记 warning（fail-closed：不猜、但也不丢文件）。
 */
export function parseEntry(raw: string, path: string | null = null): ParseResult {
  const norm = raw.replace(/\r\n/g, "\n");
  const trimmed = norm.trimStart(); // 允许文件开头有空行
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(trimmed);
  if (!m) return { ok: false, reason: "缺少 frontmatter（文件必须以 --- 开头）" };

  const warnings: string[] = [];
  const fields: Record<string, string | number | boolean | string[] | null> = {};
  for (const line of m[1].split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    // 键名允许非 ASCII（中文键名要能进“未知字段”分支，而不是被当成无法解析）
    const kv = /^([^:\s][^:]*?)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      warnings.push(`无法解析的 frontmatter 行：${line.slice(0, 40)}`);
      continue;
    }
    const key = kv[1];
    const val = kv[2];
    if (!KNOWN_KEYS.has(key)) warnings.push(`未知字段：${key}`);
    fields[key] = key === "tags" ? parseArray(val) : parseScalar(val);
  }

  // 正文：剥离 HTML 注释（它们是给人看的作者备注，不是内容，与 zhiya.ts 注入时的处理一致）
  const body = trimmed.slice(m[0].length).replace(/<!--[\s\S]*?-->/g, "");
  const str = (k: string): string => (fields[k] === null || fields[k] === undefined ? "" : String(fields[k]));

  const id = str("id") || (path ? (/[0-9A-HJKMNP-TV-Z]{26}/.exec(path)?.[0] ?? "") : "");
  if (!id) return { ok: false, reason: "缺少 id（且无法从文件名推导）" };

  const type = str("type") as PoolType;
  if (!TYPES.includes(type)) warnings.push(`type 取值非法：${str("type") || "(空)"}`);
  const temporal = str("temporal") as PoolTemporal;
  if (!TEMPORALS.includes(temporal)) warnings.push(`temporal 取值非法：${str("temporal") || "(空)"}`);
  const status = str("status") as PoolStatus;
  if (!STATUSES.includes(status)) warnings.push(`status 取值非法：${str("status") || "(空)"}`);

  const importance = Number(fields.importance ?? 0);
  if (!Number.isFinite(importance) || importance < 1 || importance > 10) {
    warnings.push(`importance 越界：${str("importance") || "(空)"}（应为 1-10）`);
  }
  const relevance = Number(fields.relevance ?? 0);
  if (!Number.isFinite(relevance) || relevance < 0 || relevance > 1) {
    warnings.push(`relevance 越界：${str("relevance") || "(空)"}（应为 0-1）`);
  }
  const recurrence = Number(fields.recurrence ?? 1);
  if (!Number.isFinite(recurrence) || recurrence < 1) warnings.push(`recurrence 非法：${str("recurrence")}`);

  // 正文与两个可选节
  const evidenceIdx = body.search(/^## 证据\s*$/m);
  const recurIdx = body.search(/^## 复现记录\s*$/m);
  let textPart = body;
  let evidence: string[] = [];
  let recurrences: string[] = [];
  const cut = [evidenceIdx, recurIdx].filter((i) => i >= 0).sort((a, b) => a - b);
  if (cut.length) textPart = body.slice(0, cut[0]);

  const section = (name: string): string[] => {
    const re = new RegExp(`^## ${name}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, "m");
    const s = re.exec(body);
    if (!s) return [];
    return s[1]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("<!--"))
      .map((l) => (l.startsWith("- ") ? l.slice(2).trim() : l));
  };
  evidence = section("证据");
  recurrences = section("复现记录");

  const createdAt = str("created_at") || (idTimestamp(id) ? new Date(idTimestamp(id)!).toISOString() : "");
  if (!createdAt) warnings.push("缺少 created_at（且无法从 id 推导）");

  const entry: PoolEntry = {
    id,
    createdAt,
    type: TYPES.includes(type) ? type : "semantic",
    temporal: TEMPORALS.includes(temporal) ? temporal : "retrospective",
    importance: Number.isFinite(importance) ? importance : 0,
    relevance: Number.isFinite(relevance) ? relevance : 0,
    recurrence: Number.isFinite(recurrence) && recurrence >= 1 ? Math.floor(recurrence) : 1,
    project: str("project") || "global",
    source: str("source"),
    status: STATUSES.includes(status) ? status : "inbox",
    promotedTo: fields.promoted_to === null || fields.promoted_to === undefined ? null : String(fields.promoted_to),
    projectRoot:
      fields.root === null || fields.root === undefined || String(fields.root).trim() === ""
        ? null
        : String(fields.root),
    tags: Array.isArray(fields.tags) ? (fields.tags as string[]) : [],
    text: textPart.trim(),
    evidence,
    recurrences,
    warnings: warnings.filter((w) => !w.startsWith("status 取值非法")),
    path,
  };
  if (!entry.text) return { ok: false, reason: "正文为空" };
  return { ok: true, entry };
}

// ---------------------------------------------------------------------------
// 目录
// ---------------------------------------------------------------------------

export function ensurePool(poolDir: string): void {
  for (const d of [poolDir, join(poolDir, "inbox")]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

/** 条目应落的路径（按年月分目录）。 */
/**
 * 条目的落盘路径。
 * ⚠️ 只有 inbox 一种：`proposals/` 是 dream 提案的地盘（另一种格式）。
 * 曾经有过"把条目搬到 proposals/"的设计——那会让条目从 listEntries 里**静默消失**，
 * 已废弃（条目晋升后仍留在 inbox/，靠 status 区分）。
 */
export function entryPath(poolDir: string, createdAt: string, id: string): string {
  return join(poolDir, "inbox", monthKey(createdAt), `${id}.md`);
}

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue; // 竞态：文件刚好被删
    }
    if (st.isDirectory()) walkFiles(p, out);
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

export interface ListResult {
  entries: PoolEntry[];
  /** 坏文件清单（解析失败）；不打断列表。 */
  broken: { path: string; reason: string }[];
}

/**
 * 列出池内全部条目。
 * ⚠️ **只扫 inbox/**：`proposals/` 里放的是 dream 提案（另一种格式：kind/outlet/entries…），
 * 扫进来会被当成记忆条目（真事故：分诊时条目数翻倍、提案本身被当成记忆再次分诊）。
 * 已晋升的条目仍留在 inbox/（用 status 区分），不回搬到别的目录。
 */
export function listEntries(poolDir: string): ListResult {
  const entries: PoolEntry[] = [];
  const broken: { path: string; reason: string }[] = [];
  {
    for (const p of walkFiles(join(poolDir, "inbox"))) {
      let raw: string;
      try {
        raw = readFileSync(p, "utf8");
      } catch (e) {
        broken.push({ path: p, reason: `读失败：${(e as Error).message}` });
        continue;
      }
      const r = parseEntry(raw, p);
      if (r.ok) entries.push(r.entry);
      else broken.push({ path: p, reason: r.reason });
    }
  }
  entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return { entries, broken };
}

/** 写入一条（原子：先写临时名再 rename）。返回落盘路径。 */
export function writeEntry(poolDir: string, e: PoolEntry): string {
  ensurePool(poolDir);
  const dest = entryPath(poolDir, e.createdAt, e.id);
  const dir = join(dest, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  const content = serializeEntry(e);
  writeFileSync(tmp, content, "utf8");
  atomicReplace(tmp, dest, content);
  e.path = dest;
  return dest;
}

/** 重命名函数（可注入，便于测试错误分支）。 */
type Renamer = (tmp: string, dest: string) => void;

/** 同步小睡（本模块是同步 API，不能用 await）。 */
function sleepSync(ms: number): void {
  // Atomics.wait 在非 worker 线程上等待共享内存是允许的
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 目标文件是否已经就是我们要写的内容（用于识别 Windows 的「假失败」）。 */
function destAlreadyWritten(dest: string, content: string): boolean {
  try {
    if (!existsSync(dest)) return false;
    const st = statSync(dest);
    if (!st.isFile() || st.size !== Buffer.byteLength(content, "utf8")) return false;
    return readFileSync(dest, "utf8") === content;
  } catch {
    return false;
  }
}

/**
 * 原子替换（临时文件 → 目标），并容错 **Windows 的「假失败」**。
 *
 * 实测（2026-09-20 真机，800 次原子写）：约 **1.9%（15/800）** 的 `renameSync` 抛
 * `EPERM: operation not permitted`，**但重命名其实已经生效**——目标文件存在且内容
 * 完整（同一 id、字节数一致）。成因是杀软/搜索索引器短暂持有句柄的竞态：
 * 操作生效，错误照报。
 *
 * 为什么不能盲目重试：第二次 rename 会因目标已存在而继续报错，最终把**已经写好**的
 * 条目当失败——迁移会报「N 条失败」而实际全部成功，上层还可能触发多余的清理/回滚。
 *
 * 正确做法：出错后**先校验目标文件内容是否与待写内容一致**（内容含 id，一致即同一条），
 * 一致 → 判定成功（并清掉临时文件）；不一致 → 有限重试（退避），仍失败才抛。
 */
export function atomicReplace(tmp: string, dest: string, content: string, rename: Renamer = renameSync, attempts = 3): void {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      rename(tmp, dest);
      return;
    } catch (e) {
      lastErr = e;
      if (destAlreadyWritten(dest, content)) {
        rmSync(tmp, { force: true });
        return;
      }
      if (i < attempts - 1) sleepSync(20 * (i + 1));
    }
  }
  rmSync(tmp, { force: true });
  throw new Error(`原子写失败（已尝试 ${attempts} 次）：${(lastErr as Error)?.message || lastErr}`);
}

// ---------------------------------------------------------------------------
// 写入端编排（阈值 → 判重 → 落盘）
// ---------------------------------------------------------------------------

export interface Candidate {
  text: string;
  type: PoolType;
  temporal: PoolTemporal;
  importance: number;
  relevance: number;
  project?: string;
  /** 采集时的项目根目录（绝对路径），用于晋升时定位项目知识库。 */
  projectRoot?: string;
  source?: string;
  tags?: string[];
  evidence?: string[];
  /** 打分是否失败（fail-open：失败时按默认 5 分写入并标 needs_review）。 */
  scoringFailed?: boolean;
}

export type IngestDecision =
  | { action: "drop"; reason: string }
  | { action: "add"; entry: PoolEntry }
  | { action: "bump"; entry: PoolEntry; matchedId: string };

/**
 * 写入端决策（纯函数，便于测试与 A/B）：
 *   1) 两维门槛：重要性 <4 或 相关性 <0.45 → drop
 *   2) 判重：与已有条目相似度 >0.82 → 不新增，累加复现计数
 *   3) 否则新增
 * `similarity` 由调用方注入（索引层或兜底子串匹配），使本函数不依赖任何引擎。
 */
/**
 * 一批摄入的共享上下文：**一次读池**，后续判定全在内存里做。
 *
 * 为什么必须这样：`decideIngest` 原本每次调用都 `listEntries()`（读全池 + 解析所有文件），
 * 于是逐条摄入是 O(n²)。实测成本曲线（合成语料，池内 N 条时**单次**写入耗时）：
 *   0→100 条 18.7ms/条 ｜ 100→300 条 68.9ms/条 ｜ 300→600 条 153.5ms/条
 * 也就是说：池子涨到 872 条时每记一条记忆要多花 ~140ms；迁移 872 条光写入约 2 分钟。
 * 用上下文后读盘只发生一次（900 条全池扫描解析实测 272ms）。
 */
export interface IngestCtx {
  poolDir: string;
  /** 池内已有条目（内存副本）；本批新增/累加的条目会同步进来，**批内也能相互判重**。 */
  entries: PoolEntry[];
  /** 本批新增的条目（调用方拿去批量更新索引）。 */
  added: PoolEntry[];
  /** 本批判重累加的条目（同上）。 */
  bumped: PoolEntry[];
}

/** 开一个摄入上下文（读一次池）。 */
export function openIngestCtx(poolDir: string): IngestCtx {
  return { poolDir, entries: listEntries(poolDir).entries, added: [], bumped: [] };
}

/** 在本上下文里做一次写入判定（不读盘）。 */
export function decideIngestIn(
  ctx: IngestCtx,
  cand: Candidate,
  similarity: (a: string, b: string) => number,
  now: number = Date.now(),
): IngestDecision {
  const decision = decideAgainst(ctx.entries, ctx.poolDir, cand, similarity, now);
  if (decision.action === "add") {
    ctx.entries.push(decision.entry);
    ctx.added.push(decision.entry);
  } else if (decision.action === "bump") {
    // 累加过的条目已在 ctx.entries 里（同一对象引用，就地改了 recurrence）
    ctx.bumped.push(decision.entry);
  }
  return decision;
}

/**
 * 批量摄入：一次读池 → 逐条判定（内存）→ 落盘 → 返回分组结果。
 * 迁移/补号这类“一次上百条”的场景走这条，别逐条调 `decideIngest`。
 */
export function ingestBatch(
  poolDir: string,
  cands: Candidate[],
  similarity?: (a: string, b: string) => number,
  now: number = Date.now(),
): { ctx: IngestCtx; results: IngestDecision[] } {
  const ctx = openIngestCtx(poolDir);
  // 默认用带缓存的相似度器：同一批已有条目会被反复比较，缓存归一化/二元组后快得多
  const sim = similarity || makeSimilarity();
  const results = cands.map((c) => decideIngestIn(ctx, c, sim, now));
  return { ctx, results };
}

/** 内层判定（不碰 ctx 的记账，方便单测对比“批量 = 逐条”）。 */
function decideAgainst(
  entries: PoolEntry[],
  poolDir: string,
  cand: Candidate,
  similarity: (a: string, b: string) => number,
  now: number,
): IngestDecision {
  if (!cand.scoringFailed) {
    if (cand.importance < THRESHOLD.minImportance) {
      return { action: "drop", reason: `重要性 ${cand.importance} < ${THRESHOLD.minImportance}` };
    }
    if (cand.relevance < THRESHOLD.minRelevance) {
      return { action: "drop", reason: `相关性 ${cand.relevance} < ${THRESHOLD.minRelevance}` };
    }
  }

  let best: { e: PoolEntry; s: number } | null = null;
  for (const e of entries) {
    if (e.status !== "inbox") continue;
    const s = similarity(cand.text, e.text);
    if (!best || s > best.s) best = { e, s };
  }
  if (best && best.s > THRESHOLD.dedupeRelevance) {
    const e = best.e;
    e.recurrence += 1;
    e.recurrences.push(`${nowIso(new Date(now))}（相似度 ${best.s.toFixed(3)}，来源 ${cand.source || "未标注"}）`);
    if (e.path) writeEntry(poolDir, e);
    return { action: "bump", entry: e, matchedId: e.id };
  }

  const id = newId(now);
  const entry: PoolEntry = {
    id,
    createdAt: nowIso(new Date(now)),
    type: cand.type,
    temporal: cand.temporal,
    importance: cand.importance,
    relevance: cand.relevance,
    recurrence: 1,
    project: cand.project || "global",
    projectRoot: cand.projectRoot ? cand.projectRoot : null,
    source: cand.source || "",
    status: "inbox",
    promotedTo: null,
    tags: cand.tags || [],
    text: cand.text.trim(),
    evidence: cand.evidence || [],
    recurrences: [],
    warnings: cand.scoringFailed ? ["scoring-failed：评分失败，按默认分写入，需人工复核"] : [],
    path: null,
  };
  writeEntry(poolDir, entry);
  return { action: "add", entry };
}

/**
 * 单条摄入（向后兼容入口）。
 * ⚠️ 它会**读全池**（O(n)）——一次要处理多条时改用 `ingestBatch`/`IngestCtx`，
 * 否则整批就是 O(n²)（实测：池内 300→600 条时单次写入 153.5ms）。
 */
export function decideIngest(
  poolDir: string,
  cand: Candidate,
  similarity: (a: string, b: string) => number,
  now: number = Date.now(),
): IngestDecision {
  return decideAgainst(listEntries(poolDir).entries, poolDir, cand, similarity, now);
}

/**
 * 带缓存的相似度器。
 *
 * 批量摄入时同一条已存条目会被每个新候选比较一次（N×M 次），而 `lexicalSimilarity`
 * 每次都要重新归一化 + 重建二元组集合。缓存后既存条的归一化/二元组只算一次。
 * 结果与 `lexicalSimilarity` **逐位一致**（有断言钉住），只是更快。
 */
export function makeSimilarity(limit = 4096): (a: string, b: string) => number {
  const cache = new Map<string, Set<string>>();
  const gramsFor = (s: string): Set<string> => {
    const hit = cache.get(s);
    if (hit) return hit;
    const g = charGrams(normalize(s));
    if (cache.size >= limit) {
      // 简单 FIFO 淘汰（Map 保持插入序）——不要为了这个引入 LRU 复杂度
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(s, g);
    return g;
  };
  return (a, b) => similarityFromGrams(gramsFor(a), gramsFor(b), normalize(a).length, normalize(b).length);
}

/** 是否该晋升：复现次数达标。 */
export function shouldPromote(e: PoolEntry): boolean {
  return e.status === "inbox" && e.recurrence >= PROMOTE_RECURRENCE;
}

/** 晋升去向：项目内教训直接进 KB lessons（自动，git diff 供审）；通用性进提案等你批。 */
export function promoteTarget(e: PoolEntry): "kb-lessons" | "proposal" {
  return e.project && e.project !== "global" ? "kb-lessons" : "proposal";
}

// ---------------------------------------------------------------------------
// 兜底相似度（无索引时用；中文按字符二元组 + token 命中率）
// ---------------------------------------------------------------------------

/** 归一化：去空白与标点，转小写。 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

/**
 * 轻量相似度（0-1）：字符二元组 Jaccard 与最长公共子串占比的加权。
 * 不做语义，只用于"同一句话是否被重复记录"这种近乎字面重复的判断；
 * 语义判重交给索引层（向量），本函数是它的兜底实现。
 */
export function lexicalSimilarity(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  return similarityFromGrams(charGrams(x), charGrams(y), x.length, y.length);
}

/** 字符二元组集合。 */
function charGrams(s: string): Set<string> {
  const out = new Set<string>();
  if (!s) return out;
  if (s.length === 1) out.add(s);
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** 相似度核心：二元组 Jaccard × 长度比修正（`lexicalSimilarity` 与缓存版共用）。 */
function similarityFromGrams(gx: Set<string>, gy: Set<string>, lx: number, ly: number): number {
  if (!lx || !ly) return 0;
  if (lx === ly && gx.size === gy.size) {
    let same = true;
    for (const g of gx) {
      if (!gy.has(g)) {
        same = false;
        break;
      }
    }
    if (same) return 1;
  }
  let inter = 0;
  for (const g of gx) if (gy.has(g)) inter++;
  const jaccard = inter / (gx.size + gy.size - inter);
  // 短串（<6 字）时 Jaccard 容易虚高，用长度比压一下
  const lenRatio = Math.min(lx, ly) / Math.max(lx, ly);
  return jaccard * (lenRatio < 0.5 ? lenRatio : 1);
}

/** 相对路径显示（日志/CLI 用）。 */
export function relPath(from: string, to: string): string {
  return relative(from, to).replace(/\\/g, "/");
}

/**
 * 检索相关性（非对称）：查词在文档里的**覆盖率**，不做长度惩罚。
 *
 * 与 `lexicalSimilarity` 的区别很重要：
 *   - `lexicalSimilarity` 用于**判重**（对称：“这两条是同一件事吗”），长文本 vs 短文本要被压低；
 *   - `queryRelevance` 用于**检索**（非对称：“这条里有没有我要找的东西”），短查询命中长文档是常态，
 *     再加长度惩罚就会把正确答案压到无关条目下面（旧实现真踩过：查「调用图」把带 importance 高的无关条目排第一）。
 * 不是语义匹配；语义召回交给索引层（zvec）。
 */
export function queryRelevance(query: string, doc: string): number {
  const q = normalize(query);
  const d = normalize(doc);
  if (!q || !d) return 0;
  if (d.includes(q)) return 1; // 整串命中，直接满分
  const grams = (s: string): string[] => {
    if (s.length === 1) return [s];
    const out: string[] = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  };
  const dg = new Set(grams(d));
  const qg = grams(q);
  let hit = 0;
  for (const g of qg) if (dg.has(g)) hit++;
  const coverage = hit / qg.length;
  // 单词查询（如「索引」）二元组信息量少，退回单字存在性
  if (q.length === 1) return d.includes(q) ? 1 : 0;
  return coverage;
}
