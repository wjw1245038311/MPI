/**
 * 记忆池纯函数层测试（P0-1）
 * 覆盖：ULID/时间、序列化往返、坏 frontmatter 不崩、判重阈值边界、复现计数、晋升判定、列表容错。
 * 运行：npm run test:memorypool
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  newId, idTimestamp, nowIso, monthKey,
  serializeEntry, parseEntry, ensurePool, entryPath, writeEntry, listEntries,
  decideIngest, shouldPromote, promoteTarget, lexicalSimilarity, queryRelevance,
  THRESHOLD, PROMOTE_RECURRENCE,
} = await import("../src/main/zhiya/pool.ts");

let n = 0;
const t = (name, fn) => {
  fn();
  n++;
  console.log(`  ✅ ${name}`);
};

/** 假的"项目根目录"（测试只关心路径字符串流转，不写死本机盘符）。 */
const fakeRoot = join(tmpdir(), "mpi-fake-project");

const dir = mkdtempSync(join(tmpdir(), "mpi-pool-test-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

// --- id 与时间 --------------------------------------------------------------
t("ULID 26 字符且字典序随时间递增", () => {
  assert.equal(newId(1700000000000).length, 26);
  const a = newId(1700000000000);
  const b = newId(1700000000001);
  assert.ok(a < b, `同前缀下按时间排序：${a} < ${b}`);
});

t("ULID 前 10 字符能解回时间戳", () => {
  const now = 1758337391000;
  assert.equal(idTimestamp(newId(now)), now);
  assert.equal(idTimestamp("不是ulid"), null);
});

t("nowIso 可被 Date.parse，且 monthKey 正确", () => {
  const iso = nowIso(new Date(2026, 8, 20, 14, 3, 11));
  assert.ok(Number.isFinite(Date.parse(iso)), iso);
  assert.equal(monthKey(iso), "2026-09");
  assert.equal(monthKey("坏时间"), "0000-00");
});

// --- 序列化往返 -------------------------------------------------------------
const sample = {
  id: newId(1758337391000),
  createdAt: nowIso(new Date(2026, 8, 20, 14, 3, 11)),
  type: "semantic",
  temporal: "present",
  importance: 7,
  relevance: 0.71,
  recurrence: 2,
  project: "MPI",
  source: "session:abc#12",
  status: "inbox",
  promotedTo: null,
  tags: ["索引", "mem0", "带:冒号"],
  text: "zg 不提供代码调用图，调用图只有 alexandria 有。",
  evidence: ["`src/main/zhiya.ts:120` ZHIYA_PROMPT_BUDGET"],
  recurrences: ["2026-09-20T15:00:00+08:00（相似度 0.910，来源 session:x#1）"],
  warnings: [],
  path: null,
};

t("序列化 → 解析 往返一致（含引号、数组、复现记录、证据）", () => {
  const raw = serializeEntry(sample);
  assert.ok(raw.startsWith("---\n") && raw.includes("\n---\n"), "frontmatter 结构");
  const r = parseEntry(raw, null);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  const e = r.entry;
  for (const k of ["id", "createdAt", "type", "temporal", "importance", "relevance", "recurrence", "project", "source", "status", "text"]) {
    assert.deepEqual(e[k], sample[k], `字段 ${k} 往返一致`);
  }
  assert.deepEqual(e.tags, sample.tags, "tags 往返（含带冒号的元素）");
  assert.deepEqual(e.evidence, sample.evidence, "证据节往返");
  assert.deepEqual(e.recurrences, sample.recurrences, "复现记录往返");
  assert.equal(e.promotedTo, null, "promoted_to null");
});

t("promoted_to 有值时往返一致", () => {
  const r = parseEntry(serializeEntry({ ...sample, promotedTo: ".alexandria/knowledge/lessons/x.md" }));
  assert.equal(r.ok && r.entry.promotedTo, ".alexandria/knowledge/lessons/x.md");
});

// --- 坏输入：不崩、按 fail-closed 处理 --------------------------------------
t("缺 frontmatter → ok:false（不抛异常）", () => {
  const r = parseEntry("# 只是一段正文\n没有 frontmatter\n");
  assert.equal(r.ok, false);
  assert.match(r.reason, /frontmatter/);
});

t("正文为空 → ok:false", () => {
  const r = parseEntry(`---\nid: ${newId()}\ntype: semantic\n---\n\n<!-- 只有注释 -->\n`);
  assert.equal(r.ok, false);
});

t("字段值非法 → 保留条目但记 warning（不丢文件）", () => {
  const r = parseEntry(
    `---\nid: ${newId()}\ncreated_at: 2026-09-20T14:00:00+08:00\ntype: 打错了\ntemporal: 也没有\nimportance: 99\nrelevance: 3\nrecurrence: 0\nstatus: 乱写\n意外字段: 1\n---\n正文仍在。\n`,
  );
  assert.equal(r.ok, true, "条目保留");
  const w = r.entry.warnings.join(" | ");
  assert.match(w, /未知字段：意外字段/);
  assert.match(w, /type 取值非法/);
  assert.match(w, /importance 越界/);
  assert.match(w, /relevance 越界/);
  assert.match(w, /recurrence 非法/);
  assert.equal(r.entry.type, "semantic", "非法 type 回退到默认，但不丢条目");
  assert.equal(r.entry.text, "正文仍在。");
});

t("id 缺失但文件名是 ULID → 从文件名推导", () => {
  const id = newId(1758337391000);
  const r = parseEntry(`---\ntype: semantic\n---\n正文\n`, join(dir, `${id}.md`));
  assert.equal(r.ok && r.entry.id, id);
  assert.ok(r.ok && r.entry.createdAt, "created_at 从 id 推导");
});

// --- 落盘 / 列表 -----------------------------------------------------------
t("写入 → 列表：路径按年月分目录、按时间倒序", () => {
  ensurePool(dir);
  const e1 = { ...sample, id: newId(1758337391000), createdAt: nowIso(new Date(2026, 8, 20, 9, 0, 0)) };
  const e2 = { ...sample, id: newId(1758340000000), createdAt: nowIso(new Date(2026, 9, 2, 9, 0, 0)) };
  const p1 = writeEntry(dir, e1);
  writeEntry(dir, e2);
  assert.match(p1.replace(/\\/g, "/"), /\/inbox\/2026-09\//, "按年月分目录");
  assert.ok(readdirSync(join(dir, "inbox")).includes("2026-09"), "月份目录存在");
  const { entries } = listEntries(dir);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, e2.id, "最新的在前");
});

t("坏文件进 broken、不影响其它条目（列表不崩）", () => {
  const bad = join(dir, "inbox", "2026-09", "broken.md");
  writeFileSync(bad, "没有 frontmatter 的垃圾文件\n", "utf8");
  const { entries, broken } = listEntries(dir);
  assert.equal(entries.length, 2, "好条目仍列出");
  assert.equal(broken.length, 1, "坏文件被单列");
  assert.match(broken[0].reason, /frontmatter/);
  rmSync(bad);
});

/** 建一个干净的临时池目录（每个用例一个，互不干扰）。 */
const fresh = () => mkdtempSync(join(tmpdir(), "mpi-pool-fresh-"));

/** 造一条候选（默认都能过阈值，只有显式覆盖才会被拦）。 */
const cand = (over = {}) => ({
  text: "临时文件一律落 tempfile 目录，可随时清除。",
  type: "semantic",
  temporal: "retrospective",
  importance: 6,
  relevance: 0.6,
  project: "MPI",
  source: "test",
  ...over,
});

t("状态变更不换目录：标记 promoted 后条目仍在池里（换目录会静默丢条目）", () => {
  const { entries } = listEntries(dir);
  const e = entries.find((x) => x.project === "MPI");
  const oldPath = e.path;
  const dest = writeEntry(dir, { ...e, status: "promoted", promotedTo: ".alexandria/knowledge/lessons/x.md" });
  assert.equal(dest.replace(/\\/g, "/"), oldPath.replace(/\\/g, "/"), "路径不变（不换目录）");
  const after = listEntries(dir);
  assert.equal(after.entries.length, entries.length, "总数不变");
  const back = after.entries.find((x) => x.id === e.id);
  assert.equal(back.status, "promoted", "状态确实改了");
  assert.equal(back.promotedTo, ".alexandria/knowledge/lessons/x.md", "promoted_to 写入");
});

t("重要性低于阈值 → drop", () => {
  const d = fresh();
  const r = decideIngest(d, cand({ importance: 3 }), lexicalSimilarity);
  assert.equal(r.action, "drop");
  assert.match(r.reason, /重要性/);
  rmSync(d, { recursive: true, force: true });
});

t("相关性低于下限 → drop；命中 dedupe 下限之上才算重复", () => {
  const d = fresh();
  assert.equal(decideIngest(d, cand({ relevance: 0.44 }), lexicalSimilarity).action, "drop");
  rmSync(d, { recursive: true, force: true });
});

t("评分失败 → fail-open 放行并标 warning", () => {
  const d = fresh();
  const r = decideIngest(d, cand({ importance: 1, relevance: 0, scoringFailed: true }), lexicalSimilarity);
  assert.equal(r.action, "add");
  assert.match(r.entry.warnings.join(), /scoring-failed/);
  rmSync(d, { recursive: true, force: true });
});

t("新条目 → add；近似重复（>0.82）→ bump 累加复现计数", () => {
  const d = fresh();
  const a = decideIngest(d, cand(), lexicalSimilarity);
  assert.equal(a.action, "add");

  // 完全同一句话 → 相似度 1 → 判重
  const b = decideIngest(d, cand({ source: "session:t#2" }), lexicalSimilarity);
  assert.equal(b.action, "bump");
  assert.equal(b.entry.recurrence, 2);
  assert.equal(listEntries(d).entries.length, 1, "没有新增第二条");

  // 落盘后复现记录还在（重新读盘校验）
  const reread = listEntries(d).entries[0];
  assert.equal(reread.recurrence, 2);
  assert.equal(reread.recurrences.length, 1);

  // 明显不同的内容 → 新条目
  const c = decideIngest(d, cand({ text: "局域网文件分发服务不需要 Docker 部署。" }), lexicalSimilarity);
  assert.equal(c.action, "add");
  assert.equal(listEntries(d).entries.length, 2);
  rmSync(d, { recursive: true, force: true });
});

t("判重阈值边界：0.82 以下不判重（不同内容分列两条）", () => {
  const d = fresh();
  decideIngest(d, cand({ text: "推送前必须等用户确认。" }), lexicalSimilarity);
  const r = decideIngest(d, cand({ text: "临时文件一律落 tempfile 目录。" }), lexicalSimilarity);
  assert.equal(r.action, "add");
  rmSync(d, { recursive: true, force: true });
});

t("lexicalSimilarity 边界合理（同一句=1、无关句低）", () => {
  assert.equal(lexicalSimilarity("abc", "abc"), 1);
  assert.ok(lexicalSimilarity("推送前必须等用户确认", "推送前必须等用户确认") === 1);
  assert.ok(lexicalSimilarity("推送前必须等用户确认", "临时文件落在 tempfile") < 0.2);
  assert.ok(lexicalSimilarity("压测发现探针不准", "探针不准，压测发现") > 0.5, "词序不同仍应偏高");
});

// --- 晋升 -------------------------------------------------------------------
t("复现到 N=3 → shouldPromote；项目内走 KB、通用走提案", () => {
  const d = fresh();
  decideIngest(d, cand(), lexicalSimilarity);
  decideIngest(d, cand(), lexicalSimilarity);
  decideIngest(d, cand(), lexicalSimilarity);
  const e = listEntries(d).entries[0];
  assert.equal(e.recurrence, PROMOTE_RECURRENCE);
  assert.equal(shouldPromote(e), true);
  assert.equal(promoteTarget(e), "kb-lessons", "有项目 → 项目 KB lessons");

  const g = { ...e, project: "global" };
  assert.equal(promoteTarget(g), "proposal", "通用性 → 提案待审批");
  assert.equal(shouldPromote({ ...e, status: "promoted" }), false, "已晋升的不再重复提案");
  rmSync(d, { recursive: true, force: true });
});

t("queryRelevance 非对称：短查询命中长文档不被长度压制（旧实现踩过的坑）", () => {
  const doc = "zg 不提供代码调用图，调用图只有 alexandria 有。";
  const other = "推送前必须等用户确认，无人值守时只 commit 不 push。";
  // 整串命中 → 满分
  assert.equal(queryRelevance("调用图", doc), 1);
  // 短查询 vs 长文档：应有明显非零相关性，且高于无关文档
  const rel = queryRelevance("调用图 谁提供", doc);
  assert.ok(rel > 0.5, `应 >0.5，实际 ${rel}`);
  assert.ok(rel > queryRelevance("调用图 谁提供", other), "相关文档应高于无关文档");
  // 对称的判重函数确实带长度惩罚（两者用途不同，不能混用）
  assert.ok(lexicalSimilarity("调用图 谁提供", doc) < 0.1, "判重函数对短长不匹配给低分（这是对的，它管的是同一件事）");
});

// --- 阈值常量与文档一致 -----------------------------------------------------
t("阈值常量与 MEMORY-MODEL.md 一致（4 / 0.45 / 0.82 / N=3）", () => {
  assert.equal(THRESHOLD.minImportance, 4);
  assert.equal(THRESHOLD.minRelevance, 0.45);
  assert.equal(THRESHOLD.dedupeRelevance, 0.82);
  assert.equal(PROMOTE_RECURRENCE, 3);
});

t("listEntries 只扫 inbox/：提案不会被当成记忆条目（真事故）", () => {
  const d = mkdtempSync(join(tmpdir(), "mpi-pool-scan-"));
  decideIngest(d, { text: "真条目。", type: "semantic", temporal: "retrospective", importance: 6, relevance: 0.6, project: "MPI", source: "t" }, lexicalSimilarity);
  // 造一个"看起来像提案"的文件放进 proposals/
  mkdirSync(join(d, "proposals"), { recursive: true });
  const proposalText = [
    "---",
    `id: ${newId()}`,
    "created: 2026-09-20T00:00:00.000Z",
    "kind: promote-kb",
    "status: pending",
    "outlet: kb",
    "entries: x",
    "title: 提案",
    "---",
    "",
    "# 提案",
    "",
    "正文",
    "",
  ].join("\n");
  writeFileSync(join(d, "proposals", `${newId()}.md`), proposalText, "utf8");
  const r = listEntries(d);
  assert.equal(r.entries.length, 1, "只应有 1 条真条目");
  assert.equal(r.entries[0].text.includes("真条目"), true);
  assert.equal(r.broken.length, 0, "提案文件不该被当成坏条目报出来");
  rmSync(d, { recursive: true, force: true });
});

t("项目根目录：root 字段往返一致、缺省为 null、不触发未知字段告警", () => {
  const dir = mkdtempSync(join(tmpdir(), "mpi-pool-root-"));
  const d = decideIngest(dir, {
    text: "带项目根的条目。",
    type: "semantic",
    temporal: "retrospective",
    importance: 6,
    relevance: 0.6,
    project: "MPI",
    projectRoot: fakeRoot,
    source: "test",
  }, lexicalSimilarity);
  const back = listEntries(dir).entries[0];
  assert.equal(back.projectRoot, fakeRoot, "root 字段往返一致（Windows 反斜杠不被吃掉）");
  assert.ok(readFileSync(d.entry.path, "utf8").includes("root: "), "落盘有 root 键");

  // 老条目没有 root 字段 → null，绝不能变成字符串 "undefined"
  const legacy = serializeEntry({ ...back, projectRoot: null });
  assert.ok(legacy.includes("root: null"), "无 root 写成 null");
  const reparsed = parseEntry(legacy);
  assert.equal(reparsed.ok, true);
  assert.equal(reparsed.entry.projectRoot, null, "解析回来是 null");
  assert.deepEqual(reparsed.entry.warnings, [], "root 是已知键，不产生未知字段告警");
  rmSync(dir, { recursive: true, force: true });
  ;
});

console.log(`\ntest:memorypool 全部通过（${n} 项）`);
