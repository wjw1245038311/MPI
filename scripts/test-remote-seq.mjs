// 线程事件的 seq 属于「事件」，不属于「订阅者」。
//
// 2026-09-25 事故：seq 曾写在 RemoteService 的**每个连接的订阅回调**里递增
// （`const seq = (this.sequences.get(threadId) || 0) + 1` 位于 subscribeThread 的
// listener 内）。同一会话有两个订阅者时（手机端 APP + 桌面网页），一个事件会触发
// 两次递增，两边各拿到 seq=1 / 2，于是每个订阅者看到的都是**步长 = 订阅者数**的
// 等差序列 → 客户端把**每一个事件**都判成「缺号」→ `thread.resync` → 而 resync
// 第一件事就是 `patch({ ready: false })` → 消息区反复被打回「加载会话…」，同时在
// 两台设备之间来回重拉 ~530KB 的快照。
//
// 主机 diag 日志的指纹：`subs=2` 与成串的 `remote-req resync` 同时出现；而多订阅者
// 出现之前轮转的那份日志里 resync 次数为 **0**、`subs>=2` 也是 0。
//
// 客户端（PWA thread-session.ts / 原生 ThreadSession.kt）假设的语义是注释里写的那句
// ——per-thread counter on the host, **monotonic across subscribers**。这个测试把
// 它钉死，避免再退回「每人一份序号」。
import assert from "node:assert/strict";
import { register } from "node:module";

// `remote/service.ts` 会（经由 `../diag-log`）import electron ——用项目既有的 stub
// loader 顶掉（同 test-pwa-thread.mjs 的做法）。必须在 dynamic import 之前 register。
register(new URL("./electron-stub-loader.mjs", import.meta.url));

const { RemoteEventHub } = await import("../src/main/remote/services.ts");
const { RemoteService } = await import("../src/main/remote/service.ts");
const { makeEnvelope } = await import("../src/main/remote/protocol.ts");

const T = "thread-a";
const ev = (kind) => ({ kind, data: {} });

// --- 1. 核心不变量：同一事件对所有订阅者发布同一个 seq --------------------------
{
  const hub = new RemoteEventHub();
  const seenA = [];
  const seenB = [];
  hub.subscribe(T, (_e, seq) => seenA.push(seq));
  hub.subscribe(T, (_e, seq) => seenB.push(seq));

  hub.publish(T, ev("one"));
  hub.publish(T, ev("two"));
  hub.publish(T, ev("three"));

  assert.deepEqual(seenA, [1, 2, 3], "订阅者 A 应看到连续序号 1,2,3");
  assert.deepEqual(seenB, [1, 2, 3], "订阅者 B 必须看到**与 A 完全相同**的序号（这是本次修的 bug）");
  assert.deepEqual(seenA, seenB, "两个订阅者的序号序列必须逐项相等");
}

// --- 2. 序号严格递增、从 1 开始、与订阅者数量无关 -------------------------------
{
  const hub = new RemoteEventHub();
  const counts = [1, 2, 5];
  for (const n of counts) {
    for (let i = 0; i < n; i++) hub.subscribe(T, () => {});
  }
  const seen = [];
  hub.subscribe(T, (_e, seq) => seen.push(seq));
  for (let i = 0; i < 4; i++) hub.publish(T, ev("x"));
  // 注意：上面每个 n 累积订阅，序号只应由「发布次数」决定，与在场订阅者数无关。
  assert.deepEqual(seen, [1, 2, 3, 4], "序号只随发布次数递增，不受订阅者数量放大");
}

// --- 3. 迟到的订阅者不改变已有订阅者的序号，自己从当下对齐 -----------------------
{
  const hub = new RemoteEventHub();
  const early = [];
  hub.subscribe(T, (_e, seq) => early.push(seq));
  hub.publish(T, ev("a"));
  hub.publish(T, ev("b"));

  const late = [];
  hub.subscribe(T, (_e, seq) => late.push(seq));
  hub.publish(T, ev("c"));

  assert.deepEqual(early, [1, 2, 3], "已在场的订阅者序号不受新订阅者影响");
  assert.deepEqual(late, [3], "迟到者从下一个事件起与所有人同号（客户端靠 applySnapshot 重建基线）");
}

// --- 4. 无人订阅：静默丢弃且不推进序号 ------------------------------------------
{
  const hub = new RemoteEventHub();
  hub.publish(T, ev("nobody-listening")); // 不应消耗序号
  hub.publish(T, ev("still-nobody"));
  const seen = [];
  hub.subscribe(T, (_e, seq) => seen.push(seq));
  hub.publish(T, ev("first-real"));
  assert.deepEqual(seen, [1], "无人订阅期间的 publish 不推进序号");
}

// --- 5. 退订后不再收到；全部退订期间序号停滞但**不复位**（单调性优先） ----------
{
  const hub = new RemoteEventHub();
  const seenA = [];
  const offA = hub.subscribe(T, (_e, seq) => seenA.push(seq));
  hub.publish(T, ev("a"));
  offA();
  hub.publish(T, ev("b")); // A 已退订，且此刻无人订阅 → 既不投递也不推进
  const seenB = [];
  hub.subscribe(T, (_e, seq) => seenB.push(seq));
  hub.publish(T, ev("c"));
  assert.deepEqual(seenA, [1], "退订后不再收到事件");
  // 序号是「每线程单调递增」的（客户端跨重连靠它做缺口检测），所以停滞后是**接着数**
  // 而不是从头开始；只有 clear() 才复位。
  assert.deepEqual(seenB, [2], "有序号停滞但不复位，新订阅者接着上次数");
}

// --- 6. 不同线程的序号彼此独立 --------------------------------------------------
{
  const hub = new RemoteEventHub();
  const a = [];
  const b = [];
  hub.subscribe("t1", (_e, seq) => a.push(seq));
  hub.subscribe("t2", (_e, seq) => b.push(seq));
  hub.publish("t1", ev("x"));
  hub.publish("t1", ev("y"));
  hub.publish("t2", ev("z"));
  assert.deepEqual(a, [1, 2], "t1 的序号独立计数");
  assert.deepEqual(b, [1], "t2 的序号独立计数");
}

// --- 7. 只声明一个参数的订阅者仍可用（messaging/channel-base.ts 的用法） ---------
{
  const hub = new RemoteEventHub();
  const got = [];
  hub.subscribe(T, (event) => got.push(event.kind)); // 少声明一个参数
  hub.publish(T, ev("config_changed"));
  assert.deepEqual(got, ["config_changed"], "忽略 seq 的订阅者（消息通道）不受影响");
}

// --- 8. clear() 同时清掉序号（总重） ---------------------------------------
{
  const hub = new RemoteEventHub();
  hub.subscribe(T, () => {});
  hub.publish(T, ev("a"));
  hub.clear();
  const seen = [];
  hub.subscribe(T, (_e, seq) => seen.push(seq));
  hub.publish(T, ev("b"));
  assert.deepEqual(seen, [1], "clear() 后序号从头开始");
}

console.log("ok 1 - 线程事件 seq 归事件而非订阅者：多订阅者同号 + 严格递增 + 独立线程");

// --- 9. 端到端复现事故场景：两个设备订阅同一会话 ------------------------------
// 这是事故的**原始形态**：旧实现里 seq 在 service.ts 的每个连接订阅回调里递增，
// 两个设备会各拿 seq=1 / 2 → 互相缺号 → 无限 resync。这里把它钉死。
{
  const THREAD = "thread-two-devices";
  // 用**真 hub** 接线，严格照 ipc.ts 的实际接法：
  //   backend.subscribeThread → remoteEventHub.subscribe；发布方 → remoteEventHub.publish
  // 自己造一个"直接把事件交给 listener"的 fake 会把 seq 丢在门外，测不到这个 bug。
  const hub = new RemoteEventHub();
  const snapshot = {
    id: THREAD, projectId: "p1", title: "t", preview: "",
    updatedAt: 0, messageCount: 0, state: "idle", permission: "sandbox", messages: [],
  };
  const backend = {
    getThread: async () => snapshot,
    subscribeThread: (threadId, listener) => hub.subscribe(threadId, listener),
  };
  const service = new RemoteService(backend);

  const framesA = [];
  const framesB = [];
  const ctx = (connectionId, deviceId, sink) => ({
    connectionId, deviceId, send: (message) => sink.push(message),
  });

  await service.handle(
    makeEnvelope("thread.subscribe", "s1", { threadId: THREAD }, { threadId: THREAD, requestId: "r1" }),
    ctx("cA", "dA", framesA),
  );
  await service.handle(
    makeEnvelope("thread.subscribe", "s1", { threadId: THREAD }, { threadId: THREAD, requestId: "r2" }),
    ctx("cB", "dB", framesB),
  );
  assert.equal(hub.subscriberCount(THREAD), 2, "两个设备应各自注册一个线程订阅者");

  // 主机发布一个事件（真实现里由 ipc.ts 的事件钩子调 publish）
  hub.publish(THREAD, { kind: "agent_start", data: {} });

  const seqsOf = (frames) => frames.filter((f) => f.type === "thread.event").map((f) => f.seq);
  assert.deepEqual(seqsOf(framesA), [1], "设备 A 收到 seq=1");
  assert.deepEqual(
    seqsOf(framesB),
    [1],
    "设备 B 必须也收到 seq=1——旧实现在这里是 2，两边互相判缺号，无限 resync",
  );
}

console.log("ok 2 - 两个设备订阅同一会话：收到同一个 seq（事故场景回归守卫）");
console.log("remote seq tests passed");
