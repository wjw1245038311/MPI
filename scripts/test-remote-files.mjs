/**
 * 手机端文件附件（T7）测试 —— 协议校验 + PWA 帧形状。
 *
 *   1. RemoteService 校验：files 张数/长度/名字/base64/体积上限
 *   2. 允许「只有文件、没有文字」（与只有图片同样合法）
 *   3. 校验通过的 files 原样到达 backend（落盘前的最后一道闸）
 *   4. PWA ThreadActions.send：files 进 thread.prompt/steer 帧，未选文件时不带 key
 */
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./electron-stub-loader.mjs", import.meta.url));

const { RemoteService } = await import("../src/main/remote/service.ts");
const { makeEnvelope } = await import("../mobile/shared/protocol.ts");
const { ThreadActions } = await import("../mobile/pwa/src/lib/thread-actions.ts");

const T = "thread-files";
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

// ---- 1-3. RemoteService 校验 + 透传 -----------------------------------------
{
  const calls = [];
  const backend = {
    listProjects: async () => [],
    listThreads: async () => [],
    getThread: async () => ({ id: T }),
    createThread: async () => ({}),
    setPermission: async () => ({}),
    setModel: async () => ({}),
    setMode: async () => ({}),
    prompt: async (id, text, images, files) => { calls.push(["prompt", id, text, images, files]); return {}; },
    steer: async (id, text, images, files) => { calls.push(["steer", id, text, images, files]); return {}; },
    followUp: async (id, text, images, files) => { calls.push(["followUp", id, text, images, files]); return {}; },
    abort: async () => ({}),
    fileTree: async () => [],
    filePreview: async () => null,
    respondUi: async () => ({}),
    subscribeThread: () => () => {},
  };
  const svc = new RemoteService(backend, { leaseMs: 60_000 });
  let n = 0;
  const send = async (payload, type = "thread.prompt") => {
    const env = { ...makeEnvelope(type, "sess-files", payload, { requestId: `f-${++n}` }), threadId: T };
    let out;
    await svc.handle(env, { connectionId: "conn-A", deviceId: "dev-1", send: (m) => (out = m) });
    return out;
  };

  // 写操作需要租约（与真实客户端一致）
  await send({}, "thread.claimWrite");

  // 只有文件、没有文字 → 合法
  calls.length = 0;
  let out = await send({ text: "", files: [{ name: "report.pdf", mimeType: "application/pdf", data: b64("PDF-BYTES") }] });
  assert.equal(out.error, undefined, "files-only 消息必须合法（与图片同理）");
  assert.equal(calls.length, 1);
  const [, , text, images, files] = calls[0];
  assert.equal(text, "", "文字可以为空");
  assert.equal(images, undefined, "没选图片时不传 images");
  assert.deepEqual(files, [{ name: "report.pdf", mimeType: "application/pdf", data: b64("PDF-BYTES") }]);

  // steer 同样带 files
  calls.length = 0;
  out = await send({ text: "看下这个", files: [{ name: "a.log", data: b64("line") }] }, "thread.steer");
  assert.equal(calls[0][0], "steer");
  assert.deepEqual(calls[0][4], [{ name: "a.log", data: b64("line") }], "mimeType 可省略");

  // 超过 3 个 → INVALID_REQUEST
  out = await send({ text: "x", files: Array.from({ length: 4 }, (_, i) => ({ name: `f${i}.txt`, data: b64("x") })) });
  assert.equal(out?.error?.code, "INVALID_REQUEST", "超过 3 个文件被拒");
  assert.match(out.error.message, /at most 3/);

  // 名字为空 / 过长
  out = await send({ text: "x", files: [{ name: "  ", data: b64("x") }] });
  assert.equal(out?.error?.code, "INVALID_REQUEST", "空名字被拒");
  out = await send({ text: "x", files: [{ name: "n".repeat(181), data: b64("x") }] });
  assert.equal(out?.error?.code, "INVALID_REQUEST", "超长名字被拒");

  // 非法 base64 / 空数据
  out = await send({ text: "x", files: [{ name: "a.bin", data: "not base64!!" }] });
  assert.equal(out?.error?.code, "PAYLOAD_TOO_LARGE", "非法 base64 被拒");
  out = await send({ text: "x", files: [{ name: "a.bin", data: "" }] });
  assert.equal(out?.error?.code, "PAYLOAD_TOO_LARGE", "空数据被拒");

  // 单文件超 8MB base64 → PAYLOAD_TOO_LARGE
  out = await send({ text: "x", files: [{ name: "big.bin", data: "A".repeat(8_000_001) }] });
  assert.equal(out?.error?.code, "PAYLOAD_TOO_LARGE", "单文件超过上限被拒");

  // 文字、图片、文件全空 → INVALID_REQUEST
  out = await send({ text: "   " });
  assert.equal(out?.error?.code, "INVALID_REQUEST", "全空消息被拒");

  console.log("ok 1-3 - remote files: 校验（张数/名字/base64/体积）+ files-only 合法 + 原样透传");
}

// ---- 4. PWA 帧形状 ----------------------------------------------------------
{
  const sent = [];
  let frameListener = null;
  const transport = {
    sendData(obj) {
      sent.push(obj);
      setTimeout(() => frameListener?.({ type: "x.result", requestId: obj.requestId, payload: { ok: true } }), 0);
      return true;
    },
    onFrame(listener) { frameListener = listener; return () => (frameListener = null); },
    isOpen: () => true,
  };
  const actions = new ThreadActions(transport, T, { leaseMs: 30_000 });

  sent.length = 0;
  const p = actions.send("带文件", "prompt", undefined, [{ name: "report.pdf", mimeType: "application/pdf", data: b64("x") }]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 2, "claimWrite + prompt");
  assert.equal(sent[1].type, "thread.prompt");
  assert.deepEqual(sent[1].payload, { text: "带文件", files: [{ name: "report.pdf", mimeType: "application/pdf", data: b64("x") }] });
  assert.ok(!("images" in sent[1].payload), "无图片时不带 images key");
  await p;

  // 只有文件（空文字）也允许
  sent.length = 0;
  const p2 = actions.send("  ", "prompt", undefined, [{ name: "a.bin", data: b64("y") }]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent[0].type, "thread.prompt");
  await p2;

  // 图片 + 文件同时带
  sent.length = 0;
  const p3 = actions.send("两个都带", "steer", [{ data: b64("img"), mimeType: "image/jpeg" }], [{ name: "a.txt", data: b64("t") }]);
  await new Promise((r) => setTimeout(r, 20));
  const payload = sent[0].payload;
  assert.equal(sent[0].type, "thread.steer");
  assert.ok(payload.images?.length === 1 && payload.files?.length === 1, "images 与 files 可同时存在");
  await p3;

  // 全空 → 本地即拒绝，不发帧
  sent.length = 0;
  await assert.rejects(async () => { actions.send("   ", "prompt"); }, /empty message/);
  assert.equal(sent.length, 0, "全空不发帧");

  console.log("ok 4 - PWA: files 进 prompt/steer 帧，可与 images 共存，空消息本地拒绝");
}

console.log("remote files tests passed");
