/**
 * mem0 → 知芽池 迁移映射（P5-1）
 *
 * 设计原则（与 MEMORY-MODEL.md 一致）：
 *   1. **正文一字不改**——改写 = 引入幻觉。原始 payload 只做字段搬运与标签补充。
 *   2. **不假装有评分**：mem0 里没有 importance/relevance，迁移给的是**默认值并写明来源**，
 *      不冒充"当时判断"。
 *   3. **不自动晋升**：全部进池 `status=inbox`，晋级照旧要过 dream + 人工审批。
 *   4. **幂等**：每条带 `mem0:<uuid>` 证据；重跑跳过已导入（干跑也会读池子里已有的）。
 *   5. **只读**：本模块不写任何文件；写盘由调用方（迁移执行器）负责。
 *
 * 本文件不依赖 electron / zvec，可被 CLI 与测试直接使用。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { listEntries, type Candidate, type PoolType, type PoolTemporal } from "./pool";

/** 导出的一行（mem0 原始 payload + `_point_id`）。 */
export interface Mem0Record {
  /** mem0 的向量点 id（uuid）——用它做幂等键 */
  _point_id?: string;
  data?: string;
  created_at?: string;
  updated_at?: string;
  user_id?: string;
  agent_id?: string;
  role?: string;
  attributed_to?: string;
  migrated_from?: string;
  hash?: string;
  [k: string]: unknown;
}

/** 迁移分类结果。 */
export interface Classified {
  /** 规则名（进报告，便于对账） */
  rule: "insight" | "tool-quirk" | "correction" | "english-fact" | "dated-event" | "plain";
  type: PoolType;
  temporal: PoolTemporal;
  importance: number;
  /** 附加标签（保留来源线索） */
  tags: string[];
}

/** 高价值类的判定前缀（与方案 §0 的分类口径一致）。 */
const PREFIX_RULES: { re: RegExp; rule: Classified["rule"] }[] = [
  { re: /^\s*\[insight\]/i, rule: "insight" },
  { re: /^\s*\[tool-quirk\]/i, rule: "tool-quirk" },
  { re: /^\s*\[correction\]/i, rule: "correction" },
];

/** 中文字符占比（判断"英文为主"）。 */
export function zhRatio(text: string): number {
  const chars = [...text];
  if (!chars.length) return 0;
  let zh = 0;
  for (const ch of chars) if (ch >= "\u4e00" && ch <= "\u9fff") zh++;
  return zh / chars.length;
}

/** 是否"英文事实陈述"（mem0 里那批 `User's …` / `User …` 的自述）。 */
export function isEnglishFact(text: string): boolean {
  const t = text.trim();
  return /^User's\b/.test(t) || /^User\b/.test(t);
}

/** 是否"含日期的事件叙述"（episodic）：日期 + 动词性叙述。 */
export function looksEpisodic(text: string): boolean {
  return /\d{4}-\d{2}-\d{2}/.test(text) && /(实测|修复|发现|迁移|上线|发布|排查|结论|结果|完成)/.test(text);
}

/**
 * 分类（确定性规则，不用模型）。
 *
 * 注意 importance 给的是**迁移默认值**：
 *   - insight / tool-quirk / correction 是明确的高价值标签 → 7
 *   - 英文事实（长期有效的偏好/事实）→ 6
 *   - 其它 → 5（不低于池子的 minImportance=4，否则会被判 drop）
 */
export function classify(rec: Mem0Record): Classified {
  const text = String(rec.data ?? "");
  const tags: string[] = [];

  for (const { re, rule } of PREFIX_RULES) {
    if (re.test(text)) {
      tags.push(rule);
      // 前缀保留在正文里（正文一字不改），标签只是便于检索
      return {
        rule,
        type: rule === "tool-quirk" ? "procedural" : "semantic",
        temporal: rule === "tool-quirk" ? "present" : "retrospective",
        importance: 7,
        tags,
      };
    }
  }

  if (isEnglishFact(text)) {
    return { rule: "english-fact", type: "semantic", temporal: "retrospective", importance: 6, tags: ["english-fact"] };
  }

  if (looksEpisodic(text)) {
    return { rule: "dated-event", type: "episodic", temporal: "retrospective", importance: 5, tags: [] };
  }

  return { rule: "plain", type: "semantic", temporal: "retrospective", importance: 5, tags: [] };
}

/** 设备代号 → 可读标签（user_id 是本机/手机/平板/另一台的区分）。 */
export const DEVICE_LABEL: Record<string, string> = {
  wjj: "本机",
  "wjj-mb": "手机",
  "wjj-tb": "平板",
  "wjj-wjw": "另一台",
};

/** agent_id → 项目名（空 = 全局）。 */
export function projectOf(rec: Mem0Record): string {
  const a = rec.agent_id;
  return a && a !== "None" && a !== "null" ? String(a) : "global";
}

/** mem0 记录 → 池子候选（字段搬运 + 标签补充，正文不动）。 */
export function toCandidate(rec: Mem0Record): Candidate {
  const c = classify(rec);
  const text = String(rec.data ?? "").trim();
  const device = String(rec.user_id ?? "");
  const tags = [...c.tags];
  tags.push("from-mem0");
  if (DEVICE_LABEL[device]) tags.push(`origin:${DEVICE_LABEL[device]}`);
  if (rec.migrated_from) tags.push("from-pi-hermes");
  if (rec.role === "user" || rec.attributed_to === "user") tags.push("user-said");

  // evidence 是自由字符串数组：放幂等键与来源线索，便于日后追溯
  const evidence = [`mem0:${rec._point_id ?? ""}`];
  if (rec.migrated_from) evidence.push(`mem0-migrated-from:${String(rec.migrated_from)}`);
  if (rec.user_id) evidence.push(`mem0-user:${String(rec.user_id)}`);

  return {
    text,
    // 保留原始时间：面板按日期分组、时间衰减都依赖它（不给会全变成"迁移当天"）
    createdAt: rec.created_at ? String(rec.created_at) : undefined,
    type: c.type,
    temporal: c.temporal,
    // ⚠️ 迁移默认分，不是"当时的判断"（mem0 没有这两个字段）
    importance: c.importance,
    relevance: 0.7,
    project: projectOf(rec),
    projectRoot: undefined, // mem0 里没有项目根路径；晋升时走 kb 落点兜底链
    source: "mem0-migrate",
    tags,
    evidence,
  };
}

/** 幂等键（从 evidence 里取）。 */
export function idempotencyKey(rec: Mem0Record): string {
  return `mem0:${rec._point_id ?? ""}`;
}

// ---------------------------------------------------------------------------
// 范围筛选（用户的"只迁高价值类"决策）
// ---------------------------------------------------------------------------

export interface ScopeOptions {
  /**
   * 只迁高价值类（默认，= 方案 §0 的 102 条口径）：
   * `[insight]` / `[tool-quirk]` / `[correction]` / 英文事实陈述（`User's …`）。
   */
  highValueOnly?: boolean;
  /** 额外纳入"英文为主"的全部条目（这会从 73 扩到 263——口径不同，显式开启） */
  includeAllEnglish?: boolean;
  /** 额外纳入 `attributed_to=user` 的条目 */
  includeAttributed?: boolean;
}

/** 判定一条记录是否在迁移范围内。 */
export function inScope(rec: Mem0Record, opts: ScopeOptions = {}): boolean {
  const c = classify(rec);
  if (opts.highValueOnly === false) return true;
  if (c.rule === "insight" || c.rule === "tool-quirk" || c.rule === "correction") return true;
  if (c.rule === "english-fact") return true;
  if (opts.includeAllEnglish && zhRatio(String(rec.data ?? "")) < 0.05) return true;
  if (opts.includeAttributed && rec.attributed_to === "user") return true;
  return false;
}

// ---------------------------------------------------------------------------
// 计划（干跑报告的数据结构）
// ---------------------------------------------------------------------------

export interface SkippedItem {
  key: string;
  rule: string;
  reason:
    | "duplicate-in-mem0"
    | "duplicate-near"
    | "already-imported"
    | "exists-in-pool"
    | "exists-in-kb"
    | "empty-text";
  /** 命中目标的说明（哪条 id / 哪个文件） */
  detail: string;
}

export interface MigrationPlan {
  /** 范围内、去重后待写入的条目 */
  toWrite: { rec: Mem0Record; cand: Candidate }[];
  skipped: SkippedItem[];
  /** 统计（报告用） */
  stats: {
    total: number;
    inScope: number;
    byRule: Record<string, number>;
    byProject: Record<string, number>;
    byDevice: Record<string, number>;
    byMonth: Record<string, number>;
    duplicateInMem0: number;
    /** 近似重复（不是完全相同）被折叠掉的条数 */
    duplicateNear: number;
    /** mem0 内部重复被压成的复现次数 */
    recurrenceAdded: number;
    /** 范围外条目里的完全重复数（用于与勘察报告对账） */
    duplicateOutOfScope: number;
    /** **去重/筛选前**的全量形态分布（用来跟勘察报告 §0 对账） */
    byRuleRaw: Record<string, number>;
    /** 全量完全重复总数（勘察报告 §0 说 22） */
    duplicateRaw: number;
  };
  /** 范围外条目按规则统计（报告里说明"被排除的 770 条都是什么"） */
  outOfScope: { byRule: Record<string, number> };
}

const bump = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};

/** 收集池子里已导入的 mem0 幂等键（读 evidence）。 */
export function importedKeys(poolDir: string): Set<string> {
  const out = new Set<string>();
  const { entries } = listEntries(poolDir);
  for (const e of entries) {
    for (const ev of e.evidence ?? []) if (ev.startsWith("mem0:")) out.add(ev);
  }
  return out;
}

/** 收集知识库已存在的正文（lessons/*.md 正文 + frontmatter 里的 title/summary 之类只做粗比对）。 */
export function kbTexts(kbDir: string | null): { path: string; text: string }[] {
  if (!kbDir) return [];
  let names: string[] = [];
  try {
    names = readdirSync(kbDir);
  } catch {
    return [];
  }
  const out: { path: string; text: string }[] = [];
  for (const n of names) {
    if (!n.endsWith(".md")) continue;
    const p = join(kbDir, n);
    try {
      out.push({ path: p, text: readFileSync(p, "utf8") });
    } catch {
      /* 读不到就跳过 */
    }
  }
  return out;
}

/** 归一化（去空白/标点/小写），用于精确重复判定。 */
function norm(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

/**
 * 生成迁移计划（**纯计算，不写任何文件**）。
 * 去重三层：① mem0 内部完全重复 → 压成复现 ② 池子里已导入 → 跳过 ③ 与池内/KB 内容重复 → 跳过
 */
export function planMigration(
  recs: Mem0Record[],
  opts: {
    poolDir: string | null;
    kbDir?: string | null;
    scope?: ScopeOptions;
    /** 判重用（默认归一化后精确比较；可注入相似度以放宽） */
    similarity?: (a: string, b: string) => number;
    threshold?: number;
    /** 近似重复折叠阈值（默认与池子写入端一致 0.82）；设 1 即关闭折叠 */
    nearThreshold?: number;
  },
): MigrationPlan {
  const scope = opts.scope ?? { highValueOnly: true };
  const threshold = opts.threshold ?? 0.9;
  const sim = opts.similarity;
  // 折叠阈值与池子写入端一致：低于它的条目池子本来也不会判重，折叠它就没有依据
  const nearThreshold = opts.nearThreshold ?? 0.82;
  const similarityOf = sim ?? ((a: string, b: string) => (norm(a) === norm(b) ? 1 : 0));

  const already = opts.poolDir ? importedKeys(opts.poolDir) : new Set<string>();
  const poolEntries = opts.poolDir ? listEntries(opts.poolDir).entries : [];
  const poolNorm = new Set(poolEntries.map((e) => norm(e.text)));
  const kb = kbTexts(opts.kbDir ?? null).map((k) => ({ ...k, norm: norm(k.text) }));

  const plan: MigrationPlan = {
    toWrite: [],
    skipped: [],
    stats: {
      total: recs.length,
      inScope: 0,
      byRule: {},
      byProject: {},
      byDevice: {},
      byMonth: {},
      duplicateInMem0: 0,
      duplicateNear: 0,
      recurrenceAdded: 0,
      duplicateOutOfScope: 0,
      byRuleRaw: {},
      duplicateRaw: 0,
    },
    outOfScope: { byRule: {} },
  };

  // ---- 阶段 0：对账用的全量分布（未筛选未去重）--------------------------
  {
    const norms = new Set<string>();
    let dup = 0;
    for (const r of recs) {
      bump(plan.stats.byRuleRaw, classify(r).rule);
      const k = norm(String(r.data ?? ""));
      if (!k) continue;
      if (norms.has(k)) dup++;
      else norms.add(k);
    }
    plan.stats.duplicateRaw = dup;
  }

  // ---- 阶段 1：按"归一化正文"分组，处理完全相同（精确重复）---------------
  const byNorm = new Map<string, Mem0Record[]>();
  for (const r of recs) {
    const k = norm(String(r.data ?? ""));
    if (!k) {
      plan.skipped.push({ key: idempotencyKey(r), rule: classify(r).rule, reason: "empty-text", detail: "正文为空" });
      continue;
    }
    const list = byNorm.get(k);
    if (list) list.push(r);
    else byNorm.set(k, [r]);
  }

  /** 分组代表（精确重复组的头，按创建时间最早者） */
  interface Head {
    rec: Mem0Record;
    cand: Candidate;
    /** 精确重复被压掉的条数 */
    exactDups: number;
    /** 折叠进来的近似条目 key */
    absorbed: string[];
  }
  const heads: Head[] = [];
  for (const [, group] of byNorm) {
    group.sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
    const head = group[0];
    const c = classify(head);
    if (!inScope(head, scope)) {
      bump(plan.outOfScope.byRule, c.rule);
      plan.stats.duplicateOutOfScope += group.length - 1;
      continue;
    }
    plan.stats.inScope++;
    bump(plan.stats.byRule, c.rule);
    bump(plan.stats.byProject, projectOf(head));
    bump(plan.stats.byDevice, String(head.user_id ?? "(空)"));
    bump(plan.stats.byMonth, String(head.created_at ?? "").slice(0, 7) || "(无)");
    const extra = group.length - 1;
    if (extra > 0) {
      plan.stats.duplicateInMem0 += extra;
      plan.stats.recurrenceAdded += extra;
      for (const dup of group.slice(1)) {
        plan.skipped.push({
          key: idempotencyKey(dup),
          rule: c.rule,
          reason: "duplicate-in-mem0",
          detail: `与 ${idempotencyKey(head)} 正文相同（压成复现次数）`,
        });
      }
    }
    heads.push({ rec: head, cand: toCandidate(head), exactDups: extra, absorbed: [] });
  }

  // ---- 阶段 2：近似重复折叠（同一件事的多次记录，留**最长正文**=超集）------
  // 为什么必须折叠：池子的写入路径对近似条目是"累加复现、保留旧正文"，
  // 于是"后记的超集"会丢掉新增内容（真机抓到：一条 tool-quirk 的 `.retired-*`
  // 说明就是这样消失的）。迁移阶段先折叠，就保留了最全的那份。
  if (nearThreshold < 1) {
    for (let i = 0; i < heads.length; i++) {
      const cur = heads[i];
      if (cur.absorbed.includes("__dropped__")) continue;
      for (let j = 0; j < heads.length; j++) {
        if (i === j) continue;
        const other = heads[j];
        if (other.absorbed.includes("__dropped__")) continue;
        const s = similarityOf(cur.cand.text, other.cand.text);
        if (s < nearThreshold) continue;
        // 长的留下（超集），短的被吸收
        const [keep, drop] = cur.cand.text.length >= other.cand.text.length ? [cur, other] : [other, cur];
        drop.absorbed.push("__dropped__");
        keep.absorbed.push(idempotencyKey(drop.rec));
        plan.stats.duplicateNear++;
        plan.skipped.push({
          key: idempotencyKey(drop.rec),
          rule: classify(drop.rec).rule,
          reason: "duplicate-near",
          detail: `近似重复（${s.toFixed(2)}），已并入 ${idempotencyKey(keep.rec)}（保留较长正文）`,
        });
      }
    }
  }

  // ---- 阶段 3：逐条做"已导入 / 池内已有 / KB 已有"检查，产出待写列表 -------
  for (const h of heads) {
    if (h.absorbed.includes("__dropped__")) continue;
    const key = idempotencyKey(h.rec);
    const rule = classify(h.rec).rule;
    if (already.has(key)) {
      plan.skipped.push({ key, rule, reason: "already-imported", detail: "池子里已有此幂等键" });
      continue;
    }
    const n = norm(h.cand.text);
    if (poolNorm.has(n)) {
      const hit = poolEntries.find((p) => norm(p.text) === n);
      plan.skipped.push({ key, rule, reason: "exists-in-pool", detail: `池内已有同内容条目 ${hit?.id ?? ""}` });
      continue;
    }
    const kbHit = kb.find((k) => k.norm.includes(n) || (sim && sim(h.cand.text, k.text) > threshold));
    if (kbHit) {
      plan.skipped.push({ key, rule, reason: "exists-in-kb", detail: `知识库已有：${kbHit.path}` });
      continue;
    }
    const tags = [...(h.cand.tags ?? [])];
    if (h.exactDups > 0) tags.push(`mem0-dups:${h.exactDups}`);
    if (h.absorbed.length) tags.push(`mem0-near-dups:${h.absorbed.length}`);
    if (h.absorbed.length && h.cand.text.length > 0) tags.push("mem0-superset");
    h.cand.tags = tags;
    plan.toWrite.push({ rec: h.rec, cand: h.cand });
  }

  return plan;
}



// ---------------------------------------------------------------------------
// 回滚保障：manifest（写什么就记什么）+ 撤销
// ---------------------------------------------------------------------------

/** manifest 一行 = 本次写入的一条（回滚时不需要重新算幂等键）。 */
/** 换行与拆分用的常量（写成常量是为了避免转义在多层工具里被改写） */
const CH_NL = String.fromCharCode(10);
const CH_SPLIT_NL = new RegExp(String.fromCharCode(13) + "?" + String.fromCharCode(10));

export interface ManifestLine {
  /** 幂等键 mem0:<uuid> */
  key: string;
  /** 池内条目 id */
  entryId: string;
  /** 落盘绝对路径 */
  file: string;
  project: string;
  rule: string;
  /** 文件内容的 sha256（回滚时校验，避免删到"已经被改过的"文件还当没事） */
  sha256: string;
  /** 写入时间 */
  writtenAt: string;
}

/** 算文件内容哈希（不存在返回 null）。 */
export function fileHash(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/** 写 manifest（JSONL）——**写池子之前**先准备好，写完逐条追加。 */
export function writeManifest(path: string, lines: ManifestLine[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join(CH_NL) + (lines.length ? CH_NL : ""), "utf8");
}

/** 读 manifest（坏行跳过，不因一行坏了就整份不可用）。 */
export function readManifest(path: string): ManifestLine[] {
  const out: ManifestLine[] = [];
  for (const line of readFileSync(path, "utf8").split(CH_SPLIT_NL)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

/**
 * 按 manifest 回滚（删除本次写入的池内文件）。
 *
 * 安全设计：**默认只删哈希一致的文件**。若文件已被后续操作改动（比如复现次数被累加），
 * 说明它已不再是"我们刚写进去的那份"，默认跳过并报告，避免回滚误删别处的成果；
 * 确认要删就显式 force。
 */
export function rollbackMigration(
  manifestPath: string,
  opts: { force?: boolean; dryRun?: boolean } = {},
): { removed: string[]; missing: string[]; changed: string[] } {
  const removed: string[] = [];
  const missing: string[] = [];
  const changed: string[] = [];
  for (const line of readManifest(manifestPath)) {
    if (!existsSync(line.file)) {
      missing.push(line.file);
      continue;
    }
    const now = fileHash(line.file);
    if (now !== line.sha256 && !opts.force) {
      changed.push(line.file);
      continue;
    }
    if (!opts.dryRun) rmSync(line.file, { force: true });
    removed.push(line.file);
  }
  return { removed, missing, changed };
}
