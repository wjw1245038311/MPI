/**
 * 延迟定位：recall 的 240ms 花在哪？
 *   A) 纯 embedding
 *   B) 开合只读句柄（空操作）
 *   C) 只向量查询 / 只全文查询 / 两者都做
 *   D) 端到端 recall
 * 运行：npm run diag:latency
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { ZvecIndex, embedText } = await import("../src/main/zhiya/zvec-index.ts");
const { decideIngest, lexicalSimilarity, listEntries } = await import("../src/main/zhiya/pool.ts");

const N = 100;
const poolDir = mkdtempSync(join(tmpdir(), "mpi-lat-"));
process.on("exit", () => rmSync(poolDir, { recursive: true, force: true }));

// 造 N 条互不相同的条目（每条带唯一随机 token，避免被判重）
let seed = 1;
const rnd = () => Math.random().toString(36).slice(2, 8);
for (let i = 0; i < N; i++) {
  decideIngest(poolDir, {
    text: `基准条目 ${i}：${rnd()}${rnd()} 关于 ${["索引", "部署", "权限", "记忆", "向量", "缓存"][i % 6]} 的说明`,
    type: "semantic", temporal: "retrospective", importance: (i % 9) + 1, relevance: 0.7,
    project: "MPI", source: `lat#${i}`,
  }, lexicalSimilarity);
}
const entries = listEntries(poolDir).entries;
console.log(`池子：${entries.length} 条\n`);

const idx = await ZvecIndex.open(poolDir);
const tR = Date.now();
await idx.rebuild(poolDir);
console.log(`rebuild：${Date.now() - tR}ms（${((Date.now() - tR) / entries.length).toFixed(1)}ms/条）\n`);

const avg = async (n, fn) => {
  const t = Date.now();
  for (let i = 0; i < n; i++) await fn(i);
  return (Date.now() - t) / n;
};

const q = "索引相关的条目";
const A = await avg(10, async (i) => embedText(`${q}${i}`));
console.log(`A) embedding 单价：${A.toFixed(1)}ms`);

const zvec = await import("@zvec/zvec");
zvec.ZVecSetDefaultJiebaDictDir(join(process.cwd(), "node_modules/@zvec/bindings-win32-x64/jieba_dict"));
const root = join(poolDir, ".zvec");
const B = await avg(15, () => {
  const c = zvec.ZVecOpen(root, { readOnly: true });
  c.closeSync();
});
console.log(`B) 开+关只读句柄：${B.toFixed(1)}ms`);

const qv = await embedText(q);
const C1 = await avg(15, () => {
  const c = zvec.ZVecOpen(root, { readOnly: true });
  c.querySync({ fieldName: "embedding", vector: qv, topk: 20 });
  c.closeSync();
});
console.log(`C1) 开合 + 向量查询：${C1.toFixed(1)}ms`);

const C2 = await avg(15, () => {
  const c = zvec.ZVecOpen(root, { readOnly: true });
  c.querySync({ fieldName: "text", fts: { matchString: q }, topk: 20 });
  c.closeSync();
});
console.log(`C2) 开合 + 全文查询：${C2.toFixed(1)}ms`);

const C3 = await avg(15, () => {
  const c = zvec.ZVecOpen(root, { readOnly: true });
  c.querySync({ fieldName: "embedding", vector: qv, topk: 20 });
  c.querySync({ fieldName: "text", fts: { matchString: q }, topk: 20 });
  c.closeSync();
});
console.log(`C3) 开合 + 两条查询：${C3.toFixed(1)}ms`);

// 同句柄复用：开一次，查多次
const cs = zvec.ZVecOpen(root, { readOnly: true });
const C4 = await avg(15, () => {
  cs.querySync({ fieldName: "embedding", vector: qv, topk: 20 });
  cs.querySync({ fieldName: "text", fts: { matchString: q }, topk: 20 });
});
cs.closeSync();
console.log(`C4) 复用句柄 + 两条查询：${C4.toFixed(1)}ms  ← 句柄复用省下的就是开合成本`);

const D = await avg(10, (i) => idx.recall({ text: `${q}${i}`, topK: 5 }));
console.log(`\nD) 端到端 recall（现实现）：${D.toFixed(1)}ms`);
await idx.close();
