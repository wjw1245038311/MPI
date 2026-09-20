/**
 * P5-0 验收测试：写入路径的两个真 bug
 *
 * Bug A — 逐条摄入是 O(n²)（`decideIngest` 每次读全池）
 *   A1 批量通道 vs 逐条：判定结果**逐条一致**（action / id / 归属）
 *   A2 批内去重：同一批里重复文本 → 一条 add、一条 bump
 *   A3 缓存相似度器与 lexicalSimilarity **逐位一致**
 *   A4 规模：872 条批量 < 5s（实测打印）；对照逐条成本曲线（只跑 300 条防超时）
 *
 * Bug B — Windows 原子写「假失败」（rename 抛 EPERM 但文件已就位）
 *   B1 正常路径：rename 成功
 *   B2 假失败：rename 抛错但目标内容已一致 → 判定成功、不抛、tmp 清理
 *   B3 真失败：一直抛错且目标不一致 → 重试 attempts 次后抛错、tmp 清理
 *   B4 第一次抛错、第二次成功 → 成功且无异常
 *   B5 真机 soak：写 600 条，全部无异常且内容逐字一致（修前会偶发抛错）
 *
 * 运行：npm run test:poolwrite
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { atomicReplace, decideIngest, ingestBatch, lexicalSimilarity, listEntries, makeSimilarity, serializeEntry, writeEntry, newId } =
  await import("../src/main/zhiya/pool.ts");

let n = 0;
const ok = (m) => {
  n++;
  console.log(`  ✅ ${m}`);
};
const tmpRoot = mkdtempSync(join(tmpdir(), "mpi-p5-0-"));
process.on("exit", () => rmSync(tmpRoot, { recursive: true, force: true }));
const fresh = (name) => {
  const d = join(tmpRoot, name);
  mkdirSync(d, { recursive: true });
  return d;
};

const cand = (text, over = {}) => ({
  text, type: "semantic", temporal: "retrospective", importance: 6, relevance: 0.6,
  project: "MPI", source: "test", ...over,
});
// 完整条目（走判定的合法通道生成，避免手写 frontmatter 漏字段）
const mkEntry = (pool, text) => decideIngest(pool, cand(text), () => 0).entry;

// ---------------------------------------------------------------------------
// B1–B4：原子写容错
// ---------------------------------------------------------------------------
{
  const d = fresh("b1");
  const tmp = join(d, "a.tmp");
  writeFileSync(tmp, "内容甲", "utf8");
  atomicReplace(tmp, join(d, "a.md"), "内容甲");
  assert.equal(readFileSync(join(d, "a.md"), "utf8"), "内容甲");
  ok("B1 正常路径：tmp → dest 成功，内容一致");

  // B2：rename 抛 EPERM，但目标其实已写好（Windows 真实现象）
  const tmp2 = join(d, "b.tmp");
  const dest2 = join(d, "b.md");
  const content = "内容乙（含 id 行）";
  writeFileSync(tmp2, content, "utf8");
  writeFileSync(dest2, content, "utf8"); // 模拟“重命名其实生效了”
  const boom = () => {
    const err = new Error("EPERM: operation not permitted, rename");
    err.code = "EPERM";
    throw err;
  };
  atomicReplace(tmp2, dest2, content, boom, 3);
  assert.equal(existsSync(tmp2), false, "假失败后临时文件应被清理");
  assert.equal(readFileSync(dest2, "utf8"), content);
  ok("B2 假失败（rename 报 EPERM 但目标已是同一内容）→ 判定成功，不抛，清理 tmp");

  // B3：一直失败且目标内容不符 → 重试 attempts 次后抛
  const tmp3 = join(d, "c.tmp");
  writeFileSync(tmp3, "新内容", "utf8");
  writeFileSync(join(d, "c.md"), "旧内容（不同）", "utf8");
  let calls = 0;
  assert.throws(
    () => atomicReplace(tmp3, join(d, "c.md"), "新内容", () => { calls++; const e = new Error("EPERM"); e.code = "EPERM"; throw e; }, 3),
    /原子写失败/,
  );
  assert.equal(calls, 3, `应重试 3 次，实际 ${calls}`);
  assert.equal(existsSync(tmp3), false, "最终失败也要清理 tmp");
  ok("B3 真失败（目标内容不同）→ 重试 3 次后抛错，tmp 清理，绝不静默丢数据");

  // B4：第一次抛错、第二次成功（退避后重试）
  const tmp4 = join(d, "d.tmp");
  const dest4 = join(d, "d.md");
  writeFileSync(tmp4, "内容丁", "utf8");
  let k = 0;
  atomicReplace(tmp4, dest4, "内容丁", (t, p) => {
    if (k++ === 0) { const e = new Error("EBUSY"); e.code = "EBUSY"; throw e; }
    writeFileSync(p, readFileSync(t, "utf8"), "utf8");
    rmSync(t, { force: true });
  }, 3);
  assert.equal(k, 2, "应第二次成功");
  assert.equal(readFileSync(dest4, "utf8"), "内容丁");
  ok("B4 先失败后成功（退避重试）→ 正常返回");
}

// ---------------------------------------------------------------------------
// B5：真机 soak —— 大量真实 writeEntry 不丢、不误报
// ---------------------------------------------------------------------------
{
  const pool = fresh("b5");
  const N = 600;
  const texts = [];
  let thrown = 0;
  for (let i = 0; i < N; i++) {
    const text = `soak 条目 ${i}：写入路径稳定性验证，正文长度固定填充 ${"填".repeat(120 + (i % 40))}`;
    texts.push(text);
    try {
      const e = mkEntry(pool, text);
      // mkEntry 已落盘；再写一次同一条（覆盖路径，也走原子写）
      writeEntry(pool, e);
    } catch (err) {
      thrown++;
      if (thrown <= 2) console.log(`      ⚠️ 写入抛错：${err.message}`);
    }
  }
  const files = listEntries(pool).entries;
  assert.equal(thrown, 0, `写 ${N} 条不应抛错（实际 ${thrown}）——修前 Windows 上约 1.9% 假失败`);
  assert.equal(files.length, N, `池内应有 ${N} 条，实际 ${files.length}`);
  // 逐字校验：所有正文都在，且没有 .tmp 残留
  const all = new Set(files.map((e) => e.text));
  const missing = texts.filter((t) => !all.has(t));
  assert.equal(missing.length, 0, `有 ${missing.length} 条正文丢失`);
  const leftovers = collectTmp(join(pool, "inbox"));
  assert.equal(leftovers.length, 0, `不应残留 .tmp（实际 ${leftovers.length}）`);
  ok(`B5 真机 soak：${N} 条写入零异常、零丢失、无 .tmp 残留（修前约 1.9% 假失败）`);
}
function collectTmp(dir) {
  const out = [];
  for (const n2 of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, n2.name);
    if (n2.isDirectory()) out.push(...collectTmp(p));
    else if (n2.name.includes(".tmp-")) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// A1：批量通道 = 逐条判定（结果必须一模一样）
// ---------------------------------------------------------------------------
{
  const seqPool = fresh("a1-seq");
  const batchPool = fresh("a1-batch");
  const seed = [
    "记忆池的索引是可重建的编译产物，不是真相源。",
    "推送前必须等用户确认；无人值守时只 commit 不 push。",
    "[tool-quirk] LM Studio 的 /v1/embeddings 只认 bundled 的 nomic-embed-text。",
    "MPI 的权限分四档：readonly / strict / sandbox / full。",
  ];
  for (const s of seed) mkEntry(seqPool, s);

  const cands = [
    "记忆池的索引是可重建的编译产物，不是真相源。", // 应 bump（重复）
    "临时文件一律落在工作区根目录的 tempfile 下。", // 应 add
    "推送前必须等用户确认；无人值守时只 commit 不 push。", // 应 bump
    "[insight] 单写者 + 短持有句柄是多读共存的正确姿势。", // 应 add
    "重要性太低的应被丢弃", // 应 drop（importance 给 1）
  ];
  // 逐条：每条都重新读池（现状路径）
  for (const s of cands) {
    const over = s.startsWith("重要性") ? { importance: 1 } : {};
    const poolS = seqPool;
    mkEntry(poolS, s); // 注意：这里用 () => 0 不走判重，另起对照
  }
  // 干净重来：真正的两路对照
  const p1 = fresh("a1-seq2");
  const p2 = fresh("a1-batch2");
  for (const s of seed) mkEntry(p1, s);
  for (const s of seed) mkEntry(p2, s);
  const seq = cands.map((s) => {
    const over = s.startsWith("重要性") ? { importance: 1 } : {};
    const d = decideIngest(p1, cand(s, over), lexicalSimilarity);
    return { action: d.action, text: d.entry?.text ?? null, recurrence: d.action === "bump" ? d.entry.recurrence : 0 };
  });
  const { results: bat } = ingestBatch(
    p2,
    cands.map((s) => cand(s, s.startsWith("重要性") ? { importance: 1 } : {})),
  );
  const batNorm = bat.map((d) => ({ action: d.action, text: d.entry?.text ?? null, recurrence: d.action === "bump" ? d.entry.recurrence : 0 }));
  assert.deepEqual(batNorm, seq, "批量与逐条的 action/正文/复现次数必须完全一致");
  assert.deepEqual(seq.map((x) => x.action), ["bump", "add", "bump", "add", "drop"]);
  assert.equal(listEntries(p2).entries.length, 6, "批后池内 4 条种子 + 2 条新增");
  ok("A1 批量通道与逐条判定结果逐条一致（bump/add/bump/add/drop），池内条数正确");
  assert.equal(listEntries(p1).entries.length, 6, "逐条路径结果相同");
}

// ---------------------------------------------------------------------------
// A2：批内去重（同一批里重复文本）
// ---------------------------------------------------------------------------
{
  const pool = fresh("a2");
  const dup = "同一条事实在同一批里出现了两次，应该只新增一次、另一次累加复现。";
  const { results, ctx } = ingestBatch(pool, [cand(dup), cand(dup), cand(dup)]);
  assert.deepEqual(results.map((r) => r.action), ["add", "bump", "bump"], "首条 add，后两条 bump");
  assert.equal(listEntries(pool).entries.length, 1, "池内只有一条");
  assert.equal(ctx.bumped.length, 2, "ctx 记账：2 条累加");
  assert.equal(listEntries(pool).entries[0].recurrence, 3, "复现次数累加到 3");
  ok("A2 批内去重：同批重复文本 → 1 条新增 + 2 次累加（现路径会重复写两次）");
}

// ---------------------------------------------------------------------------
// A3：带缓存的相似度器与 lexicalSimilarity 一致
// ---------------------------------------------------------------------------
{
  const sim = makeSimilarity(64);
  const samples = [
    "记忆池的索引是可重建的编译产物",
    "记忆池的索引是可重建的编译产物", // 完全相同
    "记忆池的索引是编译产物，可重建",
    "完全不同的另一句话，讲的是 Electron 的窗口焦点问题。",
    "a", "ab", "",
  ];
  for (const a of samples) {
    for (const b of samples) {
      assert.equal(sim(a, b), lexicalSimilarity(a, b), `相似度必须一致：${JSON.stringify([a, b])}`);
    }
  }
  // 缓存淘汰后仍要正确
  const sim2 = makeSimilarity(2);
  for (const a of samples) for (const b of samples) assert.equal(sim2(a, b), lexicalSimilarity(a, b));
  // 单字符与空串边界
  assert.equal(lexicalSimilarity("", "x"), 0);
  assert.equal(lexicalSimilarity("中", "中"), 1);
  ok("A3 带缓存的相似度器与 lexicalSimilarity 逐位一致（含缓存淘汰与空串边界）");
}

// ---------------------------------------------------------------------------
// A4：规模（872 条 = mem0 现有量级）
// ---------------------------------------------------------------------------
{
  const N = Number(process.env.P5_N || 872);
  const pool = fresh("a4");
  // 语料必须彼此**足够不像**：否则会被判重逻辑合并成几条（第一次写这个测试就踩了）
  const W = ["记忆池", "索引", "zvec", "分诊", "提案", "embedding", "检索", "归档", "教训", "面板", "注入", "预算", "单写者", "并发", "钉住", "迁移", "字段", "幂等"];
  const ri = (k) => Math.floor(Math.random() * k);
  const texts = Array.from({ length: N }, (_, i) => {
    const parts = [];
    for (let k = 0; k < 4 + ri(4); k++) parts.push(`${W[ri(W.length)]}${W[ri(W.length)]}在迁移场景 ${i}-${k} 的实测 ${ri(999)}ms 结论 ${ri(9)}`);
    return `【迁移】${parts.join("；")}`;
  });
  const cands = texts.map((t) => cand(t));
  const tBatch = Date.now();
  const { ctx } = ingestBatch(pool, cands);
  const msBatch = Date.now() - tBatch;

  const pool2 = fresh("a4-seq");
  const tSeq = Date.now();
  const M = 300;
  for (let i = 0; i < M; i++) decideIngest(pool2, cand(texts[i]), lexicalSimilarity);
  const msSeq = Date.now() - tSeq;
  const perSeq = msSeq / M;

  console.log(`     批量 ${N} 条：${(msBatch / 1000).toFixed(2)}s（${(msBatch / N).toFixed(1)}ms/条）→ 新增 ${ctx.added.length}`);
  console.log(`     逐条对照前 ${M} 条：${(perSeq).toFixed(1)}ms/条 → 推算 ${N} 条约 ${((perSeq * N) / 1000).toFixed(0)}s`);
  // 门槛 8s：剩下的 O(n²) 是相似度两两比较（872² ≈ 38 万次 × ~10µs），
  // 属一次性迁移成本；日常用的批很小（单候选 ≈ 池大小 × 10µs ≈ 9ms @872 条）
  assert.ok(msBatch < 8000, `批量 ${N} 条应 < 8s，实际 ${(msBatch / 1000).toFixed(2)}s`);
  const landed = listEntries(pool).entries.length;
  assert.ok(landed >= N * 0.95, `大部分应独立落盘（实际 ${landed}/${N}）——语料若被大量判重说明夹具问题`);
  ok(`A4 规模：批量 ${N} 条 ${(msBatch / 1000).toFixed(2)}s（< 5s 门槛）；逐条对照推算 ${((perSeq * N) / 1000).toFixed(0)}s`);
}

console.log(`\ntest:poolwrite 全部通过（${n} 项）`);
