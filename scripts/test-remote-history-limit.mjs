// 手机端历史下发上限：**单帧必须进得了手机端的硬上限**。
//
// 2026-09-24 真机事故：会话历史涨到 2.02MB 后，`thread.subscribe` 的响应每一条都被
// 手机端 `Envelope.parse` 抛 PAYLOAD_TOO_LARGE 丢掉 → 请求 10s 超时 → UI 报
// 「订阅失败」→ `Requester.onStaleConnection` 触发重握手 → 主机 `relay-device-replaced`
// → 订阅被清 → 手机再订阅……形成 ~10s 一轮的重连风暴，用户完全用不了。
//
// 所以这里钉死两件事：
//   1. 裁剪后的**真实序列化长度**一定小于「手机端硬上限 − 余量」；
//   2. 主机侧常量与手机端 Kotlin 常量不能各说各话（跨语言漂移守卫）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const {
  MAX_INNER_ENVELOPE_BYTES,
  MAX_RENDERED_MESSAGES,
  REMOTE_HISTORY_BYTE_BUDGET,
  SNAPSHOT_HEADROOM_BYTES,
  capRenderedHistory,
  remoteMessageSize,
  trimRemoteHistory,
  trimRemoteHistoryByEncodedSize,
} = await import("../src/main/remote/history-limit.ts");

const ENCODED_LIMIT = MAX_INNER_ENVELOPE_BYTES - SNAPSHOT_HEADROOM_BYTES;

// --- 常量一致性与自洽 -------------------------------------------------------

const kotlin = readFileSync(
  resolve(import.meta.dirname, "..", "mobile", "app", "app", "src", "main", "java", "com", "mpi", "app", "protocol", "Envelope.kt"),
  "utf8",
);
const kotlinCap = Number(/MAX_ENVELOPE_BYTES\s*=\s*([0-9_]+)/.exec(kotlin)?.[1].replace(/_/g, ""));
assert.equal(
  kotlinCap,
  MAX_INNER_ENVELOPE_BYTES,
  "主机侧 MAX_INNER_ENVELOPE_BYTES 与手机端 Envelope.MAX_ENVELOPE_BYTES 必须一致（改一边就要改另一边）",
);

assert.equal(REMOTE_HISTORY_BYTE_BUDGET, MAX_INNER_ENVELOPE_BYTES - SNAPSHOT_HEADROOM_BYTES);
assert.ok(REMOTE_HISTORY_BYTE_BUDGET < MAX_INNER_ENVELOPE_BYTES, "净预算必须低于手机端硬上限");

// --- 真实序列化长度兜底 -----------------------------------------------------

function message(index, bodyLength) {
  return {
    id: `m-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    blocks: [{ type: "text", text: "x".repeat(bodyLength) }],
    timestamp: 1000 + index,
  };
}

/** 一段「带转义」的正文：换行/引号会让真实 JSON 比估算更大。 */
function escapingMessage(index, bodyLength) {
  return {
    id: `e-${index}`,
    role: "assistant",
    blocks: [{ type: "text", text: ('a\n"b\\c\t').repeat(Math.ceil(bodyLength / 8)) }],
    timestamp: 2000 + index,
  };
}

{
  // 200 条 × 20KB ≈ 4MB：远超上限，必须剪到限制内。
  const messages = Array.from({ length: 200 }, (_, i) => message(i, 20_000));
  const trimmed = trimRemoteHistoryByEncodedSize(messages);

  assert.ok(trimmed.length < messages.length, "超限时必须丢最旧的");
  assert.ok(JSON.stringify(trimmed).length <= ENCODED_LIMIT, "裁剪后必须进得了限制");
  // 保留的是**最新的**那一批
  assert.equal(trimmed[trimmed.length - 1].id, "m-199");
  assert.equal(trimmed[0].id, `m-${200 - trimmed.length}`);
}

{
  // 没超限时不动（不能无谓地丢历史）
  const messages = Array.from({ length: 5 }, (_, i) => message(i, 100));
  assert.deepEqual(trimRemoteHistoryByEncodedSize(messages), messages);
}

{
  // 估算说没问题、但转义后真实超限——这正是事故形态，兜底必须抓住
  const messages = Array.from({ length: 88 }, (_, i) => escapingMessage(i, 20_000));
  assert.ok(
    messages.reduce((sum, m) => sum + remoteMessageSize(m), 0) < ENCODED_LIMIT,
    "前提：估算值本身没超（否则测不到转义导致的超限）",
  );
  const trimmed = trimRemoteHistoryByEncodedSize(messages);
  assert.ok(JSON.stringify(trimmed).length <= ENCODED_LIMIT, "转义膨胀也必须被兜住");
}

{
  // 单条就超限：至少保留最后一条（空历史比超预算更糟）
  const messages = [message(0, 10), message(1, 5_000_000)];
  const trimmed = trimRemoteHistoryByEncodedSize(messages);
  assert.equal(trimmed.length, 1);
  assert.equal(trimmed[0].id, "m-1");
}

{
  // 空数组不炸
  assert.deepEqual(trimRemoteHistoryByEncodedSize([]), []);
}

// --- 两道裁剪串起来（与 ipc.ts 的调用顺序一致）------------------------------

{
  const messages = Array.from({ length: MAX_RENDERED_MESSAGES + 50 }, (_, i) => message(i, 20_000));
  const trimmed = trimRemoteHistoryByEncodedSize(trimRemoteHistory(capRenderedHistory(messages)));
  assert.ok(trimmed.length <= MAX_RENDERED_MESSAGES, "条数上限依然生效");
  assert.ok(JSON.stringify(trimmed).length <= ENCODED_LIMIT, "字节上限依然生效");
}

console.log("remote history limit checks passed");
