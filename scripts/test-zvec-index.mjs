/**
 * ZvecIndex 验收测试（P0-3）
 *   A) 功能：写 → 检索命中 → 删除 → 搜不到 → 重建后恢复
 *   B) 纪律 1（读者 readOnly）：多个读者并发检索必须全部成功
 *   C) 纪律 2（写者短持有 + 重试）：3 读者并发检索 + 1 写者并发写入 → 零失败
 *   D) 纪律 3（重建不原地做）：读者正在检索时执行 rebuild → 两者都不崩
 *
 * 需要：本机 embedding 端点（:1235）可用；不可用时整测跳过（不算失败，但要显式说明）。
 * 运行：npm run test:zvecindex
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { ZvecIndex, embedText } = await import("../src/main/zhiya/zvec-index.ts");
const { decideIngest, lexicalSimilarity } = await import("../src/main/zhiya/pool.ts");

const EMBED = process.env.MPI_ZHIYA_EMBED_URL || "http://127.0.0.1:1235/v1/embeddings";
const poolDir = mkdtempSync(join(tmpdir(), "mpi-zvec-test-"));
process.on("exit", () => rmSync(poolDir, { recursive: true, force: true }));

// embedding 可用性预检
try {
  await embedText("预检");
} catch (e) {
  console.log(`\n⚠️ 跳过 test:zvecindex：本机 embedding 端点不可用（${EMBED}）\n   ${e.message}`);
  process.exit(0);
}

const add = (text, over = {}) => decideIngest(poolDir, {
  text, type: "semantic", temporal: "retrospective", importance: 7, relevance: 0.7,
  project: "MPI", source: "test", ...over,
}, lexicalSimilarity);

const seed = [
  "zg 不提供代码调用图，调用图只有 alexandria 有。",
  "mem0 的 BM25 稀疏检索因为 fastembed 未安装而静默失效。",
  "临时文件一律落在工作区根目录的 tempfile 下。",
  "推送前必须等用户确认，无人值守时只 commit 不 push。",
];
for (const s of seed) assert.equal(add(s).action, "add");

let n = 0;
const ok = (name) => { n++; console.log(`  ✅ ${name}`); };

// --- A) 功能 -----------------------------------------------------------------
const idx = await ZvecIndex.open(poolDir);
await idx.rebuild(poolDir);

const hits = await idx.recall({ text: "谁能给我代码调用图", topK: 3 });
assert.ok(hits.length, "检索应返回结果");
const { listEntries } = await import("../src/main/zhiya/pool.ts");
const byId = new Map(listEntries(poolDir).entries.map((e) => [e.id, e]));
assert.match(byId.get(hits[0].id).text, /调用图/, `top1 应是调用图那条，实际：${byId.get(hits[0].id).text}`);
ok("rebuild 后语义检索命中 top1");

const sem = await idx.recall({ text: "中文记忆搜索为什么不好使", topK: 2 });
assert.match(byId.get(sem[0].id).text, /fastembed|稀疏检索/, `语义命中应指向 fastembed 那条，实际：${byId.get(sem[0].id).text}`);
ok("语义召回：换了说法仍能命中（关键词不重叠）");

const filtered = await idx.recall({ text: "调用图", topK: 5, filter: { project: "MPI" } });
assert.ok(filtered.length && filtered.every((h) => byId.get(h.id).project === "MPI"), "标量过滤应生效");
ok("标量过滤（project）生效");

const noText = await idx.recall({ text: "", topK: 4 });
assert.equal(noText.length, 4, "无查询文本时按时间/重要性取回");
ok("空查询按时间+重要性排序");

const victim = hits[0].id;
await idx.remove([victim]);
const afterDel = await idx.recall({ text: "调用图", topK: 5 });
assert.ok(!afterDel.some((h) => h.id === victim), "删除后不应再被检索到");
ok("remove 生效");

await idx.rebuild(poolDir);
const afterRebuild = await idx.recall({ text: "调用图", topK: 5 });
assert.ok(afterRebuild.some((h) => h.id === victim), "文件真相源里还在 → rebuild 应恢复");
ok("rebuild 从文件真相源恢复（真相源与索引一致性）");

// --- B/C) 并发 ---------------------------------------------------------------
const runWorker = (role, count) => new Promise((res, rej) => {
  const p = spawn(process.execPath, ["--experimental-strip-types", "scripts/zvec-probe-worker.mjs", role, poolDir, String(count)], {
    cwd: process.cwd(), encoding: "utf8",
  });
  let out = "";
  let err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  p.on("close", (code) => {
    if (code !== 0) return rej(new Error(`worker ${role} 退出码 ${code}: ${err.slice(0, 200)}`));
    try {
      res(JSON.parse(out.trim().split("\n").pop()));
    } catch {
      rej(new Error(`worker ${role} 输出无法解析: ${out.slice(0, 200)}`));
    }
  });
});

console.log("   … 并发：3 读者 × 20 次检索 + 1 写者 × 5 次写入");
const t0 = Date.now();
const [r1, r2, r3, w] = await Promise.all([runWorker("reader", 20), runWorker("reader", 20), runWorker("reader", 20), runWorker("writer", 5)]);
const wall = Date.now() - t0;
const readers = [r1, r2, r3];
const readerOk = readers.reduce((a, r) => a + r.ok, 0);
const readerFail = readers.reduce((a, r) => a + r.fail, 0);
const readerMax = Math.max(...readers.map((r) => r.maxWaitMs));
console.log(`      读者 ${readerOk}/60 成功、失败 ${readerFail}、单次最长 ${readerMax}ms`);
console.log(`      写者 ${w.ok}/5 成功、失败 ${w.fail}、单次最长 ${w.maxWaitMs}ms；总墙钟 ${wall}ms`);
assert.equal(readerFail, 0, "读者不得失败（纪律 1：readOnly + 重试）");
assert.equal(w.ok, 5, "写者不得失败（纪律 2：短持有 + 20ms 重试）");
ok("并发零失败（3 读 × 20 + 1 写 × 5）");

// --- D) 读者进行中做 rebuild -------------------------------------------------
console.log("   … 读者检索期间执行 rebuild");
const readerPromise = runWorker("reader", 8);
const tR = Date.now();
await new Promise((r) => setTimeout(r, 150));
await idx.rebuild(poolDir);
const during = await readerPromise;
console.log(`      rebuild 用时 ${Date.now() - tR}ms；读者 ${during.ok}/8 成功、失败 ${during.fail}`);
assert.equal(during.fail, 0, "rebuild 期间读者应靠重试全部成功（纪律 3）");
ok("重建不原地做：读者在 rebuild 期间全部成功");

// --- 自愈：池里有条目但索引为空 → 打开时自动重建 -----------------------------
console.log("   … 自愈重建（索引被删但池里有文件）");
const { rmSync: rmR, mkdtempSync: mkT } = await import("node:fs");
const { tmpdir: td } = await import("node:os");
const healDir = mkT(join(td(), "mpi-heal-"));
process.on("exit", () => rmR(healDir, { recursive: true, force: true }));
for (const s of seed) assert.equal(decideIngest(healDir, { text: `${s}（自愈用）`, type: "semantic", temporal: "retrospective", importance: 7, relevance: 0.7, project: "MPI", source: "heal" }, lexicalSimilarity).action, "add");
const idx1 = await ZvecIndex.open(healDir);
await idx1.rebuild(healDir);
await idx1.close();
rmR(join(healDir, ".zvec"), { recursive: true, force: true }); // 模拟索引丢失
const idx2 = await ZvecIndex.open(healDir);
const healed = await idx2.recall({ text: "谁能给我代码调用图", topK: 3 });
assert.ok(healed.length > 0, "重建后应能检索到");
const healedEntries = (await import("../src/main/zhiya/pool.ts")).listEntries(healDir).entries;
assert.match(healedEntries.find((e) => e.id === healed[0].id).text, /调用图/, "top1 仍是正确条目");
await idx2.close();
ok("索引丢失后打开自动重建（索引是编译产物，丢了不丢记忆）");

await idx.close();
console.log(`\ntest:zvecindex 全部通过（${n} 项）`);
