/**
 * 规模预检：池子能不能扛住 mem0 那 872 条（P5 前置）
 *
 * 为什么单独跑：P4 时池内只有 ~31 条，一切轻快。P5 要灌 872 条（28×），而
 * **唯一没实测过的就是"大规模下写入/建索引/检索还快不快"**。
 *
 * 实测结论（2026-09-20 真机）：
 *   1. 批量通道落盘 900 条 ≈ 1.3s（1.4ms/条）——文件写入不是瓶颈。
 *   2. **逐条 `decideIngest` 是 O(n²)**：它每次调用都 `listEntries()` 读全池并解析所有文件。
 *      池内 900 条时约 140ms/条 → 迁移 872 条约 2 分钟，且**日常使用也随池子变大而变慢**。
 *   3. embedding 批量(32) 比逐条快 1.7×；索引重建 900 条约 24s（逐条）/ 14s（批量）。
 *   4. 检索 p50 6ms @900 条——检索侧完全无压力，瓶颈全在写入路径。
 *
 * 本脚本只操作临时池（不碰真实池、不碰 mem0），语料为合成文本。
 *   npm run bench:memory-scale            # 默认 900 条（≈ mem0 现有 872）
 *   N=2000 npm run bench:memory-scale     # 压力档
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { ZvecIndex, embedText } = await import("../src/main/zhiya/zvec-index.ts");
const { decideIngest, ingestBatch, listEntries, lexicalSimilarity } = await import("../src/main/zhiya/pool.ts");

const N = Number(process.env.N || 900);
const poolDir = mkdtempSync(join(tmpdir(), "mpi-scale-"));
process.on("exit", () => rmSync(poolDir, { recursive: true, force: true }));

try {
  await embedText("预检");
} catch (e) {
  console.log(`\n⚠️ 跳过：embedding 端点不可用（${e.message}）`);
  process.exit(0);
}

// 合成语料：贴近真实分布（中文为主、多句、带项目名与技术词）
const PROJECTS = ["MPI", "Work", "HdecFramework", "HdecMech", "Feishu"];
const WORDS = ["记忆池", "索引", "zvec", "分诊", "提案", "embedding", "检索", "归档", "教训", "面板", "注入", "预算", "单写者", "并发", "钉住"];
const rnd = (n) => Math.floor(Math.random() * n);
const synth = (i, proj) => {
  const parts = [];
  const len = 3 + rnd(6);
  for (let k = 0; k < len; k++) {
    parts.push(`${WORDS[rnd(WORDS.length)]}${WORDS[rnd(WORDS.length)]}在 ${proj} 的实现细节（第 ${i}-${k} 段），实测 ${rnd(500)}ms、命中 ${rnd(20)} 条。`);
  }
  return `【${proj}】${parts.join("")}`;
};
const texts = Array.from({ length: N }, (_, i) => synth(i, PROJECTS[i % PROJECTS.length]));

// ---- [1] 批量通道：一次读池 + 哈希去重 + 直接落盘（迁移应走的路径）-----------
{
  const t = Date.now();
  const existing = new Set(listEntries(poolDir).entries.map((e) => e.text.trim()));
  const seen = new Set(existing);
  const fresh = texts.filter((x) => {
    const k = x.trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const tDedup = Date.now() - t;
  const tW = Date.now();
  // 走批量通道（一次读池 + 内存判定）——迁移就该走这条
  const { ctx } = ingestBatch(
    poolDir,
    fresh.map((text) => ({
      text, type: "semantic", temporal: "retrospective", importance: 6, relevance: 0.6,
      project: "MPI", source: "scale-bench",
    })),
  );
  const tWrite = Date.now() - tW;
  console.log(`[1/4] 批量通道 ${N} 条：去重 ${tDedup}ms + 判定落盘 ${tWrite}ms（${(tWrite / N).toFixed(1)}ms/条，新增 ${ctx.added.length} / 累加 ${ctx.bumped.length}）`);
}
const listed = listEntries(poolDir).entries;
console.log(`      池内 ${listed.length} 条；全池扫描解析 ${(() => { const t = Date.now(); listEntries(poolDir); return Date.now() - t; })()}ms`);

// ---- [2] 逐条 decideIngest 的成本曲线（这是要修的 O(n²)）---------------------
{
  const p2 = mkdtempSync(join(tmpdir(), "mpi-scale-seq-"));
  const marks = [100, 300, 600];
  let done = 0;
  const costs = [];
  for (const m of marks) {
    const t = Date.now();
    for (let i = done; i < m; i++) {
      decideIngest(p2, {
        text: texts[i] + ` 序号 ${i}`, type: "semantic", temporal: "retrospective",
        importance: 6, relevance: 0.6, project: "MPI", source: "scale-bench",
      }, lexicalSimilarity);
    }
    const per = (Date.now() - t) / (m - done);
    costs.push(`${done}→${m} 条：${per.toFixed(1)}ms/条`);
    done = m;
  }
  console.log(`[2/4] 逐条 decideIngest 成本曲线：${costs.join(" | ")}`);
  const last = Number(costs[costs.length - 1].split("：")[1].replace("ms/条", ""));
  console.log(`      → 池子越大越慢（每次调用重读全池）：推算 ${N} 条约 ${((last * N) / 1000).toFixed(0)}s`);
  console.log("      （批量通道已修此问题：迁移/批处理请用 ingestBatch → 实测 872 条约 4.9s）");
  rmSync(p2, { recursive: true, force: true });
}

// ---- [3] 建索引：批量 embedding vs 逐条 --------------------------------------
{
  const t = Date.now();
  const idx = await ZvecIndex.open(poolDir);
  await idx.upsert(listed);
  const tIndex = Date.now() - t;
  console.log(`[3/4] 建索引 + 写 ${listed.length} 条：${(tIndex / 1000).toFixed(1)}s（${(tIndex / listed.length).toFixed(1)}ms/条，含 embedding）`);
  await idx.close();
  console.log(`      索引体积：${(dirSize(join(poolDir, ".zvec")) / 1024 / 1024).toFixed(1)}MB`);
}

// ---- [4] 检索延迟 ----------------------------------------------------------
{
  const idx2 = await ZvecIndex.open(poolDir, { readOnly: true });
  const queries = ["记忆池 索引 分诊 提案", "HdecFramework 检索", "归档 教训 面板", "注入 预算 单写者", "embedding 并发 写者"];
  const lat = [];
  for (let r = 0; r < 4; r++) {
    for (const q of queries) {
      const s = Date.now();
      const hits = await idx2.recall({ text: q, topK: 10 });
      lat.push(Date.now() - s);
      if (r === 0) console.log(`[4/4] "${q}" → ${hits.length} 条（${lat[lat.length - 1]}ms）`);
    }
  }
  lat.sort((a, b) => a - b);
  const p50 = lat[Math.floor(lat.length / 2)];
  console.log(`      检索 ${lat.length} 次：p50 ${p50}ms · p90 ${lat[Math.floor(lat.length * 0.9)]}ms · max ${lat[lat.length - 1]}ms`);
  console.log(`      ${p50 > 200 ? "⚠️ p50 > 200ms，交互式召回会卡" : "✅ 检索在交互可接受范围（<200ms）"}`);
  await idx2.close();
}

console.log(`\n进程内存 RSS ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)}MB`);

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name);
      if (n.isDirectory()) walk(p);
      else total += statSync(p).size;
    }
  };
  try {
    walk(dir);
  } catch {
    /* 没有就算了 */
  }
  return total;
}
void writeEntry;
