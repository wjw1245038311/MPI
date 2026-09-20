/**
 * 迁移复验（P5-2 验收）——**独立于迁移工具**，只从产物核事实
 *
 * 为什么单独一个脚本：迁移脚本自己说自己成功没有意义。这里只干一件事——
 * 拿 manifest（迁移写了什么）与 mem0 导出（源头是什么）对照池子里的**实际文件**，
 * 逐条核对：正文是否逐字一致、创建时间是否保留、幂等键与标签是否齐全、文件是否真在。
 *
 *   npm run mem0:verify                      # 核最近一份 manifest
 *   npm run mem0:verify -- --manifest <path>  # 核指定 manifest
 *   npm run mem0:verify -- --all              # 核池内所有 mem0-* 条目（不依赖 manifest）
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { listEntries } = await import("../src/main/zhiya/pool.ts");
const { readManifest } = await import("../src/main/zhiya/mem0-migrate.ts");
const { defaultPoolDir } = await import("../src/main/zhiya/memory-index.ts");

const args = process.argv.slice(2);
const val = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const poolDir = val("pool", defaultPoolDir());
const exportFile = val("export", "E:/MyWorkspace/tempfile/mem0-export.jsonl");

// manifest：显式给，或取 .migration 里最新的那份
let manifestPath = val("manifest", null);
if (!manifestPath && !args.includes("--all")) {
  const dir = join(poolDir, ".migration");
  if (existsSync(dir)) {
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
    manifestPath = files.length ? join(dir, files[files.length - 1]) : null;
  }
}

if (!existsSync(exportFile)) {
  console.log(`找不到导出文件：${exportFile}\n先跑：npm run mem0:export`);
  process.exit(1);
}
const src = readFileSync(exportFile, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
const byKey = new Map(src.map((r) => [`mem0:${r._point_id}`, r]));

const entries = listEntries(poolDir).entries;
const byId = new Map(entries.map((e) => [e.id, e]));
// 键 → 条目（一个条目可能承载多个 mem0 键：近似重复折叠成"超集"的情况）
const entryByKey = new Map();
for (const e of entries) {
  const keys = (e.evidence || []).filter((x) => x.startsWith("mem0:"));
  for (const k of keys) entryByKey.set(k, { entry: e, multi: keys.length > 1 });
}

/** 一条待核项：{ key, entry } */
let targets = [];
if (args.includes("--all")) {
  targets = [...entryByKey.entries()].map(([key, v]) => ({ key, entry: v.entry, multi: v.multi }));
  console.log(`\n=== 复验：池内全部 mem0 迁移条目（不依赖 manifest）===`);
} else {
  if (!manifestPath) {
    console.log("没有可用 manifest；用 --manifest <path> 指定，或 --all 核全池");
    process.exit(1);
  }
  const lines = readManifest(manifestPath);
  targets = lines.map((l) => {
    const byKeyHit = entryByKey.get(l.key);
    return { key: l.key, entry: byKeyHit?.entry ?? byId.get(l.entryId), multi: byKeyHit?.multi ?? false, manifest: l };
  });
  console.log(`\n=== 复验：${manifestPath}（${lines.length} 行）===`);
}
console.log(`池：${poolDir}（共 ${entries.length} 条）`);

const fail = { missing: [], text: [], time: [], key: [], tag: [], noSource: [] };
let pass = 0;
for (const t of targets) {
  const e = t.entry;
  if (!e) {
    fail.missing.push(t.key);
    continue;
  }
  const r = byKey.get(t.key);
  if (!r) {
    fail.noSource.push(t.key);
    continue;
  }
  // 超集条目（承载多条记录）只要求"包含"该条正文；单键条目必须逐字一致
  const srcText = String(r.data).trim();
  const okText = e.text === srcText || (t.multi && e.text.includes(srcText));
  // 比较**时刻**而不是日期字符串：mem0 存 UTC（+00:00），池子按本地渲染（+08:00），
  // 同一时刻在跨 16:00 UTC 时日期会差一天——那是正确的本地化，不是错误。
  const srcMs = Date.parse(String(r.created_at));
  const poolMs = Date.parse(e.createdAt);
  // 超集条目承载多条记录，它的时间取**其中最早的一条**（"这个事实最早何时被记下"），
  // 所以多键条目要拿"所属各记录的最早时间"来比，而不是逐条比。
  let okTime;
  if (!Number.isFinite(srcMs) || !Number.isFinite(poolMs)) {
    okTime = e.createdAt.slice(0, 10) === String(r.created_at).slice(0, 10);
  } else if (t.multi) {
    const times = (e.evidence || [])
      .filter((x) => x.startsWith("mem0:"))
      .map((k) => Date.parse(String(byKey.get(k)?.created_at)))
      .filter((x) => Number.isFinite(x));
    const earliest = times.length ? Math.min(...times) : srcMs;
    okTime = Math.abs(earliest - poolMs) < 1000;
  } else {
    okTime = Math.abs(srcMs - poolMs) < 1000;
  }
  const okKey = (e.evidence || []).includes(t.key);
  const okTag = (e.tags || []).includes("from-mem0");
  if (okText && okTime && okKey && okTag) {
    pass++;
    continue;
  }
  if (!okText) fail.text.push(`${e.id} 池=${JSON.stringify(e.text.slice(0, 60))} 源=${JSON.stringify(String(r.data).slice(0, 60))}`);
  if (!okTime) fail.time.push(`${e.id} 池=${e.createdAt} 源=${String(r.created_at)}（相差 ${(poolMs - srcMs) / 1000}s）`);
  if (!okKey) fail.key.push(`${e.id} ${t.key}`);
  if (!okTag) fail.tag.push(e.id);
}

console.log(`\n通过 ${pass} / ${targets.length}`);
for (const [k, list] of Object.entries(fail)) {
  if (!list.length) continue;
  const label = {
    missing: "❌ 池内找不到条目",
    text: "❌ 正文不一致",
    time: "❌ 创建时间不一致",
    key: "❌ 幂等键缺失",
    tag: "❌ 缺 from-mem0 标签",
    noSource: "❌ 导出里找不到源记录",
  }[k];
  console.log(`${label}：${list.length}`);
  for (const x of list.slice(0, 10)) console.log(`   · ${x}`);
}
// ---- 覆盖率检查：范围内每一条记录都必须有交代（落成文件 / 被压成复现 / 折叠进超集）----
let coverageBad = 0;
if (args.includes("--all")) {
  const { planMigration, inScope } = await import("../src/main/zhiya/mem0-migrate.ts");
  const { lexicalSimilarity } = await import("../src/main/zhiya/pool.ts");
  // 用"空池"重算计划 = 迁移前的世界；折叠关系从这里取
  const plan = planMigration(src, { poolDir: null, similarity: lexicalSimilarity });
  const scopeCount = src.filter((r) => inScope(r, {})).length;
  const textByKey = new Map(entries.map((e) => [(e.evidence || []).find((x) => x.startsWith("mem0:")), e.text]));
  // 一个条目可能带多个 mem0 键（折叠进超集的情况）
  for (const e of entries) for (const ev of e.evidence || []) if (ev.startsWith("mem0:")) textByKey.set(ev, e.text);

  let accounted = 0;
  const missing = [];
  for (const r of src) {
    // 范围外的记录按决策**留在 mem0**，不参与覆盖检查
    if (!inScope(r, {})) continue;
    const key = `mem0:${r._point_id}`;
    const text = String(r.data ?? "").trim();
    if (!text) continue;
    const host = textByKey.get(key);
    if (host !== undefined) {
      // 落成文件的：正文必须逐字一致；折叠进超集的：正文必须被包含
      if (host === text || host.includes(text)) accounted++;
      else missing.push(`${key} 正文既不一致也不被包含`);
      continue;
    }
    // 没落成文件的：必须是被压成复现/折叠的记录
    const sk = plan.skipped.find((x) => x.key === key);
    if (sk && ["duplicate-in-mem0", "duplicate-near"].includes(sk.reason)) accounted++;
    else if (sk) accounted++; // already-imported / exists-in-* 也算有交代
    else missing.push(`${key} 无任何交代`);
  }
  coverageBad = missing.length;
  console.log(`
覆盖检查：范围内记录 ${scopeCount} 条 → 有交代 ${accounted} 条${coverageBad ? `，❌ 无交代 ${coverageBad} 条` : " ✅"}`);
  for (const m of missing.slice(0, 10)) console.log(`   · ${m}`);
}

const bad = Object.values(fail).reduce((a, b) => a + b.length, 0) + coverageBad;
console.log(bad ? `\n❌ 复验失败（${bad} 项）` : `\n✅ 复验通过：${pass} 条逐字一致、时间保留、幂等键与标签齐全`);
process.exit(bad ? 1 : 0);
