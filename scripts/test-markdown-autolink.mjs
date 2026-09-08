import assert from "node:assert/strict";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { remarkTrimAutolinkTrailingUnicode } from "../src/renderer/src/lib/remark-autolink-trim.ts";

/** Parse markdown through the same pipeline as the renderer (react-markdown
 * uses unified + remark-parse internally) and return [link, ...siblingText].
 * run() is required: parse() alone would skip the plugin's transformer. */
async function render(src, withPlugin = true) {
  const md = unified().use(remarkParse).use(remarkGfm);
  if (withPlugin) md.use(remarkTrimAutolinkTrailingUnicode);
  const tree = await md.run(md.parse(src));

  // Flatten the top-level paragraph into [linkUrl, textAfter] pairs.
  const out = [];
  for (const node of tree.children[0]?.children || []) {
    if (node.type === "link") out.push({ link: node.url });
    else if (node.type === "text") out.push({ text: node.value });
  }
  return out;
}

// --- the bug: CJK immediately after a URL must not join the autolink -------
{
  const parts = await render("读https://example.com，然后来解决一下");
  assert.deepEqual(parts, [
    { text: "读" },
    { link: "https://example.com" },
    { text: "，然后来解决一下" },
  ]);
}

// p-a-d #50's original repro (URL preceded by a space)
{
  const parts = await render("看 https://github.com/abcwyc/pi-agent-desktop/issues/48，然后来解决一下");
  assert.deepEqual(parts, [
    { text: "看 " },
    { link: "https://github.com/abcwyc/pi-agent-desktop/issues/48" },
    { text: "，然后来解决一下" },
  ]);
}

// CJK mid-URL splits at the first non-ASCII character (percent-encoded URLs
// are pure ASCII and stay intact — see below).
{
  const parts = await render("https://foo.com/中文/path");
  assert.deepEqual(parts, [{ link: "https://foo.com/" }, { text: "中文/path" }]);
}

// --- regressions: things the plugin must NOT touch --------------------------
// Explicit [text](url) links keep their URL as written.
{
  const parts = await render("[文本](https://foo.com/中文路径)");
  assert.deepEqual(parts, [{ link: "https://foo.com/中文路径" }]);
}

// Pure-ASCII autolinks (incl. percent-encoded UTF-8) are unchanged.
{
  const parts = await render("访问 https://example.com/%E4%B8%AD%E6%96%87?x=1 结束");
  assert.deepEqual(parts, [
    { text: "访问 " },
    { link: "https://example.com/%E4%B8%AD%E6%96%87?x=1" },
    { text: " 结束" },
  ]);
}

// Sanity check that the bug exists WITHOUT the plugin (guards against a future
// remark-gfm version fixing it upstream, which would make the plugin moot).
{
  const parts = await render("读https://example.com，然后", false);
  assert.equal(parts[1]?.link, "https://example.com，然后");
}

console.log("markdown autolink tests passed");
