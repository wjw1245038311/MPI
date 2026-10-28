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

// --- 4. 无人订阅：序号照常推进、事件进缓冲（重连后可补发） --------------------
{
  const hub = new RemoteEventHub();
  hub.publish(T, ev("nobody-listening"));
  hub.publish(T, ev("still-nobody"));
  const seen = [];
  // 不带 sinceSeq（首次打开）：不补发旧事件，靠快照兜底，序号接着数
  hub.subscribe(T, (_e, seq) => seen.push(seq));
  hub.publish(T, ev("first-real"));
  assert.deepEqual(seen, [3], "无人订阅期间序号照常推进（缓冲里的事件要带稳定序号才能补发）");
}

// --- 4b. 带 sinceSeq 重订阅：补发断线期间的事件，且不重复 ----------------------
{
  const hub = new RemoteEventHub();
  const first = [];
  const { unsubscribe: off } = hub.subscribe(T, (_e, seq) => first.push(seq));
  hub.publish(T, ev("a"));
  off(); // 断线
  hub.publish(T, ev("b")); // 断线期间（无人订阅）
  hub.publish(T, ev("c"));
  const resumed = [];
  const sub = hub.subscribe(T, (_e, seq) => resumed.push(seq), 1); // 我处理到 1
  assert.equal(sub.covered, true, "缓冲能覆盖 2..3 → covered");
  assert.equal(sub.replayed, 2, "应补发 b、c 两条");
  assert.deepEqual(resumed, [2, 3], "补发的就是断线期间那两条（序号连续）");
  hub.publish(T, ev("d"));
  assert.deepEqual(resumed, [2, 3, 4], "补发之后接上实时事件，不重复也不跳号");
}

// --- 4c. 已经跟平（sinceSeq = 当前序号）：covered 且 0 条 -------------------------
{
  const hub = new RemoteEventHub();
  hub.publish(T, ev("a"));
  hub.publish(T, ev("b"));
  const seen = [];
  const sub = hub.subscribe(T, (_e, seq) => seen.push(seq), 2);
  assert.equal(sub.covered, true, "追平也算覆盖：别为了 0 条事件拉 1.6MB 快照");
  assert.equal(sub.replayed, 0);
  assert.deepEqual(seen, []);
}

// --- 4c-2. sinceSeq 比当前还大（主机重启/序号清零）：**不能**当追平 ---------------
// 否则客户端不再拉快照，而后续事件的 seq 都小于它期望的基线 → 全被判成重复丢掉，
// 手机上表现就是“永远停在旧内容”。
{
  const hub = new RemoteEventHub();
  hub.publish(T, ev("a"));
  const seen = [];
  const sub = hub.subscribe(T, (_e, seq) => seen.push(seq), 500);
  assert.equal(sub.covered, false, "客户端基线比主机新 → 必须回快照重建基线");
  assert.deepEqual(seen, []);
}

// --- 4d. 缓冲里缺了中间一段：covered=false（老实回快照） ------------------------
{
  const hub = new RemoteEventHub({ maxBufferedEvents: 2 });
  hub.publish(T, ev("a"));
  hub.publish(T, ev("b"));
  hub.publish(T, ev("c")); // a 被预算挤掉了
  const seen = [];
  const sub = hub.subscribe(T, (_e, seq) => seen.push(seq), 0);
  assert.equal(sub.covered, false, "缺了 seq=1 → 不能给断头的增量");
  assert.equal(sub.replayed, 0);
  assert.deepEqual(seen, []);
}

// --- 5. 退订后不再收到；停滞后不复位（单调性优先） ---------------------------
{
  const hub = new RemoteEventHub();
  const seenA = [];
  const { unsubscribe: offA } = hub.subscribe(T, (_e, seq) => seenA.push(seq));
  hub.publish(T, ev("a"));
  offA();
  hub.publish(T, ev("b")); // A 已退订 → 不投递，但序号推进（缓冲留给重连补发）
  const seenB = [];
  hub.subscribe(T, (_e, seq) => seenB.push(seq));
  hub.publish(T, ev("c"));
  assert.deepEqual(seenA, [1], "退订后不再收到事件");
  // 序号是「每线程单调递增」的（客户端跨重连靠它做缺口检测），所以停滞后是**接着数**
  // 而不是从头开始；只有 clear() 才复位。
  assert.deepEqual(seenB, [3], "有序号停滞但不复位，新订阅者接着上次数");
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

// --- 10. 端到端：带 sinceSeq 重订阅 → 补发事件 + **不拉快照** -----------------
// 这是 2026-10-28 真机「桌面写了一堆、手机停在旧内容」的修：手机上断线十几秒，
// 以前只能靠重连后的全量快照（建快照 1.6MB、而且不含正在流式输出的那半条）；
// 现在主机先把断线期间的事件按序补发回去，客户端带 sinceSeq 请求时**不再要快照**。
{
  const THREAD = "thread-replay";
  const hub = new RemoteEventHub();
  const backend = {
    // getThread 故意炸：只要它被调用，就证明快照没被跳过（测试要钉的就是这一点）
    getThread: async () => {
      throw new Error("不该拉快照：断线期间的事件已经补发完了");
    },
    subscribeThread: (threadId, listener, sinceSeq) => hub.subscribe(threadId, listener, sinceSeq),
  };
  const service = new RemoteService(backend);
  const frames = [];
  const ctx = { connectionId: "cR", deviceId: "dR", send: (message) => frames.push(message) };
  const subscribe = (payload, requestId) =>
    service.handle(
      makeEnvelope("thread.subscribe", "s1", { threadId: THREAD, ...payload }, { threadId: THREAD, requestId }),
      ctx,
    );

  // 断线期间主机照常发：seq 1、2 进缓冲
  hub.publish(THREAD, { kind: "agent_start", data: {} });
  hub.publish(THREAD, { kind: "message_end", data: {} });

  await subscribe({ sinceSeq: 0 }, "r1");

  const events = frames.filter((f) => f.type === "thread.event");
  assert.deepEqual(
    events.map((f) => f.seq),
    [1, 2],
    "断线期间的两条事件应按序补发给客户端",
  );
  const result = frames.find((f) => f.type === "thread.subscribe.result");
  assert.ok(result, "应有 subscribe 响应帧");
  assert.equal(result.payload.snapshot, null, "补发成功后**不带快照**（客户端不该被重置视图）");
  assert.equal(result.payload.replayed, true, "客户端据此跳过 applySnapshot，保住流式内容");
  assert.equal(result.payload.replayFrom, 1);
  assert.equal(result.payload.replayTo, 2);
}

console.log("ok 3 - 断线补发：带 sinceSeq 重订阅只回增量，不拉快照");

// --- 11. 补不齐时必须回快照（不能让客户端拿着断头的增量继续） -------------------
{
  const THREAD = "thread-replay-miss";
  const hub = new RemoteEventHub({ maxBufferedEvents: 1 });
  let snapshots = 0;
  const backend = {
    getThread: async () => {
      snapshots += 1;
      return { id: THREAD, projectId: "p1", title: "t", preview: "", updatedAt: 0, messageCount: 0, state: "idle", permission: "sandbox", messages: [] };
    },
    subscribeThread: (threadId, listener, sinceSeq) => hub.subscribe(threadId, listener, sinceSeq),
  };
  const service = new RemoteService(backend);
  const frames = [];
  const ctx = { connectionId: "cM", deviceId: "dM", send: (message) => frames.push(message) };

  hub.publish(THREAD, { kind: "agent_start", data: {} });
  hub.publish(THREAD, { kind: "message_end", data: {} }); // seq=1 已被预算挤掉

  await service.handle(
    makeEnvelope("thread.subscribe", "s1", { threadId: THREAD, sinceSeq: 0 }, { threadId: THREAD, requestId: "r1" }),
    ctx,
  );
  const result = frames.find((f) => f.type === "thread.subscribe.result");
  assert.equal(snapshots, 1, "缓冲覆盖不了 → 必须拉快照（回退到旧行为）");
  assert.ok(result.payload.snapshot, "响应里要有快照");
  assert.equal(result.payload.replayed, undefined, "不要假装补发成功");
}

console.log("ok 4 - 补发覆盖不了时回退到全量快照（安全性兜底）");
console.log("remote seq tests passed");
