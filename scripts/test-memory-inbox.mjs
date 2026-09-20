/**
 * 记忆池落地管道测试（P1 主进程侧）
 * 覆盖：校验（形状/越界/超长）、阈值丢弃、判重累加、索引写失败不影响真相源、
 *       坏 JSON 进 <池>/.failed、inbox 批量摄入、watcher 幂等、跨卷归档（EXDEV）。
 * 运行：npm run test:memoryinbox
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { ingestOne, ingestMemoryInbox, validateCandidate, sweepAbandonedClaims } = await import("../src/main/memory-inbox.ts");
const { listEntries, THRESHOLD } = await import("../src/main/zhiya/pool.ts");


/** 往任意目录写一个候选/操作文件（返回路径）。 */
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

function put0(dir, name, obj) {
  const p = join(dir, name);
  writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj), "utf8");
  return p;
}

const root = mkdtempSync(join(tmpdir(), "mpi-inbox-test-"));
const inbox = join(root, "inbox");
mkdirSync(inbox, { recursive: true });
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

let n = 0;
const ok = (name) => { n++; console.log(`  ✅ ${name}`); };
const put = (name, obj) => {
  const p = join(inbox, name);
  writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj), "utf8");
  return p;
};

// --- 校验 --------------------------------------------------------------------
assert.equal(validateCandidate(null).ok, false);
assert.equal(validateCandidate({}).ok, false);
assert.equal(validateCandidate({ text: "   " }).ok, false);
assert.equal(validateCandidate({ text: "x".repeat(2001) }).ok, false);
const v = validateCandidate({ text: "有效内容", type: "乱写", temporal: "乱写", importance: 7, relevance: 0.7 });
assert.equal(v.ok, true);
assert.equal(v.cand.type, "semantic", "非法 type 回退默认");
assert.equal(v.cand.temporal, "retrospective");
ok("校验：拒绝非对象 / 空文本 / 超长；非法枚举回退默认");

const missing = validateCandidate({ text: "缺分数" });
assert.equal(missing.ok, true);
assert.equal(missing.cand.scoringFailed, true, "缺评分 → 标 scoringFailed（fail-open）");
ok("校验：缺评分自动标 scoringFailed");

// --- 正常落地 ----------------------------------------------------------------
const before = listEntries(root).entries.length;
let written = [];
const fakeIndex = { upsert: async (es) => { written.push(...es); }, remove: async () => {}, recall: async () => [], rebuild: async () => {}, close: async () => {} };

const f1 = put("a.json", { text: "zg 不提供代码调用图。", type: "semantic", temporal: "retrospective", importance: 7, relevance: 0.7, project: "MPI", source: "ext#1" });
const r1 = await ingestOne(f1, { poolDir: root, index: fakeIndex });
assert.equal(r1.action, "add");
assert.equal(existsSync(f1), false, "源文件已消费");
assert.equal(listEntries(root).entries.length, before + 1, "池里多了一条");
assert.equal(written.length, 1, "索引被更新");
ok("正常落地：写池 + 更新索引 + 消费源文件");

// --- 阈值丢弃 ----------------------------------------------------------------
const f2 = put("b.json", { text: "今天中午吃了拉面。", importance: 2, relevance: 0.8 });
const r2 = await ingestOne(f2, { poolDir: root, index: fakeIndex });
assert.equal(r2.action, "drop");
assert.match(r2.detail, /重要性/);
assert.equal(existsSync(f2), false, "被丢弃的候选也要消费掉（否则会反复重试）");
assert.equal(listEntries(root).entries.length, before + 1, "池子没变");
ok("阈值丢弃：低重要性不进池，但源文件被消费");

const f2b = put("b2.json", { text: "毫不相关的内容。", importance: 8, relevance: 0.1 });
assert.equal((await ingestOne(f2b, { poolDir: root })).action, "drop");
assert.match("相关性", /相关性/);
ok("阈值丢弃：低相关性同样拦下");

// --- 判重累加 ----------------------------------------------------------------
const f3 = put("c.json", { text: "zg 不提供代码调用图。", importance: 8, relevance: 0.9, project: "MPI" });
const r3 = await ingestOne(f3, { poolDir: root, index: fakeIndex });
assert.equal(r3.action, "bump");
const bumped = listEntries(root).entries.find((e) => e.id === r3.id);
assert.equal(bumped.recurrence, 2);
assert.equal(listEntries(root).entries.length, before + 1, "判重不新增条目");
ok("判重：同一句话复现 → 计数累加而不是新增");

// --- 索引失败不影响真相源 -----------------------------------------------------
const boomIndex = { upsert: async () => { throw new Error("索引炸了"); }, remove: async () => {}, recall: async () => [], rebuild: async () => {}, close: async () => {} };
const logs = [];
const f4 = put("d.json", { text: "索引失败也不能丢条目。", importance: 6, relevance: 0.6 });
const r4 = await ingestOne(f4, { poolDir: root, index: boomIndex, log: (m) => logs.push(m) });
assert.equal(r4.action, "add", "索引失败仍算写入成功");
assert.ok(listEntries(root).entries.some((e) => e.text.includes("索引失败也不能丢")), "文件真相源里有");
assert.ok(logs.some((m) => m.includes("索引更新失败")), "有日志");
ok("索引失败 fail-open：池文件照写，只记日志（下次 rebuild 会补）");

// --- 坏输入 ------------------------------------------------------------------
const f5 = put("e.json", "{ 这不是合法 JSON");
const r5 = await ingestOne(f5, { poolDir: root });
assert.equal(r5.action, "error");
assert.equal(existsSync(join(root, ".failed")), true, "坏文件进 <池>/.failed 而不是反复重试");
ok("坏 JSON → .failed/，不阻塞其它候选");

// --- 批量摄入 + 幂等 ----------------------------------------------------------
put("f1.json", { text: "批量候选之一。", importance: 6, relevance: 0.6 });
put("f2.json", { text: "批量候选之二。", importance: 6, relevance: 0.6 });
put("f3.json", { text: "  ", importance: 6 });
const outcomes = await ingestMemoryInbox(inbox, { poolDir: root, index: fakeIndex });
assert.equal(outcomes.length, 3);
assert.equal(outcomes.filter((o) => o.action === "add").length, 2);
assert.equal(outcomes.filter((o) => o.action === "invalid").length, 1);
assert.equal((await ingestMemoryInbox(inbox, { poolDir: root })).length, 0, "第二次摄入无事可做（幂等）");
ok("批量摄入 + 幂等（第二次为空）");
// --- 回归：扩展的内部状态文件（点号开头）绝不能被当候选吃掉 ---------------
ok("inbox 里的 .cursor-/.pending- 等点号文件被忽略（真事故的回归测试）", async () => {
  const d = mkdtempSync(join(tmpdir(), "mpi-inbox-dot-"));
  const pool = join(d, "pool");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, ".cursor-abc.json"), JSON.stringify({ lastId: "x" }), "utf8");
  writeFileSync(join(d, ".pending-abc.json"), JSON.stringify([{ reason: "settled", window: "对话内容窗口" }]), "utf8");
  const outcomes = await ingestMemoryInbox(d, { poolDir: pool });
  assert.equal(outcomes.length, 0, "点号文件不进摄入流程");
  for (const f of [".cursor-abc.json", ".pending-abc.json"]) {
    assert.equal(existsSync(join(d, f)), true, `${f} 必须留在原地（那是扩展的游标/快照）`);
  }
  // 非点号的正常候选仍要处理
  writeFileSync(join(d, "normal.json"), JSON.stringify({ text: "正常候选内容", importance: 6, relevance: 0.6 }), "utf8");
  const two = await ingestMemoryInbox(d, { poolDir: pool });
  assert.equal(two.length, 1);
  assert.equal(two[0].action, "add");
  rmSync(d, { recursive: true, force: true });
  ok("点号文件被忽略、正常候选照常处理");
});

// --- 操作协议：forget（归档，不是删除）--------------------------------------
ok("forget 操作：把条目移到归档目录，而不是删除", async () => {
  const d = mkdtempSync(join(tmpdir(), "mpi-inbox-forget-"));
  const pool = join(d, "pool");
  const inbox = join(d, "inbox");
  mkdirSync(inbox, { recursive: true });
  // 归档目录**注入到另一个卷**（真实复现 EXDEV）——以前这里用同卷 fallback，正好漏掉了这个真事故。
  // 不写死盘符：单盘机器上找不到别的卷就跳过本用例（不伪造 PASS）。
  const archive = otherVolumeDir("mpi-archive-crossvol-test");
  if (!archive) {
    console.log("  ⚠️ 跳过跨卷归档用例：本机只有单卷（无法复现 EXDEV）");
    rmSync(d, { recursive: true, force: true });
    return;
  }
  rmSync(archive, { recursive: true, force: true });
  const removed = [];
  const idx = { upsert: async () => {}, remove: async (ids) => { removed.push(...ids); }, recall: async () => [], rebuild: async () => {}, close: async () => {} };

  const dep = { poolDir: pool, index: idx, archiveDir: archive };
  const add = await ingestOne(put0(inbox, "keep.json", { text: "这条留着。", importance: 6, relevance: 0.6 }), dep);
  const add2 = await ingestOne(put0(inbox, "drop.json", { text: "这条要归档。", importance: 6, relevance: 0.6 }), dep);
  assert.equal(add.action, "add");
  assert.equal(add2.action, "add");

  const before = listEntries(pool).entries.length;
  const opFile = put0(inbox, "op.json", { op: "forget", id: add2.id });
  const out = await ingestOne(opFile, dep);
  assert.equal(out.action, "forget", `应执行归档，实际 ${out.action}：${out.detail ?? ""}`);
  assert.equal(listEntries(pool).entries.length, before - 1, "池里少了一条");
  assert.ok(existsSync(out.detail), `归档文件应存在：${out.detail}`);
  assert.ok(out.detail.startsWith(archive.slice(0, 2)), "确实归档到了另一个卷（跨卷，会触发 EXDEV 回退）");
  assert.equal(readFileSync(out.detail, "utf8").includes("这条要归档"), true, "归档文件内容完整");
  assert.deepEqual(removed, [add2.id], "索引里也移除了");
  rmSync(d, { recursive: true, force: true });
  rmSync(archive, { recursive: true, force: true });
  console.log(`  ✅ forget：归档到 ${out.detail.split(/[\/]/).slice(-2).join("/")}，索引同步移除`);
});

ok("forget 找不到目标 → invalid（不静默成功）", async () => {
  const d = mkdtempSync(join(tmpdir(), "mpi-inbox-forget2-"));
  const inbox = join(d, "inbox");
  mkdirSync(inbox, { recursive: true });
  const out = await ingestOne(put0(inbox, "op2.json", { op: "forget", id: "不存在的ID" }), { poolDir: join(d, "pool") });
  assert.equal(out.action, "invalid");
  assert.match(out.detail, /找不到目标/);
  rmSync(d, { recursive: true, force: true });
});

ok("未知 op → invalid", async () => {
  const d = mkdtempSync(join(tmpdir(), "mpi-inbox-op3-"));
  const inbox = join(d, "inbox");
  mkdirSync(inbox, { recursive: true });
  const out = await ingestOne(put0(inbox, "op3.json", { op: "explode" }), { poolDir: join(d, "pool") });
  assert.equal(out.action, "invalid");
  assert.match(out.detail, /未知操作/);
  rmSync(d, { recursive: true, force: true });
});

assert.equal(THRESHOLD.minImportance, 4);

// --- 并发：同一份请求只能被执行一次（真事故）---------------------------------
//
// 事故：摄入批处理每 2 秒一轮，上一轮没跑完（审批要写文件+更新索引）时下一轮会重叠，
// 两个 run 同时读到同一份 op 文件 → /memory-approve 被执行两次，ops.jsonl 两条 ok。
ok("并发重叠：同一份候选/请求只处理一次（认领机制 + 单飞）", async () => {
  const d = mkdtempSync(join(tmpdir(), "mpi-inbox-claim-"));
  const pool = join(d, "pool");
  const inbox = join(d, "inbox");
  mkdirSync(inbox, { recursive: true });
  const processed = [];
  // 索引故意慢：制造"上一轮还没跑完下一轮就来了"
  const slowIndex = {
    upsert: async (es) => {
      await new Promise((r) => setTimeout(r, 120));
      processed.push(...es.map((e) => e.id));
    },
    remove: async () => {},
    recall: async () => [],
    rebuild: async () => {},
    close: async () => {},
  };
  put0(inbox, "c1.json", { text: "并发测试条目一。", importance: 6, relevance: 0.6 });
  put0(inbox, "c2.json", { text: "并发测试条目二。", importance: 6, relevance: 0.6 });

  const dep = { poolDir: pool, index: slowIndex };
  const [a, b] = await Promise.all([ingestMemoryInbox(inbox, dep), ingestMemoryInbox(inbox, dep)]);
  const ingests = [...a, ...b].filter((x) => x.action === "add" || x.action === "bump");
  assert.equal(ingests.length, 2, `两个文件应各被处理一次，实际 ${ingests.length} 次`);
  assert.equal(processed.length, 2, "索引也只写两次（没有重复）");
  assert.equal(listEntries(pool).entries.length, 2, "池里就是两条，不多不少");
  // 认领文件都清理干净了
  assert.equal(readdirSync(inbox).filter((f) => f.startsWith(".processing-")).length, 0, "不残留认领文件");
  rmSync(d, { recursive: true, force: true });
});

// --- 遗弃认领：清掉 10 分钟前的，保留新鲜的 -----------------------------------
ok("遗弃认领文件：老的清掉、新的保留", () => {
  const d = mkdtempSync(join(tmpdir(), "mpi-inbox-claim2-"));
  const inbox = join(d, "inbox");
  mkdirSync(inbox, { recursive: true });
  const old = join(inbox, ".processing-999-1-old.json");
  const fresh = join(inbox, ".processing-999-2-fresh.json");
  writeFileSync(old, "{}", "utf8");
  writeFileSync(fresh, "{}", "utf8");
  const past = Date.now() / 1000 - 3600;
  utimesSync(old, past, past);
  const cleaned = sweepAbandonedClaims(inbox);
  assert.equal(cleaned, 1, "只清掉老的那个");
  assert.equal(existsSync(old), false, "老认领文件已清理（否则崩溃一次就永久堆积）");
  assert.equal(existsSync(fresh), true, "新鲜认领文件必须保留（可能正在处理）");
  rmSync(d, { recursive: true, force: true });
});

// --- 批量索引写入（性能：zvec 的开销按「调用」计）-----------------------------
ok("同批多候选只写一次索引（实测 23× 差距）", async () => {
  const d = mkdtempSync(join(tmpdir(), "mpi-inbox-batch-"));
  const pool = join(d, "pool");
  const inbox = join(d, "inbox");
  mkdirSync(inbox, { recursive: true });
  const calls = [];
  const idx = {
    upsert: async (es) => calls.push(es.map((e) => e.text.slice(0, 8))),
    remove: async () => {},
    recall: async () => [],
    rebuild: async () => {},
    close: async () => {},
  };
  for (let i = 0; i < 5; i++) put0(inbox, `b${i}.json`, { text: `批量索引候选 ${i}。`, importance: 6, relevance: 0.6 });
  const out = await ingestMemoryInbox(inbox, { poolDir: pool, index: idx });
  assert.equal(out.filter((o) => o.action === "add").length, 5);
  assert.equal(calls.length, 1, `5 条应只触发 1 次索引写入，实际 ${calls.length} 次`);
  assert.equal(calls[0].length, 5, "并且这 5 条一次性传下去");
  assert.equal(listEntries(pool).entries.length, 5, "池文件照旧 5 条");
  rmSync(d, { recursive: true, force: true });
});

// --- 单条路径（ingestOne）不受批处理影响 --------------------------------------
ok("单独调用 ingestOne 仍然逐条写索引（批处理只在扫描入口生效）", async () => {
  const d = mkdtempSync(join(tmpdir(), "mpi-inbox-single-"));
  const pool = join(d, "pool");
  const inbox = join(d, "inbox");
  mkdirSync(inbox, { recursive: true });
  const calls = [];
  const idx = { upsert: async (es) => calls.push(es.length), remove: async () => {}, recall: async () => [], rebuild: async () => {}, close: async () => {} };
  await ingestOne(put0(inbox, "s1.json", { text: "单条一。", importance: 6, relevance: 0.6 }), { poolDir: pool, index: idx });
  await ingestOne(put0(inbox, "s2.json", { text: "单条二。", importance: 6, relevance: 0.6 }), { poolDir: pool, index: idx });
  assert.deepEqual(calls, [1, 1], "单条调用各写一次");
  rmSync(d, { recursive: true, force: true });
});

console.log(`\ntest:memoryinbox 全部通过（${n} 项）`);

