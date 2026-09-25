/**
 * S5 end-to-end: PWA thread session (lib/thread-session.ts) against a real relay +
 * real RemoteHost/RelayUplink with a fake host service that scripts the event stream.
 *
 * Covers: subscribe-response snapshot, pre-snapshot event buffering (lossless),
 * streaming reducer (text accumulation, tool block running→done, message_end
 * finalization), seq-gap → resync, and mid-stream socket drop → reconnect +
 * reauth + **重新订阅** without duplicates or loss.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
register(new URL("./electron-stub-loader.mjs", import.meta.url));

async function startRelay() {
  const child = spawn(process.execPath, [join(ROOT, "mobile", "relay", "index.mjs")], {
    env: { ...process.env, RELAY_PORT: "0", RELAY_PING_MS: "500", RELAY_DEAD_MS: "1000" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let buffer = "";
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("relay did not become ready in 5s")), 5_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const m = buffer.match(/ready ws:\/\/[^:]+:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on("exit", (code) => reject(new Error(`relay exited early (code ${code})`)));
  });
  return { child, port };
}

async function waitFor(fn, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

async function main() {
  const userData = mkdtempSync(join(tmpdir(), "mpi-pwa-thread-"));
  let relay = null;
  const clients = [];
  let uplink = null;
  let remoteHost = null;
  try {
    relay = await startRelay();
    const url = `ws://127.0.0.1:${relay.port}/ws`;

    process.env.MPI_TEST_USER_DATA = userData;
    const { RemoteHost } = await import("../src/main/remote/host.ts");
    const { RelayUplink } = await import("../src/main/remote/relay-uplink.ts");
    const { createDeviceIdentity, randomSeedB64url } = await import("../mobile/pwa/src/lib/device-identity.ts");
    const { parsePairingLink, runPairing, attachAutoReauth } = await import("../mobile/pwa/src/lib/pairing.ts");
    const { RelayClient } = await import("../mobile/pwa/src/lib/relay-client.ts");
    const { ThreadSession } = await import("../mobile/pwa/src/lib/thread-session.ts");
    const { SnapshotCache } = await import("../mobile/pwa/src/lib/snapshot-cache.ts");
    const { makeEnvelope, responseFor } = await import("../mobile/shared/protocol.ts");

    // --- fake host service: scripted thread events ------------------------------------
    const THREAD_ID = "thread-abc";
    let seqCounter = 0;
    let resyncCount = 0;
    let subscribeCount = 0;
    /** When armed, the next thread.poke emits an event with a skipped seq (gap). */
    let gapArmed = false;
    const snapshotMessages = [
      { id: "m1", role: "user", text: "old question" },
      { id: "m2", role: "assistant", blocks: [{ type: "text", text: "old answer" }, { type: "tool", name: "read", running: false, result: "ok" }] },
    ];
    const makeSnapshot = (state) => ({
      id: THREAD_ID, projectId: "p1", title: "Test thread", preview: "old answer", updatedAt: Date.now(),
      messageCount: snapshotMessages.length, state, permission: "sandbox",
      cwdName: "demo", model: null, availableModels: [], skills: [], thinkingLevel: "off",
      taskMode: "iterate",
      availableModes: [{ id: "iterate", name: "迭代", summary: "完整权限 · 低思考" }, { id: "balanced", name: "均衡", summary: "沙盒 · 低思考" }],
      messages: snapshotMessages, nextSeq: 100,
    });

    const rendererEvents = [];
    remoteHost = new RemoteHost({
      userDataDir: userData,
      signalingUrl: "",
      stunUrls: [],
      sendToRenderer: (channel, payload) => rendererEvents.push([channel, payload]),
      service: {
        handle: async (request, ctx) => {
          // S8.7 regression: an IDLE thread emits no events at all — the snapshot
          // response itself must notify view listeners (UI was stuck on loading).
          if ((request.type === "thread.subscribe" || request.type === "thread.resync") && request.threadId === "t-idle") {
            ctx.send(responseFor(request, { snapshot: { id: "t-idle", projectId: "p1", title: "Idle thread", preview: "", updatedAt: Date.now(), messageCount: 0, state: "idle", permission: "sandbox", cwdName: "demo", model: null, availableModels: [], skills: [], thinkingLevel: "off", messages: [], nextSeq: 0 } }));
            return;
          }
          if (request.type === "thread.subscribe" || request.type === "thread.resync") {
            if (request.type === "thread.resync") resyncCount += 1;
            if (request.type === "thread.subscribe") subscribeCount += 1;
            // Simulate the host's real ordering: listener registered first, snapshot
            // fetched after — so these events are published BEFORE the response.
            const sendEvent = (kind, data) => ctx.send(makeEnvelope("thread.event", request.sessionId, { kind, data }, { threadId: THREAD_ID, seq: ++seqCounter }));
            if (request.type === "thread.subscribe") {
              // Real protocol shape: data = { event: <piEvent> }.
              sendEvent("agent_start", { event: {} });
              sendEvent("message_start", { event: { message: { role: "user", content: "hi there" } } });
            }
            ctx.send(responseFor(request, { snapshot: makeSnapshot("idle") }));
            if (request.type === "thread.subscribe") {
              // Live streaming turn after the snapshot.
              const send = (kind, data) => setTimeout(() => ctx.send(makeEnvelope("thread.event", request.sessionId, { kind, data }, { threadId: THREAD_ID, seq: ++seqCounter })), 0);
              send("message_update", { event: { assistantMessageEvent: { type: "text_delta", delta: "Hel" } } });
              send("message_update", { event: { assistantMessageEvent: { type: "text_delta", delta: "lo!" } } });
              // ⚠️ 这里必须用**真实**的 pi 事件形状：`toolcall_start` **只带
              // `partial.content[contentIndex]`，没有 `toolCall` 字段**（见 pi-ai 的
              // AssistantMessageEvent 定义），`toolcall_end` 才给权威 toolCall。
              // 旧 fake 在 start 上直接给 `toolCall`，把一个真实存在的 bug 藏了起来——
              // 拼包器只看 `ame.toolCall`，于是 start 拿不到真 id → 用 `tc-0` 占位 +
              // 名字写成字面量 "tool"；等 end 拿来真 id 又新建一个块，留下一个
              // **永远转圈的幽灵**（2026-09-25 真机截图：一行「tool」在转、紧跟一行「bash ✓」）。
              //
              // 三个工具调用分别覆盖三重防线：
              //   ① bash：start 的 partial 就带真 id（正常路径）
              //   ② read：start 不带 id → 占位 tc-1；end 才给真 id → 必须**改名合并**
              //   ③ glob：只有 start（占位）+ tool_execution_end，**没有 toolcall_end**
              //      → 必须靠「同名且在跑的占位块」认领（否则永远转圈）
              //   ④ write：只 start、**永不收尾**（模拟回合被中断：用户点停止 /
              //      进程退出，tool_execution_end 永远不来）→ 只能靠 agent_settled 兜底
              // partial 是「到目前为止的完整 AssistantMessage」：content 数组会随块增长，
              // 新块就在 contentIndex 那个位置上（所以下标 1/2 要先把前面的位置铺上）。
              const part = (index, id, name, args) => ({
                content: Array.from({ length: index + 1 }, (_, i) =>
                  i === index ? { type: "toolCall", ...(id ? { id } : {}), name, arguments: args } : { type: "text", text: "" },
                ),
              });
              send("message_update", { event: { assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: part(0, "call_1", "bash", {}) } } });
              send("message_update", { event: { assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { id: "call_1", name: "bash", arguments: { command: "ls" } }, partial: part(0, "call_1", "bash", { command: "ls" }) } } });
              send("tool_execution_end", { event: { toolCallId: "call_1", toolName: "bash", result: { content: "file.txt\n" }, isError: false } });
              send("message_update", { event: { assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, partial: part(1, undefined, "read", {}) } } });
              send("message_update", { event: { assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: { id: "call_2", name: "read", arguments: { path: "a.txt" } }, partial: part(1, "call_2", "read", { path: "a.txt" }) } } });
              send("tool_execution_end", { event: { toolCallId: "call_2", toolName: "read", result: { content: "hello\n" }, isError: false } });
              send("message_update", { event: { assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, partial: part(2, undefined, "glob", {}) } } });
              send("tool_execution_end", { event: { toolCallId: "call_3", toolName: "glob", result: { content: "x.ts\n" }, isError: false } });
              send("message_update", { event: { assistantMessageEvent: { type: "toolcall_start", contentIndex: 3, partial: part(3, "call_4", "write", {}) } } });
              send("message_end", { event: { message: { role: "assistant", stopReason: "stop" } } });
              send("agent_settled", {});
            }
            return;
          }
          if (request.type === "thread.poke-config") {
            // 会话配置同步：模拟 host 收到手机的 setMode/setModel 后的广播。
            ctx.send(makeEnvelope("thread.event", request.sessionId, {
              kind: "config_changed",
              data: {
                permission: "full",
                model: { provider: "lmstudio", id: "qwen3.6-27b" },
                taskMode: null,
                thinkingLevel: "high",
                origin: "remote",
              },
            }, { threadId: THREAD_ID, seq: ++seqCounter }));
            return responseFor(request, { ok: true });
          }
          if (request.type === "thread.poke") {
            // Test hook: emit one live event; with gapArmed the seq jumps by two.
            const skip = gapArmed ? 1 : 0;
            gapArmed = false;
            ctx.send(makeEnvelope("thread.event", request.sessionId, { kind: "agent_settled", data: {} }, { threadId: THREAD_ID, seq: ++seqCounter + skip }));
            return responseFor(request, { ok: true });
          }
        },
        disconnect: () => {},
      },
    });
    remoteHost.start();

    const cryptoMaterial = remoteHost.getRelayCryptoMaterial();
    uplink = new RelayUplink({ relayUrl: url, hostId: remoteHost.getStatus().hostId, userDataDir: userData, x25519PrivB64u: cryptoMaterial.x25519PrivB64u, x25519PubB64u: cryptoMaterial.x25519PubB64u, getHost: () => remoteHost });
    remoteHost.setRelay(uplink);
    uplink.start();
    await waitFor(() => uplink.getStatus().state === "connected", "uplink connected");

    // --- pair ---------------------------------------------------------------------------
    const seed = randomSeedB64url();
    const identity = createDeviceIdentity(seed);
    const ticketInfo = remoteHost.createPairingTicket();
    const link = `mpi://pair?payload=${Buffer.from(JSON.stringify({ hostId: ticketInfo.hostId, fingerprint: ticketInfo.fingerprint, hostPublicKeyPem: ticketInfo.hostPublicKeyPem, relayUrl: url, ticket: ticketInfo.ticket, expiresAt: ticketInfo.expiresAt, protocol: 1 })).toString("base64url")}`;
    const payload = parsePairingLink(link);

    const client = new RelayClient({ url });
    clients.push(client);
    const resultPromise = runPairing(client, payload, identity, "test-pwa-thread");
    await waitFor(() => rendererEvents.some(([ch]) => ch === "remote:pairing-request"), "desktop pairing request");
    const pairingRequest = rendererEvents.find(([ch]) => ch === "remote:pairing-request")[1];
    assert.equal(remoteHost.approvePairing(pairingRequest.connectionId), true);
    const result = await resultPromise;
    client.setHelloCreds(identity.deviceId, result.deviceToken, payload.hostId);

    // --- S5.1: open thread — snapshot + buffered pre-snapshot events ----------------------
    const ts = new ThreadSession(client, THREAD_ID, { requestTimeoutMs: 3_000 });
    attachAutoReauth(client, payload.hostId, identity, "test-pwa-thread", () => {
      void ts.resync().catch(() => {}); // post-reauth recovery (the open-triggered one may race AUTH_REQUIRED)
    });
    await ts.open();

    let view = ts.getSnapshot();
    assert.equal(view.ready, true);
    assert.equal(view.summary?.title, "Test thread");
    // 2 history messages + the buffered live user message ("hi there").
    assert.deepEqual(
      view.messages.map((m) => m.role),
      ["user", "assistant", "user"],
      "pre-snapshot events were buffered and flushed after the snapshot (lossless)",
    );
    assert.equal(view.messages[2].blocks[0].text, "hi there");

    // Streaming turn completes: text accumulated, tool block ran to done, message finalized.
    await waitFor(() => {
      const v = ts.getSnapshot();
      return v.messages.length === 4 && !v.streaming && !v.running;
    }, "streaming turn finalizes");
    view = ts.getSnapshot();
    const liveAssistant = view.messages[3];
    assert.equal(liveAssistant.role, "assistant");
    assert.deepEqual(
      liveAssistant.blocks.map((b) => b.type),
      ["text", "tool", "tool", "tool", "tool"],
      "blocks in arrival order（四个工具调用各一个块）",
    );
    assert.equal(liveAssistant.blocks[0].text, "Hello!", "text deltas accumulated");
    // 幽灵块守卫：绝不能出现名字停在字面量 "tool"、还在转圈的占位块。
    const ghost = liveAssistant.blocks.find((b) => b.type === "tool" && b.running);
    assert.equal(ghost, undefined, `不允许有永远转圈的工具块（实际: ${JSON.stringify(ghost)}）`);
    assert.equal(
      liveAssistant.blocks.some((b) => b.type === "tool" && b.name === "tool"),
      false,
      "工具名不能停在占位值 \"tool\"（toolcall_start 要从 partial.content[contentIndex] 取真名）",
    );
    const [bashBlock, readBlock, globBlock] = liveAssistant.blocks.filter((b) => b.type === "tool");
    assert.equal(bashBlock.name, "bash");
    assert.equal(bashBlock.running, false, "tool block finalized by tool_execution_end");
    assert.ok((bashBlock.text || "").includes("file.txt"), "tool result captured");
    assert.equal(readBlock.name, "read", "占位 id 在 toolcall_end 拿到真 id 后被改名合并（不新建块）");
    assert.ok((readBlock.text || "").includes("hello"), "第二个工具的 result 落在同一个块上");
    assert.equal(globBlock.name, "glob", "没有 toolcall_end 时也要靠同名在跑的占位块认领到真 id");
    assert.equal(globBlock.running, false, "认领后能被 tool_execution_end 收口（否则永远转圈）");
    // ④ 回合被中断：write 只发了 start、永远等不到 tool_execution_end。
    //    它是 message_end 时被快照进 messages 的，所以必须由 agent_settled 收口——
    //    而 agent_settled 要同时管 streaming 与已落地消息（否则重开页面/重同步又转圈）。
    const writeBlock = liveAssistant.blocks.filter((b) => b.type === "tool")[3];
    assert.equal(writeBlock.name, "write");
    assert.equal(writeBlock.running, false, "回合结束（agent_settled）时必须收口还在跑的工具块");

    // --- snapshot carries task mode + mode catalog -----------------------------------
    assert.equal(view.taskMode, "iterate", "snapshot taskMode lands in the view");
    assert.deepEqual(
      view.availableModes.map((m) => m.id),
      ["iterate", "balanced"],
      "snapshot availableModes lands in the view",
    );

    // --- S9: config_changed event (desktop/agent-side change) syncs the chips --------
    await client.sendData(makeEnvelope("thread.poke-config", "test-session", {}));
    await waitFor(
      () => {
        const v = ts.getSnapshot();
        return v.summary?.permission === "full" && v.model?.id === "qwen3.6-27b" && v.taskMode === null;
      },
      "config_changed updates permission + model + taskMode live",
    );

    // --- seq gap → resync -----------------------------------------------------------------
    const beforeGap = resyncCount;
    gapArmed = true; // next poke emits seq+2 — the skipped event is never delivered
    await client.sendData(makeEnvelope("thread.poke", "test-session", {}));
    await waitFor(() => resyncCount > beforeGap, "gap detected → thread.resync requested");
    await waitFor(() => ts.getSnapshot().ready && ts.getSnapshot().messages.length === 2, "resync snapshot replaces state");

    // --- mid-stream drop: reconnect + reauth + **重新订阅** --------------------------------
    // 曾经的 bug（PWA 独有，原生端已修但未移植）：主机按 connectionId 记订阅，断线即清；
    // 客户端重连后只发 `thread.resync`——而它**只拉快照、不注册订阅**，于是之后所有实时
    // 事件都被主机静默丢弃（diag 指纹 `remote-pub … subs=0`，真机表现为「气泡卡发送中 /
    // 整条消息包括回复一起晚到）。所以重连后必须重新 `thread.subscribe`。
    const beforeDropSub = subscribeCount;
    client.simulateDrop();
    await waitFor(
      () => subscribeCount > beforeDropSub,
      "重连后重新注册订阅（thread.subscribe，而不是只发 thread.resync）",
      15_000,
    );
    await waitFor(() => ts.getSnapshot().ready, "重连后视图恢复");
    // 实时投递的硬证据：预设的实时回合（快照之后发的，即订阅已生效之后）必须到达。
    // 旧实现只 resync 的话这一步会超时——因为主机根本不会把事件发给它。
    await waitFor(
      () => ts.getSnapshot().messages.some((m) => m.role === "assistant" && m.blocks.some((b) => b.text === "Hello!")),
      "重连后实时事件恢复投递（证明订阅真的注册上了）",
      15_000,
    );
    view = ts.getSnapshot();
    const historyIds = view.messages.filter((m) => m.id === "m1" || m.id === "m2").map((m) => m.id);
    assert.deepEqual(historyIds, ["m1", "m2"], "重连后的快照历史不重复（无重连丢流尾巴的重复）");

    // --- S8.7 regression: idle thread — snapshot must notify without any events -------
    {
      const tsIdle = new ThreadSession(client, "t-idle", { requestTimeoutMs: 3_000 });
      let notifiedReady = false;
      const off = tsIdle.subscribe((v) => { if (v.ready) notifiedReady = true; });
      await tsIdle.open();
      assert.equal(notifiedReady, true, "idle snapshot notifies view listeners (no events needed)");
      assert.equal(tsIdle.getSnapshot().ready, true);
      off();
      tsIdle.detach();
    }

    // --- P1 Tier 1：本地缓存播种（切回来先出内容，不再白屏「加载会话…」） --------------
    // 先把主 session 摘掉：生产里同一会话不会有两个 ThreadSession 并存（openThread 切换时
    // 会 detach 上一个），而测试的假 host 用**全局 seq 计数器**，两个 session 同订一个会话
    // 会互相干扰、让本块变成抖动源。
    ts.detach();
    {
      const cache = new SnapshotCache(5);
      const seen = [];
      const tsCached = new ThreadSession(client, THREAD_ID, {
        requestTimeoutMs: 3_000,
        onSnapshot: (snapshot) => {
          seen.push(snapshot);
          cache.set(THREAD_ID, snapshot);
        },
      });

      // 种子快照里故意带一个「运行中」的工具块：它既能证明播种内容被渲染，又能用下面
      // 那个**不依赖竞态**的判据验证「播种后的会话仍处理实时事件」。
      const savedAt = Date.now() - 5 * 60_000;
      tsCached.applyCachedSnapshot(
        {
          ...makeSnapshot("idle"),
          messages: [
            { id: "m1", role: "user", text: "old question" },
            { id: "m2", role: "assistant", blocks: [{ type: "tool", id: "t-old", name: "bash", running: true }] },
          ],
        },
        savedAt,
      );

      let seeded = tsCached.getSnapshot();
      assert.equal(seeded.ready, true, "缓存播种后立即可渲染（不必等网络往返）");
      assert.equal(seeded.cachedAt, savedAt, "cachedAt 记录缓存时间（UI 靠它显示「本地缓存（x 分钟前）」）");
      assert.deepEqual(seeded.messages.map((m) => m.id), ["m1", "m2"], "缓存快照的历史被渲染出来");
      assert.equal(seeded.messages[1].blocks[0].running, true, "种子里的运行中工具块被渲染");
      assert.equal(seen.length, 0, "播种不触发 onSnapshot——否则会把缓存自己写回去并刷掉真实 savedAt");

      // 播种后的会话必须**仍然处理实时事件**，否则缓存视图会永远停在旧内容。
      // 判据用 agent_settled（回合收口应关掉运行中的工具块）——单个小帧、按需发送，
      // 不像「订阅响应 + 随后一串实时回合」那样受解密乱序影响（后者曾让本块 2/5 抖动）。
      await client.sendData(makeEnvelope("thread.poke", "test-session", {}));
      await waitFor(
        () => tsCached.getSnapshot().messages[1].blocks[0].running === false,
        "播种后的会话仍处理实时事件（agent_settled 收口了运行中的工具块）",
      );

      await tsCached.open();
      seeded = tsCached.getSnapshot();
      assert.equal(seeded.cachedAt, null, "实时快照到达后清掉缓存标记（内容已是最新）");
      assert.ok(seen.length >= 1, "实时快照触发 onSnapshot，缓存得以更新（下次切回来才有东西可铺）");
      assert.deepEqual(
        seeded.messages.filter((m) => m.id === "m1" || m.id === "m2").map((m) => m.id),
        ["m1", "m2"],
        "先播种再被实时快照替换，历史不重复",
      );
      tsCached.detach();
    }

    console.log("pwa-thread tests passed");
  } finally {
    for (const c of clients) c.close();
    uplink?.stop();
    remoteHost?.stop();
    if (relay && !relay.child.killed) relay.child.kill("SIGKILL");
    rmSync(userData, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
