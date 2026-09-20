/**
 * 一次性回填：把"原文裸文件"式的 lesson 补成标准骨架
 *
 * 背景：`applyProposal` 修好之前（见 commit 3aba515），promote 会**直接写记忆原文**，
 * 于是仓库里有 9 篇 lesson 没有 frontmatter、没有分节。本脚本用同一套 `wrapRawLesson`
 * 把它们补齐——**原文一字不丢**，只是多出结构；标题取原文首句，lesson 名沿用原文件名
 * （避免文件名与 lesson 名不一致）。
 *
 *   npm run backfill:lessons            # 干跑：列出将改的文件
 *   npm run backfill:lessons -- --apply  # 真改（改前把原文件备份到 <目录>/.backup-bare/）
 *
 * 幂等：已经是合格 lesson（有 frontmatter 且 ≥2 个 ##）的文件一律跳过。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { looksLikeLessonDoc, wrapRawLesson } = await import("../src/main/memory-promote.ts");
const { listEntries } = await import("../src/main/zhiya/pool.ts");
const { defaultPoolDir } = await import("../src/main/zhiya/memory-index.ts");
const { clipTitle } = await import("../src/main/memory-dream.ts");

const apply = process.argv.includes("--apply");
const dir = process.argv.includes("--dir")
  ? process.argv[process.argv.indexOf("--dir") + 1]
  : join(process.cwd(), ".alexandria", "knowledge", "lessons");
const pool = defaultPoolDir();

/** 文件名 → lesson 名（PascalCase → kebab）：MemoryApprove.md → memory-approve */
const slugOf = (file) =>
  basename(file, ".md")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .toLowerCase();

// 池内条目 → 该 lesson 的标签（靠 promotedTo 反查），让回填也带上标签
const byFile = new Map();
for (const e of listEntries(pool).entries) {
  if (e.promotedTo) byFile.set(e.promotedTo, e);
}

const files = readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => join(dir, f));
const todo = [];
for (const f of files) {
  const text = readFileSync(f, "utf8");
  if (looksLikeLessonDoc(text)) continue;
  const entry = byFile.get(f);
  const title = clipTitle(String(text.split(/\r?\n/).find((l) => l.trim()) || basename(f, ".md")).trim(), 60);
  todo.push({ f, text, title, tags: entry?.tags ?? [], id: entry?.id ?? "00000000", slug: slugOf(f) });
}

console.log(`\n=== lesson 裸文件回填${apply ? "【真改】" : "（干跑）"} ===`);
console.log(`目录：${dir}`);
console.log(`发现裸文件 ${todo.length} / 共 ${files.length} 篇\n`);
for (const t of todo) {
  console.log(`· ${basename(t.f)}`);
  console.log(`    lesson: ${t.slug}   标题：${t.title.slice(0, 40)}   标签：${t.tags.join(",") || "（无）"}`);
}

if (!apply) {
  console.log(`\n（干跑结束。真改：npm run backfill:lessons -- --apply）`);
  process.exit(0);
}
if (!todo.length) {
  console.log("没有需要回填的文件。");
  process.exit(0);
}

const backup = join(dir, ".backup-bare");
if (!existsSync(backup)) mkdirSync(backup, { recursive: true });
for (const t of todo) {
  copyFileSync(t.f, join(backup, basename(t.f))); // 先备份原文
  writeFileSync(t.f, wrapRawLesson({ title: t.title, body: t.text, tags: t.tags, id: t.id, slug: t.slug }), "utf8");
  console.log(`✓ 已回填 ${basename(t.f)}（原文备份在 ${basename(backup)}/）`);
}
console.log(`\n共回填 ${todo.length} 篇。原文一字未丢（都在「原文（待整理）」一节里）。`);
