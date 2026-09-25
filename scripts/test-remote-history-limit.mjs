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
  CLIENT_MAX_ENVELOPE_BYTES,
  MAX_INNER_ENVELOPE_BYTES,
  MAX_RENDERED_MESSAGES,
  REMOTE_HISTORY_BYTE_BUDGET,
  SHRINK_MARKER,
  SNAPSHOT_HEADROOM_BYTES,
  capRenderedHistory,
  prepareRemoteHistory,
  remoteMessageSize,
  settleToolsOutsideRunningTurn,
  shrinkToBudget,
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
// 2026-09-25 起改成「主机 ≤ 客户端」而不是「相等」：改用**发布顺序**代替能力协商——
// 先把两侧客户端的上限提到 8MB（此时主机仍只发 1.6MB，行为零变化），确认可用后才提
// 主机侧。这条断言编码的才是真正的安全性质：**主机永远不会发出客户端接不住的帧**。
assert.ok(
  MAX_INNER_ENVELOPE_BYTES <= kotlinCap,
  `主机侧 MAX_INNER_ENVELOPE_BYTES(${MAX_INNER_ENVELOPE_BYTES}) 不得超过原生 Envelope.MAX_ENVELOPE_BYTES(${kotlinCap})——否则整帧会被客户端 PAYLOAD_TOO_LARGE 丢弃`,
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
  // 造出 ≈ 3× 上限的量，必然要剪。
  // 自校准：以前硬编码「200 条 × 20KB ≈ 4MB：远超上限」，上限从 1.6MB 提到 7.6MB
  // 之后那个 fixture 就不再超限、测试静默失效了。预算变了这里不用动。
  const per = 20_000;
  const count = Math.ceil((ENCODED_LIMIT * 3) / per);
  const messages = Array.from({ length: count }, (_, i) => message(i, per));
  const trimmed = trimRemoteHistoryByEncodedSize(messages);

  assert.ok(trimmed.length < messages.length, "超限时必须丢最旧的");
  assert.ok(JSON.stringify(trimmed).length <= ENCODED_LIMIT, "裁剪后必须进得了限制");
  // 保留的是**最新的**那一批
  assert.equal(trimmed[trimmed.length - 1].id, `m-${count - 1}`);
  assert.equal(trimmed[0].id, `m-${count - trimmed.length}`);
}

{
  // 没超限时不动（不能无谓地丢历史）
  const messages = Array.from({ length: 5 }, (_, i) => message(i, 100));
  assert.deepEqual(trimRemoteHistoryByEncodedSize(messages), messages);
}

{
  // 估算说没问题、但转义后真实超限——这正是事故形态，兜底必须抓住。
  // 自校准：由**实测膨胀比**推条数（让真实编码总量 ≈ 1.2× 预算），
  // 只要膨胀比 > 1/1.2 就能同时满足「估算不超、真实超」两个前提。
  // 实测该 fixture 的膨胀比约 1.48（转义把 \n / " / \\ / \t 各变成两个字符）。
  const probe = escapingMessage(0, 20_000);
  const estimateOne = remoteMessageSize(probe);
  const encodedOne = JSON.stringify(probe).length + 1;
  const count = Math.max(1, Math.floor((ENCODED_LIMIT / encodedOne) * 1.2));
  const messages = Array.from({ length: count }, (_, i) => escapingMessage(i, 20_000));
  assert.ok(
    messages.reduce((sum, m) => sum + remoteMessageSize(m), 0) < ENCODED_LIMIT,
    "前提：估算值本身没超（否则测不到转义导致的超限）",
  );
  assert.ok(
    JSON.stringify(messages).length > ENCODED_LIMIT,
    "前提：真实序列化长度确实超了（转义膨胀）",
  );
  const trimmed = trimRemoteHistoryByEncodedSize(messages);
  assert.ok(JSON.stringify(trimmed).length <= ENCODED_LIMIT, "转义膨胀也必须被兜住");
}

{
  // 单条就超限：至少保留最后一条（空历史比超预算更糟）。
  // 自校准：用「1.5× 预算」而不是硬编码 5MB——后者在上限提到 7.6MB 后就不再超限了。
  const messages = [message(0, 10), message(1, Math.ceil(ENCODED_LIMIT * 1.5))];
  const trimmed = trimRemoteHistoryByEncodedSize(messages);
  assert.equal(trimmed.length, 1, "单条自己就超预算时也必须保留它（空历史更糟）");
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

// --- 单帧硬保证：去掉 thinking 逐块上限后，这条兜底必须真的挡得住 ----------------
//
// 背景：`trimRemoteHistoryByEncodedSize` 的出口是「至少保留最后一条」，所以**单条消息
// 自己**超过预算时它只能原样放行 → 整帧超客户端上限 → PAYLOAD_TOO_LARGE 丢帧 →
// 重握手风暴（2026-09-24）。在此之前那个出口是安全的，靠的是逐块上限本身；去掉
// thinking 的 12,000 上限后那道隐式保证就没了，由 shrinkToBudget 显式兜住。

{
  const big = (n) => "y".repeat(n);

  // 1) 单条巨型 thinking（模拟模型吐几 MB 推理）→ 必须被压进预算
  {
    const monster = {
      id: "monster",
      role: "assistant",
      blocks: [{ type: "thinking", text: big(REMOTE_HISTORY_BYTE_BUDGET * 3) }],
    };
    const out = prepareRemoteHistory([monster]);
    assert.equal(out.length, 1, "单条也要保留（空历史比超预算更糟）");
    assert.ok(
      JSON.stringify(out).length <= REMOTE_HISTORY_BYTE_BUDGET,
      `单条超预算时必须收缩到预算内（实际 ${JSON.stringify(out).length} > ${REMOTE_HISTORY_BYTE_BUDGET}）`,
    );
    assert.ok(out[0].blocks[0].text.includes("已截断"), "收缩后带省略标记，用户能看出被截过");
  }

  // 2) shrinkToBudget 自身：进预算 / 带标记 / 不动调用方对象
  {
    const original = [{ id: "a", role: "assistant", text: big(50_000) }];
    const snapshot = JSON.stringify(original);
    const out = shrinkToBudget(original, 5_000);
    assert.ok(JSON.stringify(out).length <= 5_000, "收缩到指定预算内");
    assert.ok(out[0].text.endsWith(SHRINK_MARKER), "尾部带省略标记");
    assert.equal(JSON.stringify(original), snapshot, "只改副本，不动调用方的对象");
  }

  // 3) 已在预算内时一个字节都不动
  {
    const small = [message(0, 100), message(1, 100)];
    assert.deepEqual(shrinkToBudget(small, 1_000_000), small, "未超预算时原样返回");
  }

  // 4) 地板：字段都砍到地板仍超预算时，不死循环、不抛错、不丢消息
  {
    const many = Array.from({ length: 400 }, (_, i) => message(i, 5_000));
    const out = shrinkToBudget(many, 1_000); // 预算远小于「地板 × 条数」→ 只能尽力而为
    assert.equal(out.length, 400, "收缩而不是丢弃消息");
    assert.ok(JSON.stringify(out).length < JSON.stringify(many).length, "至少压掉了一部分");
  }

  // 5) 四级流水线仍然受条数上限与字节预算约束
  {
    const many = Array.from({ length: MAX_RENDERED_MESSAGES + 50 }, (_, i) => message(i, 20_000));
    const out = prepareRemoteHistory(many);
    assert.ok(out.length <= MAX_RENDERED_MESSAGES, "条数上限依然生效");
    assert.ok(JSON.stringify(out).length <= REMOTE_HISTORY_BYTE_BUDGET, "字节预算依然生效");
  }

  // 6) 发布顺序的安全前提：主机侧上限不得超过客户端能接受的上限
  {
    assert.ok(
      MAX_INNER_ENVELOPE_BYTES <= CLIENT_MAX_ENVELOPE_BYTES,
      `主机上限(${MAX_INNER_ENVELOPE_BYTES}) 不得超过客户端上限(${CLIENT_MAX_ENVELOPE_BYTES})`,
    );
  }
}

// --- 快照兜底：回合不在跑时收口工具块 -----------------------------------------
//
// 为什么要它：`remoteMessages` 对没有 toolResult 的 toolCall 一律标 `running: true`。
// 被**中断**的工具（用户点停止 / 进程退出）永远不会落 toolResult → 远程视图每次重载
// 都显示一行永远转圈的工具。真机数据里已存在实例（2026-09-23 那会话的 entry#821）。

{
  const toolMsg = (id, running) => ({ id, role: "assistant", blocks: [{ type: "tool", id, name: "bash", running }] });

  // 1) 线程正在跑 → **一个字节都不能改**（工具确实可能真在途）
  {
    const running = [toolMsg("a", true)];
    assert.equal(
      settleToolsOutsideRunningTurn(running, "running"),
      running,
      "state=running 时必须原样返回（不得误清正在执行中的工具）",
    );
  }

  // 2) 回合已结束 → 收口（这正是被中断的工具会永远转圈的修法）
  {
    const input = [toolMsg("a", true), { id: "t", role: "assistant", blocks: [{ type: "text", text: "hi" }] }];
    for (const state of ["idle", "draft", "error"]) {
      const out = settleToolsOutsideRunningTurn(input, state);
      assert.equal(out[0].blocks[0].running, false, `state=${state} 时应收口在跑的工具块`);
      assert.equal(out[1].blocks[0].type, "text", "非工具块不受影响");
    }
    assert.equal(input[0].blocks[0].running, true, "只改副本，不动调用方对象");
  }

  // 3) 没有在跑的工具时不做无谓复制（返回同一引用）
  {
    const clean = [toolMsg("a", false)];
    assert.equal(settleToolsOutsideRunningTurn(clean, "idle"), clean, "无需改动时返回原数组（避免无谓渲染）");
  }

  // 4) 空数组安全
  {
    assert.deepEqual(settleToolsOutsideRunningTurn([], "idle"), []);
  }
}

console.log("remote history limit checks passed");
