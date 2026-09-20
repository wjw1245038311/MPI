/**
 * mem0 → 知芽池 迁移 CLI（P5-1）
 *
 * 默认 **--dry-run（只出报告，不写任何文件）**；要真写必须显式加 --apply。
 *
 *   npm run mem0:plan                      # 干跑：范围筛选 + 去重 + 统计报告
 *   npm run mem0:plan -- --all             # 看全量口径（872 条）的报告
 *   npm run mem0:plan -- --english         # 英文为主全纳入（73 → 263 口径）
 *   npm run mem0:plan -- --attributed      # 额外纳入 attributed_to=user
 *   npm run mem0:apply -- --limit 5        # 真写（先小批量）：默认写进真池
 *
 * 输入：scripts/mem0-export.py 产出的 JSONL（默认工作区 tempfile/mem0-export.jsonl）
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { planMigration, classify, DEVICE_LABEL, fileHash, writeManifest, rollbackMigration } = await import("../src/main/zhiya/mem0-migrate.ts");
const { ingestBatch, lexicalSimilarity, makeSimilarity } = await import("../src/main/zhiya/pool.ts");
const { defaultPoolDir } = await import("../src/main/zhiya/memory-index.ts");

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const val = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const input = val("input", "E:/MyWorkspace/tempfile/mem0-export.jsonl");
const poolDir = val("pool", defaultPoolDir());
const kbDir = val("kb", null);
const apply = flag("apply");
const diverse = flag("diverse");
const rollbackFile = val("rollback", null);
const limit = val("limit", null) ? Number(val("limit")) : null;
const scope = {
  highValueOnly: !flag("all"),
  includeAllEnglish: flag("english"),
  includeAttributed: flag("attributed"),
};

// ---- 回滚模式：按 manifest 撤销（默认只删哈希一致的，被改过的需 --force）----
if (rollbackFile) {
  const res = rollbackMigration(rollbackFile, { force: flag("force") });
  console.log(`
=== 回滚（manifest: ${rollbackFile}）===`);
  console.log(`已删除：${res.removed.length} 个文件`);
  if (res.missing.length) console.log(`文件已不在（可能被手动删过）：${res.missing.length}`);
  if (res.changed.length) {
    console.log(`⚠️ 内容已被改动、**未删除**：${res.changed.length}（确认要删加 --force）`);
    for (const f of res.changed.slice(0, 5)) console.log(`  · ${f}`);
  }
  process.exit(0);
}

if (!existsSync(input)) {
  console.log(`找不到导出文件：${input}\n先跑：python scripts/mem0-export.py`);
  process.exit(1);
}
const recs = readFileSync(input, "utf8")
  .split(/\r?\n/)
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

console.log(`\n=== mem0 → 知芽池 迁移${apply ? "【真写】" : "（干跑，不写任何文件）"} ===`);
console.log(`导出文件：${input}（${recs.length} 条）`);
console.log(`目标池：${poolDir}`);
console.log(`范围：${scope.highValueOnly ? "只高价值类（insight/tool-quirk/correction/英文事实）" : "全量"}${scope.includeAllEnglish ? " + 英文为主全部" : ""}${scope.includeAttributed ? " + attributed_to=user" : ""}`);

const plan = planMigration(recs, { poolDir, kbDir, scope, similarity: lexicalSimilarity, threshold: 0.9 });

const pct = (n, of) => `${n}（${((n / Math.max(1, of)) * 100).toFixed(1)}%）`;
console.log(`\n--- 对账（与勘察报告 §0 逐项核对）---`);
console.log(`总点数：${recs.length}（勘察：872）`);
console.log(
  `全量形态分布（去重/筛选前）：${Object.entries(plan.stats.byRuleRaw)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join("  ")}`,
);
console.log(`  （勘察：tool-quirk=19  insight=7  correction=3  英文事实=73；其余为普通语句/事件叙述）`);
console.log(
  `完全重复：${plan.stats.duplicateRaw} 条（勘察：22 —— 差异因本脚本的归一化更严格：去空白与标点，把"只差标点"的也视作同一条）= 范围内 ${plan.stats.duplicateInMem0} + 范围外 ${plan.stats.duplicateOutOfScope}`,
);

console.log(`\n--- 范围 ---`);
console.log(
  `范围口径命中：${plan.stats.inScope + plan.stats.duplicateInMem0} 条 → 去掉范围内 ${plan.stats.duplicateInMem0} 条完全重复 → **待写入 ${plan.toWrite.length} 条**`,
);
console.log(`范围内分类：${Object.entries(plan.stats.byRule).map(([k, v]) => `${k}=${v}`).join("  ") || "—"}`);
console.log(`项目分布：${Object.entries(plan.stats.byProject).map(([k, v]) => `${k}=${v}`).join("  ")}`);
console.log(`设备分布：${Object.entries(plan.stats.byDevice).map(([k, v]) => `${DEVICE_LABEL[k] || k}=${v}`).join("  ")}`);
console.log(`月份分布：${Object.entries(plan.stats.byMonth).sort().map(([k, v]) => `${k}=${v}`).join("  ")}`);
console.log(`\n--- 去重 ---`);
const byReason = {};
for (const s of plan.skipped) byReason[s.reason] = (byReason[s.reason] ?? 0) + 1;
console.log(`跳过合计：${plan.skipped.length} 条`);
for (const [k, v] of Object.entries(byReason).sort()) console.log(`  ${k}: ${v}`);
if (plan.skipped.length) {
  for (const s of plan.skipped.slice(0, 5)) console.log(`  · ${s.key.slice(0, 22)} [${s.reason}] ${s.detail.slice(0, 90)}`);
}
console.log(`\n--- 范围外（留在 mem0）---`);
const outTotal = Object.values(plan.outOfScope.byRule).reduce((a, b) => a + b, 0);
console.log(`合计 ${pct(outTotal, recs.length)}：${Object.entries(plan.outOfScope.byRule).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  ")}`);

console.log(`\n--- 待写入样例（前 3 条）---`);
for (const { rec, cand } of plan.toWrite.slice(0, 3)) {
  console.log(`  · [${cand.type}/${cand.temporal}] ${cand.project} · ${String(rec.created_at).slice(0, 10)} · tags=${(cand.tags || []).join(",")}`);
  console.log(`    ${cand.text.slice(0, 110).replace(/\n/g, " ")}…`);
}

if (!apply) {
  console.log(`\n（干跑结束。要真写：npm run mem0:apply，建议先 --limit 5 小批量验证）`);
  process.exit(0);
}

// ---- 真写：走批量通道（一次读池 + 内存判定），并把幂等键写进 evidence ----
// 取样：--limit N 取前 N；--diverse 先每类各取一条再补足（小批量验证时覆盖各分类）
let picked = plan.toWrite;
if (diverse) {
  // 每个分类先各抽一条，剩下的按原顺序补——小批量验证时能覆盖全部分类
  const seenRule = new Set();
  const heads = [];
  const rest = [];
  for (const item of plan.toWrite) {
    const r = classify(item.rec).rule;
    if (seenRule.has(r)) rest.push(item);
    else {
      seenRule.add(r);
      heads.push(item);
    }
  }
  picked = [...heads, ...rest];
}
const toWrite = limit ? picked.slice(0, limit) : picked;
if (!toWrite.length) {
  console.log("\n没有要写入的条目。");
  process.exit(0);
}
const t0 = Date.now();
// 先写 manifest 占位（写入后回填哈希）——回滚要能只靠这一份文件
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const manifestPath = val("manifest", join(poolDir, ".migration", `mem0-${stamp}.jsonl`));
const { ctx } = ingestBatch(poolDir, toWrite.map((x) => x.cand), makeSimilarity());
const ms = Date.now() - t0;
const manifestLines = ctx.added.map((e) => {
  const src = toWrite.find((x) => x.cand.text === e.text);
  return {
    key: src ? `mem0:${src.rec._point_id}` : "",
    entryId: e.id,
    file: e.path,
    project: e.project,
    rule: src ? classify(src.rec).rule : "",
    sha256: fileHash(e.path) || "",
    writtenAt: new Date().toISOString(),
  };
});
writeManifest(manifestPath, manifestLines);
console.log(`\n--- 写入结果 ---`);
console.log(`新增 ${ctx.added.length} / 累加 ${ctx.bumped.length} / 用时 ${(ms / 1000).toFixed(2)}s`);
console.log(`manifest：${manifestPath}（${manifestLines.length} 行）`);
console.log(`回滚：npm run mem0:plan -- --rollback "${manifestPath}"`);
for (const l of manifestLines) console.log(`  写 ${l.entryId} [${l.rule}] ${l.project} → ${l.file}`);
if (ctx.bumped.length) {
  console.log(`⚠️ 有 ${ctx.bumped.length} 条被判为重复累加（不是新增）——抽查确认是否符合预期：`);
  for (const e of ctx.bumped.slice(0, 5)) console.log(`  · ${e.id} 复现 ${e.recurrence}：${e.text.slice(0, 80)}`);
}
console.log(`\n下一步：npm run mem0:plan（重跑应显示 already-imported = ${toWrite.length}，即幂等成立）`);
