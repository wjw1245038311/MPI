import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 源级护栏：聊天区「贴底跟随」的四条不变量。
// 背景（用户 2026-02 实测）：多轮「思考 → 工具 → 思考」的会话里，每进入下一段
// 视图会先退回上一个节点、再被拉回最新——拉扯长度随轮次增长。成因是高度变化
// 发生在 React 提交之后（content-visibility 估算高度解析、streaming→final 替换、
// Markdown 增量布局），当时只有提交时的一次性 scrollTop 写入，没人补中间态；
// 浏览器把 scrollTop 钳到收缩后的新底部，下一段 delta 才拉回底部。
//
// 这里钉住三处修法，防止以后重构时被悄悄抹掉：
//   ① 贴底收敛：ResizeObserver 在布局后、绘制前补齐，且带跟随/恢复/手势三重让位；
//   ② 贴底态关掉浏览器滚动锚定（overflow-anchor），否则锚定补偿与程序化贴底互相打架；
//   ③ 回合结束（streaming → null）的贴底不做平滑动画——动画会与随后每段的即时
//      写入抢同一个位置，方向相反时就是用户看到的「先退后进」。

const chat = readFileSync(new URL("../src/renderer/src/components/Chat.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/renderer/src/styles.css", import.meta.url), "utf8");

// --- ① 贴底收敛 ------------------------------------------------------------

const roStart = chat.indexOf("const pin = () => {");
assert.ok(roStart > 0, "Chat.tsx 必须用 ResizeObserver 做贴底收敛（找不到贴底收敛函数 pin）");
const roBody = chat.slice(roStart, roStart + 1200);
assert.ok(roBody.includes("new ResizeObserver("), "贴底收敛必须由 ResizeObserver 驱动（布局后、绘制前纠正）");
assert.ok(roBody.includes("stickRef.current"), "ResizeObserver 贴底必须受 stick 意图约束（阅读历史时不许拽回）");
assert.ok(roBody.includes("isRestoring()"), "ResizeObserver 贴底必须让位给切会话恢复期");
assert.ok(roBody.includes("hasScrollGesture()"), "ResizeObserver 贴底必须让位给用户滚动手势");
assert.ok(roBody.includes("lastScrollTopRef.current"), "程序化写入必须同步 lastScrollTopRef，否则会被误判成用户上滚");
assert.ok(roBody.includes("ro.observe(host)"), "ResizeObserver 必须观察 transcript 容器（.messages）");
// 观察目标必须真的挂到 .messages 上，否则观察器永远收不到高度变化。
assert.ok(/<div\s+className=\{`messages[^`]*`\}\s+ref=\{messagesRef\}/.test(chat), ".messages 必须挂 ref={messagesRef}");
// tuiMode 会整体替换聊天区，观察器必须跟着重建。
assert.ok(roBody.includes("[activeThreadId, tuiMode]"), "ResizeObserver effect 依赖必须含 tuiMode（TUI 模式整体替换聊天区）");

// --- ② 贴底态关闭滚动锚定 ---------------------------------------------------

assert.ok(/className=\{`chat-scroll\$\{atBottom \? " sticking" : ""\}`\}/.test(chat), ".chat-scroll 必须按贴底态加 sticking 类");
assert.ok(/\.chat-scroll\.sticking\s*\{[^}]*overflow-anchor:\s*none/.test(css), "styles.css 必须给 .chat-scroll.sticking 设 overflow-anchor: none");
// 反向护栏：不能在阅读态也关掉锚定——那会让长会话上翻时位置漂移。
const stickyRule = css.match(/\.chat-scroll\.sticking\s*\{[^}]*\}/)?.[0] || "";
assert.ok(!/^\.chat-scroll\s*\{[^}]*overflow-anchor/m.test(css), ".chat-scroll 基础规则不得无条件关闭锚定（只在 sticking 态关）");
assert.ok(stickyRule.length > 0);

// --- ③ 回合结束的贴底不做平滑动画 -------------------------------------------

const turnEndStart = chat.indexOf("prev.on && !now");
assert.ok(turnEndStart > 0, "找不到回合结束（streaming → null）的贴底分支");
const turnEndBody = chat.slice(turnEndStart, turnEndStart + 900);
assert.ok(turnEndBody.includes("el.scrollTop = el.scrollHeight"), "回合结束必须直接贴底");
assert.ok(!turnEndBody.includes('behavior: "smooth"'), "回合结束的贴底不得用平滑动画（会与后续 delta 的即时写入抢位置）");

// 反向护栏：用户显式点「跳转到最新」仍可平滑滚动（那是用户的主动操作，不是跟随）。
assert.ok(/jump-latest[\s\S]{0,600}behavior: "smooth"/.test(chat), "「跳转到最新」按钮应保留平滑滚动");

console.log("chat-scroll: 8 项通过（贴底收敛 / 锚定 / 段末贴底 / 显式跳转）");
