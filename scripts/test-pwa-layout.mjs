import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * 会话视图的布局契约（静态检查，纯文本解析 CSS/JSX 源码）。
 *
 * 起因是一次真机事故：`.app` 与 `.thread-view` 之间的 `<main class="app-main">`
 * 没有 CSS 规则 → 它是 height:auto 的 flex item（min-height:auto，不会收缩），
 * flex 链在此断掉：消息区高度=内容高度（没有内部滚动），而 `.app.thread-open`
 * 的 overflow:hidden 把输入框整条裁掉——真机表现就是「输入框没了、对话拉不动」。
 *
 * 这类事故的共同点是「某条承重规则被静默删掉/改名」，靠人眼审 CSS 抓不住，
 * 所以用契约把它钉死：以下每一条都是会话视图能滚能显示的**必要条件**。
 */

const css = readFileSync(new URL("../mobile/pwa/src/styles.css", import.meta.url), "utf8");
const appTsx = readFileSync(new URL("../mobile/pwa/src/App.tsx", import.meta.url), "utf8");
const threadTsx = readFileSync(new URL("../mobile/pwa/src/ThreadView.tsx", import.meta.url), "utf8");

/** 去掉注释与 @media 块（暗色主题只覆盖颜色变量，与布局无关）。 */
function strip(cssText) {
  return cssText
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
}

/** 取某选择器最终生效的声明（同属性后者覆盖前者）。 */
function declarations(selector) {
  const result = new Map();
  for (const match of strip(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(",").map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const decl of match[2].split(";")) {
      const idx = decl.indexOf(":");
      if (idx < 0) continue;
      result.set(decl.slice(0, idx).trim(), decl.slice(idx + 1).trim());
    }
  }
  return result;
}

function has(selector, prop, pattern) {
  const value = declarations(selector).get(prop);
  assert.ok(value, `${selector} 必须声明 ${prop}（承重规则，见文件头注释；缺失会导致输入框被裁、消息区不可滚动）`);
  assert.match(value, pattern, `${selector} 的 ${prop}=${value} 不满足 ${pattern}`);
  return value;
}

// --- 链路上的每一环都必须能把高度传下去 -------------------------------
// .app：会话视图固定高度且不整体滚动；主页用 min-height + 整页滚动。
assert.match(declarations(".app").get("min-height") ?? "", /100dvh/, ".app 需要 min-height:100dvh");
const threadOpen = "overflow";
assert.equal(declarations(".app.thread-open").get(threadOpen), "hidden");
assert.match(declarations(".app.thread-open").get("height") ?? "", /100dvh/, "会话视图需要确定高度");

// 关键事故点：包装层必须伸缩且允许收缩到 0（min-height:auto 会让它撑成内容高度）。
has(".app-main", "flex", /(^|\s)1(\s|$)/);
has(".app-main", "min-height", /^0/);
has(".app-main", "display", /flex/);
has(".app-main", "flex-direction", /column/);

has(".thread-view", "flex", /(^|\s)1(\s|$)/);
has(".thread-view", "min-height", /^0/);

// 消息区定位容器：同样要能伸缩 + min-height:0（它在链上，少一环就断）。
has(".thread-scroll-wrap", "flex", /(^|\s)1(\s|$)/);
has(".thread-scroll-wrap", "min-height", /^0/);
has(".thread-scroll-wrap", "position", /^relative/);

// 消息区：唯一可滚动区域，必须能伸缩且 min-height:0（否则内容把它撑开，滚不动）。
has(".thread-scroll", "flex", /(^|\s)1(\s|$)/);
has(".thread-scroll", "min-height", /^0/);
has(".thread-scroll", "overflow-y", /auto/);

// 「回到底部」必须悬浮（absolute），不能是占位的 flex item——真机反馈：
// sticky 的按钮会占掉消息区底部一行，且贴在半空很难看。
has(".to-bottom", "position", /^absolute/);

// 工具条与输入框不许被压缩（曾经 chip 下半截被裁）。
has(".thread-toolbar", "flex", /^none/);
has(".composer", "flex", /^none/);

// --- DOM 链不能断：App 必须把 ThreadView 放在 .app-main 里 ---------------
const mainIdx = appTsx.indexOf('className="app-main"');
assert.ok(mainIdx > 0, "App.tsx 缺少 .app-main 包装层");
const threadIdx = appTsx.indexOf("<ThreadView", mainIdx); // useState<ThreadViewState> 里也有该子串，故只从 mainIdx 之后找
assert.ok(threadIdx > mainIdx, "ThreadView 必须在 .app-main 内部");
assert.ok(/app\$\{[^}]*\} \? " thread-open"/.test(appTsx) || appTsx.includes("thread-open"), "缺少 thread-open 类名切换");
assert.ok(threadTsx.includes('className="thread-scroll"'), "ThreadView 缺少 .thread-scroll 容器");
assert.ok(threadTsx.includes('className="thread-scroll-wrap"'), "ThreadView 缺少 .thread-scroll-wrap（回到底部按钮的定位容器）");
assert.ok(threadTsx.includes('className={`composer'), "ThreadView 缺少 composer");

console.log("ok 1 - pwa 布局契约：高度链（app→app-main→thread-view→thread-scroll）+ 不可压缩区");
console.log("pwa layout tests passed");
