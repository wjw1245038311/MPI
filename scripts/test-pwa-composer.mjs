/**
 * Composer feature tests (2026-09-15): image attachments + voice input.
 *
 *   1. WAV encoding (voice-input.encodeWavPcm16) — canonical RIFF header,
 *      sizes, sample placement
 *   2. arrayBufferToBase64 — chunked btoa equivalent round-trip (multi-chunk)
 *   3. nextQuality (image-attach) — compression quality loop terminates and
 *      respects the raw-byte budget / floor
 *   4. ThreadActions.send with images + transcribe — frame shapes over a fake
 *      transport; transcribe must NOT take a write lease
 */
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./electron-stub-loader.mjs", import.meta.url));

const { encodeWavPcm16, arrayBufferToBase64, VOICE_SAMPLE_RATE } = await import("../mobile/pwa/src/lib/voice-input.ts");
const { nextQuality, MAX_RAW_BYTES } = await import("../mobile/pwa/src/lib/image-attach.ts");
const { ThreadActions } = await import("../mobile/pwa/src/lib/thread-actions.ts");

// ---- 1. WAV encoding --------------------------------------------------------
{
  const pcm = new Int16Array([0, 16384, -16384, 32767, -32768]);
  const wav = encodeWavPcm16(pcm, VOICE_SAMPLE_RATE);
  assert.equal(wav.byteLength, 44 + pcm.length * 2, "file size = header + data");

  const view = new DataView(wav);
  const str = (offset, len) => {
    let out = "";
    for (let i = 0; i < len; i++) out += String.fromCharCode(view.getUint8(offset + i));
    return out;
  };
  assert.equal(str(0, 4), "RIFF");
  assert.equal(view.getUint32(4, true), 36 + pcm.length * 2, "RIFF chunk size");
  assert.equal(str(8, 4), "WAVE");
  assert.equal(str(12, 4), "fmt ");
  assert.equal(view.getUint32(16, true), 16, "fmt chunk size");
  assert.equal(view.getUint16(20, true), 1, "PCM format");
  assert.equal(view.getUint16(22, true), 1, "mono");
  assert.equal(view.getUint32(24, true), VOICE_SAMPLE_RATE, "sample rate");
  assert.equal(view.getUint32(28, true), VOICE_SAMPLE_RATE * 2, "byte rate");
  assert.equal(view.getUint16(32, true), 2, "block align");
  assert.equal(view.getUint16(34, true), 16, "bits per sample");
  assert.equal(str(36, 4), "data");
  assert.equal(view.getUint32(40, true), pcm.length * 2, "data chunk size");
  for (let i = 0; i < pcm.length; i++) {
    assert.equal(view.getInt16(44 + i * 2, true), pcm[i], `sample ${i} placed verbatim`);
  }
  console.log("ok 1 - wav encoding: header fields + sample placement");
}

// ---- 2. base64 round-trip ----------------------------------------------------
{
  for (const size of [1, 32 * 1024 - 1, 32 * 1024, 100_000]) {
    const buf = new ArrayBuffer(size);
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < size; i++) bytes[i] = (i * 7 + 13) & 0xff;
    assert.equal(arrayBufferToBase64(buf), Buffer.from(bytes).toString("base64"), `round-trip at ${size} bytes`);
  }
  console.log("ok 2 - arrayBufferToBase64: chunked round-trip matches node base64");
}

// ---- 3. nextQuality loop ------------------------------------------------------
{
  assert.deepEqual(nextQuality(100_000, 0.8), { done: true, quality: 0.8 }, "under budget → done immediately");
  assert.deepEqual(nextQuality(MAX_RAW_BYTES, 0.8), { done: true, quality: 0.8 }, "exactly at budget → done");
  assert.deepEqual(nextQuality(300_000, 0.8), { done: false, quality: 0.7 }, "over budget → step down");
  assert.deepEqual(nextQuality(999_999, 0.5), { done: true, quality: 0.5 }, "floor at MIN_QUALITY even if still over");

  // Simulate the full loop with a size that shrinks as quality drops — must terminate.
  let quality = 0.8;
  const sizesAtQuality = new Map([[0.8, 350_000], [0.7, 320_000], [0.6, 290_000], [0.5, 250_000]]);
  let steps = 0;
  for (;;) {
    const step = nextQuality(sizesAtQuality.get(quality) ?? 100_000, quality);
    assert.ok(steps < 10, "loop must terminate");
    if (step.done) break;
    quality = step.quality;
    steps++;
  }
  assert.equal(quality, 0.5, "settles at the floor when size only drops below budget there");
  console.log("ok 3 - nextQuality: budget/floor semantics + loop termination");
}

// ---- 4. ThreadActions frames ---------------------------------------------------
{
  const sent = [];
  let frameListener = null;
  // Auto-ack every request on a macrotask so claimWrite settles before the
  // follow-up write frame goes out (mirrors host behavior).
  const transport = {
    sendData(obj) {
      sent.push(obj);
      setTimeout(() => frameListener?.({ type: "x.result", requestId: obj.requestId, payload: { ok: true } }), 0);
      return true;
    },
    onFrame(listener) {
      frameListener = listener;
      return () => (frameListener = null);
    },
    isOpen: () => true,
  };

  // Requester registers its own onFrame listener last → it wins the single slot.
  const actions = new ThreadActions(transport, "thread-1", { leaseMs: 30_000 });

  // send with images → thread.prompt carries text + images[]
  sent.length = 0;
  const p1 = actions.send("看图说话", "prompt", [{ data: "QUJD", mimeType: "image/jpeg" }]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 2, "claimWrite + prompt");
  assert.equal(sent[0].type, "thread.claimWrite");
  assert.equal(sent[1].type, "thread.prompt");
  // send() 会把本地压缩产物补成线上形状 {type:"image",…}（否则主机报 images[0].type must be image）
  assert.deepEqual(sent[1].payload, { text: "看图说话", images: [{ type: "image", data: "QUJD", mimeType: "image/jpeg" }] });
  await p1;

  // images-only message (empty text) is allowed
  sent.length = 0;
  const p2 = actions.send("   ", "prompt", [{ data: "REVG", mimeType: "image/jpeg" }]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent[0].type, "thread.prompt");
  assert.deepEqual(sent[0].payload, { text: "", images: [{ type: "image", data: "REVG", mimeType: "image/jpeg" }] });
  await p2;

  // no images → payload must NOT carry an images key (host treats undefined as none)
  sent.length = 0;
  const p3 = actions.send("纯文本", "steer");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent[0].type, "thread.steer");
  assert.ok(!("images" in sent[0].payload), "no images key when none attached");
  await p3;

  // empty text + no images → rejected before any frame is sent
  sent.length = 0;
  await assert.rejects(async () => {
    actions.send("  ", "prompt");
  }, /empty message/);
  assert.equal(sent.length, 0, "no frames for an empty send");

  // transcribe: single stt.transcribe frame, NO claimWrite (read-only path)
  sent.length = 0;
  const p4 = actions.transcribe("V0FWeA==", VOICE_SAMPLE_RATE);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 1, "transcribe must not take a write lease");
  assert.equal(sent[0].type, "stt.transcribe");
  assert.deepEqual(sent[0].payload, { audioB64: "V0FWeA==", sampleRate: VOICE_SAMPLE_RATE });
  const result = await p4;
  assert.deepEqual(result, { ok: true }); // auto-ack payload; frame shape asserted above

  console.log("ok 4 - thread-actions: images in prompt/steer frames + lease-free transcribe");
}

// ---- 5. ThreadActions.setModel (会话顶部配置栏) ----------------------------------
{
  const sent = [];
  let frameListener = null;
  const transport = {
    sendData(obj) {
      sent.push(obj);
      setTimeout(() => frameListener?.({ type: "x.result", requestId: obj.requestId, payload: { ok: true } }), 0);
      return true;
    },
    onFrame(listener) {
      frameListener = listener;
      return () => (frameListener = null);
    },
    isOpen: () => true,
  };
  const actions = new ThreadActions(transport, "thread-1", { leaseMs: 30_000 });

  // 写操作：必须先 claimWrite（否则 host 回 WRITE_CLAIM_REQUIRED）
  sent.length = 0;
  const p = actions.setModel("lmstudio", "qwen3.8-27b");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 2, "claimWrite + setModel");
  assert.equal(sent[0].type, "thread.claimWrite");
  assert.equal(sent[1].type, "thread.setModel");
  assert.deepEqual(sent[1].payload, { provider: "lmstudio", modelId: "qwen3.8-27b" });
  await p;

  // 已持有租约时不再重复 claim
  sent.length = 0;
  const p2 = actions.setModel("lmstudio", "qwen3.6-27b");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 1, "lease reuse: no second claimWrite");
  assert.equal(sent[0].type, "thread.setModel");
  assert.deepEqual(sent[0].payload, { provider: "lmstudio", modelId: "qwen3.6-27b" });
  await p2;

  // setMode：同样走写租约，modeId 为空串 = 清除模式
  sent.length = 0;
  const p3 = actions.setMode("iterate");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 1, "lease reuse: setMode 不再 claim");
  assert.equal(sent[0].type, "thread.setMode");
  assert.deepEqual(sent[0].payload, { modeId: "iterate" });
  await p3;

  sent.length = 0;
  const p4 = actions.setMode("");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent[0].payload, { modeId: "" }, "空 modeId = 清除模式（仍会发帧）");
  await p4;

  console.log("ok 5 - thread-actions: setModel/setMode 走写租约（含清除模式）");
}

// ---- 6. 新版本检测（WebView 不重载导致的旧页面问题） ---------------------------
{
  const { bundleNameFromUrl, parseBundleName } = await import("../mobile/pwa/src/lib/update-watch.ts");

  // 真实形态：中继根路径下的 hashed 产物
  assert.equal(bundleNameFromUrl("https://relay:9443/assets/index-IogLhVdz.js"), "index-IogLhVdz.js");
  assert.equal(bundleNameFromUrl("http://127.0.0.1:6173/src/main.tsx"), null, "vite dev 无 hashed 名 → null");
  assert.equal(bundleNameFromUrl("https://relay:9443/assets/other-abc.js"), null, "非 index-* 产物不误判");

  const served = '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-2LMAQt9S.js"></script></head></html>';
  assert.equal(parseBundleName(served), "index-2LMAQt9S.js");
  assert.equal(parseBundleName("<html>no bundle</html>"), null);

  // 判定语义：当前名 ≠ 服务端名 → 需要刷新（用例直接对应 2026-09-15 的现场：
  // 运行 index-DUb0pTa0、服务端已是 index-2LMAQt9S）
  assert.equal(
    bundleNameFromUrl("https://relay/assets/index-DUb0pTa0.js") !== parseBundleName(served),
    true,
    "旧 bundle 运行中 → 提示刷新",
  );
  assert.equal(
    bundleNameFromUrl("https://relay/assets/index-2LMAQt9S.js") !== parseBundleName(served),
    false,
    "已是最新 → 不提示",
  );

  console.log("ok 6 - update-watch: bundle 名解析 + 新旧判定");
}

// ---- 7. markdown-lite：代码围栏分段（含流式未闭合） -------------------------
{
  const { parseSegments, languageLabel } = await import("../mobile/pwa/src/lib/markdown-lite.ts");
  const NL = String.fromCharCode(10); // 避免测试源码里出现转义序列
  const join = (lines) => lines.join(NL);

  // 没有围栏 → 原样一段，不做加工
  const plain = parseSegments(join(["就是一段普通文本", "第二行"]));
  assert.equal(plain.length, 1);
  assert.equal(plain[0].type, "text");
  assert.equal(plain[0].text, join(["就是一段普通文本", "第二行"]));

  // 文本 + 代码 + 文本
  const mixed = parseSegments(
    join(["说明：", "```python", "import akshare as ak", "df = ak.x()", "```", "用的是东财 API。"]),
  );
  assert.deepEqual(mixed.map((x) => x.type), ["text", "code", "text"]);
  assert.equal(mixed[1].lang, "python");
  assert.equal(mixed[1].closed, true);
  assert.ok(mixed[1].text.includes("akshare"), "代码内容完整保留");
  assert.ok(mixed[2].text.includes("东财"), "围栏后的说明仍是文本");

  // 流式未闭合：后半段继续当代码，closed=false（闭合后重排不会闪回正文）
  const streaming = parseSegments(join(["```js", "const x = 1;", "const y = 2;"]));
  assert.equal(streaming.length, 1);
  assert.equal(streaming[0].type, "code");
  assert.equal(streaming[0].closed, false);
  assert.equal(streaming[0].lang, "js");

  // 无语言标记的围栏
  const noLang = parseSegments(join(["```", "plain", "```"]));
  assert.equal(noLang[0].type, "code");
  assert.equal(noLang[0].lang, "");

  // 语言标签映射（Qoder 风格展示名）
  assert.equal(languageLabel("py"), "Python");
  assert.equal(languageLabel("bash"), "Shell");
  assert.equal(languageLabel("yml"), "YAML");
  assert.equal(languageLabel(""), "代码");
  assert.equal(languageLabel("brainfuck"), "Brainfuck", "未知语言首字母大写");
  assert.equal(languageLabel("toml"), "TOML", "已知别名走映射");

  console.log("ok 7 - markdown-lite: 围栏分段/未闭合流式/语言标签映射");
}

// ---- 8. tool-groups：同类工具合并 + 无信息行丢弃 --------------------------
{
  const { groupToolBlocks, hasToolInfo, TOOL_GROUP_MIN } = await import("../mobile/pwa/src/lib/tool-groups.ts");
  const tool = (name, args, result, extra = {}) => ({ type: "tool", name, argsText: args, text: result, ...extra });

  // 连续 12 个 bash（都有 command）→ 合并成一组
  const many = Array.from({ length: 12 }, (_, i) => tool("bash", `echo ${i}`, `out ${i}`));
  const grouped = groupToolBlocks(many);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].kind, "toolGroup");
  assert.equal(grouped[0].group.name, "bash");
  assert.equal(grouped[0].group.blocks.length, 12);

  // 少于阈值不合并
  assert.equal(groupToolBlocks(many.slice(0, TOOL_GROUP_MIN - 1)).length, TOOL_GROUP_MIN - 1);
  assert.equal(groupToolBlocks(many.slice(0, TOOL_GROUP_MIN))[0].kind, "toolGroup");

  // 不同名交替 → 不合并（保持独立）
  const mixed = [tool("bash", "a", "1"), tool("edit", "b", "2"), tool("bash", "c", "3")];
  assert.equal(groupToolBlocks(mixed).every((i) => i.kind === "block"), true, "同名但不连续不合并");

  // 运行中的工具不参与合并（spinner 必须可见）
  const running = [tool("bash", "a", undefined, { running: true }), tool("bash", "b", "x"), tool("bash", "c", "y")];
  assert.equal(groupToolBlocks(running)[0].kind, "block");

  // 无信息行被丢弃（旧主机不传 args / 无结果）
  const empty = [tool("bash", undefined, undefined), tool("bash", undefined, undefined), tool("bash", undefined, undefined)];
  assert.equal(groupToolBlocks(empty).length, 0, "没有参数也没有结果的工具行直接不渲染");
  assert.equal(hasToolInfo(tool("bash", undefined, undefined)), false);
  assert.equal(hasToolInfo(tool("bash", "", "   ")), false, "空白不算信息");
  // 但运行中/出错的空行要保留（状态信号）
  assert.equal(groupToolBlocks([tool("bash", undefined, undefined, { running: true })]).length, 1);
  assert.equal(groupToolBlocks([tool("bash", undefined, undefined, { isError: true })]).length, 1);

  // 文本块不受影响，顺序保持
  const withText = [{ type: "text", text: "hi" }, ...many, { type: "text", text: "bye" }];
  const items = groupToolBlocks(withText);
  assert.deepEqual(items.map((i) => i.kind), ["block", "toolGroup", "block"]);

  console.log("ok 8 - tool-groups: 同类合并 / 运行中不合并 / 无信息行丢弃");
}

console.log("pwa composer tests passed");
