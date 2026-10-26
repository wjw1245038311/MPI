/**
 * 「交接到新会话」的回归测试。
 *
 * 为什么是源级断言：`store.ts` 依赖 React / pi SDK，拉不进 node 测试，也没有 store 夹具。
 * 而这个功能的语义**恰好全是"装配顺序"问题**（先建空会话、继承哪几项、任务模式必须先应用、
 * 提示词必须在继承之后才发），一旦被重构改乱，功能会静默退化（模型没继承过去 / 第一轮
 * 用了旧模型跑），所以在这里钉住。
 *
 * 需求背景（2026-10-13 用户）：新建会话原本只读全局默认
 * （settings.json 的 defaultProvider / defaultModel / defaultThinkingLevel），
 * 于是在某个会话里临时切换的模型不会跟到新会话；而长会话继续堆下去代价很高
 * （实测 38 万 token 的会话，缓存未命中时冷读一轮 75 s）。交接 = 配置不变、上下文清零。
 *
 * 语义由用户在同一天三次指正后定稿：
 *   ① 入口在**对话区域右键菜单**（不是侧栏会话列表）；
 *   ② 触发条件是**选中一段文字**；
 *   ③ 那段文字**就是新会话的提示词，并直接开跑**（不是开个空会话让用户再输一遍）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const store = readFileSync(new URL("../src/renderer/src/store.ts", import.meta.url), "utf8");
const menu = readFileSync(new URL("../src/renderer/src/components/MessageQuoteMenu.tsx", import.meta.url), "utf8");

const anchor = store.indexOf("handoffToNewSession: async (cwd, sessionFile, prompt, name) =>");
assert.ok(anchor > 0, "store 里找不到 handoffToNewSession 实现（签名应带 prompt 参数）");
const body = store.slice(anchor, anchor + 5000);

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

// ④ 选中文字 = 新会话的第一条提示词，且**在继承之后**发出（否则第一轮会跑在旧模型/旧权限上）
const iSend = at("sendPrompt(liveId");
assert.ok(iSend > iPerm, `提示词必须在继承全部就位之后再发：权限(${iPerm}) → sendPrompt(${iSend})`);
assert.match(store, /handoffToNewSession: \(cwd: string, sessionFile: string \| null, prompt\?: string, name\?: string\)/, "store 类型声明未带上 prompt / name 参数");

// ⑤ 入口在**对话区域右键菜单**里，并且把选中的文字传给交接
assert.match(menu, /handoffToNewSession\(t\.cwd, t\.sessionFile, quote\.text\)/, "菜单未把选中文字作为提示词传给 handoffToNewSession");
assert.match(menu, /交接到新会话/, "对话区菜单缺少「交接到新会话」文案");

// ⑥ 菜单只由「一段选中的文字」触发：没选中文字就不该接管右键
assert.ok(!/closest\("\.chat-scroll"\)/.test(menu), "菜单不该再按「右键落在对话区」无条件弹出——交接需要选中文字");
assert.ok(!/quote: PendingQuote \| null/.test(menu), "菜单 state 不该再有“无选中”形态（quote 必须非空）");
assert.match(menu, /if \(!text \|\| !sel\) return;/, "未选中文字时应直接放行（保留各处原有右键菜单）");

// ⑦ 侧栏会话列表**不再**承载这个入口（用户指正过：入口在对话区）
const sidebar = readFileSync(new URL("../src/renderer/src/components/Sidebar.tsx", import.meta.url), "utf8");
assert.ok(!/handoffToNewSession/.test(sidebar), "Sidebar 不该再挂交接入门（入口在对话区右键菜单）");

// ⑧ 手机/远程那条路（主机侧 thread.handoff）必须继承**同一套四项、同一顺序**
//    2026-10-26 事故：远程版模型没继承 → 新会话落到项目默认模型（指向不可达端点）
//    → 手机上一整页 Connection error。这里直接从源码钉住，不靠人工记忆。
const ipc = readFileSync(new URL("../src/main/ipc.ts", import.meta.url), "utf8");
const handoffAt = ipc.indexOf("handoff: async (threadId) => {");
assert.ok(handoffAt > 0, "ipc.ts 里找不到远程 handoff 实现");
const remoteBody = ipc.slice(handoffAt, ipc.indexOf("fileTree: (projectId", handoffAt));
const rat = (needle) => remoteBody.indexOf(needle);
const [rTask, rModel, rThink, rPerm, rPrompt] = [
  rat("remoteBackend.setMode"),
  rat("remoteBackend.setModel"),
  rat("remoteBackend.setThinking"),
  rat("remoteBackend.setPermission"),
  rat("threadService.prompt"),
];
assert.ok([rTask, rModel, rThink, rPerm, rPrompt].every((i) => i > 0), "远程交接的四项继承/首发缺项");
assert.ok(
  rTask < rModel && rModel < rThink && rThink < rPerm && rPerm < rPrompt,
  `远程交接顺序错了（应 任务模式→模型→思考等级→权限→提示词）：${[rTask, rModel, rThink, rPerm, rPrompt].join(" → ")}`,
);
// create 的第一个参数是**远程项目 id**（HMAC 后的 opaque 串），不是 cwd：
// 传 cwd 会得到 NOT_FOUND Project not found（2026-10-25 实测）。
assert.match(remoteBody, /threadService\.create\(ref\.projectId/, "远程交接新建会话必须传 ref.projectId（传 ref.cwd 会 NOT_FOUND）");

// ⑨ 过程要推 handoff_progress，否则手机端又是黑箱等待（用户 2026-10-26 反馈）
for (const phase of ["doc", "create", "config", "prompt", "done", "error"]) {
  assert.match(remoteBody, new RegExp(`phase\\(\\s*"${phase}"`), `远程交接缺少 ${phase} 阶段的进度推送`);
}
const pwaSession = readFileSync(new URL("../mobile/pwa/src/lib/thread-session.ts", import.meta.url), "utf8");
assert.match(pwaSession, /case "handoff_progress"/, "PWA 未处理 handoff_progress 事件");
const pwaView = readFileSync(new URL("../mobile/pwa/src/ThreadView.tsx", import.meta.url), "utf8");
assert.match(pwaView, /handoff-banner/, "PWA 交接中缺少进度横幅");
const kotlinSession = readFileSync(
  new URL("../mobile/app/app/src/main/java/com/mpi/app/data/ThreadSession.kt", import.meta.url),
  "utf8",
);
assert.match(kotlinSession, /"handoff_progress" ->/, "安卓未处理 handoff_progress 事件");
const kotlinScreen = readFileSync(
  new URL("../mobile/app/app/src/main/java/com/mpi/app/ui/ThreadScreen.kt", import.meta.url),
  "utf8",
);
assert.match(kotlinScreen, /HandoffBanner\(/, "安卓交接中缺少进度横幅");

// ⑩ 新会话的标题 = 交接文档的一级标题（三端都要接上，否则又会退化成一模一样的标题）
//    桌面：host 回 { title } → store 透传给 handoffToNewSession → renameThread
assert.match(store, /handoffToNewSession: \(cwd: string, sessionFile: string \| null, prompt\?: string, name\?: string\)/,
  "handoffToNewSession 类型声明缺少 name 参数（交接文档标题）");
assert.match(store, /handoffToNewSession\(cwd, sessionFile, kickoff, typeof res\.title === "string"/,
  "handoffWithDoc 没把文档标题传给 handoffToNewSession");
assert.match(store, /if \(name\) \{\s*await get\(\)\.renameThread\(liveId, name\)/,
  "handoffToNewSession 没把 name 落到新会话（renameThread）");
//    主机/手机：远程 create 传 doc.title，且 createFn 真的把 name 写进 pi
assert.match(remoteBody, /threadService\.create\(ref\.projectId, doc\.title/, "远程交接没把文档标题作为会话名传给 create");
assert.match(ipc, /setSessionName\(name\)/, "createFn 没把 name 落到 pi（只存在 draft 上等于被忽略）");
assert.match(ipc, /handoffDocTitle\(readFileSync\(path, "utf8"\), handoffFallbackTitle\(path, language\)\)/,
  "文档标题应取自文档 H1，缺 H1 时回落时间戳");

console.log("handoff-session tests passed");
