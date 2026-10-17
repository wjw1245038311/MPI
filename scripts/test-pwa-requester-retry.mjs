/**
 * Requester 的「等连接就绪再发」行为（`mobile/pwa/src/lib/requester.ts`）。
 *
 * 起因（真机现象）：minibox 上刷新页面后首页挂着
 *   「数据刷新失败：cannot send projects request (connection not ready)」
 * 因为 `sendData` 在 **E2E 握手未完成 / socket 刚重建** 时返回 false，而页面一 open 就发
 * `projects.list`。这个窗口通常只有几百毫秒，直接 reject 会让整个首页停在一个假错误上。
 *
 * 钉住三件事：
 *  ① false 之后重试，一旦就绪就正常完成（不报错）；
 *  ② 一直不就绪 → 窗口耗尽后才报错（错误文案不变，UI 继续可读）；
 *  ③ 发送抛异常也一样按「未就绪」重试；detach 后不再死等。
 */
import assert from "node:assert/strict";
import { register } from "node:module";

// 复用既有 loader：把 bundler 风格的扩展名省略 import（requester.ts 里的 "../../../shared/protocol"）
// 解析到 .ts，否则 node ESM 直接 ERR_MODULE_NOT_FOUND。
register(new URL("./electron-stub-loader.mjs", import.meta.url));

const { Requester } = await import("../mobile/pwa/src/lib/requester.ts");

/** 最小可用 transport：只实现 Requester 需要的四个方法。 */
function makeTransport(script) {
  const sent = [];
  let listener = null;
  return {
    sent,
    transport: {
      sendData: async (envelope) => {
        const verdict = script.shift();
        if (verdict instanceof Error) throw verdict;
        if (verdict === false) return false;
        sent.push(envelope);
        // 立刻回一个成功的 result（模拟主机应答）
        queueMicrotask(() => listener?.({ type: `${envelope.type}.result`, requestId: envelope.requestId, ok: true, payload: { ok: true } }));
        return true;
      },
      onFrame: (fn) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
      isOpen: () => true,
      getClientId: () => "test",
    },
  };
}

// ---- ① 先 false 后 true：应重试成功 --------------------------------------------
{
  const { transport } = makeTransport([false, false, true]);
  const requester = new Requester(transport, { requestTimeoutMs: 2_000, readyRetryWindowMs: 1_000 });
  try {
    const result = await requester.request("projects.list", undefined, "projects");
    assert.deepEqual(result, { ok: true }, "就绪后请求应正常完成");
  } finally {
    requester.detach();
  }
}

// ---- ② 一直 false：窗口耗尽后报错（文案不变）-----------------------------------
{
  const { transport } = makeTransport(Array(50).fill(false));
  const requester = new Requester(transport, { requestTimeoutMs: 2_000, readyRetryWindowMs: 150 });
  const started = Date.now();
  try {
    await requester.request("threads.list", undefined, "threads");
    assert.fail("一直不就绪时应当报错");
  } catch (error) {
    assert.match(String(error.message), /cannot send threads request \(connection not ready\)/);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 60, `应当先退避重试一会儿再报错（实际 ${elapsed}ms）`);
    assert.ok(elapsed < 1_500, `不应拖到整体超时（实际 ${elapsed}ms）`);
  } finally {
    requester.detach();
  }
}

// ---- ③ 抛异常也当作未就绪；detach 后立即放弃 -----------------------------------
{
  const { transport } = makeTransport([new Error("socket closed"), true]);
  const requester = new Requester(transport, { requestTimeoutMs: 2_000, readyRetryWindowMs: 1_000 });
  try {
    const result = await requester.request("thread.create", { projectId: "p1" }, "create");
    assert.deepEqual(result, { ok: true }, "抛错后仍应重试成功");
  } finally {
    requester.detach();
  }

  const { transport: stuck } = makeTransport(Array(50).fill(false));
  const detached = new Requester(stuck, { requestTimeoutMs: 5_000, readyRetryWindowMs: 5_000 });
  const promise = detached.request("projects.list", undefined, "projects");
  detached.detach();
  await assert.rejects(promise, /detach|connection not ready/, "detach 后不该继续死等");
}

console.log("pwa-requester-retry tests passed");
