import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const { earlierEntriesFromEntries, earlierDisplayMessages } = await import("../src/main/context-estimate.ts");
const { readEarlierMessages } = await import("../src/main/session-store.ts");

// ---------------------------------------------------------------------------
// Fixture helpers：带 parent 链的会话条目（镜像 pi JSONL 结构）
// ---------------------------------------------------------------------------

let seq = 0;
function id() {
  return `e${++seq}`;
}
function msg(role, content, extra = {}) {
  return { type: "message", id: id(), parentId: null, message: { role, content, ...extra } };
}
function link(entry, parent) {
  entry.parentId = parent.id;
  return entry;
}

/** m1..mN 顺序链，返回 [entries, first, last]。 */
function chain(n) {
  const entries = [];
  let prev = null;
  for (let i = 0; i < n; i++) {
    const e = msg(i % 2 === 0 ? "user" : "assistant", `text-${i}`);
    if (prev) link(e, prev);
    entries.push(e);
    prev = e;
  }
  return [entries, entries[0], entries[n - 1]];
}

// ---------------------------------------------------------------------------
// 1. 无 compaction → 空（活跃上下文 = 全部分支，没有「更早」）
// ---------------------------------------------------------------------------
{
  const [entries] = chain(6);
  assert.deepEqual(earlierEntriesFromEntries(entries, null), []);
}

// ---------------------------------------------------------------------------
// 2. 单次压缩：firstKeptEntryId 之前的全部条目 = 「更早」（时间序）
// ---------------------------------------------------------------------------
{
  const [entries, first] = chain(10); // e1..e10
  const kept = entries[7]; // e8 起保留
  const compaction = { type: "compaction", id: id(), parentId: null, summary: "S", firstKeptEntryId: kept.id };
  link(compaction, entries[9]);
  const after = link(msg("user", "post"), compaction);
  assert.deepEqual(
    earlierEntriesFromEntries([...entries, compaction, after], after.id).map((e) => e.id),
    [first.id, ...entries.slice(1, 7).map((e) => e.id)], // e1..e7
  );
}

// ---------------------------------------------------------------------------
// 3. firstKeptEntryId 不在路径上 → 压缩前全部算「更早」
// ---------------------------------------------------------------------------
{
  const [entries] = chain(5);
  const compaction = { type: "compaction", id: id(), parentId: null, summary: "S", firstKeptEntryId: "missing" };
  link(compaction, entries[4]);
  const after = link(msg("user", "post"), compaction);
  assert.equal(earlierEntriesFromEntries([...entries, compaction, after], after.id).length, 5);
}

// ---------------------------------------------------------------------------
// 4. 多次压缩：只认最新一次；旧摘要与更早消息都在「更早」里（时间序）
// ---------------------------------------------------------------------------
{
  const [a] = chain(6); // e1..e6
  const comp1 = { type: "compaction", id: id(), parentId: null, summary: "S1", firstKeptEntryId: a[4].id };
  link(comp1, a[5]);
  const m7 = link(msg("user", "m7"), comp1);
  const m8 = link(msg("assistant", "m8"), m7);
  const comp2 = { type: "compaction", id: id(), parentId: null, summary: "S2", firstKeptEntryId: m7.id };
  link(comp2, m8);
  const m9 = link(msg("user", "m9"), comp2);

  const earlier = earlierEntriesFromEntries([a[0], a[1], a[2], a[3], a[4], a[5], comp1, m7, m8, comp2, m9], m9.id);
  // e1..e6 + comp1（m7/m8 属于最新压缩的保留区，不算更早）
  assert.deepEqual(earlier.map((e) => e.id), [a[0].id, a[1].id, a[2].id, a[3].id, a[4].id, a[5].id, comp1.id]);
}

// ---------------------------------------------------------------------------
// 5. leafId 决定分支：leaf 之前的旁支条目不参与
// ---------------------------------------------------------------------------
{
  const [entries] = chain(4); // e1..e4（主链）
  const fork = link(msg("user", "fork"), entries[2]); // e3 的旁支
  assert.deepEqual(earlierEntriesFromEntries([...entries, fork], entries[3].id), []);
}

// ---------------------------------------------------------------------------
// 6. earlierDisplayMessages：条目 → 可展示消息（镜像 pi sessionEntryToContextMessages）
// ---------------------------------------------------------------------------
{
  const [entries] = chain(4); // e1..e4
  const compaction = { type: "compaction", id: id(), parentId: null, summary: "SUM", firstKeptEntryId: entries[2].id, tokensBefore: 1234, timestamp: "2026-09-08T03:01:37.500Z" };
  link(compaction, entries[3]);
  const after = link(msg("user", "post"), compaction);

  const msgs = earlierDisplayMessages([...entries, compaction, after], after.id);
  assert.equal(msgs.length, 2); // e1、e2（保留区从 e3 起）
  assert.deepEqual(msgs[0], entries[0].message); // message 条目原样透传

  // compaction → compactionSummary 伪消息（timestamp ISO→ms，与 pi createCompactionSummaryMessage 一致）。
  // 注意：最新压缩本身不在「更早」里——用双压缩数据验证旧摘要的转换。
  const [c4] = chain(2); // f1、f2
  const compA = { type: "compaction", id: id(), parentId: null, summary: "SA", firstKeptEntryId: c4[0].id, tokensBefore: 999, timestamp: "2026-09-08T03:01:37.500Z" };
  link(compA, c4[1]);
  const m3 = link(msg("user", "m3"), compA);
  const compB = { type: "compaction", id: id(), parentId: null, summary: "SB", firstKeptEntryId: m3.id };
  link(compB, m3);
  const out = earlierDisplayMessages([c4[0], c4[1], compA, m3, compB], compB.id);
  // 「更早」= f1、f2（compA 的保留区起点）+ compA 本身；最后一条是旧摘要伪消息
  assert.deepEqual(out[out.length - 1], {
    role: "compactionSummary",
    summary: "SA",
    tokensBefore: 999,
    timestamp: new Date("2026-09-08T03:01:37.500Z").getTime(),
  });

  // custom_message / branch_summary → 对应伪消息；session/model_change 跳过
  const mixed = [
    { type: "session", id: "s1", parentId: null, cwd: "/x" },
    { type: "custom_message", id: "c1", parentId: "s1", customType: "status", content: [{ type: "text", text: "hi" }], display: true, timestamp: 111 },
    { type: "branch_summary", id: "b1", parentId: "c1", summary: "BS", fromId: "s1", timestamp: 222 },
    { type: "model_change", id: "mc1", parentId: "b1", provider: "p", modelId: "m" },
    { type: "compaction", id: "cp1", parentId: "mc1", summary: "S", firstKeptEntryId: "nope" },
  ];
  const mixedOut = earlierDisplayMessages(mixed, null);
  assert.deepEqual(mixedOut.map((m) => m.role), ["custom", "branchSummary"]);
  assert.equal(mixedOut[0].customType, "status");
  assert.equal(mixedOut[1].summary, "BS");
}

// ---------------------------------------------------------------------------
// 7. readEarlierMessages：真实 JSONL 文件端到端（临时目录，hermetic）
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "mpi-earlier-"));
  try {
    const [entries] = chain(5); // e1..e5
    const compaction = { type: "compaction", id: id(), parentId: null, summary: "SUMMARY", firstKeptEntryId: entries[3].id };
    link(compaction, entries[4]);
    const after = link(msg("user", "post"), compaction);
    const lines = [
      { type: "session", version: 3, cwd: "/tmp/proj" },
      ...entries,
      compaction,
      after,
    ].map((e) => JSON.stringify(e));
    const file = join(dir, "test-session.jsonl");
    writeFileSync(file, lines.join("\n") + "\n", "utf8");

    const res = await readEarlierMessages(file);
    assert.equal(res.messages.length, 3); // e1..e3（保留区从 e4 起）
    assert.deepEqual(res.messages[0], entries[0].message);

    // 不存在的文件 → 空（forEachLine 对缺失文件的行为：抛错由调用方兜底，这里只测正常路径外的空文件）
    const emptyFile = join(dir, "empty.jsonl");
    writeFileSync(emptyFile, "", "utf8");
    assert.deepEqual((await readEarlierMessages(emptyFile)).messages, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("earlier-history tests passed");
