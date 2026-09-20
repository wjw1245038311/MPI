/**
 * 记忆管道端到端测试（P1 验收）：候选 JSON → 落池 → 索引 → 召回
 * 用**真实 ZvecIndex**（embedding 不可用时自动退到 JsonIndex 并说明）。
 * 运行：npm run test:memorypipeline
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { ingestMemoryInbox } = await import("../src/main/memory-inbox.ts");
const { listEntries } = await import("../src/main/zhiya/pool.ts");
const { ZvecIndex } = await import("../src/main/zhiya/zvec-index.ts");
const { JsonIndex } = await import("../src/main/zhiya/memory-index.ts");

const root = mkdtempSync(join(tmpdir(), "mpi-pipeline-test-"));
const inbox = join(root, "inbox");
mkdirSync(inbox, { recursive: true });
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

let index;
let kind = "zvec";
try {
  index = await ZvecIndex.open(root);
} catch (e) {
  console.log(`⚠️ zvec 不可用（${e.message.split("\n")[0]}）→ 本次用 JsonIndex 验证管道（索引层细节由 test:zvecindex 覆盖）`);
  index = new JsonIndex(root);
  kind = "json";
}

const put = (name, obj) => writeFileSync(join(inbox, name), typeof obj === "string" ? obj : JSON.stringify(obj), "utf8");

// 模拟扩展写出的三条候选 + 一条重复 + 一条低分 + 一条坏 JSON
put("c1.json", {
  text: "zg 不提供代码调用图，调用图只有 alexandria 有。",
  type: "semantic", temporal: "retrospective", importance: 7, relevance: 0.71,
  project: "MPI", source: "ext:settled:abc123",
});
put("c2.json", {
  text: "推送前必须等用户确认，无人值守时只 commit 不 push。",
  type: "procedural", temporal: "present", importance: 9, relevance: 0.9,
  project: "global", source: "ext:settled:abc123",
});
put("c3.json", {
  text: "临时文件一律落在工作区根目录的 tempfile 下。",
  type: "semantic", temporal: "retrospective", importance: 6, relevance: 0.6,
  project: "global", source: "ext:settled:abc123",
});
put("c4-dup.json", { text: "zg 不提供代码调用图，调用图只有 alexandria 有。", importance: 8, relevance: 0.8, project: "MPI" });
put("c5-low.json", { text: "今天中午吃了拉面。", importance: 2, relevance: 0.7 });
put("c6-broken.json", "{ 不是合法 JSON");

const outcomes = await ingestMemoryInbox(inbox, { poolDir: root, index, log: (m) => console.log("   " + m) });
const byAction = outcomes.reduce((a, o) => ((a[o.action] = (a[o.action] || 0) + 1), a), {});
console.log("  摄入结果：", JSON.stringify(byAction));

assert.equal(byAction.add, 3, "三条新条目进池");
assert.equal(byAction.bump, 1, "重复条目判重累加");
assert.equal(byAction.drop, 1, "低分条目被阈值拦下");
assert.equal(byAction.error, 1, "坏 JSON 进 .failed");
console.log("  ✅ 摄入：3 新增 / 1 判重 / 1 阈值丢弃 / 1 坏 JSON");

const entries = listEntries(root).entries;
assert.equal(entries.length, 3, "池里恰好三条（判重不新增）");
const dup = entries.find((e) => e.text.includes("调用图"));
assert.equal(dup.recurrence, 2, "重复条目的复现计数为 2");
console.log("  ✅ 池文件：3 条，判重条目复现计数 = 2");

// 召回（走索引层）：语义查询应命中
const hits = await index.recall({ text: "谁能提供代码调用图", topK: 3 });
assert.ok(hits.length, "召回有结果");
const top = entries.find((e) => e.id === hits[0].id);
assert.match(top.text, /调用图/, `top1 应为调用图条目，实际：${top.text}`);
console.log(`  ✅ 召回（${kind}）：top1 = ${top.text.slice(0, 24)}`);

// 索引与真相源一致：删掉索引重建后结果不变
await index.rebuild(root);
const hits2 = await index.recall({ text: "谁能提供代码调用图", topK: 3 });
assert.equal(hits2[0].id, hits[0].id, "rebuild 后 top1 不变（索引是编译产物）");
console.log("  ✅ rebuild 后召回结果一致（真相源为准）");

// 幂等：再扫一次 inbox 应无事可做
assert.equal((await ingestMemoryInbox(inbox, { poolDir: root, index })).length, 0);
console.log("  ✅ 幂等：二次摄入为空");

await index.close();
console.log("\ntest:memorypipeline 全部通过（5 项）");
