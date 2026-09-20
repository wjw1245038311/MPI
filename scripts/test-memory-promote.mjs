/**
 * 提案存储 + 审批执行器测试（P3-b）
 *
 * 覆盖：读写往返、状态流转规则、三个出口的执行语义
 *   - kb：写出 alexandria 格式 lesson、条目标记 promoted、**同名不覆盖**
 *   - archive：移到归档目录（跨卷也要成）、索引移除
 *   - inject/now：**不自动改共享文件**，只给待人工合并
 *
 * 运行：npm run test:promote
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { listProposals, writeProposal, readProposal, setProposalStatus, canTransition, pendingProposals } = await import(
  "../src/main/zhiya/proposals.ts"
);
const { applyProposal, lessonSlug } = await import("../src/main/memory-promote.ts");
const { newId, decideIngest, lexicalSimilarity, listEntries } = await import("../src/main/zhiya/pool.ts");

/** 找一个与系统临时目录**不同卷**的目录，用来真实复现跨卷 rename 的 EXDEV。
 *  找不到（只有单盘机器）就返回 null，调用方跳过该断言而不是伪造结果。 */
function otherVolumeDir(name) {
  const t = tmpdir();
  const sameRoot = (t[0] || "").toUpperCase();
  for (const drive of ["D:", "E:", "F:", "G:", "H:"]) {
    if (drive[0] === sameRoot) continue;
    const root = `${drive}/`;
    if (!existsSync(root)) continue;
    return join(root, name);
  }
  return null;
}

let n = 0;
const ok = (msg) => {
  n++;
  console.log(`  ✅ ${msg}`);
};

const mkProposal = (over = {}) => ({
  id: newId(),
  createdAt: new Date().toISOString(),
  kind: "promote-kb",
  status: "pending",
  outlet: "kb",
  entries: [],
  reason: "测试用",
  title: "Ext self contained",
  body: "## Symptom\n\n加载失败。\n",
  target: null,
  decidedAt: null,
  result: null,
  ...over,
});

// --- 读写往返 / 列表 ---------------------------------------------------------
{
  const pool = mkdtempSync(join(tmpdir(), "mpi-prop-store-"));
  const p = mkProposal({ entries: [newId()] });
  writeProposal(pool, p);

  const back = readProposal(pool, p.id);
  assert.equal(back?.id, p.id, "能按 id 读回");
  assert.equal(readProposal(pool, "不存在的ID"), null, "不存在返回 null 而不是抛");

  const list = listProposals(pool);
  assert.equal(list.proposals.length, 1, "列表能列出来");
  assert.equal(list.broken.length, 0, "无坏文件");

  // 坏文件要能被看见，不能静默忽略
  writeFileSync(join(pool, "proposals", "broken.md"), "---\nkid: typo\n---\n", "utf8");
  const list2 = listProposals(pool);
  assert.equal(list2.proposals.length, 1, "坏文件不进正常列表");
  assert.equal(list2.broken.length, 1, "坏文件被单独报出来");
  ok("提案存储：读写往返、列表、坏文件单独报告（不静默吞）");

  // 状态流转
  assert.equal(canTransition("pending", "approved"), true);
  assert.equal(canTransition("pending", "applied"), false, "未批准不能直接 applied");
  assert.equal(canTransition("rejected", "approved"), false, "已拒绝不能再批准");
  assert.equal(canTransition("failed", "approved"), true, "失败可重试");
  const ap = setProposalStatus(pool, p.id, "approved");
  assert.equal(ap?.status, "approved");
  assert.ok(ap?.decidedAt, "批准时记下时间");
  assert.equal(setProposalStatus(pool, p.id, "pending"), null, "非法流转返回 null");
  assert.equal(readProposal(pool, p.id).status, "approved", "非法流转不改磁盘状态");
  assert.equal(pendingProposals(pool).length, 0, "批准后不在 pending 里");
  ok("状态流转：pending→approved/rejected，approved→applied/failed，失败可重试");

  rmSync(pool, { recursive: true, force: true });
}

// --- kb 出口：写 lesson + 标记条目 ------------------------------------------
{
  const pool = mkdtempSync(join(tmpdir(), "mpi-prop-kb-"));
  const lessons = mkdtempSync(join(tmpdir(), "mpi-lessons-"));
  const e = decideIngest(pool, {
    text: "pi 扩展以 ?raw 源码写进 userData，不能 import 本仓模块。",
    type: "semantic",
    temporal: "retrospective",
    importance: 7,
    relevance: 0.7,
    project: "MPI",
    source: "test",
  }, lexicalSimilarity).entry;

  const p = mkProposal({ entries: [e.id], title: "Extension must be self contained" });
  writeProposal(pool, p);
  setProposalStatus(pool, p.id, "approved");

  const upserts = [];
  const r = await applyProposal(readProposal(pool, p.id), {
    poolDir: pool,
    kbLessonsDir: lessons,
    index: { upsert: async (x) => upserts.push(...x), remove: async () => {} },
  });
  assert.equal(r.action, "applied", `应落地：${r.detail}`);
  const file = join(lessons, "ExtensionMustBeSelfContained.md");
  assert.equal(existsSync(file), true, "lesson 文件已写出");
  assert.ok(readFileSync(file, "utf8").includes("## Symptom"), "内容完整");
  assert.equal(readProposal(pool, p.id).status, "applied", "提案标记 applied");
  const after = listEntries(pool).entries.find((x) => x.id === e.id);
  assert.equal(after.status, "promoted", "池内条目标记 promoted");
  assert.equal(after.promotedTo, file, "promotedTo 指向 lesson 文件");
  assert.equal(upserts.length, 1, "索引同步更新（status 变化要能被过滤掉）");
  ok(`kb 出口：写 lesson + 条目标记 promoted + 索引同步（文件 ${file.split(/[\\/]/).pop()}）`);

  // 同名不覆盖：第二份同名提案必须跳过，保护人写内容
  const p2 = mkProposal({ entries: [e.id], title: "Extension must be self contained" });
  writeProposal(pool, p2);
  setProposalStatus(pool, p2.id, "approved");
  const r2 = await applyProposal(readProposal(pool, p2.id), { poolDir: pool, kbLessonsDir: lessons });
  assert.equal(r2.action, "skipped", "同名 lesson 应跳过");
  assert.equal(readProposal(pool, p2.id).status, "failed", "跳过记为 failed（可见，不静默）");
  assert.equal(readdirSync(lessons).length, 1, "没有产生第二个文件");
  ok("kb 出口：同名 lesson 存在则跳过（绝不覆盖人写内容）");

  rmSync(pool, { recursive: true, force: true });
  rmSync(lessons, { recursive: true, force: true });
}

// --- archive 出口：跨卷归档 + 索引移除 --------------------------------------
{
  const pool = mkdtempSync(join(tmpdir(), "mpi-prop-arc-"));
  const e = decideIngest(pool, {
    text: "这条记忆已经过期了。",
    type: "episodic",
    temporal: "present",
    importance: 5,
    relevance: 0.6,
    project: "MPI",
    source: "test",
  }, lexicalSimilarity).entry;

  const p = mkProposal({ kind: "archive", outlet: "archive", entries: [e.id], title: "已过期" });
  writeProposal(pool, p);
  setProposalStatus(pool, p.id, "approved");

  // 归档目录刻意放在**另一个卷**——跨卷 EXDEV 真事故的回归。
  // 不写死盘符：单卷机器找不到别的卷就跳过（不伪造 PASS）。
  const archDir = otherVolumeDir("mpi-promote-archive-test");
  if (!archDir) {
    console.log("  ⚠️ 跳过跨卷归档用例：本机只有单卷");
  } else {
    rmSync(archDir, { recursive: true, force: true });
    const removed = [];
    const r = await applyProposal(readProposal(pool, p.id), {
      poolDir: pool,
      archiveDir: archDir,
      index: { upsert: async () => {}, remove: async (ids) => removed.push(...ids) },
    });
    assert.equal(r.action, "applied", `应归档成功：${r.detail}`);
    assert.equal(existsSync(join(archDir, `${e.id}.md`)), true, "文件进了归档目录（跨卷）");
    assert.equal(listEntries(pool).entries.some((x) => x.id === e.id), false, "池里不再有这条");
    assert.deepEqual(removed, [e.id], "索引里也移除了");
    assert.equal(readFileSync(join(archDir, `${e.id}.md`), "utf8").includes("已经过期"), true, "内容完整");
    ok("archive 出口：跨卷归档成功 + 池内移除 + 索引移除（归档≠删除，文件还在）");
    rmSync(archDir, { recursive: true, force: true });
  }

  rmSync(pool, { recursive: true, force: true });
}

// --- inject / now 出口：只给建议，不动共享文件 -------------------------------
{
  const pool = mkdtempSync(join(tmpdir(), "mpi-prop-manual-"));
  const e = decideIngest(pool, {
    text: "提交前必须等用户确认再 push。",
    type: "procedural",
    temporal: "prospective",
    importance: 8,
    relevance: 0.8,
    project: "global",
    source: "test",
  }, lexicalSimilarity).entry;

  for (const kind of ["promote-inject", "promote-now"]) {
    const p = mkProposal({ kind, outlet: kind === "promote-inject" ? "inject" : "now", entries: [e.id], title: "推送前等确认" });
    writeProposal(pool, p);
    setProposalStatus(pool, p.id, "approved");
    const r = await applyProposal(readProposal(pool, p.id), { poolDir: pool });
    assert.equal(r.action, "manual", `${kind} 应是待人工合并`);
    const after = readProposal(pool, p.id);
    assert.equal(after.status, "approved", "保持 approved（待人工合并，不是 applied）");
    assert.ok(after.result.includes("人工"), "结果里说明需人工");
    // 池内条目**不能**被标记晋升（否则证据链断了：没人真做这件事）
    const cur = listEntries(pool).entries.find((x) => x.id === e.id);
    assert.equal(cur.status, "inbox", "未真正落地前条目保持 inbox");
  }
  ok("inject/now 出口：只产出待人工合并的说明，不改共享文件、不假标记为已晋升");

  rmSync(pool, { recursive: true, force: true });
}

// --- 边界：条目没了 ---------------------------------------------------------
{
  const pool = mkdtempSync(join(tmpdir(), "mpi-prop-gone-"));
  mkdirSync(join(pool, "proposals"), { recursive: true });
  const p = mkProposal({ entries: [newId()] });
  writeProposal(pool, p);
  setProposalStatus(pool, p.id, "approved");
  const r = await applyProposal(readProposal(pool, p.id), { poolDir: pool, kbLessonsDir: tmpdir() });
  assert.equal(r.action, "skipped");
  assert.equal(readProposal(pool, p.id).status, "failed", "依据消失 → failed 可见");
  ok("边界：依据条目不存在 → skipped + 提案标 failed（可见，不静默）");

  // slug 生成
  assert.equal(lessonSlug("Extension must be self contained", "x"), "ExtensionMustBeSelfContained");
  assert.equal(lessonSlug("扩展自包含", "01H2ABCDEFGH"), "Lesson-ABCDEFGH", "纯中文标题退回 id 末 8 位");
  assert.equal(lessonSlug("扩展自包含", "01ABCXYZ"), "Lesson-01ABCXYZ", "id 短于 8 位就用整段");
  rmSync(pool, { recursive: true, force: true });
}

console.log(`\ntest:promote 全部通过（${n} 项）`);
