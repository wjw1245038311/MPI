// 远端消息 id 的生成规则：两端必须算出同一串，否则增量快照的锚点永远 miss。
//
// 现场（2026-10-29）：PWA 每打开/每重连一次会话都重下整段历史（311KB～1.6MB），
// 表现像“每次都在全量刷新”。根因是客户端把本地合成的 id（`local-N` 回显、`a-N` 流式、
// `u-N-M` 事件里补的）当成 `haveMessageId` 锚点，而主机快照里是另一套（位置型
// `assistant-<index>`），`findIndex` 永远 -1。
//
// 修法：两端统一成 `role-<timestamp>`（pi 的消息对象没有 id 但有 timestamp）。
// 这个测试把规则和「哪些 id 不算锚点」钉死，防止再退回位置型 id。
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./electron-stub-loader.mjs", import.meta.url));

const { remoteMessageId, isHostMessageId } = await import("../src/main/remote/message-id.ts");

// --- 1. 稳定键：同一台主机、同一批消息，两次生成的 id 必须完全一样 -----------------
{
  const user = { role: "user", content: "hi", timestamp: 1793157932657 };
  const assistant = { role: "assistant", content: [], timestamp: 1793157933159 };

  assert.equal(remoteMessageId(user, "user", 3), "user-1793157932657");
  assert.equal(remoteMessageId(assistant, "assistant", 4), "assistant-1793157933159");
  // 位置变了（前面插了几条）但时间戳没变 → id 不变，锚点照样能对上
  assert.equal(remoteMessageId(user, "user", 57), "user-1793157932657", "id 不能随位置漂移");
}

// --- 2. 显式 id 优先（未来 pi 若给了真 id，直接用它）----------------------------
{
  assert.equal(remoteMessageId({ id: "abc-123", timestamp: 1 }, "user", 0), "abc-123");
  assert.equal(remoteMessageId({ id: "  ", timestamp: 5 }, "user", 0), "user-5", "空白 id 当作没给");
}

// --- 3. 没有时间戳的老条目：回退到位置 id（同一台主机上仍稳定）--------------------
{
  assert.equal(remoteMessageId({ role: "system" }, "system", 2), "system-2");
  assert.equal(remoteMessageId(null, "user", 7), "user-7");
  assert.equal(remoteMessageId({ timestamp: Number.NaN }, "tool", 1), "tool-1");
}

// --- 4. 只有主机那种 id 才能当锚点 ---------------------------------------------
{
  // 主机发的
  for (const id of ["user-1793157932657", "assistant-1793157933159", "tool-call_abc", "system-3"]) {
    assert.equal(isHostMessageId(id), true, `主机 id 应可当锚点：${id}`);
  }
  // 客户端本地合成的（这些拿去问 haveMessageId 必然 miss）
  for (const id of ["local-1", "local-42", "a-17", "u-17-3", "u-9-0"]) {
    assert.equal(isHostMessageId(id), false, `本地合成 id 不该当锚点：${id}`);
  }
  assert.equal(isHostMessageId(""), false);
}

console.log("ok 1 - 远端消息 id 稳定键（role-<timestamp>）+ 位置回退");
console.log("ok 2 - 只有主机 id 才能当增量锚点");

// --- 5. 端到端：事件侧算出的 id 与快照侧一致 → 增量快照真能命中 ------------------
// 这是「PWA 每次全量刷新」的回归守卫：先按事件规则造两轮消息，再模拟主机按同一规则
// 生成快照，`haveMessageId` 必须能找到锚点。
{
  const { applyIncrementalSnapshot } = await import("../src/main/remote/history-limit.ts");
  const events = [
    { role: "user", timestamp: 1000 },
    { role: "assistant", timestamp: 1100 },
    { role: "user", timestamp: 2000 },
    { role: "assistant", timestamp: 2100 },
  ];
  // 客户端：从事件里算出的 id（与 hosts 的规则相同）
  const clientIds = events.map((m, i) => remoteMessageId(m, m.role, i));
  // 主机：快照按同一规则生成
  const snapshot = {
    messages: events.map((m, i) => ({ id: remoteMessageId(m, m.role, i), role: m.role, blocks: [] })),
  };
  const anchor = clientIds[clientIds.length - 1];
  const incremental = applyIncrementalSnapshot(snapshot, anchor);
  assert.equal(incremental.incremental, true, "锚点命中 → 应回增量而不是全量");
  assert.deepEqual(
    incremental.messages.map((m) => m.id),
    [anchor],
    "增量只回锚点及其之后（这里锚点就是最后一条）",
  );

  // 用本地合成 id 当锚点（旧行为）→ 必然 miss，退化成全量
  const miss = applyIncrementalSnapshot(snapshot, "a-17");
  assert.equal(miss.incremental, undefined, "本地合成 id 找不到锚点 → 回全量（这就是要避免的）");
  assert.equal(miss.messages.length, snapshot.messages.length);
}

console.log("ok 3 - 事件 id 与快照 id 一致时，增量快照确实命中");
console.log("remote message-id tests passed");
