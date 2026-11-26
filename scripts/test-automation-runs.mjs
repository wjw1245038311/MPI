// 定时任务运行历史（automation-runs-store.ts）单测。
//
// 背景：批次 B 要把「每次运行」变成可查对象（时间 / 触发方式 / 结果 / 会话文件），
// 侧栏红点与「待查看」也依赖这份数据。这里钉住：追加、回填、两层上限淘汰、
// 损坏文件降级、未查看计数。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 源码用无扩展名的跨文件 import，node 需要这个解析器。
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { loadConfig } = await import("../src/main/config.ts");
const store = await import("../src/main/automation-runs-store.ts");

let checks = 0;
const ok = (label) => {
  checks++;
  return label;
};

const dataDir = mkdtempSync(join(tmpdir(), "mpi-automation-runs-"));
const runsFile = join(dataDir, "automation-runs.json");

try {
  loadConfig(dataDir); // 把 getConfigDir() 指向临时目录

  // ---- 基本追加与回填 -----------------------------------------------------
  // 空历史
  assert.equal(store.unreviewedFailureCount(), 0, ok("初始无未查看失败"));
  assert.deepEqual(store.listRuns("task-a"), [], ok("初始历史为空"));

  const run1 = store.startRun({ taskId: "task-a", trigger: "schedule", startedAt: 1000 });
  assert.equal(run1.taskId, "task-a", ok("新建记录带 taskId"));
  assert.equal(run1.status, "skipped", ok("初始状态是 skipped（尚未有结论）"));
  assert.equal(run1.startedAt, 1000, ok("初始时间戳保留"));

  // 回填成功
  store.updateRun(run1.id, { status: "ok", finishedAt: 2000, sessionFile: "/tmp/x.jsonl", model: "p/m" });
  let runs = store.listRuns("task-a");
  assert.equal(runs.length, 1, ok("回填后仍是一条"));
  assert.equal(runs[0].status, "ok", ok("回填状态生效"));
  assert.equal(runs[0].finishedAt, 2000, ok("回填完成时间"));
  assert.equal(runs[0].sessionFile, "/tmp/x.jsonl", ok("回填会话文件"));
  assert.equal(runs[0].model, "p/m", ok("回填模型"));

  // updateRun 找不到的 id 返回 false（历史被清空时不该抛）
  assert.equal(store.updateRun("run-does-not-exist", { status: "ok" }), false, ok("更新不存在的记录返回 false"));

  // ---- 写入落盘（flush 后读文件）-----------------------------------------
  store.flushAutomationRuns();
  const onDisk = JSON.parse(readFileSync(runsFile, "utf8"));
  assert.equal(onDisk.version, 1, ok("文件带 version"));
  assert.equal(onDisk.runs["task-a"].length, 1, ok("文件里按任务分组"));
  assert.equal(onDisk.runs["task-a"][0].status, "ok", ok("文件内容与内存一致"));

  // ---- 失败 + 未查看计数 -------------------------------------------------
  const failA = store.startRun({ taskId: "task-a", trigger: "schedule", startedAt: 3000 });
  store.updateRun(failA.id, { status: "error", finishedAt: 3500, error: "Connection error." });
  const failB = store.startRun({ taskId: "task-b", trigger: "manual", startedAt: 4000 });
  store.updateRun(failB.id, { status: "aborted", finishedAt: 4500, error: "运行超时（30 分钟），任务已停止" });
  assert.equal(store.unreviewedFailureCount(), 2, ok("error 与 aborted 都算未查看失败"));

  // missed 不算失败（它是「没跑」，不消耗注意力红点）
  const missedRun = store.startRun({ taskId: "task-b", trigger: "schedule", startedAt: 5000 });
  store.updateRun(missedRun.id, { status: "missed", finishedAt: 5000 });
  assert.equal(store.unreviewedFailureCount(), 2, ok("missed 不计入未查看失败"));

  // 标记已查看
  assert.equal(store.markRunsReviewed(), 2, ok("标记全部已查看返回 2"));
  assert.equal(store.unreviewedFailureCount(), 0, ok("标记后归零"));

  // 只标记指定 id
  const failC = store.startRun({ taskId: "task-c", trigger: "schedule", startedAt: 6000 });
  store.updateRun(failC.id, { status: "error", finishedAt: 6100, error: "boom" });
  const failD = store.startRun({ taskId: "task-c", trigger: "schedule", startedAt: 7000 });
  store.updateRun(failD.id, { status: "error", finishedAt: 7100, error: "boom2" });
  assert.equal(store.markRunsReviewed([failC.id]), 1, ok("按 id 标记只改一条"));
  assert.equal(store.unreviewedFailureCount(), 1, ok("剩下那条仍未查看"));

  // ---- 每任务 30 条上限 --------------------------------------------------
  for (let i = 0; i < 40; i++) {
    const r = store.startRun({ taskId: "task-flood", trigger: "schedule", startedAt: 10_000 + i });
    store.updateRun(r.id, { status: "ok", finishedAt: 10_000 + i });
  }
  const flood = store.listRuns("task-flood", 100);
  assert.equal(flood.length, store.MAX_RUNS_PER_TASK, ok("每任务最多保留 30 条"));
  // 保留的是最新的 30 条：最新一条是 startedAt 10039
  assert.equal(flood[0].startedAt, 10_039, ok("listRuns 最新在前"));
  assert.equal(flood[flood.length - 1].startedAt, 10_010, ok("保留最新的 30 条（旧的被淘汰）"));

  // ---- 全局 500 条上限 ---------------------------------------------------
  for (let t = 0; t < 20; t++) {
    for (let i = 0; i < 30; i++) {
      const r = store.startRun({ taskId: `bulk-${t}`, trigger: "schedule", startedAt: 20_000 + t * 100 + i });
      store.updateRun(r.id, { status: "ok", finishedAt: 20_000 + t * 100 + i });
    }
  }
  store.flushAutomationRuns();
  const afterBulk = JSON.parse(readFileSync(runsFile, "utf8"));
  const total = Object.values(afterBulk.runs).reduce((n, list) => n + list.length, 0);
  assert.ok(total <= store.MAX_RUNS_TOTAL, `全局上限：实际 ${total} 条 ≤ ${store.MAX_RUNS_TOTAL}`);
  assert.equal(total, store.MAX_RUNS_TOTAL, ok("全局上限被精确执行（删除最旧的直到刚好等于上限）"));

  // ---- 删除任务的历史 ----------------------------------------------------
  // 注意：全局淘汰会把最早的（bulk-0/bulk-1…）删掉，所以这里先建一条肯定存在的
  // 分组再删，不依赖那些可能已被淘汰的任务。
  const survivor = store.startRun({ taskId: "bulk-19", trigger: "schedule", startedAt: 99_999 });
  store.updateRun(survivor.id, { status: "ok", finishedAt: 100_000 });
  store.flushAutomationRuns();
  const before = JSON.parse(readFileSync(runsFile, "utf8"));
  assert.ok(before.runs["bulk-19"], ok("目标分组删除前存在"));
  const beforeCount = Object.keys(before.runs).length;

  store.deleteRunsForTask("bulk-19");
  store.flushAutomationRuns();
  const afterDelete = JSON.parse(readFileSync(runsFile, "utf8"));
  assert.equal(afterDelete.runs["bulk-19"], undefined, ok("deleteRunsForTask 清掉该任务的分组"));
  assert.equal(Object.keys(afterDelete.runs).length, beforeCount - 1, ok("分组数减少 1"));

  // ---- 损坏文件降级 ------------------------------------------------------
  store.resetAutomationRunsCache();
  writeFileSync(runsFile, "{ this is not json ", "utf8");
  assert.deepEqual(store.listRuns("task-a"), [], ok("损坏文件按空历史处理，不抛"));
  assert.equal(store.unreviewedFailureCount(), 0, ok("损坏文件下计数为 0"));

  // 部分损坏：数组里混入非法项 → 只丢非法项
  store.resetAutomationRunsCache();
  writeFileSync(
    runsFile,
    JSON.stringify({
      version: 1,
      runs: {
        "task-x": [
          { id: "good", taskId: "task-x", trigger: "schedule", status: "ok", startedAt: 100 },
          { id: "", taskId: "task-x", status: "ok" }, // 缺 id → 丢
          null,
          { id: "nocode", taskId: "task-x", status: "bogus", startedAt: 200 }, // 未知状态 → 归 error
        ],
      },
    }),
    "utf8",
  );
  const partial = store.listRuns("task-x");
  assert.equal(partial.length, 2, ok("非法项被丢弃，合法项保留"));
  assert.equal(partial.find((r) => r.id === "nocode").status, "error", ok("未知状态归一为 error"));

  // ---- 未知任务 / 空任务 id ----------------------------------------------
  assert.deepEqual(store.listRuns("never-existed"), [], ok("查询不存在的任务返回空数组"));
  assert.deepEqual(Object.keys(store.latestRunsByTask()).length > 0, true, ok("latestRunsByTask 有摘要"));

  // ---- 时间戳缺失容错 ----------------------------------------------------
  store.resetAutomationRunsCache();
  writeFileSync(
    runsFile,
    JSON.stringify({ version: 1, runs: { t: [{ id: "n", taskId: "t", trigger: "schedule", status: "ok" }] } }),
    "utf8",
  );
  const noAt = store.listRuns("t");
  assert.equal(noAt.length, 1, ok("缺 startedAt 仍可读"));
  assert.ok(typeof noAt[0].startedAt === "number" && noAt[0].startedAt > 0, ok("缺 startedAt 时补当前时间"));
} finally {
  store.resetAutomationRunsCache();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`automation-runs ok (${checks} 项断言通过)`);
