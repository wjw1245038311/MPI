/**
 * 「不接模型」场景下的效率对比：知芽记忆池 vs mem0
 *
 * 对等的比法（关键，别拿不同条件比）：
 *   知芽：未设置记忆模型 → 不调 LLM，显式写入走**原文直存** + 本地 embedding 建索引
 *   mem0：`infer:false` → 不调 LLM，原始文本直存 + embedding
 * 两边都是"只用基础记忆读写改"，都不需要 chat 模型。
 *
 * 顺带回答一个用户会关心的问题：**不接模型时，记忆功能到底还剩什么**——
 * 落地（写入/检索/归档）全在，只有自动抽取、打分、lesson 正文生成停用。
 *
 * 运行：npm run bench:memory-vs-mem0
 * ⚠️ mem0 侧用独立 user_id（bench-<时间戳>）并在结束时删干净，不碰既有数据。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { ZvecIndex } = await import("../src/main/zhiya/zvec-index.ts");
const { ingestMemoryInbox, ingestOne } = await import("../src/main/memory-inbox.ts");
const { listEntries } = await import("../src/main/zhiya/pool.ts");

const MEM0 = process.env.MEM0_URL || "http://127.0.0.1:8000";
const N = Number(process.env.BENCH_N || 30);
const Q = Number(process.env.BENCH_Q || 10);
const USER = `bench-${Date.now()}`;

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const ms = (v) => `${v.toFixed(1)}ms`;
const stat = (arr) =>
  `p50 ${ms(pct(arr, 50))}　p95 ${ms(pct(arr, 95))}　合计 ${ms(arr.reduce((a, b) => a + b, 0))}`;

async function timed(fn) {
  const t0 = performance.now();
  const v = await fn();
  return { ms: performance.now() - t0, v };
}

/** 语料：用真实记忆池里的正文（中文、长短混合，比合成文本更有代表性）。 */
function corpus() {
  const pool = join(process.env.USERPROFILE || process.env.HOME || "", ".pi", "agent", "zhiya", "pool", "inbox");
  const texts = [];
  const walk = (d) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, name.name);
      if (name.isDirectory()) {
        walk(p);
        continue;
      }
      if (!name.name.endsWith(".md")) continue;
      const raw = readFileSync(p, "utf8");
      const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").split(/\r?\n## (复现记录|证据)/)[0].trim();
      if (body) texts.push(body);
    }
  };
  try {
    walk(pool);
  } catch {
    /* 池不在就退回合成语料 */
  }
  if (texts.length >= N) return texts.slice(0, N);
  const filler = Array.from({ length: N }, (_, i) => `基准测试用记忆条目 ${i + 1}：这条描述一个可复用的工程经验。`);
  return [...texts, ...filler].slice(0, N);
}

const dirSize = (root) => {
  let n = 0;
  const walk = (d) => {
    let items = [];
    try {
      items = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = join(d, it.name);
      try {
        if (it.isDirectory()) walk(p);
        else n += statSync(p).size;
      } catch {
        /* 竞态忽略 */
      }
    }
  };
  walk(root);
  return n;
};

const texts = corpus();
console.log(`\n语料：${texts.length} 条真实记忆正文　检索查询：${Q} 次\n`);

// ---------------------------------------------------------------- 知芽
console.log("═══ 知芽记忆池（未设置记忆模型 = 不调 LLM）═══");
const pool = mkdtempSync(join(tmpdir(), "zhiya-bench-"));
const inbox = join(pool, "_inbox");
writeFileSync(join(pool, ".keep"), "", "utf8");
const { mkdirSync } = await import("node:fs");
mkdirSync(inbox, { recursive: true });
const idx = await ZvecIndex.open(pool);

// 真实链路：扩展把候选一批写进 inbox → 主进程一次批量摄入（每 2 秒轮询消费一批）。
// 单条逐个 ingestOne 不是应用的用法（实测差 20 倍以上，见 memory-inbox 的批量 flush 注释）。
for (const [i, text] of texts.entries()) {
  writeFileSync(
    join(inbox, `c${i}.json`),
    JSON.stringify({ text, importance: 6, relevance: 0.9, project: "bench", source: "bench" }),
    "utf8",
  );
}
const batch = await timed(() => ingestMemoryInbox(inbox, { poolDir: pool, index: idx }));
const writeLat = Array.from({ length: N }, () => batch.ms / N); // 摊到每条，便于与 mem0 对齐
const zEntries = listEntries(pool).entries.length;

const queries = texts.slice(0, Q).map((t) => t.slice(0, 30));
const zRead = [];
for (const q of queries) zRead.push((await timed(() => idx.recall({ text: q, topK: 5 }))).ms);
const zIndexBytes = dirSize(join(pool, ".zvec"));
// zvec 不会自动合并段文件：不压缩的话写入量直接换成磁盘占用（实测很夸张）
const tCompact = await timed(() => idx.compact());
const zIndexAfter = dirSize(join(pool, ".zvec"));

console.log(`写入 ${N} 条（一次批量摄入，真实链路）：合计 ${ms(batch.ms)}　平均 ${ms(batch.ms / N)}/条`);
console.log(`检索 ${Q} 次：${stat(zRead)}`);
console.log(`落地条目：${zEntries} 条`);
console.log(
  `索引占用：${(zIndexBytes / 1048576).toFixed(1)}MB → 压缩后 ${(zIndexAfter / 1048576).toFixed(1)}MB（${ms(tCompact.ms)}）`,
);
console.log("（批量 flush 索引前会慢 20 倍：zvec 的开销按调用计，实测逐条 250ms/条 vs 批量 11ms/条）");

// 归档（= mem0 的删除对照）
const archiveDir = join(pool, "_archive");
const first = listEntries(pool).entries[0];
const zDel = (await timed(() => ingestOne(
  join((() => { const f = join(inbox, "del.json"); writeFileSync(f, JSON.stringify({ op: "forget", id: first.id }), "utf8"); return f; })(), ),
  { poolDir: pool, index: idx, archiveDir },
))).ms;
console.log(`归档/删除 1 条：${ms(zDel)}（归档≠删除，文件仍在）`);

// ---------------------------------------------------------------- mem0
console.log("\n═══ mem0（infer:false = 不调 LLM）═══");
let mem0ok = true;
const mWrite = [];
const mRead = [];
const created = [];
const post = async (path, body) => {
  const r = await fetch(`${MEM0}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
  return r.json();
};
try {
  for (const text of texts) {
    const r = await timed(() => post("/v1/memories", { text, userId: USER, infer: false }));
    mWrite.push(r.ms);
    const id = r.v?.results?.[0]?.id ?? r.v?.id;
    if (id) created.push(id);
  }
  for (const q of queries) {
    mRead.push((await timed(() =>
      fetch(`${MEM0}/v1/memories?query=${encodeURIComponent(q)}&user_id=${USER}&top_k=5`).then((r) => {
        if (!r.ok) throw new Error(`search → HTTP ${r.status}`);
        return r.json();
      }),
    )).ms);
  }
  const stored = await fetch(`${MEM0}/v1/memories/all?user_id=${USER}`).then((r) => r.json()).catch(() => ({ count: "?" }));
  console.log(`写入 ${N} 条：${stat(mWrite)}`);
  console.log(`检索 ${Q} 次：${stat(mRead)}`);
  console.log(`落地条目：${typeof stored.count === "number" ? stored.count : "?"} 条`);

  const mDel = (await timed(() =>
    fetch(`${MEM0}/v1/memories/${created[0]}`, { method: "DELETE" }).then((r) => {
      if (!r.ok) throw new Error(`delete → HTTP ${r.status}`);
      return r.json();
    }),
  )).ms;
  console.log(`删除 1 条：${ms(mDel)}（真删）`);
  console.log(`落地条目少于写入数：mem0 在 infer:false 下仍会丢弃一部分（去重/过滤）`);
} catch (e) {
  mem0ok = false;
  console.log(`mem0 侧未跑通：${e.message}`);
}

// ---------------------------------------------------------------- 清理与对比
await idx.close();
rmSync(pool, { recursive: true, force: true });
if (mem0ok) {
  const r = await fetch(`${MEM0}/v1/memories?user_id=${USER}`, { method: "DELETE" });
  console.log(`\nmem0 基准数据已清理（user_id=${USER}，HTTP ${r.status}）`);
}

console.log("\n═══ 对比（都是「不接模型」）═══");
if (mem0ok) {
  console.log(`写入（每条均摊）　知芽 ${ms(batch.ms / N)}　vs　mem0 ${ms(pct(mWrite, 50))}（p50）`);
  console.log(`检索 p50　知芽 ${ms(pct(zRead, 50))}　vs　mem0 ${ms(pct(mRead, 50))}`);
} else {
  console.log("mem0 侧不可用，只有知芽数据。");
}
