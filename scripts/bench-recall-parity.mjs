/**
 * P5-3 召回对照：mem0 vs 知芽（同一批查询，两边各取 top-5）
 *
 * 目的不是"证明谁更强"，而是**看清差异**：迁移后知芽的召回是不是丢东西了。
 * 所以只报数据，不设通过门槛（方案 §4 的约定）。
 *
 * 两个查询家族：
 *   A 词面命中（10 条，取自已迁移条目的正文前缀）—— 检检索链路是否通
 *   B 语义改写（8 条，人工写的自然问法 + 声明关键词）—— 检语义召回
 *
 * 注意一处**结构不对称**（如实报告，不粉饰）：mem0 按 user_id 分区（本机只配了 `wjj`），
 * 而知芽的池子是**单一空间**（不分设备）。为公平，mem0 侧对 4 个已知 user_id 各查一次再合并。
 *
 *   npm run bench:recall-parity
 */
import { readFileSync } from "node:fs";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { ZvecIndex } = await import("../src/main/zhiya/zvec-index.ts");
const { listEntries } = await import("../src/main/zhiya/pool.ts");
const { defaultPoolDir } = await import("../src/main/zhiya/memory-index.ts");

const MEM0 = process.env.MEM0_URL || "http://127.0.0.1:8000";
const USERS = ["wjj", "wjj-mb", "wjj-tb", "wjj-wjw"];
const TOPK = 5;
const poolDir = defaultPoolDir();
const exportFile = "E:/MyWorkspace/tempfile/mem0-export.jsonl";

const exportRecs = readFileSync(exportFile, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse);
const entries = listEntries(poolDir).entries.filter((e) => (e.evidence || []).some((x) => x.startsWith("mem0:")));
// 知芽条目 id → mem0 点 id（用幂等键对齐两个空间）
const ALL = listEntries(poolDir).entries; // 检索范围是整池（含既有条目），标签映射必须覆盖全池
const entryKey = new Map(ALL.map((e) => [e.id, (e.evidence || []).find((x) => x.startsWith("mem0:"))]));
const entryText = new Map(ALL.map((e) => [e.id, e.text]));

// ---- 查询集 ----------------------------------------------------------------
// A：词面命中——取已迁移条目的正文前 40 字（两边都应该轻松找到）
const familyA = entries
  .filter((e) => e.text.length > 60)
  .filter((_, i) => i % Math.max(1, Math.floor(entries.length / 10)) === 0)
  .slice(0, 10)
  .map((e) => ({
    q: e.text.replace(/\s+/g, " ").slice(0, 40),
    expectKey: entryKey.get(e.id),
    expectHint: e.text.slice(0, 30),
    kind: "A 词面",
  }));

// B：语义改写——人工写的自然问法 + 声明关键词（命中判定看正文是否含关键词之一）
const familyB = [
  { q: "怎么让局域网里的自建服务只能内网访问、不从公网暴露？", kws: ["tailnet", "Tailscale", "公网"] },
  { q: "为什么本地向量索引文件会越写越大？", kws: ["索引", "zvec", "压缩", "段"] },
  { q: "Windows 上写文件偶尔失败但其实写成功了，是什么原因？", kws: ["EPERM", "杀软", "rename", "原子"] },
  { q: "推送代码前需要遵守什么约定？", kws: ["推送", "确认", "commit"] },
  { q: "本地 embedding 服务用哪个模型、多少维？", kws: ["embedding", "768", "nomic", "bge"] },
  { q: "怎么把一台设备的记忆同步到另一台？", kws: ["同步", "设备", "Seafile", "母版"] },
  { q: "自动压缩上下文时怎么避免消息丢失？", kws: ["压缩", "compact", "丢失"] },
  { q: "子代理和主代理之间怎么共享上下文？", kws: ["子代理", "上下文", "session"] },
].map((x) => ({ ...x, kind: "B 语义" }));

// ---- 检索 ----------------------------------------------------------------
const idx = await ZvecIndex.open(poolDir, { readOnly: true });

async function zhiyaSearch(q) {
  const hits = await idx.recall({ text: q, topK: TOPK });
  return hits.map((h) => ({
    key: entryKey.get(h.id) ?? h.id,
    text: entryText.get(h.id) ?? "",
    label: entryText.get(h.id)?.slice(0, 28) ?? h.id,
  }));
}

async function mem0Search(q) {
  const merged = new Map();
  for (const u of USERS) {
    const url = `${MEM0}/v1/memories?query=${encodeURIComponent(q)}&user_id=${u}&top_k=${TOPK}`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) continue;
      const d = await r.json();
      for (const hit of d.results || []) {
        const key = `mem0:${hit.id}`;
        const prev = merged.get(key);
        if (!prev || (hit.score ?? 0) > (prev.score ?? 0)) merged.set(key, { key, text: hit.memory || "", label: (hit.memory || "").slice(0, 28), score: hit.score });
      }
    } catch (e) {
      merged.set(`__err__${u}`, { key: `__err__`, text: String(e.message), label: `查询失败(${u})` });
    }
  }
  return [...merged.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, TOPK);
}

const rows = [];
let zLat = [];
let mLat = [];
for (const item of [...familyA, ...familyB]) {
  let t = process.hrtime.bigint();
  const z = await zhiyaSearch(item.q);
  const zms = Number(process.hrtime.bigint() - t) / 1e6;
  t = process.hrtime.bigint();
  const m = await mem0Search(item.q);
  const mms = Number(process.hrtime.bigint() - t) / 1e6;
  zLat.push(zms);
  mLat.push(mms);

  // 命中判定
  const hitZ = item.kind.startsWith("A")
    ? z.findIndex((h) => h.key === item.expectKey)
    : z.findIndex((h) => item.kws?.some((k) => h.text.toLowerCase().includes(k.toLowerCase())));
  const hitM = item.kind.startsWith("A")
    ? m.findIndex((h) => h.key === item.expectKey)
    : m.findIndex((h) => item.kws?.some((k) => h.text.toLowerCase().includes(k.toLowerCase())));
  const overlap = z.filter((h) => m.some((x) => x.key === h.key)).length;
  rows.push({ ...item, z, m, hitZ, hitM, overlap, zms, mms });
}

// ---- 报告 ----------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
console.log(`\n=== 召回对照：mem0 vs 知芽（top-${TOPK}，${rows.length} 个查询）===`);
console.log(`知芽池内可对齐条目 ${entries.length} 条（带 mem0 幂等键）；mem0 侧合并 ${USERS.length} 个 user_id\n`);
console.log(pad("查询", 44) + pad("知芽", 10) + pad("mem0", 10) + "top3 重合");
console.log("-".repeat(78));
let rz = { 1: 0, 3: 0, 5: 0, miss: 0 };
let rm = { 1: 0, 3: 0, 5: 0, miss: 0 };
let overlapSum = 0;
for (const r of rows) {
  const mark = (i) => (i < 0 ? "—" : `#${i + 1}`);
  const zMark = mark(r.hitZ);
  const mMark = mark(r.hitM);
  console.log(pad(r.q.slice(0, 42), 44) + pad(zMark, 10) + pad(mMark, 10) + `${r.overlap}/${TOPK}`);
  const tally = (v, i) => {
    if (i === 0) v[1]++;
    if (i >= 0 && i < 3) v[3]++;
    if (i >= 0) v[5]++;
    else v.miss++;
  };
  tally(rz, r.hitZ);
  tally(rm, r.hitM);
  overlapSum += r.overlap;
}
const pct = (n) => `${((n / rows.length) * 100).toFixed(0)}%`;
console.log("-".repeat(78));
console.log(pad("命中率", 44) + pad("知芽", 10) + pad("mem0", 10) + "");
console.log(pad("  top1", 44) + pad(`${rz[1]} (${pct(rz[1])})`, 10) + pad(`${rm[1]} (${pct(rm[1])})`, 10));
console.log(pad("  top3", 44) + pad(`${rz[3]} (${pct(rz[3])})`, 10) + pad(`${rm[3]} (${pct(rm[3])})`, 10));
console.log(pad("  top5", 44) + pad(`${rz[5]} (${pct(rz[5])})`, 10) + pad(`${rm[5]} (${pct(rm[5])})`, 10));
console.log(pad("  完全未命中", 44) + pad(String(rz.miss), 10) + pad(String(rm.miss), 10));

const stat = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return { p50: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
};
const zs = stat(zLat);
const msv = stat(mLat);
console.log(`\n延迟：知芽 p50 ${zs.p50.toFixed(1)}ms / max ${zs.max.toFixed(0)}ms ｜ mem0 p50 ${msv.p50.toFixed(1)}ms / max ${msv.max.toFixed(0)}ms`);
console.log(`top-${TOPK} 平均重合：${(overlapSum / rows.length).toFixed(1)}/${TOPK}`);

// 差异最大的几条，把两边的 top3 打出来看
// 未命中归因：是"知芽有却没召回"，还是"那条记录按拍板口径根本没迁进来"？
const poolKeys = new Set([...entryKey.values()].filter(Boolean));
const zMiss = rows.filter((r) => r.hitZ < 0);
console.log(`
=== 未命中归因（知芽未命中 ${zMiss.length} 个查询）===`);
for (const r of zMiss) {
  const mTop = r.m[0];
  const migrated = mTop?.key && poolKeys.has(mTop.key);
  console.log(`· ${r.q.slice(0, 40)}`);
  console.log(`   mem0 top1 ${migrated ? "**在知芽池内 → 真召回差距**" : "不在迁移范围内（按口径本就未迁）"}：${mTop?.label ?? "（无结果）"}`);
}

console.log(`\n=== 差异较大的查询（知芽与 mem0 的 top3 几乎不重合）===`);
let shown = 0;
for (const r of rows) {
  const o3 = r.z.slice(0, 3).filter((h) => r.m.slice(0, 3).some((x) => x.key === h.key)).length;
  if (o3 > 0 || shown >= 3) continue;
  shown++;
  console.log(`\n· ${r.q}`);
  console.log(`  知芽：${r.z.slice(0, 3).map((h) => h.label).join(" ｜ ") || "（无结果）"}`);
  console.log(`  mem0：${r.m.slice(0, 3).map((h) => h.label).join(" ｜ ") || "（无结果）"}`);
}
if (!shown) console.log("（无：两边 top3 都有重合）");

await idx.close();
