/**
 * mem0 → 知芽池 迁移映射测试（P5-1）
 *
 * 重点钉住的是**不会静默出错**的几件事：
 *   - 正文一字不改（改写 = 幻觉）
 *   - 分类与范围口径能和勘察报告对账（102 条那套）
 *   - 幂等（重跑不重复写入）
 *   - 去重三层都真的会拦（mem0 内部 / 已导入 / 池内 / KB）
 *
 * 运行：npm run test:mem0migrate
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { classify, inScope, toCandidate, idempotencyKey, planMigration, importedKeys, zhRatio, isEnglishFact, writeManifest, readManifest, rollbackMigration, fileHash } =
  await import("../src/main/zhiya/mem0-migrate.ts");
const { decideIngest, listEntries, openIngestCtx } = await import("../src/main/zhiya/pool.ts");

let n = 0;
const ok = (m) => {
  n++;
  console.log(`  ✅ ${m}`);
};
const CH_NL = String.fromCharCode(10);
const tmpRoot = mkdtempSync(join(tmpdir(), "mpi-p5-1-"));
process.on("exit", () => rmSync(tmpRoot, { recursive: true, force: true }));
const fresh = (name) => {
  const d = join(tmpRoot, name);
  mkdirSync(d, { recursive: true });
  return d;
};
const rec = (over = {}) => ({
  _point_id: `id-${Math.random().toString(36).slice(2, 10)}`,
  data: "普通的一条记忆。",
  created_at: "2026-09-10T10:00:00+08:00",
  user_id: "wjj",
  agent_id: "MPI",
  role: "user",
  ...over,
});

// ---------------------------------------------------------------------------
// 分类规则
// ---------------------------------------------------------------------------
{
  const cases = [
    ["[insight] 单写者 + 短持有句柄。", "insight", "semantic", 7],
    ["[tool-quirk] LM Studio 只认 bundled 模型。", "tool-quirk", "procedural", 7],
    ["[correction] 上一轮的结论是错的，应为……", "correction", "semantic", 7],
    ["User's workstation is a LENOVO ThinkStation.", "english-fact", "semantic", 6],
    ["  [Insight] 大小写与前导空白也要认出来。", "insight", "semantic", 7],
    ["2026-09-15 实测发现：批量 flush 提速 23×。", "dated-event", "episodic", 5],
    ["这是一条普通的自然语句。", "plain", "semantic", 5],
  ];
  for (const [text, rule, type, importance] of cases) {
    const c = classify(rec({ data: text }));
    assert.equal(c.rule, rule, `规则：${text.slice(0, 20)}`);
    assert.equal(c.type, type, `type：${text.slice(0, 20)}`);
    assert.equal(c.importance, importance, `importance：${text.slice(0, 20)}`);
    assert.ok(c.importance >= 4, "迁移默认分不得低于池子 minImportance（否则会被判 drop）");
  }
  ok("分类：insight / tool-quirk / correction / 英文事实 / 事件叙述 / 普通语句（含大小写与前导空白）");

  assert.ok(isEnglishFact("User's services are tailnet-only."));
  assert.ok(isEnglishFact("User prefers Tailscale Serve."));
  assert.ok(!isEnglishFact("用户的偏好是……"), "中文陈述不算英文事实");
  assert.equal(zhRatio("中文"), 1);
  assert.equal(zhRatio("abc"), 0);
  assert.equal(zhRatio(""), 0);
  ok("英文事实判定与中文占比：边界正确（中文陈述不误判）");
}

// ---------------------------------------------------------------------------
// 范围口径（= 方案 §0 的 102 条那套）
// ---------------------------------------------------------------------------
{
  const highValue = [
    rec({ data: "[insight] a" }),
    rec({ data: "[tool-quirk] b" }),
    rec({ data: "[correction] c" }),
    rec({ data: "User's english fact." }),
  ];
  const others = [rec({ data: "普通语句" }), rec({ data: "2026-09-15 实测发现：x。" })];
  for (const r of highValue) assert.ok(inScope(r), `应在范围内：${r.data}`);
  for (const r of others) assert.ok(!inScope(r), `应在范围外：${r.data}`);

  // 范围外条目在 includeAllEnglish 下要能显式纳入（口径不同，必须用户主动开）
  const enPlain = rec({ data: "Workstation cannot establish passwordless SSH to minibox." });
  assert.ok(!inScope(enPlain), "默认口径不含「英文为主但非 User 开头」的条目");
  assert.ok(inScope(enPlain, { includeAllEnglish: true }), "显式开 --english 后纳入");
  assert.ok(inScope(others[0], { highValueOnly: false }), "全量口径下都纳入");
  assert.ok(
    inScope(rec({ data: "普通语句", attributed_to: "user" }), { includeAttributed: true }),
    "显式开 --attributed 后纳入 attributed_to=user",
  );
  ok("范围：默认只含高价值四类；--english / --attributed / --all 三种扩口径各自生效");
}

// ---------------------------------------------------------------------------
// 字段映射：正文一字不改 + 幂等键 + 标签
// ---------------------------------------------------------------------------
{
  const raw = "[tool-quirk] LM Studio 的 /v1/embeddings 只认 bundled 的 nomic-embed-text。\n第二行也要原样保留。";
  const r = rec({ data: raw, user_id: "wjj-mb", agent_id: "Work", migrated_from: "pi-hermes failures.md" });
  const c = toCandidate(r);
  assert.equal(c.text, raw.trim(), "正文必须一字不改（只去首尾空白）");
  assert.equal(c.project, "Work");
  assert.equal(c.importance, 7);
  assert.equal(c.relevance, 0.7, "相关性是迁移默认值");
  assert.equal(c.projectRoot, undefined, "mem0 没有项目根，不得瞎猜");
  for (const tag of ["tool-quirk", "from-mem0", "origin:手机", "from-pi-hermes", "user-said"]) {
    assert.ok((c.tags || []).includes(tag), `应有标签 ${tag}`);
  }
  assert.ok((c.evidence || []).includes(idempotencyKey(r)), "evidence 必须含 mem0:<uuid> 幂等键");
  assert.ok((c.evidence || []).some((e) => e.startsWith("mem0-user:")), "evidence 记设备");

  const noAgent = toCandidate(rec({ agent_id: "None" }));
  assert.equal(noAgent.project, "global", "没有 agent_id → global（不是瞎填项目）");
  const nullAgent = toCandidate(rec({ agent_id: null }));
  assert.equal(nullAgent.project, "global");
  ok("字段映射：正文一字不改、项目映射、设备标签、evidence 幂等键、无 agent_id → global");
}

// ---------------------------------------------------------------------------
// 去重三层 + 幂等
// ---------------------------------------------------------------------------
{
  const pool = fresh("dedup-pool");
  const kb = fresh("dedup-kb");
  writeFileSync(join(kb, "SomeLesson.md"), "---\ntitle: x\n---\n\n# 已有教训\n\n正文里包含：[insight] 这条已经写进知识库了，不必再迁。\n", "utf8");

  const dupText = "[insight] 同一条洞见被记录了两次。";
  const alreadyText = "[insight] 这条之前已经导入过池子了。";
  // 必须是在范围口径**之内**的条目，才能真正验证"KB 已有 → 跳过"这一步
  const kbText = "[insight] 这条已经写进知识库了，不必再迁。";

  const recs = [
    rec({ _point_id: "d1", data: dupText, created_at: "2026-09-05T10:00:00+08:00" }),
    rec({ _point_id: "d2", data: dupText, created_at: "2026-09-06T10:00:00+08:00" }), // 后出现 → 压复现
    rec({ _point_id: "a1", data: alreadyText }),
    rec({ _point_id: "k1", data: kbText }),
    rec({ _point_id: "n1", data: "[insight] 全新的洞见，应该被写入。" }),
    rec({ _point_id: "e1", data: "" }), // 空正文
    rec({ _point_id: "o1", data: "范围外的普通语句。" }),
  ];

  // 先"导入过" a1：直接写一条带同样幂等键的池内条目
  const ctx = openIngestCtx(pool);
  decideIngest(ctx.poolDir, {
    text: "这条之前已经导入过池子了。", type: "semantic", temporal: "retrospective",
    importance: 7, relevance: 0.7, project: "MPI", source: "test",
    evidence: [`mem0:a1`],
  }, () => 0);
  assert.equal(importedKeys(pool).has("mem0:a1"), true, "能从池子里读出已导入的幂等键");

  const plan = planMigration(recs, { poolDir: pool, kbDir: kb });
  const reasons = new Map(plan.skipped.map((s) => [s.key, s.reason]));
  assert.equal(reasons.get("mem0:d2"), "duplicate-in-mem0", "后出现的完全相同正文 → 压成复现");
  assert.equal(reasons.get("mem0:a1"), "already-imported", "已导入 → 跳过");
  assert.equal(reasons.get("mem0:k1"), "exists-in-kb", "知识库里已有 → 跳过");
  assert.equal(reasons.get("mem0:e1"), "empty-text", "空正文 → 跳过");
  assert.equal(reasons.has("mem0:o1"), false, "范围外条目不算 skipped（记在 outOfScope）");
  assert.deepEqual(plan.toWrite.map((x) => x.rec._point_id), ["d1", "n1"], "应写入：代表条 + 全新条");
  assert.deepEqual(plan.outOfScope.byRule, { plain: 1 }, "范围外统计正确");

  // 复现次数以标签形式带过去（d1 组有 2 条 → dups:1）
  const d1 = plan.toWrite.find((x) => x.rec._point_id === "d1");
  assert.ok((d1.cand.tags || []).includes("mem0-dups:1"), "重复组应留下 mem0-dups:N 标签");

  // 对账字段
  assert.equal(plan.stats.duplicateRaw, 1, "全量完全重复 1 条（d1/d2）");
  assert.equal(plan.stats.byRuleRaw.insight, 5, "全量 insight 5 条（d1/d2/a1/k1/n1，去重去筛选前）");
  ok("去重三层：mem0 内部（压复现）→ 已导入（幂等键）→ 知识库已有；空正文与范围外分开统计");
}

// ---------------------------------------------------------------------------
// 幂等：连跑两次计划，结果必须一致（干跑不改任何东西）
// ---------------------------------------------------------------------------
{
  const pool = fresh("idem-pool");
  const recs = [rec({ _point_id: "i1", data: "[insight] 幂等测试。" }), rec({ _point_id: "i2", data: "User's idempotent fact." })];
  const p1 = planMigration(recs, { poolDir: pool });
  const p2 = planMigration(recs, { poolDir: pool });
  assert.deepEqual(
    p1.toWrite.map((x) => x.rec._point_id),
    p2.toWrite.map((x) => x.rec._point_id),
    "两次干跑结果一致",
  );
  assert.equal(listEntries(pool).entries.length, 0, "干跑不得写任何文件");

  // 模拟"导入完成"：把计划真正写进池子（走批量通道）
  const { ingestBatch } = await import("../src/main/zhiya/pool.ts");
  ingestBatch(pool, p1.toWrite.map((x) => x.cand));
  assert.equal(listEntries(pool).entries.length, 2, "写入 2 条");
  const p3 = planMigration(recs, { poolDir: pool });
  assert.equal(p3.toWrite.length, 0, "重跑计划：0 条待写（幂等成立）");
  assert.equal(p3.skipped.filter((s) => s.reason === "already-imported").length, 2, "两条都记为 already-imported");
  ok("幂等：干跑不写文件；导入后重跑 0 条待写（全部 already-imported）");
}

// ---------------------------------------------------------------------------
// 真实导出文件对账（存在就核，缺了不失败）
// ---------------------------------------------------------------------------
{
  const { existsSync, readFileSync } = await import("node:fs");
  const file = "E:/MyWorkspace/tempfile/mem0-export.jsonl";
  if (existsSync(file)) {
    const recs = readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
    const plan = planMigration(recs, { poolDir: null });
    assert.equal(recs.length, 872, `导出条数应为 872，实际 ${recs.length}`);
    const raw = plan.stats.byRuleRaw;
    assert.equal(raw["tool-quirk"], 19, "tool-quirk 应 19");
    assert.equal(raw.insight, 7, "insight 应 7");
    assert.equal(raw.correction, 3, "correction 应 3");
    assert.equal(raw["english-fact"], 73, "英文事实应 73");
    const hit = (raw.insight ?? 0) + (raw["tool-quirk"] ?? 0) + (raw.correction ?? 0) + (raw["english-fact"] ?? 0);
    assert.equal(hit, 102, `范围口径命中应 102，实际 ${hit}`);
    assert.equal(plan.toWrite.length, 96, "去重后待写入应 96（102 − 6 条范围内重复）");
    ok(`真实导出对账：872 条 / tool-quirk 19 / insight 7 / correction 3 / 英文事实 73 / 口径 102 → 待写 ${plan.toWrite.length}`);
  } else {
    console.log("  ⏭️ 跳过真实导出对账（先跑 python scripts/mem0-export.py 生成）");
  }
}


// ---------------------------------------------------------------------------
// manifest + 回滚（写真实池子前的安全网）
// ---------------------------------------------------------------------------
{
  const { ingestBatch } = await import("../src/main/zhiya/pool.ts");
  const pool = fresh("manifest-pool");
  const recs = [
    rec({ _point_id: "m1", data: "[insight] 回滚测试第一条。" }),
    rec({ _point_id: "m2", data: "[tool-quirk] 回滚测试第二条。" }),
  ];
  const plan = planMigration(recs, { poolDir: pool });
  const { ctx } = ingestBatch(pool, plan.toWrite.map((x) => x.cand));
  const manifestPath = join(pool, ".migration", "test.jsonl");
  writeManifest(
    manifestPath,
    ctx.added.map((e) => ({
      key: `mem0:${e.id}`,
      entryId: e.id,
      file: e.path,
      project: e.project,
      rule: "insight",
      sha256: fileHash(e.path),
      writtenAt: new Date().toISOString(),
    })),
  );
  const mLines = readManifest(manifestPath);
  assert.equal(mLines.length, 2, "manifest 两行");
  assert.ok(mLines.every((l) => l.sha256 && l.file), "每行都有文件路径与哈希");
  assert.equal(listEntries(pool).entries.length, 2, "池内 2 条");

  // 干扰项：不在 manifest 里的条目，回滚不得碰它
  ingestBatch(pool, [
    { text: "不在 manifest 里的条目，回滚不该删。", type: "semantic", temporal: "retrospective", importance: 6, relevance: 0.7, project: "MPI", source: "test" },
  ]);
  assert.equal(listEntries(pool).entries.length, 3, "现在是 3 条");

  // 先留一份内容副本（后面要按原路径还原，才能验证"文件被改过"这条分支）
  const saved = ctx.added.map((e) => ({ path: e.path, content: readFileSync(e.path, "utf8") }));

  const res = rollbackMigration(manifestPath, {});
  assert.equal(res.removed.length, 2, "删掉 manifest 里的 2 条");
  assert.equal(res.changed.length, 0, "无内容变动");
  assert.equal(listEntries(pool).entries.length, 1, "无关条目没被误删");
  ok("manifest + 回滚：按清单精确删除，不碰清单外的条目");

  // 还原：第一条原样、第二条被人工改过
  writeFileSync(saved[0].path, saved[0].content, "utf8");
  writeFileSync(saved[1].path, saved[1].content + CH_NL + CH_NL + "（后续被人工改过）" + CH_NL, "utf8");
  const r2 = rollbackMigration(manifestPath, {});
  assert.equal(r2.removed.length, 1, "只删哈希一致的那条");
  assert.equal(r2.changed.length, 1, "被改动的那条默认不删");
  assert.equal(r2.missing.length, 0, "两条此刻都在盘上（一条被改过一条未变）");
  assert.ok(readFileSync(saved[1].path, "utf8").includes("被人工改过"), "被改动的文件确实还在");
  const r2b = rollbackMigration(manifestPath, { force: false });
  assert.equal(r2b.changed.length, 1, "再跑一次仍拒绝删（幂等：不会悄悄升级为删除）");
  rollbackMigration(manifestPath, { force: true });
  assert.equal(existsSync(saved[1].path), false, "force 后连被改动的也删");
  assert.equal(existsSync(saved[0].path), false, "force 下已删的保持删除");
  ok("回滚安全性：内容被改动的默认跳过（需 --force），缺失文件单独记为 missing");

  // dry-run：只报告不真删
  writeFileSync(saved[0].path, saved[0].content, "utf8");
  const dry = rollbackMigration(manifestPath, { dryRun: true });
  assert.ok(dry.removed.length >= 1, "dryRun 报告会删的条数");
  assert.ok(dry.removed.every((f) => existsSync(f)), "dryRun 不得真删");
  ok("回滚 dry-run：只报告，不真删文件");
}


// ---------------------------------------------------------------------------
// 创建时间保留（真机迁移抓到的 bug：Candidate 没有 createdAt → 全变成"迁移当天"）
// ---------------------------------------------------------------------------
{
  const { ingestBatch, decideIngest } = await import("../src/main/zhiya/pool.ts");
  const pool = fresh("createdat-pool");
  const { ctx } = ingestBatch(pool, [
    { text: "带原时间的条目。", createdAt: "2026-09-02T08:30:00+08:00", type: "semantic", temporal: "retrospective", importance: 6, relevance: 0.7, project: "MPI", source: "test" },
  ]);
  const e = ctx.added[0];
  assert.equal(e.createdAt.slice(0, 10), "2026-09-02", "候选给了 createdAt 就必须用它（不是迁移当天）");
  assert.ok(e.path.includes("2026-09"), `落盘月份目录应按原时间：${e.path}`);
  assert.ok(e.id.startsWith(""), "ULID 仍为 26 位时间序 id");
  assert.ok(e.id.slice(0, 10).length === 10, "id 前 10 位编码时间序");
  ok("创建时间：候选带 createdAt 时保留原时间，并按原时间落月目录");

  // 非法时间不能炸：退回"现在"
  const d = decideIngest(pool, { text: "非法时间的条目。", createdAt: "不是时间", type: "semantic", temporal: "retrospective", importance: 6, relevance: 0.7, project: "MPI", source: "test" }, () => 0);
  assert.equal(d.action, "add", "非法 createdAt 不应导致失败");
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(d.entry.createdAt.slice(0, 10), today, "非法时间退回现在");
  ok("创建时间：非法 createdAt 安全退回「现在」（不因脏数据炸掉写入）");
}

console.log(`\ntest:mem0migrate 全部通过（${n} 项）`);
