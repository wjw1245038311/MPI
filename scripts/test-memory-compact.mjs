/**
 * 索引压缩测试（真事故回归）
 *
 * 事故：zvec 每次写入落一个 ~5MB 段文件，且**不会自动合并**。跑了一天 16 条条目，
 *       `.zvec` 就涨到 128MB（真实测量值）；`optimizeSync()` 后回到 4.4MB。
 *       不压缩的话磁盘会按天线性增长。
 *
 * A) 纯函数：阈值判定（>32MB 或 >8 段）
 * B) 集成：真索引写入多条（产生多段）→ compact → 占用显著下降
 * C) JsonIndex.compact 存在且为空操作（接口一致性，调用方不用分支）
 *
 * 运行：npm run test:memorycompact（需要本机 embedding 端点）
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { ZvecIndex, embedText } = await import("../src/main/zhiya/zvec-index.ts");
const { JsonIndex } = await import("../src/main/zhiya/memory-index.ts");
const { COMPACT_LIMITS, shouldCompactFromStats } = await import("../src/main/memory-service.ts");

let n = 0;
const ok = (msg) => {
  n++;
  console.log(`  ✅ ${msg}`);
};

// --- A) 阈值判定 -------------------------------------------------------------
assert.equal(shouldCompactFromStats({ bytes: 0, segments: 0 }), false, "空索引不压");
assert.equal(shouldCompactFromStats({ bytes: COMPACT_LIMITS.bytes, segments: 1 }), false, "恰好等于阈值不压");
assert.equal(shouldCompactFromStats({ bytes: COMPACT_LIMITS.bytes + 1, segments: 1 }), true, "超字节阈值要压");
assert.equal(shouldCompactFromStats({ bytes: 1024, segments: COMPACT_LIMITS.segments + 1 }), true, "超段数阈值要压");
assert.equal(shouldCompactFromStats({ bytes: 1024, segments: COMPACT_LIMITS.segments }), false, "恰好等于段数阈值不压");
ok("阈值判定：>32MB 或 >8 段触发，边界值不触发");

// --- C) JsonIndex.compact 空操作不影响数据 -----------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "mpi-jsonidx-compact-"));
  const j = new JsonIndex(dir);
  await j.upsert([
    {
      id: "x1",
      text: "JSON 索引条目",
      type: "semantic",
      temporal: "retrospective",
      importance: 6,
      relevance: 0.6,
      project: "MPI",
      source: "test",
      status: "inbox",
      recurrence: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      path: "",
    },
  ]);
  await j.compact(); // 不应抛、不应清数据
  const hits = await j.recall({ text: "JSON 索引" });
  assert.ok(hits.length >= 1, "compact 后仍能检索到");
  await j.close();
  rmSync(dir, { recursive: true, force: true });
  ok("JsonIndex.compact 是安全空操作（接口一致，调用方无需分支）");
}

// --- B) 真索引压缩 -----------------------------------------------------------
try {
  await embedText("预检");
} catch (e) {
  console.log(`\n⚠️ 跳过集成部分：本机 embedding 端点不可用（${e.message}）`);
  console.log(`\ntest:memorycompact 全部通过（${n} 项）`);
  process.exit(0);
}

const dirStats = (root) => {
  let bytes = 0;
  let segments = 0;
  const walk = (d) => {
    for (const it of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, it.name);
      if (it.isDirectory()) walk(p);
      else {
        bytes += statSync(p).size;
        if (it.name.includes(".proxima")) segments++;
      }
    }
  };
  walk(root);
  return { bytes, segments };
};

const poolDir = mkdtempSync(join(tmpdir(), "mpi-zvec-compact-"));
const idx = await ZvecIndex.open(poolDir);
const mk = (i) => ({
  id: `c${i}-${"0".repeat(26 - String(i).length)}`,
  text: `压缩测试条目第 ${i} 条：记忆池索引碎片会在每次写入后累积，必须定期合并。`,
  type: "semantic",
  temporal: "retrospective",
  importance: 6,
  relevance: 0.6,
  project: "MPI",
  source: "test",
  status: "inbox",
  recurrence: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  path: "",
});

const N = 10;
for (let i = 0; i < N; i++) await idx.upsert([mk(i)]);
const root = join(poolDir, ".zvec");
const before = dirStats(root);
assert.equal(before.segments >= N, true, `写入 ${N} 次后应有至少 ${N} 个段文件，实际 ${before.segments}`);

await idx.compact();
const after = dirStats(root);
assert.ok(
  after.bytes < before.bytes / 2,
  `压缩后占用应至少减半：${(before.bytes / 1048576).toFixed(1)}MB → ${(after.bytes / 1048576).toFixed(1)}MB`,
);

// 压缩不能损坏检索
const hits = await idx.recall({ text: "索引碎片需要定期合并", topK: 3 });
assert.ok(hits.length > 0, "压缩后仍能检索到");
assert.ok(hits[0].id.startsWith("c"), `压缩后命中的仍是池内条目，实际 id=${hits[0].id}`);
assert.ok(hits[0].score > 0, "压缩后打分链路正常（score > 0）");
ok(
  `真索引压缩：${before.segments} 段 / ${(before.bytes / 1048576).toFixed(1)}MB → ` +
    `${after.segments} 段 / ${(after.bytes / 1048576).toFixed(1)}MB，且检索正常`,
);

await idx.close();
rmSync(poolDir, { recursive: true, force: true });
console.log(`\ntest:memorycompact 全部通过（${n} 项）`);
