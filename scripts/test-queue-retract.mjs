/**
 * 「撤回待投递插话」的回填规则（2026-10-19）。
 *
 * 背景：Alt+Enter「立即插入」= pi 的 steer，消息在 `_steeringMessages` 队列里等到下一个
 * LLM 调用边界才注入上下文；这段窗口内可以用 `clear_queue` 整队撤回。
 * 关键约束：pi **只能整队清**、且只返回文本 —— 所以撤回后必须把文本回填到
 * 「待处理后续」卡片，不能静默丢弃。
 */
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { normalizePiQueue, piQueueCount, piQueueTexts, mergeRetractedQueue, EMPTY_PI_QUEUE } = await import(
  "../src/renderer/src/lib/queue-retract.ts"
);

// 1) 事件 / IPC 返回值的规整：非数组、非字符串、空白一律丢弃
assert.deepEqual(normalizePiQueue({ steering: ["a", "  ", 1, null], followUp: ["b"] }), { steering: ["a"], followUp: ["b"] });
assert.deepEqual(normalizePiQueue(null), { steering: [], followUp: [] });
assert.deepEqual(normalizePiQueue("nope"), { steering: [], followUp: [] });
console.log("[1] 队列规整：脏数据被过滤");

// 2) 计数与文本顺序（steering 先于 followUp，保持 pi 的投递顺序）
const queue = { steering: ["改口径：用 A 方案", "再加一句"], followUp: ["之后跑测试"] };
assert.equal(piQueueCount(queue), 3);
assert.deepEqual(piQueueTexts(queue), ["改口径：用 A 方案", "再加一句", "之后跑测试"]);
assert.equal(piQueueCount(EMPTY_PI_QUEUE), 0);
console.log("[2] 计数 / 顺序");

// 3) 撤回后回填：没有待处理卡片 → 新建一张，文本按顺序拼接
const fresh = mergeRetractedQueue(null, queue);
assert.ok(fresh);
assert.equal(fresh.text, "改口径：用 A 方案\n\n再加一句\n\n之后跑测试");
assert.deepEqual(fresh.images, []);
assert.deepEqual(fresh.files, []);
console.log("[3] 无卡片时新建并拼接");

// 4) 已有待处理卡片 → 文本追加在后面，附件（图片/文件/引用）保留
const existing = {
  text: "已有的待处理内容",
  images: [{ dataUrl: "data:image/png;base64,AA", mimeType: "image/png" }],
  files: [{ name: "a.txt", abs: "E:/a.txt" }],
  quotes: [{ id: "q1", text: "引用片段" }],
};
const merged = mergeRetractedQueue(existing, { steering: ["插话"], followUp: [] });
assert.ok(merged);
assert.equal(merged.text, "已有的待处理内容\n\n插话");
assert.equal(merged.images.length, 1, "原有图片不能被撤回操作抹掉");
assert.equal(merged.files.length, 1, "原有文件不能被撤回操作抹掉");
assert.equal(merged.quotes?.length, 1, "原有引用不能被撤回操作抹掉");
console.log("[4] 合并时保留原有附件");

// 5) 什么都没撤回（pi 队列已空 / 已被模型消费）→ 不造空卡片
assert.equal(mergeRetractedQueue(null, { steering: [], followUp: [] }), null);
assert.equal(mergeRetractedQueue(existing, { steering: [], followUp: [] }), existing);
console.log("[5] 空撤回不改变状态");

// 6) 只有 followUp 也要能回填（用户可能同时有排队的后续消息）
assert.equal(mergeRetractedQueue(null, { followUp: ["后续 A"] })?.text, "后续 A");
console.log("[6] 仅 followUp 也能回填");

console.log("\n撤回回填规则：6 项全部通过");

// 7) 契约检查：主进程 bridge / IPC / preload 三处都得接上 clear_queue，
//    否则 UI 点了按钮只会报「not a function」。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const bridge = readFileSync(join(ROOT, "src/main/pi-bridge.ts"), "utf8");
const ipc = readFileSync(join(ROOT, "src/main/ipc.ts"), "utf8");
const preload = readFileSync(join(ROOT, "src/preload/index.ts"), "utf8");
assert.match(bridge, /clearQueue\(\)[^{]*\{[^}]*send\("clear_queue"\)/s, "pi-bridge 必须把 clear_queue 封装成 clearQueue()");
assert.match(ipc, /"thread:clearQueue"/, "ipc 必须暴露 thread:clearQueue");
assert.match(ipc, /bridge\.clearQueue\(\)/, "ipc 必须真的调用 bridge.clearQueue()");
assert.match(preload, /clearQueue: \(args: \{ threadId: string \}\)/, "preload 必须注入 clearQueue");
console.log("[7] bridge / ipc / preload 三处接线齐全");

// 8) 三端接线：协议白名单与两个移动客户端的撤回入口都得在，
//    否则手机上那个「×」点了会得到 MODEL_UNAVAILABLE 之类的莫名错误。
const desktopProtocol = readFileSync(join(ROOT, "src/main/remote/protocol.ts"), "utf8");
const sharedProtocol = readFileSync(join(ROOT, "mobile/shared/protocol.ts"), "utf8");
assert.match(desktopProtocol, /"thread\.clearQueue"/, "桌面协议白名单必须包含 thread.clearQueue");
assert.match(sharedProtocol, /"thread\.clearQueue"/, "PWA 共享协议白名单必须包含 thread.clearQueue（两端要一致）");
const pwaActions = readFileSync(join(ROOT, "mobile/pwa/src/lib/thread-actions.ts"), "utf8");
assert.match(pwaActions, /clearQueue\(\)[\s\S]{0,160}thread\.clearQueue/, "PWA 必须实现 clearQueue()");
const pwaSession = readFileSync(join(ROOT, "mobile/pwa/src/lib/thread-session.ts"), "utf8");
assert.match(pwaSession, /case "queue_update"/, "PWA 必须消费 queue_update 事件");
const androidActions = readFileSync(join(ROOT, "mobile/app/app/src/main/java/com/mpi/app/data/ThreadActions.kt"), "utf8");
assert.match(androidActions, /thread\.clearQueue/, "安卓必须实现 clearQueue()");
const androidSession = readFileSync(join(ROOT, "mobile/app/app/src/main/java/com/mpi/app/data/ThreadSession.kt"), "utf8");
assert.match(androidSession, /"queue_update" ->/, "安卓必须消费 queue_update 事件");
console.log("[8] 协议白名单 + PWA/安卓 撤回入口齐全");
