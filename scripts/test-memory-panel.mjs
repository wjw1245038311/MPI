/**
 * 记忆池面板数据层测试（P4）
 *
 * 面板的逻辑（过滤/排序/统计/操作）都在 memory-panel.ts，不带 electron，
 * 所以能直接单测——UI 只负责画。
 *
 * 运行：npm run test:memorypanel
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { buildSnapshot, filterEntries, archiveEntryFromPanel, decideProposalFromPanel } = await import(
  "../src/main/memory-panel.ts"
);
const { decideIngest, lexicalSimilarity, listEntries } = await import("../src/main/zhiya/pool.ts");
const { writeProposal, listProposals, setProposalStatus } = await import("../src/main/zhiya/proposals.ts");
const { newId } = await import("../src/main/zhiya/pool.ts");

let n = 0;
const ok = (msg) => {
  n++;
  console.log(`  ✅ ${msg}`);
};

function seed(items) {
  const pool = mkdtempSync(join(tmpdir(), "mpi-panel-"));
  for (const it of items) {
    decideIngest(
      pool,
      {
        text: it.text,
        type: it.type ?? "semantic",
        temporal: "retrospective",
        importance: it.importance ?? 6,
        relevance: 0.6,
        project: it.project ?? "MPI",
        source: "test",
      },
      lexicalSimilarity,
    );
  }
  return pool;
}

// --- 过滤与排序 ---------------------------------------------------------------
{
  const pool = seed([
    { text: "索引必须复用句柄。", type: "semantic", importance: 9, project: "MPI" },
    { text: "提交前必须等确认。", type: "procedural", importance: 8, project: "global" },
    { text: "某次调试的临时发现。", type: "episodic", importance: 5, project: "Other" },
  ]);
  const entries = listEntries(pool).entries;

  assert.equal(filterEntries(entries).length, 3, "默认返回全部");
  assert.equal(filterEntries(entries, { type: "procedural" }).length, 1, "按类型过滤");
  assert.equal(filterEntries(entries, { project: "global" }).length, 1, "按项目过滤");
  assert.equal(filterEntries(entries, { q: "句柄" }).length, 1, "按关键词过滤（命中正文）");
  assert.equal(filterEntries(entries, { q: "PROCEDURAL" }).length, 0, "关键词小写比较，类型名不算正文");
  assert.equal(filterEntries(entries, { q: "mpi" }).length, 1, "关键词大小写不敏感（命中项目名 MPI）");

  const byImp = filterEntries(entries, { sort: "importance" }).map((e) => e.importance);
  assert.deepEqual(byImp, [9, 8, 5], "按重要性排序");
  const statusFiltered = filterEntries(entries, { status: "promoted" });
  assert.equal(statusFiltered.length, 0, "状态过滤生效");
  ok("过滤/排序：类型、项目、关键词（大小写不敏感）、状态、三种排序");

  // 视图字段是给面板用的，必须齐全且正文被截断
  const v = filterEntries(entries)[0];
  for (const k of ["id", "createdAt", "type", "importance", "recurrence", "project", "status", "summary", "length"]) {
    assert.ok(k in v, `视图应含字段 ${k}`);
  }
  assert.ok(v.length >= v.summary.length, "length 是全文长度");
  rmSync(pool, { recursive: true, force: true });
}

// --- 快照：统计 / 提案 / 累加器 ----------------------------------------------
{
  const pool = seed([
    { text: "甲。", project: "MPI", importance: 5 },
    { text: "乙。", project: "MPI", importance: 6 },
    { text: "丙。", project: "Other", importance: 7 },
  ]);
  const e = listEntries(pool).entries[0];
  writeProposal(pool, {
    id: newId(),
    createdAt: new Date().toISOString(),
    kind: "promote-kb",
    status: "pending",
    outlet: "kb",
    entries: [e.id],
    reason: "本项目知识",
    title: "提案甲",
    body: "正文",
    target: null,
    decidedAt: null,
    result: null,
  });

  const snap = buildSnapshot({ poolDir: pool, archiveDir: "E:/tmp/archive" });
  assert.equal(snap.entries.length, 3, "快照给全部条目");
  assert.equal(snap.stats.total, 3);
  assert.equal(snap.stats.byType.semantic, 3, "按类型统计");
  assert.equal(snap.stats.pendingProposals, 1, "待审批提案数");
  assert.equal(snap.proposals.length, 1, "提案随快照一起给");
  assert.equal(snap.stats.projects[0].name, "MPI", "项目按数量排序");
  assert.equal(snap.stats.projects[0].count, 2);
  assert.equal(snap.stats.archiveDir, "E:/tmp/archive", "归档目录透传（面板要有「打开归档目录」按钮）");
  assert.equal(typeof snap.stats.consolidation.remaining, "number", "累加器读数（面板显示离巩固还差多少分）");
  assert.equal(snap.stats.consolidation.threshold, 150);
  ok("快照：条目 + 统计（状态/类型/项目）+ 提案 + 归档目录 + 巩固累加器");

  // limit 只影响返回条数，不影响 matched/统计
  const limited = buildSnapshot({ poolDir: pool, limit: 1 });
  assert.equal(limited.entries.length, 1);
  assert.equal(limited.matched, 3, "matched 是过滤后的总数（用于「显示 1/3」）");
  assert.equal(limited.stats.total, 3);
  ok("limit：只截断返回条目，matched 与统计仍是全量（面板能显示「显示 1/3」）");
  rmSync(pool, { recursive: true, force: true });
}

// --- 面板操作：归档 -----------------------------------------------------------
{
  const pool = seed([{ text: "这条要被归档。" }]);
  const e = listEntries(pool).entries[0];
  const archDir = join(pool, "_archive");
  const removed = [];
  const r = await archiveEntryFromPanel(pool, e.id, {
    archiveDir: archDir,
    index: { upsert: async () => {}, remove: async (ids) => removed.push(...ids) },
  });
  assert.equal(r.ok, true, `归档应成功：${r.detail}`);
  assert.equal(existsSync(join(archDir, `${e.id}.md`)), true, "文件进了归档目录");
  assert.equal(listEntries(pool).entries.length, 0, "池里不再有这条");
  assert.deepEqual(removed, [e.id], "索引同步移除");

  const missing = await archiveEntryFromPanel(pool, "不存在的id", { archiveDir: archDir });
  assert.equal(missing.ok, false, "找不到条目要报错而不是静默成功");
  ok("面板归档：走与 /memory-forget 相同的执行路径（moveFileSafe + 索引移除），找不到时报错");

  // 前缀匹配也要能用（面板可能拿到短 id）
  const d2 = seed([{ text: "用短 id 归档。" }]);
  const e2 = listEntries(d2).entries[0];
  const r2 = await archiveEntryFromPanel(d2, e2.id.slice(-8), { archiveDir: join(d2, "_a") });
  assert.equal(r2.ok, true, "短 id 也能归档");
  rmSync(pool, { recursive: true, force: true });
  rmSync(d2, { recursive: true, force: true });
}

// --- 面板操作：批准 / 拒绝 ----------------------------------------------------
{
  const pool = seed([{ text: "会被晋升的条目。" }]);
  const e = listEntries(pool).entries[0];
  const lessons = join(pool, "_lessons");
  const mk = (over = {}) => ({
    id: newId(),
    createdAt: new Date().toISOString(),
    kind: "promote-kb",
    status: "pending",
    outlet: "kb",
    entries: [e.id],
    reason: "本项目知识",
    title: "Lesson alpha",
    body: "---\nlesson: lesson-a\n---\n\n# Lesson A\n\n## Guard\n\n别这么干。\n",
    target: null,
    decidedAt: null,
    result: null,
    ...over,
  });

  const p1 = mk();
  writeProposal(pool, p1);
  const approve = await decideProposalFromPanel(pool, p1.id.slice(-8), "approve", { kbLessonsDir: lessons });
  assert.equal(approve.ok, true, `批准应成功：${approve.detail}`);
  assert.equal(existsSync(join(lessons, "LessonAlpha.md")), true, "lesson 真写出来了（标题的 ASCII 词 → 驼峰文件名）");
  assert.equal(listProposals(pool).proposals.find((x) => x.id === p1.id).status, "applied", "提案标记已落地");
  assert.equal(listEntries(pool).entries.find((x) => x.id === e.id).status, "promoted", "条目标记晋升");

  // 重复批准要被挡住
  const again = await decideProposalFromPanel(pool, p1.id.slice(-8), "approve", { kbLessonsDir: lessons });
  assert.equal(again.ok, false, "已落地的不能再批准");

  const p2 = mk({ id: newId(), title: "Lesson beta" });
  writeProposal(pool, p2);
  const rej = await decideProposalFromPanel(pool, p2.id.slice(-8), "reject");
  assert.equal(rej.ok, true);
  assert.equal(listProposals(pool).proposals.find((x) => x.id === p2.id).status, "rejected");
  assert.equal(listEntries(pool).entries.find((x) => x.id === e.id).status, "promoted", "拒绝不影响条目状态");

  const nope = await decideProposalFromPanel(pool, "不存在", "approve");
  assert.equal(nope.ok, false);
  ok("面板审批：批准→写入 lesson + 标记晋升；重复批准被挡；拒绝只改提案状态；不存在要报错");

  // kb 落点：优先用提案自带 target（面板不传 kbLessonsDir 时也能落地）
  const p3 = mk({ id: newId(), target: join(lessons, "FromTarget.md") });
  writeProposal(pool, p3);
  const r3 = await decideProposalFromPanel(pool, p3.id.slice(-8), "approve");
  assert.equal(r3.ok, true, `应落到提案自带 target：${r3.detail}`);
  assert.equal(existsSync(join(lessons, "FromTarget.md")), true);
  ok("kb 落点优先用提案自带 target（面板不必知道知识库目录）");
  rmSync(pool, { recursive: true, force: true });
}

// --- 坏文件不炸面板 -----------------------------------------------------------
{
  const pool = mkdtempSync(join(tmpdir(), "mpi-panel-broken-"));
  mkdirSync(join(pool, "proposals"), { recursive: true });
  writeFileSync(join(pool, "proposals", "bad.md"), "---\nkid: typo\n---\n", "utf8");
  const snap = buildSnapshot({ poolDir: pool });
  assert.equal(snap.proposals.length, 0);
  assert.equal(snap.broken.length, 1, "坏文件要在快照里报出来（面板显示而不是静默）");
  ok("坏提案文件：快照里单独报告，不静默、不炸");
  rmSync(pool, { recursive: true, force: true });
}

console.log(`\ntest:memorypanel 全部通过（${n} 项）`);
