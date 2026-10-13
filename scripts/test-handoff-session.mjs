/**
 * 「交接到新会话」的回归测试。
 *
 * 为什么是源级断言：`store.ts` 依赖 React / pi SDK，拉不进 node 测试，也没有 store 夹具。
 * 而这个功能的语义**恰好全是"装配顺序"问题**（先建空会话、继承哪几项、任务模式必须先应用），
 * 一旦被重构改乱，功能会静默退化（模型没继承过去 / 权限被任务模式覆盖），所以在这里钉住。
 *
 * 需求背景（2026-10-13 用户）：新建会话原本只读全局默认
 * （settings.json 的 defaultProvider / defaultModel / defaultThinkingLevel），
 * 于是在某个会话里临时切换的模型不会跟到新会话；而长会话继续堆下去代价很高
 * （实测 38 万 token 的会话，缓存未命中时冷读一轮 75 s）。交接 = 配置不变、上下文清零。
 *
 * 入口位置由用户在同一天两次指正后定稿：**对话区域右键菜单**（MessageQuoteMenu），
 * 不是侧栏会话列表——并且"没选中文字、直接右键对话区"也要能用。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const store = readFileSync(new URL("../src/renderer/src/store.ts", import.meta.url), "utf8");
const menu = readFileSync(new URL("../src/renderer/src/components/MessageQuoteMenu.tsx", import.meta.url), "utf8");

const anchor = store.indexOf("handoffToNewSession: async (cwd, sessionFile) =>");
assert.ok(anchor > 0, "store 里找不到 handoffToNewSession 实现");
const body = store.slice(anchor, anchor + 4000);

// ① 必须新建**空**会话（openThread 的第二参为 undefined），不能把来源会话本身拿来用
assert.match(body, /openThread\(cwd, undefined\)/, "交接必须新建空会话：openThread(cwd, undefined)");

// ② 未打开的来源会话要从磁盘读配置（权限/任务模式不在会话文件里，读不到属已知限制）
assert.match(body, /loadHistory\(/, "未打开的来源会话应从磁盘读 model / thinkingLevel");

// ③ 继承四项，且**顺序必须是 任务模式 → 模型 → 思考等级 → 权限**
//    理由：applyTaskMode 会连带写 thinking 与权限，放后面会把继承来的值覆盖掉。
const at = (needle) => body.indexOf(needle);
const [iTask, iModel, iThink, iPerm] = [at("applyTaskMode"), at("setModel"), at("setThinking"), at("setPermission")];
assert.ok([iTask, iModel, iThink, iPerm].every((i) => i > 0), "四项继承缺项（任务模式/模型/思考等级/权限）");
assert.ok(iTask < iModel && iModel < iThink && iThink < iPerm, `继承顺序错了：任务模式(${iTask}) → 模型(${iModel}) → 思考等级(${iThink}) → 权限(${iPerm})`);

// ④ 入口在**对话区域右键菜单**里
assert.match(menu, /handoffToNewSession/, "对话区菜单未接入 handoffToNewSession");
assert.match(menu, /交接到新会话/, "对话区菜单缺少「交接到新会话」文案");

// ⑤ 没选中文字、只右键对话区时也要能用
assert.match(menu, /closest\("\.chat-scroll"\)/, "未选中文字时未接住对话区右键（closest(\".chat-scroll\")）");
assert.match(menu, /quote\?: PendingQuote \| null|quote: PendingQuote \| null/, "菜单 state 未支持“无选中”形态（quote 可空）");

// ⑥ 侧栏会话列表**不再**承载这个入口（用户指正过：入口在对话区）
const sidebar = readFileSync(new URL("../src/renderer/src/components/Sidebar.tsx", import.meta.url), "utf8");
assert.ok(!/handoffToNewSession/.test(sidebar), "Sidebar 不该再挂交接入门（入口在对话区右键菜单）");

console.log("handoff-session tests passed");
