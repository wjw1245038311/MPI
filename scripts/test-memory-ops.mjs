/**
 * op 协议 + 执行器测试（P3-d）
 *
 * 这是**跨进程契约**：扩展只写 op 文件，主进程执行并把结果写回执。
 * 契约坏了的表现是"命令说已提交，但其实什么都没发生"——正是之前踩过的坑，
 * 所以每条路径（成功/缺参数/处理器抛错/未启用）都要钉住。
 *
 * 运行：npm run test:ops
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { ingestOne } = await import("../src/main/memory-inbox.ts");
const { appendOpResult, recentOpResults, opLogPath, approveProposal, rejectProposal, startDream } = await import(
  "../src/main/memory-ops.ts"
);
const { listProposals, writeProposal, readProposal, setProposalStatus } = await import("../src/main/zhiya/proposals.ts");
const { decideIngest, lexicalSimilarity, listEntries, newId } = await import("../src/main/zhiya/pool.ts");

let n = 0;
const ok = (msg) => {
  n++;
  console.log(`  ✅ ${msg}`);
};

const put = (dir, name, obj) => {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(obj), "utf8");
  return p;
};

// --- 回执日志 ---------------------------------------------------------------
{
  const pool = mkdtempSync(join(tmpdir(), "mpi-ops-log-"));
  assert.equal(recentOpResults(pool).length, 0, "没有日志时返回空数组");
  appendOpResult(pool, { at: "2026-09-20T01:00:00.000Z", op: "dream", id: null, ok: true, detail: "第一条" });
  appendOpResult(pool, { at: "2026-09-20T01:01:00.000Z", op: "approve", id: "abc", ok: false, detail: "第二条" });
  const recent = recentOpResults(pool, 10);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].detail, "第二条", "最新的在前");
  assert.equal(recent[1].op, "dream");
  assert.equal(recentOpResults(pool, 1).length, 1, "支持限制条数");
  assert.ok(readFileSync(opLogPath(pool), "utf8").split("\n").filter(Boolean).length === 2, "JSONL 一行一条");
  ok("回执日志：JSONL 追加、最新在前、条数限制");
  rmSync(pool, { recursive: true, force: true });
}

// --- op 分发：dream / approve / reject / 缺参数 / 抛错 ------------------------
{
  const pool = mkdtempSync(join(tmpdir(), "mpi-ops-dispatch-"));
  const results = [];
  const ops = {
    dream: async (op) => ({ detail: `干跑=${op.dryRun}` }),
    approve: async (id) => {
      if (id === "boom") throw new Error("落地炸了");
      return { detail: `批准了 ${id}` };
    },
    reject: async (id) => ({ detail: `拒绝了 ${id}` }),
    logResult: (r) => results.push(r),
  };
  const dep = { poolDir: pool, ops };

  const r1 = await ingestOne(put(pool, "dream.json", { op: "dream", dryRun: true }), dep);
  assert.equal(r1.action, "add");
  assert.equal(r1.detail, "干跑=true", "dream 的 dryRun 透传下去");
  assert.equal(existsSync(join(pool, "dream.json")), false, "op 文件处理后删除");
  assert.equal(results.at(-1).ok, true);

  const r2 = await ingestOne(put(pool, "ap.json", { op: "approve", id: "p1" }), dep);
  assert.equal(r2.detail, "批准了 p1");
  const r3 = await ingestOne(put(pool, "rj.json", { op: "reject", id: "p2" }), dep);
  assert.equal(r3.detail, "拒绝了 p2");

  // 缺 id → 判无效，不能把 undefined 传给处理器
  const r4 = await ingestOne(put(pool, "noid.json", { op: "approve" }), dep);
  assert.equal(r4.action, "invalid");
  assert.match(r4.detail, /缺少提案 id/);
  assert.equal(results.at(-1).ok, false, "失败也要写回执");

  // 处理器抛错 → 进 .failed + 回执记失败（不能静默）
  const r5 = await ingestOne(put(pool, "boom.json", { op: "approve", id: "boom" }), dep);
  assert.equal(r5.action, "error");
  assert.match(r5.detail, /落地炸了/);
  assert.equal(results.at(-1).ok, false);
  assert.equal(existsSync(join(pool, ".failed")), true, "失败的 op 进 .failed 可复查");
  ok("op 分发：dream 透传 dryRun、approve/reject 传 id、缺 id 判无效、抛错进 .failed 且都有回执");

  // 没有注入 ops → 明确报"未启用"，而不是假装成功
  const r6 = await ingestOne(put(pool, "noops.json", { op: "approve", id: "x" }), { poolDir: pool });
  assert.equal(r6.action, "invalid");
  assert.match(r6.detail, /未启用/);
  ok("未注入处理器 → invalid「操作未启用」（绝不假装成功）");

  // 未知 op
  const r7 = await ingestOne(put(pool, "weird.json", { op: "explode" }), dep);
  assert.equal(r7.action, "invalid");
  assert.match(r7.detail, /不支持的操作/);
  ok("未知 op → invalid（不猜、不静默）");
  rmSync(pool, { recursive: true, force: true });
}

// --- 端到端：approve 真落地（kb）+ reject 留痕 -------------------------------
{
  const pool = mkdtempSync(join(tmpdir(), "mpi-ops-e2e-"));
  const lessons = mkdtempSync(join(tmpdir(), "mpi-ops-lessons-"));
  const e = decideIngest(
    pool,
    { text: "扩展自包含。", type: "semantic", temporal: "retrospective", importance: 7, relevance: 0.7, project: "MPI", source: "test" },
    lexicalSimilarity,
  ).entry;

  const p = {
    id: newId(),
    createdAt: new Date().toISOString(),
    kind: "promote-kb",
    status: "pending",
    outlet: "kb",
    entries: [e.id],
    reason: "本项目知识",
    title: "Ext self contained",
    body: "---\nlesson: ext-self-contained\n---\n\n# Ext\n\n## Guard\n\n自包含。\n",
    target: null,
    decidedAt: null,
    result: null,
  };
  writeProposal(pool, p);

  const deps = {
    poolDir: pool,
    apply: { index: { upsert: async () => {}, remove: async () => {} } },
    log: () => {},
  };
  const done = await approveProposal({ ...deps, apply: { ...deps.apply, kbLessonsDir: lessons } }, p.id);
  assert.ok(done.detail.includes("ExtSelfContained.md"), `批准时应落地：${done.detail}`);
  assert.equal(existsSync(join(lessons, "ExtSelfContained.md")), true, "lesson 真写出来了");
  assert.equal(readProposal(pool, p.id).status, "applied", "提案状态 applied");
  assert.equal(listEntries(pool).entries.find((x) => x.id === e.id).status, "promoted", "条目已标记晋升");
  assert.equal(recentOpResults(pool).at(-1).op, "approve", "回执记下来了");

  // 已 applied 的不能再批准
  await assert.rejects(() => approveProposal(deps, p.id), /不能批准/, "重复批准要报错");
  ok("approve 端到端：lesson 落地 + 条目晋升 + 回执；重复批准被拒");

  // reject：留痕
  const p2 = { ...p, id: newId(), status: "pending" };
  writeProposal(pool, p2);
  const rej = await rejectProposal(deps, p2.id);
  assert.ok(rej.detail.includes("已拒绝"));
  assert.equal(readProposal(pool, p2.id).status, "rejected");
  assert.equal(
    listProposals(pool).proposals.find((x) => x.id === p2.id).decidedAt !== null,
    true,
    "拒绝也记时间（留痕）",
  );
  await assert.rejects(() => rejectProposal(deps, "不存在的提案id"), /找不到提案/);
  ok("reject：状态置 rejected 并留时间戳；不存在的提案报错而不是静默");

  // dream：单飞守卫（已有任务在跑时不叠加）
  const r = await startDream({ ...deps, isDreaming: () => true, setDreaming: () => {} }, true);
  assert.match(r.detail, /进行中/, "正在跑时拒绝再启动");
  ok("dream 单飞：已在跑时拒绝叠加启动");
  rmSync(pool, { recursive: true, force: true });
  rmSync(lessons, { recursive: true, force: true });
}

console.log(`\ntest:ops 全部通过（${n} 项）`);
