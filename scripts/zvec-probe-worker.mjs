/**
 * zvec 并发探针 worker（供 test-zvec-index.mjs 派生）
 *   node --experimental-strip-types scripts/zvec-probe-worker.mjs <reader|writer> <poolDir> <n>
 * 输出一行 JSON：{ ok, fail, retries, maxWaitMs }
 */
import { register } from "node:module";
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const [role, poolDir, nRaw] = process.argv.slice(2);
const n = Number(nRaw || 20);
const { ZvecIndex } = await import("../src/main/zhiya/zvec-index.ts");
const { listEntries } = await import("../src/main/zhiya/pool.ts");

const idx = await ZvecIndex.open(poolDir);
const { entries } = listEntries(poolDir);
let ok = 0;
let fail = 0;
let retries = 0;
let maxWait = 0;

for (let i = 0; i < n; i++) {
  const t0 = Date.now();
  try {
    if (role === "reader") {
      const hits = await idx.recall({ text: ["代码调用图", "中文检索失效", "临时文件放哪", "推送前确认"][i % 4], topK: 3 });
      if (!hits.length) throw new Error("空结果");
    } else {
      const e = entries[i % entries.length];
      await idx.upsert([{ ...e, id: `${e.id}`, text: `${e.text}`, importance: ((i % 9) + 1) }]);
    }
    ok++;
  } catch (err) {
    fail++;
    if (/lock/i.test(String(err.message))) retries++;
  }
  maxWait = Math.max(maxWait, Date.now() - t0);
  await new Promise((r) => setTimeout(r, 15));
}

await idx.close();
console.log(JSON.stringify({ role, ok, fail, retries, maxWaitMs: maxWait }));
