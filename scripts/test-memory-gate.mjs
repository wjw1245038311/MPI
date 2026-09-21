/**
 * 手动写入重要性把关（gateManualImportance）测试。
 *
 * 背景：minibox 2026-09-21 实测——importance<4 的条目被主进程按 minImportance:4
 * 静默 drop，但 /memory、/memory-remember、memory_note 仍回「已记入记忆池」。
 * 修复 = 入队前把关 + 如实回报；本测试锁住把关语义与阈值一致性。
 *
 * 特殊做法（同 test-memory-command.mjs）：扩展文件自包含、import 不到本仓模块，
 * 所以从扩展源码里**抽出那段逻辑再跑**，避免两处漂移。
 * 运行：npm run test:memorygate
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transform } from "esbuild";

const SRC = "src/main/mpi-memory-ext.ts";
const src = readFileSync(SRC, "utf8");

// ---- 抽取出 MIN_IMPORTANCE + gateManualImportance（锚点：注释头 → const log）----
const start = src.indexOf("/** 低于这个重要性连 inbox 都不进");
const end = src.indexOf("\n\nconst log =");
assert.ok(start > 0 && end > start, "能从扩展源码里定位到把关段");
const block = src.slice(start, end).replace(/^export /gm, "");
const js = (await transform(block, { loader: "ts", target: "es2022" })).code;
const factory = new Function(`${js}\nreturn { MIN_IMPORTANCE, gateManualImportance };`);
const { MIN_IMPORTANCE, gateManualImportance } = factory();

// ---- 阈值一致性：扩展侧必须与 main 侧 pool.ts THRESHOLD.minImportance 相同（改一处漏一处的漂移守卫）----
const poolSrc = readFileSync("src/main/zhiya/pool.ts", "utf8");
const m = /minImportance:\s*(\d+)/.exec(poolSrc);
assert.ok(m, "pool.ts 里应能定位到 THRESHOLD.minImportance");
assert.equal(MIN_IMPORTANCE, Number(m[1]), `扩展 MIN_IMPORTANCE=${MIN_IMPORTANCE} 与 pool.ts minImportance=${m[1]} 不一致`);

let n = 0;
const ok = (name) => {
  n++;
  console.log(`  ✅ ${name}`);
};

// ≥ 下限：原样通过（两种模式）
assert.equal(gateManualImportance(4, false), 4);
ok("score=4（恰好压线）→ 通过");
assert.equal(gateManualImportance(7, false), 7);
ok("score=7 → 原样通过");
assert.equal(gateManualImportance(10, true), 10);
ok("score=10 verbatim → 原样通过");

// < 下限、非原文模式：丢弃（返回 null，调用方如实报「未写入」）
assert.equal(gateManualImportance(3, false), null);
ok("score=3 /memory → 丢弃（null）");
assert.equal(gateManualImportance(1, false), null);
ok("score=1 memory_note → 丢弃（null）");

// < 下限、原文模式：显式「存这条」指令，模型评分不得否决 → 钳到下限
assert.equal(gateManualImportance(3, true), MIN_IMPORTANCE);
ok(`score=3 /memory-remember → 钳到 ${MIN_IMPORTANCE} 强制保留`);
assert.equal(gateManualImportance(1, true), MIN_IMPORTANCE);
ok(`score=1 /memory-remember → 钳到 ${MIN_IMPORTANCE} 强制保留`);

console.log(`\n✅ gateManualImportance：${n} 项断言全过（阈值与 pool.ts 一致 = ${MIN_IMPORTANCE}）`);
