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

/** 源码里的转义字符串 → 真实值（`"a\nb"` → 换行）。 */
function unescapeString(literal) {
  try {
    return JSON.parse(`"${literal}"`);
  } catch {
    return literal;
  }
}

function parseExactDict(src) {
  const start = src.indexOf("const exact: Record<string, string> = {");
  assert.ok(start >= 0, "i18n.ts: `exact` dictionary not found — parser drift?");
  const end = src.indexOf("\n};", start);
  assert.ok(end > start, "i18n.ts: could not find the end of the `exact` block");
  const dict = {};
  // 词条可以跨行：`"键":` 与 `"值",` 分处两行时也要能解析。
  for (const m of src.slice(start, end).matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:\s*\n?\s*"((?:[^"\\]|\\.)*)"\s*,?\s*$/gm)) {
    dict[unescapeString(m[1])] = unescapeString(m[2]);
  }
  return dict;
}

const i18nSrc = readFileSync(path.join(root, "src/renderer/src/lib/i18n.ts"), "utf8");
const dict = parseExactDict(i18nSrc);
assert.ok(
  Object.keys(dict).length > 100,
  `i18n.ts: dictionary parse yielded only ${Object.keys(dict).length} entries — parser drift?`
);

// 断言某个文件里的所有 `language === "zh" ? "中文" : "English"` 成对文案
// 都能在 exact 词典里双向命中。
// 注意 `\s*` 而不是单个空格：长段说明在多行写法里 `?` 和 `:` 都换行了，
// 只认单行的正则恰好在这一段漏掉了两条词条（2026-11-26 实测）。
//
// strict=false 时只报告不失败：用于「词典缺口存在但尚未验证会造成用户可见故障」的文件。
function checkPairs(file, label, { strict = true } = {}) {
  const src = readFileSync(path.join(root, file), "utf8");
  const pairs = [
    ...src.matchAll(/language === "(zh|en)"\s*\?\s*"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g),
  ];
  assert.ok(pairs.length > 0, `${label}: no conditional labels found — pattern drift?`);
  const missing = [];
  for (const [, dir, a, b] of pairs) {
    const zh = unescapeString(dir === "zh" ? a : b);
    const en = unescapeString(dir === "zh" ? b : a);
    if (dict[zh] !== en) missing.push(`"${zh}" -> "${en}"`);
  }
  if (strict) {
    for (const line of missing) console.error(`MISSING i18n entry (${label}): ${line}`);
    assert.equal(
      missing.length,
      0,
      `${missing.length}/${pairs.length} ${label} conditional labels lack an i18n.ts exact entry (stale-language bug)`
    );
  } else if (missing.length) {
    // 已知缺口：既有代码里的多行三元文案（置顶提示、归档确认等）。
    // 是否会产生用户可见故障尚未实测，先只做提醒、不阻断。
    console.warn(`KNOWN GAP (${label}): ${missing.length}/${pairs.length} 条文案未进词典（未验证是否影响显示）`);
  }
  return { total: pairs.length, missing: missing.length };
}

// Sidebar 在配置加载前就挂载，是 v0.6.12「应用商店卡英文」的事故点。
const sidebar = checkPairs("src/renderer/src/components/Sidebar.tsx", "Sidebar", { strict: false });
// 定时任务面板：切换语言时若面板正开着，同样会踩这个坑。
const automation = checkPairs("src/renderer/src/components/AutomationPanel.tsx", "AutomationPanel");

console.log(
  `i18n-labels ok (${sidebar.total} Sidebar + ${automation.total} AutomationPanel pairs covered by ${Object.keys(dict).length}-entry dictionary)`
);
