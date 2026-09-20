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
const { buildSnapshot, filterEntries, archiveEntryFromPanel, decideProposalFromPanel, dayKey, rangeStart, parseBound, resolveLessonsDirFor } =
  await import("../src/main/memory-panel.ts");
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


// --- 按日期：分组键与时间范围 -------------------------------------------------
{
  // 分组键用**本地日历**（不是 UTC 日界）：跨零点的条目不能被算到前一天
  const iso = new Date(2026, 8, 20, 23, 30).toISOString();
  assert.equal(dayKey(iso), "2026-09-20", "本地日期键");
  assert.equal(dayKey("坏时间"), "未知日期", "坏时间不炸");

  // 范围起点：today = 今天本地零点；7d 含今天共 7 天；30d 含今天共 30 天
  const now = new Date(2026, 8, 20, 15, 0).getTime();
  const midnight = new Date(2026, 8, 20, 0, 0).getTime();
  assert.equal(rangeStart("all", now), 0);
  assert.equal(rangeStart("today", now), midnight);
  assert.equal(rangeStart("7d", now), midnight - 6 * 86400000, "近 7 天含今天");
  assert.equal(rangeStart("30d", now), midnight - 29 * 86400000, "近 30 天含今天");
  ok("按日期：分组键用本地日历、范围起点含今天（不是 7*24 小时的滑动窗口）");

  // 过滤：造三条不同日期的条目（用真实时钟算相对日期，避免依赖测试运行日）
  const pool = mkdtempSync(join(tmpdir(), "mpi-panel-date-"));
  const mkAt = (text, daysAgo, hours = 12) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(hours, 0, 0, 0);
    const p = join(pool, "inbox", `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    mkdirSync(p, { recursive: true });
    // 直接写文件（绕过 decideIngest 的"现在"），这样能构造历史日期
    const id = newId(d.getTime());
    writeFileSync(
      join(p, `${id}.md`),
      [
        "---",
        `id: ${id}`,
        `created_at: ${new Date(d.getTime()).toISOString()}`,
        "type: semantic",
        "temporal: retrospective",
        "importance: 6",
        "relevance: 0.6",
        "recurrence: 1",
        "project: MPI",
        "source: test",
        "status: inbox",
        "promoted_to: null",
        "tags: []",
        "---",
        "",
        text,
        "",
      ].join("\n"),
      "utf8",
    );
  };
  mkAt("今天的条目。", 0);
  mkAt("三天前的条目。", 3);
  mkAt("四十天前的条目。", 40);
  const all = listEntries(pool).entries;
  assert.equal(all.length, 3, "三条历史条目都读进来");
  assert.equal(filterEntries(all, { range: "all" }).length, 3, "全部时间");
  assert.equal(filterEntries(all, { range: "today" }).length, 1, "只看今天");
  assert.equal(filterEntries(all, { range: "7d" }).length, 2, "近 7 天含今天与三天前");
  assert.equal(filterEntries(all, { range: "30d" }).length, 2, "近 30 天不含四十天前");
  rmSync(pool, { recursive: true, force: true });
  ok("时间范围过滤：全部/今天/近 7 天/近 30 天（含今天，历史条目不漏不重）");
}


// --- 具体日期区间（面板上的"从 / 到"）------------------------------------------
{
  const mk = (y, mo, d, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();
  const entries = [
    { createdAt: mk(2026, 9, 18), text: "18 号的。", project: "P", tags: [], status: "inbox", type: "semantic", importance: 6, recurrence: 1, id: "01AAAAAAAAAAAAAAAAAAAAAAAA", warnings: [], evidence: [], recurrences: [] },
    { createdAt: mk(2026, 9, 20, 9), text: "20 号早上。", project: "P", tags: [], status: "inbox", type: "semantic", importance: 6, recurrence: 1, id: "01BBBBBBBBBBBBBBBBBBBBBBBB", warnings: [], evidence: [], recurrences: [] },
    { createdAt: mk(2026, 9, 20, 23, 30), text: "20 号深夜。", project: "P", tags: [], status: "inbox", type: "semantic", importance: 6, recurrence: 1, id: "01CCCCCCCCCCCCCCCCCCCCCCCC", warnings: [], evidence: [], recurrences: [] },
    { createdAt: mk(2026, 9, 22), text: "22 号的。", project: "P", tags: [], status: "inbox", type: "semantic", importance: 6, recurrence: 1, id: "01DDDDDDDDDDDDDDDDDDDDDDDD", warnings: [], evidence: [], recurrences: [] },
  ];

  // 边界：只给日期时，"到 X" 必须**包含 X 当天**（按零点算会漏掉一整天，最容易踩）
  assert.equal(parseBound("2026-09-20", "start"), new Date(2026, 8, 20, 0, 0, 0, 0).getTime());
  assert.equal(parseBound("2026-09-20", "end"), new Date(2026, 8, 20, 23, 59, 59, 999).getTime());
  assert.equal(parseBound("2026-09-20T08:30", "start"), new Date(2026, 8, 20, 8, 30, 0, 0).getTime(), "带时分按精确时刻");
  assert.equal(parseBound("", "start"), null);
  assert.equal(parseBound("乱填", "start"), null, "认不出来当没填（不会把面板滤空）");
  ok("日期边界解析：只给日期时含当天；支持时分精度；非法输入忽略");

  assert.equal(filterEntries(entries, { from: "2026-09-20", to: "2026-09-20" }).length, 2, "20 号整天（含深夜 23:30）");
  assert.equal(filterEntries(entries, { from: "2026-09-20" }).length, 3, "只给起点");
  assert.equal(filterEntries(entries, { to: "2026-09-18" }).length, 1, "只给终点");
  assert.equal(filterEntries(entries, { from: "2026-09-19", to: "2026-09-21" }).length, 2, "区间");
  assert.equal(filterEntries(entries, { from: "2026-09-20T10:00" }).length, 2, "时分精度：20 号 10 点之后 = 20 号深夜 + 22 号");
  assert.equal(filterEntries(entries, { from: "2026-09-20T10:00", to: "2026-09-20T23:59" }).length, 1, "两端带时分可以精确到那一天的那一时段");
  assert.equal(filterEntries(entries, { from: "2026-09-20", to: "2026-09-20", range: "today" }).length, 2, "自定义区间优先于预设范围");
  ok("具体日期过滤：闭区间含当天、只给一端也行、时分精度可用、优先于预设范围");
}


// --- kb 落点兜底链（真机报错：老条目没有 projectRoot → "无法确认 lesson 落点"）-----
{
  // 换行用变量拼，避免测试文件里堆转义
  const NL = String.fromCharCode(10);
  const writeEntry = (poolDir, text, { project, root = null, daysAgo = 0 }) => {
    const d = new Date(Date.now() - daysAgo * 86400000);
    const dir = join(poolDir, "inbox", `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    mkdirSync(dir, { recursive: true });
    const id = newId(d.getTime());
    const lines = [
      "---",
      `id: ${id}`,
      `created_at: ${new Date(d.getTime()).toISOString()}`,
      "type: semantic",
      "temporal: retrospective",
      "importance: 6",
      "relevance: 0.6",
      "recurrence: 1",
      `project: ${project}`,
      root ? `root: ${root}` : "root: null",
      "source: test",
      "status: inbox",
      "promoted_to: null",
      "tags: []",
      "---",
      "",
      text,
      "",
    ];
    writeFileSync(join(dir, `${id}.md`), lines.join(NL), "utf8");
    return id;
  };
  const prop = (entries, over = {}) => ({
    id: newId(),
    createdAt: new Date().toISOString(),
    kind: "promote-kb",
    status: "pending",
    outlet: "kb",
    entries,
    reason: "t",
    title: "T",
    body: "b",
    target: null,
    decidedAt: null,
    result: null,
    ...over,
  });

  const pool = mkdtempSync(join(tmpdir(), "mpi-panel-roots-"));
  // ⚠️ 项目根必须也放临时目录：写死真实路径的话，第二次跑就撞"同名 lesson 已存在"，
  //    还会往磁盘上留垃圾目录（第一次写测试时踩过）
  const rootA = join(pool, "fake-proj-a");
  const rootB = join(pool, "fake-proj-b");

  // ① 条目自带 root
  const withRoot = writeEntry(pool, "有 root 的项目条目。", { project: "OldProj", root: rootA });
  assert.equal(
    resolveLessonsDirFor(pool, prop([withRoot])),
    join(rootA, ".alexandria", "knowledge", "lessons"),
    "① 条目自带 root 优先",
  );

  // ② 老条目没有 root → 用**同项目**较新条目的 root（真机上就是这一档救回来的）
  const noRoot = writeEntry(pool, "没有 root 的老条目。", { project: "MPI", daysAgo: 30 });
  writeEntry(pool, "同项目新条目（有 root）。", { project: "MPI", root: rootB, daysAgo: 1 });
  assert.equal(
    resolveLessonsDirFor(pool, prop([noRoot])),
    join(rootB, ".alexandria", "knowledge", "lessons"),
    "② 同项目条目的 root 兜底",
  );

  // ③ 整个池子都没 root → null（宁可失败，也不要瞎猜一个目录往里写）
  const solo = mkdtempSync(join(tmpdir(), "mpi-panel-noroot-"));
  const lone = writeEntry(solo, "孤独条目。", { project: "X" });
  assert.equal(resolveLessonsDirFor(solo, prop([lone])), null, "③ 全都没 root → null（不瞎猜）");

  // ④ 集成：没有 target 的老条目提案，批准时也能落地（不再报「无法确认 lesson 落点」）
  const lessonsOfMpi = resolveLessonsDirFor(pool, prop([noRoot]));
  const p1 = prop([noRoot], {
    title: "Legacy lesson",
    body: ["---", "lesson: legacy", "---", "", "# L", "", "## Guard", "", "x", ""].join(NL),
  });
  writeProposal(pool, p1);
  const r = await decideProposalFromPanel(pool, p1.id.slice(-8), "approve", { kbLessonsDir: lessonsOfMpi });
  assert.equal(r.ok, true, `无 target 的老条目也应能落地：${r.detail}`);
  assert.equal(existsSync(join(lessonsOfMpi, "LegacyLesson.md")), true, "lesson 真的写进了同项目解析出的目录");
  assert.equal(listProposals(pool).proposals.find((x) => x.id === p1.id).status, "applied");
  ok("kb 落点兜底链：条目 root → 同项目 root → null；老条目提案批准不再报「无法确认 lesson 落点」");

  rmSync(pool, { recursive: true, force: true });
  rmSync(solo, { recursive: true, force: true });
}

console.log(`\ntest:memorypanel 全部通过（${n} 项）`);
