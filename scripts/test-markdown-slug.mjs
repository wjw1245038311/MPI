import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSlug from "rehype-slug";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Run the same heading pipeline as the renderer (react-markdown + rehype-slug)
// and collect the ids assigned to h1–h6, in document order. remark-rehype is
// required between the two phases: without it run() never compiles mdast to
// hast and the rehype plugins would see the wrong tree type.
async function headingIds(src) {
  const md = unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeSlug);
  const tree = await md.run(md.parse(src));
  const ids = [];
  (function walk(node) {
    if (node.type === "element" && /^h[1-6]$/.test(node.tagName)) {
      ids.push(typeof node.properties?.id === "string" ? node.properties.id : null);
    }
    for (const child of node.children || []) walk(child);
  })(tree);
  return ids;
}

// The user manuals' tables of contents are literal (#anchor) links. They only
// work in-app if rehype-slug generates exactly those ids, so verify every
// anchor in each manual resolves to a heading it actually contains.
for (const file of ["resources/user-manual.md", "resources/user-manual-en.md"]) {
  const src = readFileSync(path.join(root, file), "utf8");
  const ids = await headingIds(src);
  const anchors = [...new Set([...src.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]))];
  assert.ok(anchors.length > 0, `${file}: expected TOC anchor links`);
  for (const anchor of anchors) {
    assert.ok(ids.includes(anchor), `${file}: anchor #${anchor} has no matching heading id`);
  }
  console.log(`${path.basename(file)}: ${ids.length} headings, all ${anchors.length} distinct anchors resolve`);
}

// Spot-check the tricky slug shapes (colon drops in place, slash leaves a
// double hyphen) so a future dependency bump can't silently break them.
{
  const ids = await headingIds("## 12. Extensions: Skills / Packages / MCP\n## 14. 全局搜索（Ctrl+K）");
  assert.deepEqual(ids, ["12-extensions-skills--packages--mcp", "14-全局搜索ctrlk"]);
}

console.log("markdown slug tests passed");
