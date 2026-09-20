/**
 * 记忆召回回归集（P2 验收：10 题，命中率 ≥70%）
 *
 * 为什么自建而不是信厂商 benchmark：题目全部来自本项目**真实反复重解释**的问题，
 * 答不出就是真有缺口；厂商榜单跑分再高也不代表能回答"推送前要做什么"。
 *
 * 两种模式：
 *   默认        fixture 模式：把 10 条答案灌进临时池子，用**改写过的问法**去问，
 *               量的是"检索器好不好"（可重复、不依赖你机器上的实际池子）
 *   --real      真池模式：拿同一批问题问你机器上的实际记忆池，只报告命中/缺失
 *               （这是健康检查，不是断言——缺口正是我们要看见的东西）
 *
 * 运行：npm run test:memoryregress  ·  npm run test:memoryregress -- --real
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));

const REAL = process.argv.includes("--real");

/** 10 组：答案条目（真实结论）+ 改写问法（不共用措辞，考的是语义召回）。 */
const CASES = [
  { id: "dev-restart", answer: "修改 main 或 preload 之后必须完整重启 npm run dev，Ctrl+R 不够。", ask: "改了主进程代码要怎么才能生效？" },
  { id: "push-confirm", answer: "推送前必须等用户确认；无人值守时只 commit 不 push 并列出待推送项。", ask: "提交代码之后能直接推吗？" },
  { id: "zvec-open-cost", answer: "zvec 的 ZVecOpen 约 208 毫秒（带 FTS 索引），读者必须复用只读句柄，否则每次 recall 都要付这个开合成本。", ask: "为什么每次检索都开一次数据库句柄会很慢？" },
  { id: "call-graph", answer: "zg 不提供代码调用图，调用图只有 alexandria 有（存在 edges 表里）。", ask: "哪个工具能查谁调用了谁？" },
  { id: "mem0-fastembed", answer: "mem0 的 BM25 稀疏检索因为 fastembed 未安装而静默失效，实际退化为纯语义检索。", ask: "全文关键词那一路为什么没生效？" },
  { id: "tempfile", answer: "临时文件一律落在工作区根目录的 tempfile 下，可随时清除，不污染正式工程。", ask: "随手写的脚本和缓存该扔哪？" },
  { id: "ext-self-contained", answer: "pi 扩展以 ?raw 源码写进 userData 由 pi 加载，必须自包含，import 不到本仓模块。", ask: "为什么扩展里不能引用项目里的其它文件？" },
  { id: "dedupe-promote", answer: "记忆池里相似度超过 0.82 判为重复并累加复现计数，复现 3 次触发晋升。", ask: "同一条经验要出现几次才会被提升成规则？" },
  { id: "zhiya-inject-order", answer: "知芽注入顺序是硬规则、指针、人物画像、工作空间速查，共享 4000 字符预算、尾部截断。", ask: "系统提示里这些内容的排列顺序是什么？" },
  { id: "reasoning-model-tokens", answer: "本机 qwen3.8-27b 是推理模型，reasoning_content 与 content 分离；max_tokens 给小了答案会是空的。", ask: "本机模型返回空内容是什么原因？" },
];

let n = 0;
const ok = (name) => { n++; console.log(`  ✅ ${name}`); };

const poolDir = REAL ? join(homedir(), ".pi", "agent", "zhiya", "pool") : mkdtempSync(join(tmpdir(), "mpi-regress-"));
if (!REAL) process.on("exit", () => { try { rmSync(poolDir, { recursive: true, force: true }); } catch { /* 句柄未释放 */ } });

const { decideIngest, lexicalSimilarity, listEntries } = await import("../src/main/zhiya/pool.ts");
const { ZvecIndex } = await import("../src/main/zhiya/zvec-index.ts");
const { disposeMemoryIndex } = await import("../src/main/memory-service.ts");

if (!REAL) {
  for (const c of CASES) {
    const r = decideIngest(poolDir, {
      text: c.answer, type: "semantic", temporal: "retrospective",
      importance: 7, relevance: 0.7, project: "MPI", source: `regress#${c.id}`,
    }, lexicalSimilarity);
    assert.equal(r.action, "add", `灌入 ${c.id} 失败：${r.action}`);
  }
}

const expectCount = REAL ? listEntries(poolDir).entries.length : CASES.length;
console.log(`\n模式：${REAL ? "真池（健康检查）" : "fixture（检索器基准）"}　池内 ${expectCount} 条\n`);

let index;
try {
  index = await ZvecIndex.open(poolDir);
} catch (e) {
  console.log(`⚠️ 跳过：zvec 不可用（${e.message.split("\n")[0]}）`);
  process.exit(0);
}
// fixture 模式下先重建，保证索引完整（自愈也会做，这里显式一些）
if (!REAL) await index.rebuild(poolDir);

const entries = listEntries(poolDir).entries;
const byText = new Map(entries.map((e) => [e.text, e]));

let top1 = 0;
let top3 = 0;
const rows = [];

for (const c of CASES) {
  const hits = await index.recall({ text: c.ask, topK: 3 });
  let expectId = null;
  if (!REAL) expectId = byText.get(c.answer)?.id ?? null;
  else {
    // 真池模式：只要 top3 里有一条命中该问题的关键词要点即算"有记忆可用"
    const key = c.answer.slice(0, 10);
    expectId = hits.find((h) => byText.get(entries.find((e) => e.id === h.id)?.text ?? "")?.id && (entries.find((e) => e.id === h.id)?.text ?? "").includes(key))?.id ?? null;
  }
  const rank = expectId ? hits.findIndex((h) => h.id === expectId) : -1;
  if (rank === 0) top1++;
  if (rank >= 0 && rank < 3) top3++;
  const top = hits[0] ? (entries.find((e) => e.id === hits[0].id)?.text ?? "").slice(0, 34) : "（无命中）";
  rows.push({ 问题: c.ask.slice(0, 22), 命中: rank === 0 ? "top1" : rank > 0 ? `top${rank + 1}` : "未命中", top1结果: top });
}

console.table(rows);
const pct = (x) => `${Math.round((x / CASES.length) * 100)}%`;
console.log(`\ntop1 命中 ${top1}/${CASES.length}（${pct(top1)}）　top3 命中 ${top3}/${CASES.length}（${pct(top3)}）`);

await index.close();
await disposeMemoryIndex();

if (!REAL) {
  // 回归守卫：融合策略变更（权重/归一方式）特别容易悄悄把排序搞坏——基线是 9/10、10/10。
  assert.ok(top1 / CASES.length >= 0.7, `top1 命中率应 ≥70%，实际 ${pct(top1)}`);
  assert.ok(top3 / CASES.length >= 0.9, `top3 命中率应 ≥90%，实际 ${pct(top3)}`);
  ok(`检索器基准：top1 ${top1}/10、top3 ${top3}/10（守卫线 70% / 90%）`);
  console.log(`\ntest:memoryregress 通过（${n} 项）`);
} else {
  console.log("\n（真池模式只报告，不判定：缺口正是要看见的东西）");
}
