/**
 * 诊断：引擎分数到底是什么语义？
 *   A) vector-only 查询的原始 score（对比 JS 里手算的余弦相似度作基准真值）
 *   B) FTS 查询的原始 score
 *   C) multiQuery weighted 融合后的 score
 * 目的：确认是"我把距离当相似度"还是"融合分数不可用"。
 */
import { createRequire } from "node:module";
import { join } from "node:path";
const req = createRequire(import.meta.url);
const zvec = await import("@zvec/zvec");
zvec.ZVecSetDefaultJiebaDictDir(
  join(process.cwd(), "node_modules/@zvec/bindings-win32-x64/jieba_dict"),
);

const ROOT = process.argv[2];
const col = zvec.ZVecOpen(ROOT, { readOnly: true });

const embed = async (t) =>
  (await (await fetch("http://127.0.0.1:1235/v1/embeddings", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: t }),
  })).json()).data[0].embedding;

const cos = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
};

const Q = "谁能给我代码调用图";
const qv = await embed(Q);
console.log(`查询：${Q}\n`);

console.log("=== A) vector-only（includeVector，手算余弦作真值）===");
const va = col.querySync({ fieldName: "embedding", vector: qv, topk: 5, includeVector: true });
for (const d of va) {
  const v = d.vectors?.embedding;
  const sim = v ? cos(qv, Array.from(v)) : NaN;
  console.log(`  engine=${String(d.score).padEnd(10)} 手算余弦=${sim.toFixed(4)}  ${String(d.fields.text).slice(0, 30)}`);
}

console.log("\n=== B) FTS only ===");
const fb = col.querySync({ fieldName: "text", fts: { matchString: Q }, topk: 5 });
for (const d of fb) console.log(`  engine=${String(d.score).padEnd(10)} ${String(d.fields.text).slice(0, 34)}`);
if (!fb.length) console.log("  （无命中）");

console.log("\n=== C) multiQuery weighted [1,1] ===");
const mc = col.multiQuerySync({
  queries: [
    { fieldName: "embedding", vector: qv, topk: 20 },
    { fieldName: "text", fts: { matchString: Q }, topk: 20 },
  ],
  rerank: { type: "weighted", weights: [1, 1] },
});
for (const d of mc.slice(0, 5)) console.log(`  engine=${String(d.score).padEnd(10)} ${String(d.fields.text).slice(0, 34)}`);

console.log("\n=== D) multiQuery 默认（RRF k=60）===");
const mr = col.multiQuerySync({
  queries: [
    { fieldName: "embedding", vector: qv, topk: 20 },
    { fieldName: "text", fts: { matchString: Q }, topk: 20 },
  ],
});
for (const d of mr.slice(0, 5)) console.log(`  engine=${String(d.score).padEnd(10)} ${String(d.fields.text).slice(0, 34)}`);
col.closeSync();
