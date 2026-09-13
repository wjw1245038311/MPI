// R-regression (v0.6.12: sidebar「应用商店」stuck as English "App Store" in a zh UI).
//
// Root cause: Sidebar renders `language === "zh" ? zh : en` labels, and before the
// config loads the fallback is "en". The DOM language bridge (lib/i18n.ts) records
// whatever text it first sees as each node's *original*; when the real (zh) config
// arrives it re-translates from that stored original. Any conditional pair missing
// from the `exact` dictionary cannot be reversed, so the label stays English even
// though React re-rendered Chinese on top of it.
//
// Sidebar is the only component mounted at t=0 (before config loads), so its static
// conditional labels are exactly the ones exposed to this trap. This test asserts
// every `language === "zh" ? "A" : "B"` pair in Sidebar.tsx has an A→B entry in the
// i18n dictionary (dynamic template-literal pairs are skipped — they carry user data).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function parseExactDict(src) {
  const start = src.indexOf("const exact: Record<string, string> = {");
  assert.ok(start >= 0, "i18n.ts: `exact` dictionary not found — parser drift?");
  const end = src.indexOf("\n};", start);
  assert.ok(end > start, "i18n.ts: could not find the end of the `exact` block");
  const dict = {};
  for (const m of src.slice(start, end).matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,?\s*$/gm)) {
    dict[m[1]] = m[2];
  }
  return dict;
}

const i18nSrc = readFileSync(path.join(root, "src/renderer/src/lib/i18n.ts"), "utf8");
const dict = parseExactDict(i18nSrc);
assert.ok(
  Object.keys(dict).length > 100,
  `i18n.ts: dictionary parse yielded only ${Object.keys(dict).length} entries — parser drift?`
);

const sidebarSrc = readFileSync(path.join(root, "src/renderer/src/components/Sidebar.tsx"), "utf8");
const pairs = [...sidebarSrc.matchAll(/language === "(zh|en)" \? "((?:[^"\\]|\\.)*)" : "((?:[^"\\]|\\.)*)"/g)];
assert.ok(pairs.length > 0, "Sidebar.tsx: no conditional labels found — pattern drift?");

let failures = 0;
for (const [, dir, a, b] of pairs) {
  const zh = dir === "zh" ? a : b;
  const en = dir === "zh" ? b : a;
  if (dict[zh] !== en) {
    failures++;
    console.error(`MISSING i18n entry: "${zh}" -> "${en}"`);
  }
}
assert.equal(
  failures,
  0,
  `${failures}/${pairs.length} Sidebar conditional labels lack an i18n.ts exact entry (stale-English-original bug)`
);

console.log(`i18n-labels ok (${pairs.length} Sidebar pairs covered by ${Object.keys(dict).length}-entry dictionary)`);
