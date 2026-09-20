#!/usr/bin/env node
/**
 * 记忆池 CLI（P0 的验收入口；UI 留 P4）
 *
 *   npm run memory:list                 # 列出池内条目
 *   npm run memory:add -- "文本"        # 写入一条（走阈值 + 判重 + 复现计数）
 *   npm run memory:recall -- "查询词"   # 检索（默认 JsonIndex；--index zvec 用 zvec）
 *   npm run memory:reindex              # 从文件真相源重建索引
 *   npm run memory:optimize             # 压缩索引碎片（zvec 不会自动合并）
 *   npm run memory:dream [--dry]        # 跑一次周期分诊（产出晋升/归档提案）
 *   npm run memory:proposals            # 看提案列表
 *   npm run memory:approve -- <id后缀>   # 批准并落地（写 lesson / 归档）
 *   npm run memory:reject  -- <id后缀>   # 拒绝（留痕）
 *   npm run memory:show -- <id>         # 看单条原文
 *
 * 环境变量：MPI_ZHIYA_POOL_DIR 覆盖池目录（测试/多实例用）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

// 源码用 bundler 风格的无扩展名相对导入，直接跑要给它补 .ts
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const { defaultPoolDir, JsonIndex } = await import("../src/main/zhiya/memory-index.ts");
const { listProposals, setProposalStatus } = await import("../src/main/zhiya/proposals.ts");
const { applyProposal } = await import("../src/main/memory-promote.ts");
const { defaultMemoryModel, resolveMemoryModelFrom } = await import("../src/main/memory-model.ts");
const { runDream } = await import("../src/main/memory-dream.ts");
const { markConsolidated } = await import("../src/main/zhiya/consolidation.ts");
const { archiveDirFor } = await import("../src/main/memory-inbox.ts");
const KIND_LABEL = {
  "promote-kb": "→ 知识库 lessons",
  "promote-inject": "→ 常驻注入",
  "promote-now": "→ 当前任务",
  archive: "→ 归档",
};
const {
  decideIngest, ensurePool, lexicalSimilarity, listEntries, promoteTarget, shouldPromote,
  THRESHOLD, PROMOTE_RECURRENCE,
} = await import("../src/main/zhiya/pool.ts");
// 归档走**面板同一条执行路径**（跨卷安全移动 + 索引移除），不自己 rm 文件
const { archiveEntryFromPanel, resolveLessonsDirFor } = await import("../src/main/memory-panel.ts");

const args = process.argv.slice(2);
const cmd = args[0];

/** 极简 flag 解析：--k v / --flag。 */
function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const f = flags(args.slice(1));
const poolDir = defaultPoolDir();

const NL = String.fromCharCode(10);
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

function cmdList() {
  const { entries, broken } = listEntries(poolDir);
  const limit = Number(f.limit || 20);
  if (f.json) {
    console.log(JSON.stringify({ poolDir, entries, broken }, null, 1));
    return;
  }
  console.log(`${bold("池目录")} ${poolDir}`);
  console.log(`${bold(`共 ${entries.length} 条`)}${broken.length ? `（坏文件 ${broken.length}）` : ""}`);
  for (const e of entries.slice(0, limit)) {
    const tags = [e.type, e.temporal, `重要性${e.importance}`, `复现${e.recurrence}`, e.project].join(" · ");
    const flag = shouldPromote(e) ? " ⬆可晋升" : "";
    const warn = e.warnings.length ? ` ⚠${e.warnings.length}` : "";
    console.log(`  ${dim(e.id.slice(0, 8))} ${e.text.slice(0, 54)}${e.text.length > 54 ? "…" : ""}`);
    console.log(`           ${dim(tags)}${flag}${warn}`);
  }
  if (entries.length > limit) console.log(dim(`  …还有 ${entries.length - limit} 条（--limit 调整）`));
  for (const b of broken) console.log(`  ⚠ 坏文件 ${b.path}\n     ${b.reason}`);
  const promotable = entries.filter(shouldPromote);
  if (promotable.length) {
    console.log(`\n${bold("待晋升（复现 ≥" + PROMOTE_RECURRENCE + "）")}`);
    for (const e of promotable) console.log(`  ${e.id.slice(0, 8)} → ${promoteTarget(e) === "kb-lessons" ? "项目 KB lessons" : "提案（等你批）"}  ${e.text.slice(0, 40)}`);
  }
}

function cmdAdd() {
  const text = (f._ || []).join(" ").trim() || (typeof f.text === "string" ? f.text : "");
  if (!text) {
    console.error("用法：npm run memory:add -- \"要记住的内容\" [--importance 6] [--relevance 0.7] [--type semantic|episodic|procedural] [--temporal retrospective|present|prospective] [--project MPI] [--source session:x#1] [--evidence \"...\"]");
    process.exit(2);
  }
  ensurePool(poolDir);
  const evidence = f.evidence ? (Array.isArray(f.evidence) ? f.evidence : [f.evidence]) : [];
  const cand = {
    text,
    type: typeof f.type === "string" ? f.type : "semantic",
    temporal: typeof f.temporal === "string" ? f.temporal : "retrospective",
    // P0：没有 embedding 打分，评分由调用方给；P1 起由扩展用本机模型算
    importance: Number(f.importance ?? 6),
    relevance: Number(f.relevance ?? 0.7),
    project: typeof f.project === "string" ? f.project : "global",
    source: typeof f.source === "string" ? f.source : "cli",
    tags: [],
    evidence,
  };
  const d = decideIngest(poolDir, cand, lexicalSimilarity);
  if (d.action === "drop") {
    console.log(`✗ 未写入：${d.reason}（阈值：重要性 ≥${THRESHOLD.minImportance}、相关性 ≥${THRESHOLD.minRelevance}）`);
    process.exit(1);
  }
  if (d.action === "bump") {
    console.log(`↻ 判为重复（相似度 >${THRESHOLD.dedupeRelevance}）→ 复现计数 ${d.entry.recurrence}/${PROMOTE_RECURRENCE}`);
    console.log(`  ${dim(d.entry.path)}`);
    // 同步索引
    const idx = new JsonIndex(poolDir);
    idx.upsert([d.entry]).then(() => console.log(dim("  索引已更新")));
    return;
  }
  console.log(`✓ 已写入 ${dim(d.entry.path)}`);
  const idx = new JsonIndex(poolDir);
  idx.upsert([d.entry]).then(() => console.log(dim("  索引已更新")));
}

async function cmdRecall() {
  const text = (f._ || []).join(" ").trim();
  const topK = Number(f.topk || 5);
  const filter = {};
  if (typeof f.project === "string") filter.project = f.project;
  if (typeof f.status === "string") filter.status = [f.status];
  if (typeof f.type === "string") filter.type = f.type;
  const which = typeof f.index === "string" ? f.index : "json";
  const idx = which === "zvec" ? await makeZvec() : new JsonIndex(poolDir);
  const hits = await idx.recall({ text, topK, filter });
  const label = text || "(空：按时间/重要性排序)";
  console.log(bold(`检索：${label}`) + `　索引=${which}`);
  const { entries } = listEntries(poolDir);
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const h of hits) {
    const e = byId.get(h.id);
    console.log(`  ${h.score.toFixed(3)}  ${e ? e.text.slice(0, 56) : h.id}`);
    console.log(`         ${dim(`recency ${h.parts.recency.toFixed(2)} · relevance ${h.parts.relevance.toFixed(2)} · importance ${h.parts.importance.toFixed(2)}`)}`);
  }
  if (!hits.length) console.log(dim("  （无命中）"));
}

async function makeZvec() {
  const p = new URL("../src/main/zhiya/zvec-index.ts", import.meta.url);
  if (!existsSync(p)) {
    console.error("zvec 索引尚未实现（P0-2b）→ 回退 JsonIndex");
    return new JsonIndex(poolDir);
  }
  try {
    const { ZvecIndex } = await import("../src/main/zhiya/zvec-index.ts");
    return await ZvecIndex.open(poolDir);
  } catch (e) {
    console.error(`zvec 不可用（${e.message.split("\n")[0]}）→ 回退 JsonIndex`);
    return new JsonIndex(poolDir);
  }
}

async function cmdReindex() {
  const which = typeof f.index === "string" ? f.index : "json";
  const idx = which === "zvec" ? await makeZvec() : new JsonIndex(poolDir);
  await idx.rebuild(poolDir);
  const { entries, broken } = listEntries(poolDir);
  console.log(`✓ 索引已重建（${which}）：${entries.length} 条${broken.length ? `，跳过坏文件 ${broken.length}` : ""}`);
  await idx.close();
}

function cmdShow() {
  const id = (f._ || [])[0];
  if (!id) { console.error("用法：npm run memory:show -- <id 前缀>"); process.exit(2); }
  const { entries } = listEntries(poolDir);
  const e = entries.find((x) => x.id.startsWith(id));
  if (!e) { console.error(`没找到 ${id}`); process.exit(1); }
  console.log(readFileSync(e.path, "utf8"));
}

/** 压缩：zvec 每次写入落一个 5MB 段文件且不会自动合并，不压就会持续膨胀。 */
async function cmdOptimize() {
  const root = join(poolDir, ".zvec");
  const size = (d) => {
    let s = 0;
    for (const it of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, it.name);
      s += it.isDirectory() ? size(p) : statSync(p).size;
    }
    return s;
  };
  const before = size(root);
  const idx = await makeZvec();
  const t0 = Date.now();
  await idx.compact();
  await idx.close();
  const after = size(root);
  console.log(
    `✓ 已压缩：${(before / 1048576).toFixed(1)}MB → ${(after / 1048576).toFixed(1)}MB（${Date.now() - t0}ms）`,
  );
}

/**
 * 归档一条记忆（归档 ≠ 删除）。
 *
 * 设计取舍：
 *   - **前缀歧义不猜**：前缀匹配到多条就列出来让人挑，绝不批量误归档（--all 才全归）。
 *   - 默认**先看清楚再动手**：打印命中的正文摘要；--dry 只预览不落盘。
 *   - 与面板「归档」/扩展 /memory-forget 同一执行路径（archiveEntryFromPanel）。
 */
async function cmdForget() {
  const needle = (f._ || [])[0];
  if (!needle) {
    console.error("用法：npm run memory:forget -- <id 前缀或正文关键词> [--dry] [--all]");
    process.exit(2);
  }
  const { entries } = listEntries(poolDir);
  const byId = entries.filter((e) => e.id.startsWith(needle) || e.id.endsWith(needle));
  const byText = entries.filter((e) => !byId.includes(e) && e.text.includes(needle));
  const hit = byId.length ? byId : byText;
  if (!hit.length) {
    console.error(`没找到匹配「${needle}」的条目（可用 npm run memory:list 或 memory:recall 找 id）`);
    process.exit(1);
  }
  // 前缀歧义不猜：匹配多条就列出来让人挑，绝不批量误归档（--all 才全归）
  if (hit.length > 1 && f.all !== true) {
    console.log(`${NL}前缀「${needle}」匹配到 ${hit.length} 条，不会猜。请给更长的前缀，或加 --all 全部归档：${NL}`);
    for (const e of hit.slice(0, 20)) {
      console.log(`  ${e.id}  ${dim(`${e.project} · ${e.createdAt.slice(0, 10)}`)}`);
      console.log(`    ${oneLine(e.text, 90)}`);
    }
    process.exit(1);
  }
  // 归档目录：与 IPC/面板一致（母版配了就放母版的 archive/zhiya-pool，否则池内 archived/）
  const dir = archiveDirFor(poolDir);
  console.log(`${NL}将归档 ${hit.length} 条到 ${dir}（归档 ≠ 删除，可恢复）：`);
  for (const e of hit) {
    console.log(`  ${e.id}  ${dim(e.project)}`);
    console.log(`    ${oneLine(e.text, 90)}`);
  }
  if (f.dry === true || f.preview === true) {
    console.log(`${NL}（--dry 预览，未落盘）`);
    return;
  }
  let okCount = 0;
  for (const e of hit) {
    const r = await archiveEntryFromPanel(poolDir, e.id, { archiveDir: dir, index: undefined });
    if (r.ok) okCount++;
    else console.error(`  ✗ ${e.id}：${r.detail}`);
  }
  console.log(`${NL}✓ 已归档 ${okCount}/${hit.length} 条 → ${dir}`);
  console.log("  提示：跑 npm run memory:reindex 让索引同步");
}

/** 单行化 + 截断（列表里显示）。 */
function oneLine(text, max) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}


async function cmdProposals() {
  const { proposals, broken } = listProposals(poolDir);
  if (!proposals.length) {
    console.log("没有提案。可用：npm run memory:dream");
    return;
  }
  const order = { pending: 0, approved: 1, failed: 2, applied: 3, rejected: 4 };
  proposals.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || (a.createdAt < b.createdAt ? 1 : -1));
  console.log(`\x1b[1m提案\x1b[0m ${poolDir}/proposals\n`);
  for (const p of proposals) {
    const flag = p.status === "pending" ? "\x1b[33m待审批\x1b[0m" : p.status === "applied" ? "\x1b[32m已落地\x1b[0m" : p.status;
    console.log(`${flag}  ${p.id.slice(-8)}  ${KIND_LABEL[p.kind] ?? p.kind}`);
    console.log(`    ${p.title}`);
    console.log(`    理由：${p.reason}`);
    if (p.target) console.log(`    目标：${p.target}`);
    if (p.result) console.log(`    结果：${p.result}`);
    console.log(`    依据：${p.entries.join(" ")}　→  npm run memory:approve -- ${p.id.slice(-8)}`);
  }
  if (broken.length) console.log(`\n\x1b[31m坏提案文件 ${broken.length} 个\x1b[0m：\n  ${broken.map((b) => `${b.path}（${b.reason}）`).join("\n  ")}`);
}

async function cmdApprove() {
  const id = (f._ || [])[0];
  if (!id) {
    console.error("用法：npm run memory:approve -- <提案 id 前缀>");
    process.exit(2);
  }
  const all = listProposals(poolDir).proposals;
  const hits = all.filter((x) => x.id === id || x.id.startsWith(id) || x.id.endsWith(id));
  if (hits.length > 1) {
    console.error(`「${id}」匹配到 ${hits.length} 份提案，请多输几位：${hits.map((x) => x.id.slice(-6)).join(" / ")}`);
    process.exit(2);
  }
  const p = hits[0];
  if (!p) {
    console.error(`找不到提案：${id}（前缀或后缀都行）`);
    process.exit(1);
  }
  if (p.status !== "pending" && p.status !== "failed") {
    console.error(`提案状态是 ${p.status}，不能批准`);
    process.exit(1);
  }
  const approved = setProposalStatus(poolDir, p.id, "approved");
  // 尽量用真索引（zvec 不可用时退化为空操作：文件真相源仍然正确，只是索引要等重建）
  let index = { upsert: async () => {}, remove: async () => {} };
  try {
    const z = await makeZvec();
    index = { upsert: (es) => z.upsert(es), remove: (ids) => z.remove(ids) };
  } catch (e) {
    console.warn(`（索引层不可用，仅写文件真相源：${e.message}）`);
  }
  // 老提案（打 projectRoot 之前采集的）没有 target —— 用**面板同一条兜底链**解析落点，
  // 否则同一条提案"面板能批、CLI 报无法确定落点"（两条执行路径行为不一致，真机抓到过）。
  const lessonsDir = approved.kind === "promote-kb" && !approved.target ? resolveLessonsDirFor(poolDir, approved) : null;
  const r = await applyProposal(approved, {
    poolDir,
    archiveDirFor,
    index,
    kbLessonsDir: lessonsDir ?? undefined,
    log: (m) => console.log(m),
  });
  console.log(`${r.ok ? "✓" : "✗"} ${r.detail}`);
  if (r.action === "manual") {
    console.log("\n待人工合并的正文：\n---");
    console.log(p.body.trim());
    console.log("---");
  }
  if (!r.ok) process.exit(1);
}

async function cmdReject() {
  const id = (f._ || [])[0];
  if (!id) {
    console.error("用法：npm run memory:reject -- <提案 id 前缀>");
    process.exit(2);
  }
  const all = listProposals(poolDir).proposals;
  const hits = all.filter((x) => x.id === id || x.id.startsWith(id) || x.id.endsWith(id));
  if (hits.length > 1) {
    console.error(`「${id}」匹配到 ${hits.length} 份提案，请多输几位：${hits.map((x) => x.id.slice(-6)).join(" / ")}`);
    process.exit(2);
  }
  const p = hits[0];
  if (!p) {
    console.error(`找不到提案：${id}（前缀或后缀都行）`);
    process.exit(1);
  }
  const done = setProposalStatus(poolDir, p.id, "rejected");
  console.log(done ? `✓ 已拒绝：${p.title}` : `✗ 状态流转被拒绝（当前 ${p.status}）`);
  if (!done) process.exit(1);
}

/**
 * 从磁盘读「记忆模型」设置（CLI 没有 electron，不能走主进程那套 getConfig）。
 * 配置文件路径可用 MPI_CONFIG_FILE 覆盖；models.json 取 pi 的默认位置。
 */
function readMemoryModelSetting() {
  const cfgFile =
    process.env.MPI_CONFIG_FILE || join(process.env.APPDATA || "", "MPI Dev", "config.json");
  let mm;
  try {
    mm = JSON.parse(readFileSync(cfgFile, "utf8")).memoryModel;
  } catch {
    return defaultMemoryModel(); // 读不到就按"未设置"
  }
  const mode = mm?.mode ?? (mm?.provider && mm?.model ? "model" : "none");
  if (mode === "none") return defaultMemoryModel();
  if (mode === "session") {
    // CLI 里没有"会话"，用 settings.json 的默认模型代表主模型
    try {
      const settings = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8"));
      const provider = settings.defaultProvider;
      const modelId = settings.defaultModel;
      if (!provider || !modelId) return { ...defaultMemoryModel(), describe: "跟随主模型：settings.json 没写默认模型 → 不调模型" };
      const providers = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "models.json"), "utf8")).providers || {};
      const r = resolveMemoryModelFrom(provider, modelId, providers, "model");
      return { ...r, mode: "session", source: "session", describe: `跟随主模型（默认模型 ${provider}/${modelId}）` };
    } catch (e) {
      return { ...defaultMemoryModel(), describe: `跟随主模型：读取失败（${e.message}）→ 不调模型` };
    }
  }
  try {
    const providers = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "models.json"), "utf8")).providers || {};
    return resolveMemoryModelFrom(mm.provider, mm.model, providers, "model");
  } catch (e) {
    return { ...defaultMemoryModel(), describe: `读 models.json 失败（${e.message}）→ 不调模型` };
  }
}

/** 跑一次分诊（本地模型 1-2 分钟）。 */
async function cmdDream() {
  const dry = f.dry === true || f.preview === true;
  const mm = readMemoryModelSetting();
  console.log(`记忆模型：${mm.describe}`);
  console.log(`开始周期分诊${dry ? "（预览，不落盘）" : ""}…`);
  const report = await runDream({
    poolDir,
    dryRun: dry,
    mode: mm.mode,
    modelDesc: mm.describe,
    llmUrl: mm.url || undefined,
    llmModel: mm.model || undefined,
    llmKey: mm.key,
    log: (m) => console.log(m),
    maxEntries: Number(f.entries) || undefined,
    maxBodies: Number(f.bodies) || undefined,
    force: f.force === true,
    llmClassify: f["llm-classify"] === true,
    // 从项目目录跑时用 cwd 兜底：老条目没带 projectRoot，否则 lesson 落点解析不出来
    defaultProjectRoot: process.cwd(),
  });
  console.log(`\n${report.ok ? "✓" : "✗"} ${report.entries} 条 → ${report.themes} 个主题 → ${report.proposals.length} 份提案（${(report.ms / 1000).toFixed(1)}s）`);
  for (const p of report.proposals) {
    console.log(`  [${KIND_LABEL[p.kind] ?? p.kind}] ${p.title}`);
    console.log(`    ${p.reason}`);
    if (p.target) console.log(`    目标：${p.target}`);
  }
  if (report.errors.length) console.log(`\n警告 ${report.errors.length} 条：\n  ${report.errors.join("\n  ")}`);
  if (report.ok && !dry) {
    markConsolidated(poolDir, "manual");
    console.log("\n提示：审批用小面板 /memory-approve，或 npm run memory:approve -- <id>");
  }
  if (!report.ok) process.exit(1);
}

const table = {
  list: cmdList,
  add: cmdAdd,
  recall: cmdRecall,
  reindex: cmdReindex,
  show: cmdShow,
  optimize: cmdOptimize,
  proposals: cmdProposals,
  approve: cmdApprove,
  reject: cmdReject,
  forget: cmdForget,
  archive: cmdForget, // 同义词：归档（归档 ≠ 删除）
  dream: cmdDream,
};
if (!table[cmd]) {
  console.log(
    "用法：memory:list | memory:add | memory:recall | memory:reindex | memory:optimize | memory:show | memory:proposals | memory:approve | memory:reject | memory:forget（别名 archive）| memory:dream",
  );
  process.exit(2);
}
await table[cmd]();
