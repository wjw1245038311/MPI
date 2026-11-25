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
// 窗口拉到整段 effect（含新增的容器观察器），因为 pin 到依赖数组的距离
// 随代码增长而变化——固定的字符数不是不变量。
const roAnchor = chat.indexOf("}, [activeThreadId, tuiMode]);", roStart);
assert.ok(roAnchor > roStart, "找不到 ResizeObserver effect 的依赖数组 [activeThreadId, tuiMode]");
const roBody = chat.slice(roStart, roAnchor + 40);
assert.ok(roBody.includes("new ResizeObserver("), "贴底收敛必须由 ResizeObserver 驱动（布局后、绘制前纠正）");
assert.ok(roBody.includes("stickRef.current"), "ResizeObserver 贴底必须受 stick 意图约束（阅读历史时不许拽回）");
assert.ok(roBody.includes("isRestoring()"), "ResizeObserver 贴底必须让位给切会话恢复期");
// 2026-11-25 取证后**反向**：贴底不得再被手势窗口挡掉（见该行下方 ①d 的说明）。
assert.ok(!/const pin = \(\) => \{[\s\S]*?hasScrollGesture\(\)[\s\S]*?\};/.test(roBody), "pin() 不得再用手势窗口挡贴底——stick 已是唯一事实源（2026-11-25 scroll-pin 日志实证）");
assert.ok(roBody.includes("lastScrollTopRef.current"), "程序化写入必须同步 lastScrollTopRef，否则会被误判成用户上滚");
assert.ok(roBody.includes("ro.observe(host)"), "ResizeObserver 必须观察 transcript 容器（.messages）");
assert.ok(roBody.includes("[activeThreadId, tuiMode]"), "ResizeObserver effect 依赖必须含 tuiMode（TUI 模式整体替换聊天区）");// 观察目标必须真的挂到 .messages 上，否则观察器永远收不到高度变化。
assert.ok(/<div\s+className=\{`messages[^`]*`\}\s+ref=\{messagesRef\}/.test(chat), ".messages 必须挂 ref={messagesRef}");

// --- ①b 容器自身也要观察（v0.15.2 漏掉的那一侧）--------------------------------
//
// 滚动容器变矮（窗口高变化 / 输入框长高 / 兄弟元素出现）时 max 变小、scrollTop 被钳到
// 新底部，而 .messages 的尺寸没变 → 只观察内容收不到这次变化。少了这条，多轮会话里
// 「先停在上一条」仍然会出现（2026-11-25 复现）。
assert.ok(roBody.includes("roScroller.observe(scroller)"), "必须同时观察滚动容器（scroller），否则容器变矮导致的钳制无人补");
assert.ok(/const roScroller = new ResizeObserver\(/.test(roBody), "容器必须有独立的 ResizeObserver 回调");
assert.ok(roBody.includes("roScroller.disconnect()"), "容器观察器必须在 effect 清理时断开");

// --- ①d stick 是唯一事实源（2026-11-25 取证结论）--------------------------------
//
// mpi-diag.log 的 167 条 scroll-pin 里，148 条 ro-content 全部卡在
// `stick=true` + `skipped:"gesture"`：滚轮归因窗口（200ms）比流式内容增长慢，
// 窗口内每帧贴底被挡；窗口到期后 handleUserScroll 把那段位移当布局噪声，
// 不再补位 → 视口留在半路（实测 gap=11342，约 18 屏）。
//
// 所以贴底只能由 stick（+ 切会话恢复期）决定。手势窗口的职责是「归因」，
// 它已经把结论写进 stick 了；再挡一次就是第二套判定。
{
  const pinBody = chat.slice(chat.indexOf("const pin = () => {"), chat.indexOf("const ro = new ResizeObserver(pin)"));
  assert.ok(pinBody.includes("stickRef.current"), "pin() 必须看 stick");
  assert.ok(pinBody.includes("isRestoring()"), "pin() 必须让位给切会话恢复期（那段位置由 applySavedScroll 负责）");
  assert.ok(!pinBody.includes("hasScrollGesture"), "pin() 不得引用手势判定——stick 已包含该结论");
  const pinScrollerBody = chat.slice(chat.indexOf("const pinScroller = () => {"), chat.indexOf("const roScroller = new ResizeObserver"));
  assert.ok(!pinScrollerBody.includes("hasScrollGesture"), "容器观察器的贴底同样不得被手势挡掉");
  // 反向护栏：手势归因本身不能删——handleUserScroll / handleWheel 仍靠它区分用户意图与布局位移。
  assert.ok(chat.includes("const hasScrollGesture = ()"), "手势归因函数必须保留（handleUserScroll / 恢复期让位仍在用）");
}

// --- ①c 取证埋点：贴底被让位 / 补了还有差距时要留下证据 -------------------------
//
// 没有样本就只能继续猜。每次都写会刷屏，所以实现里按几何去重——但采样调用必须存在。
assert.ok(chat.includes("logScrollPin("), "贴底收敛必须上报诊断样本（否则下次复现仍然只能猜）");
for (const source of ["ro-content", "ro-scroller"]) {
  assert.ok(chat.includes(`"${source}"`), `诊断样本必须区分触发源：${source}`);
}

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

console.log("chat-scroll: 12 项通过（贴底收敛 / 容器变矮 / 取证埋点 / 锚定 / 段末贴底 / 显式跳转）");
