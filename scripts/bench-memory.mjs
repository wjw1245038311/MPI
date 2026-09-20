/**
 * 记忆池延迟基准（P0 遗留项：embedding 缓存 / P95）
 *   1) 延迟构成：embedding、开合句柄、查询各占多少
 *   2) recall 的 p50 / p95（当前实现：每次开合句柄 + 每次取 embedding）
 *   3) rebuild 全量耗时（embedding 是主要成本 → 也是缓存的主要受益点）
 * 运行：npm run bench:memory
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { ZvecIndex, embedText } = await import("../src/main/zhiya/zvec-index.ts");
const { decideIngest, lexicalSimilarity, listEntries } = await import("../src/main/zhiya/pool.ts");

const N = Number(process.env.BENCH_N || 100);
const RECALLS = Number(process.env.BENCH_RECALLS || 30);
const poolDir = mkdtempSync(join(tmpdir(), "mpi-bench-"));
process.on("exit", () => rmSync(poolDir, { recursive: true, force: true }));

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const ms = (x) => `${x.toFixed(1)}ms`;

// --- 造数据 ------------------------------------------------------------------
const SENTENCES = [
  "zg 不提供代码调用图，调用图只有 alexandria 有",
  "mem0 的 BM25 稀疏检索因为 fastembed 未安装而静默失效",
  "临时文件一律落在工作区根目录的 tempfile 下",
  "推送前必须等用户确认，无人值守时只 commit 不 push",
  "知芽的注入顺序是硬规则、指针、画像、工作空间",
  "zvec 是阿里开源的嵌入式向量数据库",
  "计划任务 Mem0Server 每五分钟探测健康并自愈",
  "用户主攻 C# 与 C++ 二次开发，方向是三维建模",
  "Python 包管理统一使用 uv，不用 pip",
  "本机唯一 shell 是 Git Bash，禁止 PowerShell",
  "知识库文档的事实与推断要分开标记",
  "压缩改造要保留用户原话，不能转述",
];
for (let i = 0; i < N; i++) {
  // 每条带唯一随机 token——否则会被自己的判重逻辑拦下（第一版就踩了这个）
  decideIngest(poolDir, {
    text: `${SENTENCES[i % SENTENCES.length]}（基准条目 ${i} ${Math.random().toString(36).slice(2, 10)}）`,
    type: "semantic", temporal: "retrospective", importance: (i % 9) + 1, relevance: 0.7,
    project: i % 3 === 0 ? "MPI" : "OTHER", source: `bench#${i}`,
  }, lexicalSimilarity);
}
console.log(`池子已就绪：${listEntries(poolDir).entries.length} 条\n`);

// --- 1) embedding 单价 -------------------------------------------------------
const t0 = Date.now();
for (let i = 0; i < 10; i++) await embedText(`基准查询 ${i}`);
console.log(`① embedding 单价：${ms((Date.now() - t0) / 10)}（10 次平均，无缓存）`);

// --- 2) 开合只读句柄单价 -----------------------------------------------------
const idx = await ZvecIndex.open(poolDir);
const tCold = Date.now();
await idx.rebuild(poolDir);
console.log(`② rebuild #1（冷，逐条取 embedding）：${ms(Date.now() - tCold)}`);
const first = Date.now();
await idx.recall({ text: "预热", topK: 3 });
console.log(`③ 首次 recall（含一次性句柄打开）：${ms(Date.now() - first)}`);

// --- 3) recall 分布 ----------------------------------------------------------
const lat = [];
for (let i = 0; i < RECALLS; i++) {
  const t = Date.now();
  await idx.recall({ text: SENTENCES[i % SENTENCES.length].slice(0, 8), topK: 5 });
  lat.push(Date.now() - t);
}
console.log(`④ recall 分布（句柄复用）：p50 ${ms(pct(lat, 50))} / p95 ${ms(pct(lat, 95))} / max ${ms(Math.max(...lat))}`);

// --- 3b) 同一查询重复（吃 embedding 缓存）-------------------------------------
await idx.recall({ text: "缓存命中用查询", topK: 5 });
const hit = [];
for (let i = 0; i < 10; i++) {
  const t = Date.now();
  await idx.recall({ text: "缓存命中用查询", topK: 5 });
  hit.push(Date.now() - t);
}
console.log(`   同一查询重复 10 次（embedding 缓存命中）：p50 ${ms(pct(hit, 50))}`);

// --- 4) rebuild 全量 ---------------------------------------------------------
const tR = Date.now();
await idx.rebuild(poolDir);
console.log(`⑤ rebuild #2（embedding 缓存命中）：${ms(Date.now() - tR)}　→ 剩余成本是 zvec 写入本身，不是 embedding`);

await idx.close();
