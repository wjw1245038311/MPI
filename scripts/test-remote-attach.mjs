/**
 * 附件按需取字节（`attachment.fetch`）—— 主机侧分片读取 + 会话作用域校验 + 不进请求缓存。
 *
 * 背景：视频原片一旦不再内联进快照，远程客户端就得自己把字节拉回来（见
 * `src/main/remote/service.ts` 的 NON_CACHED_REQUEST_TYPES 与 `ipc.ts` 的
 * attachmentNameAllowed）。这条链路有三个容易写错的地方，这里逐个钉死：
 *
 *   1. **分片边界**：offset/eof/length 的算法错一位，症状是视频播到一半卡住或尾部丢字节，
 *      而日志上一切正常（所以要真读真比）。
 *   2. **作用域**：只能取「本会话引用过」的附件——否则任何配对设备拿名字就能遍历整个附件区。
 *   3. **不缓存**：分片响应几百 KB，而请求缓存能存 500 条；缓存它们会把内存吃掉几百 MB。
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./electron-stub-loader.mjs", import.meta.url));

// 沙盒：附件区必须隔离，否则会去读真实机器上的 userData。
const TEMP = join(tmpdir(), `mpi-remote-attach-${process.pid}`);
process.env.MPI_TEST_USER_DATA = TEMP;
process.env.MPI_TEST_TEMP = join(TEMP, "sys-temp");
mkdirSync(join(TEMP, "chat-attachments"), { recursive: true });
mkdirSync(process.env.MPI_TEST_TEMP, { recursive: true });

const { RemoteService } = await import("../src/main/remote/service.ts");
const { makeEnvelope } = await import("../mobile/shared/protocol.ts");
const { REMOTE_REQUEST_TYPES } = await import("../src/main/remote/protocol.ts");
const { ATTACHMENT_FETCH_CHUNK_BYTES, readAttachmentSlice } = await import("../src/main/chat-attachment-store.ts");
const { fillVideoPosters, LAZY_VIDEO_NOTE, MISSING_VIDEO_NOTE } = await import("../src/main/remote/video-poster.ts");
const { ThreadActions } = await import("../mobile/pwa/src/lib/thread-actions.ts");
const { fetchAttachmentBytes } = await import("../mobile/pwa/src/lib/attachment-fetch.ts");

const CHUNK = ATTACHMENT_FETCH_CHUNK_BYTES;
const T = "thread-attach";

// ---- 1. 协议白名单 ----------------------------------------------------------
assert.ok(
  REMOTE_REQUEST_TYPES.includes("attachment.fetch"),
  "attachment.fetch 必须在 REMOTE_REQUEST_TYPES 里（协议版本表 / 客户端能力判断都读它）",
);
console.log("ok 1 - attachment.fetch 已登记进协议请求白名单");

// ---- 2. 分片读取（真读真比） -------------------------------------------------
{
  // 三片：两片满 + 一片不满，覆盖“整片 / 末片 / 越界”三种情形。
  const SIZE = CHUNK * 2 + 100;
  const NAME = "3f9c1a55-1111-4222-8333-abcdefabcdef-clip.mp4";
  const source = Buffer.alloc(SIZE);
  for (let i = 0; i < SIZE; i++) source[i] = i % 251;
  writeFileSync(join(TEMP, "chat-attachments", NAME), source);

  const first = readAttachmentSlice(NAME, 0);
  assert.deepEqual(
    { offset: first.offset, length: first.data.length, eof: first.eof, size: first.size },
    { offset: 0, length: CHUNK, eof: false, size: SIZE },
    "第一片必须是整片且未到末尾",
  );
  assert.ok(first.data.equals(source.subarray(0, CHUNK)), "第一片字节必须与原文件一致（不是占位/截断数据）");

  const last = readAttachmentSlice(NAME, CHUNK * 2);
  assert.deepEqual(
    { offset: last.offset, length: last.data.length, eof: last.eof },
    { offset: CHUNK * 2, length: 100, eof: true },
    "末片必须是剩余字节且 eof=true（否则客户端会一直请求下去）",
  );
  assert.ok(last.data.equals(source.subarray(CHUNK * 2)), "末片字节必须与原文件一致");

  // 客户端就是这样循环的：offset += length，直到 eof。拼回来必须逐字节等于原文。
  const assembled = Buffer.concat([first.data, readAttachmentSlice(NAME, CHUNK).data, last.data]);
  assert.ok(assembled.equals(source), "按 offset+length 循环拼回的字节必须与原文件完全相同");

  // 上限夹紧：客户端就算要一片 10MB，也只会拿到 CHUNK（防止一片顶到 envelope 硬上限）。
  const clamped = readAttachmentSlice(NAME, 0, 10 * 1024 * 1024);
  assert.equal(clamped.data.length, CHUNK, "单片长度必须被夹到 ATTACHMENT_FETCH_CHUNK_BYTES");

  // 越界 / 负数 / 不存在 / 非法名字 → 一律 null（调用方按 NOT_FOUND 处理）。
  assert.equal(readAttachmentSlice(NAME, SIZE), null, "offset == size 越界");
  assert.equal(readAttachmentSlice(NAME, SIZE + 10), null, "offset 超过文件长度");
  assert.equal(readAttachmentSlice(NAME, -1), null, "负 offset");
  assert.equal(readAttachmentSlice("nope.mp4", 0), null, "文件不在附件区");
  assert.equal(readAttachmentSlice("../../secret.mp4", 0), null, "路径穿越名字");
  console.log("ok 2 - 分片读取：整片/末片/夹紧/越界/非法名字 + 循环拼回逐字节一致");
}

// ---- 3. RemoteService：校验 + 作用域 + 不缓存 --------------------------------
{
  const ALLOWED = "3f9c1a55-1111-4222-8333-abcdefabcdef-clip.mp4";
  const DENIED = "deadbeef-0000-1111-2222-333344445555-other.mp4";
  const SIZE = CHUNK + 7;
  writeFileSync(join(TEMP, "chat-attachments", ALLOWED), Buffer.alloc(SIZE, 3));
  writeFileSync(join(TEMP, "chat-attachments", DENIED), Buffer.alloc(64, 4));

  let fetches = 0;
  let threadGets = 0;
  const backend = {
    listProjects: async () => [],
    listThreads: async () => [],
    getThread: async () => {
      threadGets++;
      return { id: T };
    },
    createThread: async () => ({}),
    setPermission: async () => ({}),
    setModel: async () => ({}),
    setMode: async () => ({}),
    prompt: async () => ({}),
    steer: async () => ({}),
    followUp: async () => ({}),
    abort: async () => ({}),
    fileTree: async () => [],
    filePreview: async () => null,
    fetchAttachment: async (threadId, name, offset) => {
      fetches++;
      // 复刻 ipc.ts 的语义：作用域校验先于读盘，越权/不存在一律 NOT_FOUND。
      if (threadId !== T || name !== ALLOWED) {
        const { RemoteProtocolError } = await import("../src/main/remote/protocol.ts");
        throw new RemoteProtocolError("NOT_FOUND", "Attachment is not available for this thread");
      }
      const slice = readAttachmentSlice(name, offset, CHUNK);
      if (!slice) {
        const { RemoteProtocolError } = await import("../src/main/remote/protocol.ts");
        throw new RemoteProtocolError("NOT_FOUND", "Attachment is no longer available");
      }
      return {
        name,
        size: slice.size,
        offset: slice.offset,
        length: slice.data.length,
        eof: slice.eof,
        data: slice.data.toString("base64"),
      };
    },
    respondUi: async () => ({}),
    subscribeThread: () => () => {},
  };

  const svc = new RemoteService(backend, { leaseMs: 60_000 });
  let n = 0;
  const send = async (payload, { type = "attachment.fetch", threadId = T, requestId } = {}) => {
    let out;
    const env = {
      ...makeEnvelope(type, "sess-attach", payload, { requestId: requestId ?? `a-${++n}` }),
      ...(threadId ? { threadId } : {}),
    };
    await svc.handle(env, { connectionId: "conn-A", deviceId: "dev-1", send: (m) => (out = m) });
    return out;
  };

  // 正常：拉完整个文件（两片），逐字节等于原文件。
  let out = await send({ name: ALLOWED, offset: 0 });
  assert.equal(out.error, undefined, "合法请求不应报错");
  assert.equal(out.type, "attachment.fetch.result", "响应类型必须回带 .result 后缀（Requester 靠它配对）");
  const chunk1 = out.payload.chunk;
  assert.deepEqual(
    { offset: chunk1.offset, length: chunk1.length, eof: chunk1.eof, size: chunk1.size },
    { offset: 0, length: CHUNK, eof: false, size: SIZE },
  );
  const chunk2 = (await send({ name: ALLOWED, offset: chunk1.length })).payload.chunk;
  assert.equal(chunk2.eof, true, "末片必须 eof=true");
  assert.ok(
    Buffer.concat([Buffer.from(chunk1.data, "base64"), Buffer.from(chunk2.data, "base64")]).equals(Buffer.alloc(SIZE, 3)),
    "客户端按 offset+length 循环拼出的内容必须与原文件一致",
  );

  // 缺 threadId / offset 非法 / 缺 name → INVALID_REQUEST（这是协议层校验，不该打到 backend）。
  // 注意传 null 而不是 undefined：解构默认值对 undefined 生效。
  out = await send({ name: ALLOWED, offset: 0 }, { threadId: null });
  assert.equal(out?.error?.code, "INVALID_REQUEST", "缺 threadId 必须被拒（作用域校验以会话为界）");
  out = await send({ name: ALLOWED, offset: -1 });
  assert.equal(out?.error?.code, "INVALID_REQUEST", "负 offset 必须被拒");
  out = await send({ name: ALLOWED, offset: "abc" });
  assert.equal(out?.error?.code, "INVALID_REQUEST", "非数字 offset 必须被拒");
  out = await send({ offset: 0 });
  assert.equal(out?.error?.code, "INVALID_REQUEST", "缺 name 必须被拒");

  // 作用域：不属于该会话的附件 → NOT_FOUND（不能成为遍历附件区的入口）。
  out = await send({ name: DENIED, offset: 0 });
  assert.equal(out?.error?.code, "NOT_FOUND", "未在本会话引用过的附件必须拒绝");
  // 越界 offset 走到底层 → NOT_FOUND（不泄漏“文件存在但读不到”的差别）。
  out = await send({ name: ALLOWED, offset: SIZE + 1 });
  assert.equal(out?.error?.code, "NOT_FOUND", "越界读取按不存在处理");

  // 不缓存：同一个 requestId（= 客户端重试）必须**重新**读盘。
  // 对照：thread.get 同 requestId 只打一次 backend（去重缓存仍然生效）。
  const before = fetches;
  await send({ name: ALLOWED, offset: 0 }, { requestId: "retry-1" });
  await send({ name: ALLOWED, offset: 0 }, { requestId: "retry-1" });
  assert.equal(fetches - before, 2, "attachment.fetch 不能进请求缓存（分片几百 KB，500 条能吃掉几百 MB）");
  const getsBefore = threadGets;
  await send({}, { type: "thread.get", requestId: "dup-1" });
  await send({}, { type: "thread.get", requestId: "dup-1" });
  assert.equal(threadGets - getsBefore, 1, "其它请求类型的去重缓存不能被这次改动破坏");
  console.log("ok 3 - RemoteService：校验/作用域 NOT_FOUND/不缓存 + 其它类型缓存未受影响");
}

// ---- 4. PWA 客户端：分片循环拼装 + 请求接线 -----------------------------------
{
  const NAME = "3f9c1a55-1111-4222-8333-abcdefabcdef-clip.mp4";
  const SIZE = CHUNK + 1234;
  const source = Buffer.alloc(SIZE);
  for (let i = 0; i < SIZE; i++) source[i] = (i * 7) % 251;
  writeFileSync(join(TEMP, "chat-attachments", NAME), source);

  // 用真实的分片读取当服务端，只把“网络”换成 Promise —— 客户端拼装逻辑是真的跑了一遍。
  const progress = [];
  const bytes = await fetchAttachmentBytes(async (_name, offset) => {
    const slice = readAttachmentSlice(NAME, offset, CHUNK);
    return { name: NAME, size: slice.size, offset: slice.offset, length: slice.data.length, eof: slice.eof, data: slice.data.toString("base64") };
  }, NAME, { onProgress: (loaded, total) => progress.push([loaded, total]) });
  assert.ok(Buffer.from(bytes).equals(source), "PWA 拼回的字节必须与原文件逐字节一致");
  assert.deepEqual(progress.at(-1), [SIZE, SIZE], "最后一次进度必须是 已收=总大小（界面百分比才不会停在 99%）");
  assert.ok(progress.length >= 2 && progress[0][0] < SIZE, "分多片时应多次回调进度（首片还没收完）");

  // 取消：signal 已中止 → 不发起请求就抛错。
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(
    () => fetchAttachmentBytes(async () => { called = true; throw new Error("不应被调用"); }, NAME, { signal: controller.signal }),
    /已取消/,
  );
  assert.equal(called, false, "已取消的拉取不应发请求");

  // 护栏：主机若一直回「空片且不置 eof」，客户端必须停手而不是死循环。
  await assert.rejects(
    () => fetchAttachmentBytes(async () => ({ name: NAME, size: 100, offset: 0, length: 0, eof: false, data: "" }), NAME),
    /无进展/,
  );

  // ThreadActions 接线：attachment.fetch 只读（不先 claimWrite），payload 形状固定。
  const sent = [];
  let frameListener = null;
  const transport = {
    sendData(obj) {
      sent.push(obj);
      const slice = readAttachmentSlice(NAME, obj.payload.offset, CHUNK);
      const chunk = slice
        ? { name: NAME, size: slice.size, offset: slice.offset, length: slice.data.length, eof: slice.eof, data: slice.data.toString("base64") }
        : undefined;
      setTimeout(() => frameListener?.({ type: "attachment.fetch.result", requestId: obj.requestId, payload: { chunk } }), 0);
      return true;
    },
    onFrame(listener) { frameListener = listener; return () => (frameListener = null); },
    isOpen: () => true,
  };
  const actions = new ThreadActions(transport, T, { leaseMs: 30_000 });
  const viaActions = await actions.fetchAttachmentBytes(NAME);
  assert.ok(Buffer.from(viaActions).equals(source), "ThreadActions 拉回的字节必须一致");
  assert.equal(sent.length >= 2, true, "应至少发了两片（分片循环确实在推进 offset）");
  assert.ok(sent.every((frame) => frame.type === "attachment.fetch"), "拉字节不应顺带发 claimWrite（它不需要写租约）");
  assert.deepEqual(Object.keys(sent[0].payload).sort(), ["name", "offset"], "payload 只带 name/offset（分片边界由服务端决定）");
  console.log("ok 4 - PWA：分片循环拼装/进度/取消/防死循环 + ThreadActions 接线（只读、无 claimWrite）");
}

// ---- 5. 快照封面回填（不下发视频本体，只下发封面）------------------------
{
  const make = (video, size, poster) => {
    const state = { size: undefined, poster: undefined, mime: undefined, note: undefined };
    return {
      state,
      candidate: {
        videoPath: video,
        ...(poster ? { posterPath: poster } : {}),
        setSize: (value) => { state.size = value; },
        setPoster: (value, mime) => { state.poster = value; state.mime = mime; },
        setNote: (value) => { state.note = value; },
      },
    };
  };

  const sizes = { "a.mp4": 50_000_000, "b.mp4": 12_000, "a.mp4.poster.jpg": 40_000, "b.mp4.poster.png": 30_000 };
  const bases = { "a.mp4.poster.jpg": "P".repeat(40_000), "b.mp4.poster.png": "Q".repeat(30_000) };
  const options = {
    sizeOf: (path) => {
      if (!(path in sizes)) throw new Error("ENOENT");
      return sizes[path];
    },
    readBase64: (path) => bases[path],
    budget: 1_000_000,
  };

  // 大视频：不下发本体，但有封面 + size（卡片看得见画面，点开才拉字节）。
  const big = make("a.mp4", 50_000_000, "a.mp4.poster.jpg");
  fillVideoPosters([big.candidate], options);
  assert.equal(big.state.size, 50_000_000, "大视频必须带 size（卡片尺寸与拉取进度条都要它）");
  assert.equal(big.state.poster, bases["a.mp4.poster.jpg"], "没封面就没有任何画面可显示");
  assert.equal(big.state.mime, "image/jpeg", "封面 mime 由文件名扇出（客户端要用它构造 data URL）");
  assert.equal(big.state.note, LAZY_VIDEO_NOTE, "无论有没有封面，都要告诉客户端“点开按需获取”");

  // 没有封面的视频（发送端抽帧失败 / 旧消息）：size 照样要写，note 也不能缺。
  const noPoster = make("b.mp4", 12_000);
  fillVideoPosters([noPoster.candidate], options);
  assert.equal(noPoster.state.size, 12_000, "没封面也要带 size");
  assert.equal(noPoster.state.poster, undefined);
  assert.equal(noPoster.state.note, LAZY_VIDEO_NOTE);

  // 附件被清理：措辞要能区分于没封面（否则排查会一直往封面方向查）。
  const gone = make("missing.mp4", 0, undefined);
  const goneSizeOf = options.sizeOf;
  fillVideoPosters([gone.candidate], { ...options, sizeOf: (path) => { if (path === "missing.mp4") throw new Error("ENOENT"); return goneSizeOf(path); } });
  assert.equal(gone.state.note, MISSING_VIDEO_NOTE, "读不到视频要明说“已被清理”");
  assert.equal(gone.state.size, undefined);

  // 超预算：封面不填，但 size/note 仍在（降级成深色卡片，视频仍可点开拉）。
  const overBudget = make("a.mp4", 50_000_000, "a.mp4.poster.jpg");
  fillVideoPosters([overBudget.candidate], { ...options, budget: 10 });
  assert.equal(overBudget.state.poster, undefined, "超出预算的封面不下发");
  assert.equal(overBudget.state.size, 50_000_000, "被省略封面的视频同样要带 size");
  assert.equal(overBudget.state.note, LAZY_VIDEO_NOTE);

  // 封面文件异常（超出单张字节上限）：当作没封面，不能把坏字节写进块里。
  const fatPoster = make("a.mp4", 50_000_000, "a.mp4.poster.jpg");
  fillVideoPosters([fatPoster.candidate], { ...options, posterMaxBytes: 10 });
  assert.equal(fatPoster.state.poster, undefined, "超上限的封面一律不下发（防止一张胖图撑爆快照）");

  // 预算按**最新优先**：预算只够一张时，先满足列表末尾（最新）那个。
  const older = make("a.mp4", 1_000, "a.mp4.poster.jpg");
  const newer = make("b.mp4", 1_000, "b.mp4.poster.png");
  const orderSizes = { "a.mp4": 1_000, "b.mp4": 1_000, "a.mp4.poster.jpg": 40_000, "b.mp4.poster.png": 30_000 };
  fillVideoPosters([older.candidate, newer.candidate], {
    sizeOf: (path) => orderSizes[path],
    readBase64: (path) => bases[path],
    budget: 30_000,
  });
  assert.equal(newer.state.poster, bases["b.mp4.poster.png"], "预算不够时应优先保留**最新**视频的封面");
  assert.equal(older.state.poster, undefined, "更早的视频封面被省略（视频本体仍可点开拉）");
  assert.equal(older.state.size, 1_000, "被省略封面的视频同样要带 size");
  console.log("ok 5 - 快照封面回填：不下发本体/带 size/封面缺失可区分/超限丢弃/最新优先");
}

console.log("\nremote-attach: 全部通过");