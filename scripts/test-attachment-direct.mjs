/**
 * 附件**直连服务**（P1）：能力令牌 + 分片上传 + Range 下载。
 *
 * 这条链路把「字节搬运」从协议通道里摘出来（原来上行是整帧 base64 内联在 JSON envelope 里，
 * 被 8MB 内层上限卡到 ~6MB；下行只能走中继分片，拉完才能播）。它同时是**新增的对外监听面**，
 * 所以这里要真起一个 HTTP 服务、真发请求，把三件事钉死：
 *
 *   1. **授权**：令牌是唯一凭证——无效/过期/方向不对一律拒，且不同方向不能互相冒用；
 *   2. **分片拼装**：`PUT` + Content-Range 的偏移语义、收齐判定、原子改名（不能出现半截成品）；
 *   3. **Range**：下行必须支持 206（播放器靠它 seek），且字节要对得上。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./electron-stub-loader.mjs", import.meta.url));

// 沙盒：附件区必须隔离，否则会读写真实机器上的 userData。
const TEMP = join(tmpdir(), `mpi-attach-direct-${process.pid}`);
process.env.MPI_TEST_USER_DATA = TEMP;
process.env.MPI_TEST_TEMP = join(TEMP, "sys-temp");
mkdirSync(join(TEMP, "chat-attachments"), { recursive: true });
mkdirSync(process.env.MPI_TEST_TEMP, { recursive: true });

const { AttachmentTokenStore, parseUploadOffset } = await import("../src/main/remote/attachment-tokens.ts");
const { createAttachmentServer } = await import("../src/main/remote/attachment-server.ts");
const store = await import("../src/main/chat-attachment-store.ts");
const { uploadVideoDirect, requestDirectPlaybackUrl, DIRECT_UPLOAD_CHUNK_BYTES } = await import(
  "../mobile/pwa/src/lib/attachment-direct.ts"
);

// ---- 1. 令牌与偏移解析（纯逻辑）---------------------------------------------
{
  let now = 1_000_000;
  const tokens = new AttachmentTokenStore(1_000, () => now);
  const token = tokens.mint({ mode: "write", threadId: "t-1", deviceId: "dev-1", name: "a.mp4", size: 100 });
  assert.ok(token.token.length >= 20, "令牌必须足够长（URL 不可猜就是能力 URL 的全部安全性）");
  assert.equal(tokens.get(token.token)?.name, "a.mp4", "签发的令牌能取回来");
  now += 1_001;
  assert.equal(tokens.get(token.token), null, "过期令牌必须失效（主机重启/超时后 URL 不该还能用）");

  const fresh = tokens.mint({ mode: "read", threadId: "t-1", deviceId: "dev-1", name: "b.mp4" });
  tokens.revoke(fresh.token);
  assert.equal(tokens.get(fresh.token), null, "撤销后立即失效（取消上传时用）");

  // Content-Range / 简化头
  assert.deepEqual(parseUploadOffset("bytes 0-1023/2048", null), { offset: 0, total: 2048 });
  assert.deepEqual(parseUploadOffset(null, "1024"), { offset: 1024, total: null });
  assert.deepEqual(parseUploadOffset("bytes 1024-2047/*", null), { offset: 1024, total: null });
  assert.equal(parseUploadOffset("bytes 2047-1024/2048", null), null, "end < start 必须拒（不能猜偏移写坏文件）");
  assert.equal(parseUploadOffset("bytes 0-2048/2048", null), null, "end >= total 必须拒");
  assert.equal(parseUploadOffset(null, null), null, "两个头都缺 → 无法定位");
  assert.equal(parseUploadOffset(null, "abc"), null, "非数字偏移必须拒");
  console.log("ok 1 - 令牌：签发/取回/过期/撤销 + 分片偏移解析（含非法输入）");
}

// ---- 2. 真起一个服务，真发请求 ------------------------------------------------
const logs = [];
const tokens = new AttachmentTokenStore();
const completed = [];
const server = createAttachmentServer({
  tokens,
  host: "127.0.0.1",
  port: 0,
  log: (line) => logs.push(line),
  onUploadComplete: (info) => completed.push(info),
});
await new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

try {
  // ---- 2.1 分片上传（两片，第二片收齐后原子改名）----
  const SOURCE = Buffer.alloc(6_000, 7);
  SOURCE[5_999] = 42;
  const writeToken = tokens.mint({ mode: "write", threadId: "t-1", deviceId: "dev-1", name: store.reserveVideoName("clip.mp4", "video/mp4"), size: SOURCE.length });
  const putUrl = `${base}/att/${writeToken.token}`;
  const CHUNK = 4_096;

  const first = await fetch(putUrl, {
    method: "PUT",
    headers: { "Content-Range": `bytes 0-${CHUNK - 1}/${SOURCE.length}` },
    body: SOURCE.subarray(0, CHUNK),
  });
  assert.equal(first.status, 200, "第一片应被接受");
  const firstBody = await first.json();
  assert.equal(firstBody.done, false, "两片只传了一片 → 不能算完成");
  assert.equal(firstBody.received, CHUNK, "主机要回报已收字节（客户端据此显示进度）");
  assert.ok(
    !existsSync(join(TEMP, "chat-attachments", writeToken.name)),
    "分片期间**不能**出现正式文件（半截文件被当成成品是最糟的失败模式）",
  );

  const second = await fetch(putUrl, {
    method: "PUT",
    headers: { "Content-Range": `bytes ${CHUNK}-${SOURCE.length - 1}/${SOURCE.length}` },
    body: SOURCE.subarray(CHUNK),
  });
  const secondBody = await second.json();
  assert.equal(secondBody.done, true, "末片到达后 done=true");
  const finalPath = join(TEMP, "chat-attachments", writeToken.name);
  assert.ok(existsSync(finalPath), "收齐后必须出现正式文件");
  assert.ok(readFileSync(finalPath).equals(SOURCE), "落盘字节必须与上传的逐字节一致");
  assert.equal(statSync(finalPath).size, SOURCE.length);
  assert.equal(completed.length, 1, "完成时要回调一次（ipc.ts 靠它登记作用域允许表）");
  assert.equal(completed[0].name, writeToken.name);
  assert.equal(completed[0].threadId, "t-1");

  // 超出声明长度的分片必须被拒（否则客户端能悄悄写大文件）
  const overflow = await fetch(putUrl, {
    method: "PUT",
    headers: { "Content-Range": `bytes 0-${SOURCE.length}/${SOURCE.length}` },
    body: Buffer.alloc(SOURCE.length + 1, 1),
  });
  assert.equal(overflow.status, 400, "超过声明长度的分片必须被拒");

  // ---- 2.2 封面（POST，数据收齐后单独送）----
  const poster = await fetch(putUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ poster: Buffer.alloc(500, 3).toString("base64"), posterMimeType: "image/jpeg" }),
  });
  const posterBody = await poster.json();
  assert.ok(posterBody.posterName, "封面应落盘并回报文件名");
  assert.equal(posterBody.posterName, store.findVideoPoster(writeToken.name), "封面名必须能被 findVideoPoster 找到（快照回填靠它）");

  // ---- 2.3 下行 Range（播放器 seek 靠它）----
  const readToken = tokens.mint({ mode: "read", threadId: "t-1", deviceId: "dev-1", name: writeToken.name });
  const readUrl = `${base}/att/${readToken.token}`;

  const full = await fetch(readUrl);
  assert.equal(full.status, 200, "整段下载应 200");
  assert.equal(full.headers.get("accept-ranges"), "bytes", "必须声明支持 Range（否则播放器不会去 seek）");
  assert.equal(full.headers.get("access-control-allow-origin"), "*", "PWA 与静态站不同源，缺 CORS 网页端永远拉不到");
  assert.ok(Buffer.from(await full.arrayBuffer()).equals(SOURCE), "整段字节要一致");

  const ranged = await fetch(readUrl, { headers: { Range: "bytes=100-199" } });
  assert.equal(ranged.status, 206, "带 Range 必须回 206");
  assert.equal(ranged.headers.get("content-range"), `bytes 100-199/${SOURCE.length}`, "Content-Range 要准确");
  assert.equal((await ranged.arrayBuffer()).byteLength, 100, "只回请求的那一段");
  assert.ok(Buffer.from(await (await fetch(readUrl, { headers: { Range: "bytes=5999-" } })).arrayBuffer()).equals(SOURCE.subarray(5_999)));

  const head = await fetch(readUrl, { method: "HEAD" });
  assert.equal(head.status, 200, "HEAD 也要能回（播放器/预检会先探一次）");

  // ---- 2.4 授权：无效/过期/方向错误 ----
  const bad = await fetch(`${base}/att/not-a-real-token`);
  assert.equal(bad.status, 403, "无效令牌一律 403");
  const wrongDirection = await fetch(readUrl, {
    method: "PUT",
    headers: { "Content-Range": "bytes 0-9/*" },
    body: Buffer.alloc(10, 1),
  });
  assert.equal(wrongDirection.status, 403, "读令牌不能用来写（否则任何拿到 URL 的人都能改字节）");
  const readOnWrite = await fetch(putUrl);
  assert.equal(readOnWrite.status, 403, "写令牌不能用来读");
  const noRange = await fetch(`${base}/att/${tokens.mint({ mode: "write", threadId: "t", deviceId: "d", name: "x.mp4" }).token}`, {
    method: "PUT",
    body: Buffer.alloc(10, 1),
  });
  assert.equal(noRange.status, 400, "缺 Content-Range/X-MPI-Offset 一律 400（不猜偏移）");

  const options = await fetch(readUrl, { method: "OPTIONS" });
  assert.equal(options.status, 204, "预检要回 204");
  assert.match(options.headers.get("access-control-allow-headers") || "", /Content-Range/i, "预检要放行 Content-Range");

  // 附件不存在（被清理）→ 404 而不是 500
  const missing = await fetch(`${base}/att/${tokens.mint({ mode: "read", threadId: "t", deviceId: "d", name: "gone.mp4" }).token}`);
  assert.equal(missing.status, 404, "文件已被清理 → 404（客户端据此退化成占位卡片）");
  console.log("ok 2 - HTTP 服务：分片上传/原子改名/封面/Range(206)/CORS/授权/404 全覆盖");

  // ---- 2.5 PWA 客户端：分片上传 + 回落信号 ------------------------------------
  // 用**真服务**当后端，只把“动作层”换成一个能签发令牌的替身（形状同 ThreadActions）。
  const actions = {
    async requestAttachmentUrl(input) {
      const token = tokens.mint({
        mode: input.mode,
        threadId: "t-1",
        deviceId: "dev-1",
        name: input.name || store.reserveVideoName(input.originalName, input.mimeType),
        size: input.size,
        mimeType: input.mimeType,
      });
      return { url: `${base}/att/${token.token}`, token: token.token, name: token.name, expiresAt: token.expiresAt };
    },
  };

  // 跨分片上传（故意大于一个分片）→ 服务端拼出来的字节必须逐字节一致。
  const big = Buffer.alloc(DIRECT_UPLOAD_CHUNK_BYTES + 1_234);
  for (let i = 0; i < big.length; i += 997) big[i] = i % 251;
  const progress = [];
  const uploaded = await uploadVideoDirect(
    actions,
    { file: { name: "clip.mp4" }, bytes: new Uint8Array(big), mimeType: "video/mp4", poster: { data: Buffer.alloc(300, 1).toString("base64"), mimeType: "image/jpeg" } },
    (loaded, total) => progress.push([loaded, total]),
  );
  assert.ok(uploaded?.storedName, "直连上传应返回主机预分配的附件名（消息里只带它）");
  assert.equal(uploaded.posterStored, true, "封面应随上传送达（POST 分支）");
  assert.ok(
    readFileSync(join(TEMP, "chat-attachments", uploaded.storedName)).equals(big),
    "两个分片拼出来的字节必须与上传的逐字节一致",
  );
  assert.equal(progress.at(-1)[0], big.length, "最后一次进度必须是“已传=总大小”");
  assert.ok(progress.length >= 2, "跨分片时必须多次回报进度（否则进度条会从 0 直接跳满）");

  // 回落信号：动作层报错（DIRECT_UNAVAILABLE / 网络问题）→ 返回 null，由调用方走内联。
  const refusing = { requestAttachmentUrl: async () => { throw new Error("DIRECT_UNAVAILABLE: nope"); } };
  const fallback = await uploadVideoDirect(refusing, { file: { name: "x.mp4" }, bytes: new Uint8Array([1, 2, 3]), mimeType: "video/mp4", poster: null }, () => {});
  assert.equal(fallback, null, "直连不可用必须返回 null（调用方据此回落，而不是把错误抛给用户）");

  // 读 URL：拿到就能直接喂 <video>（真流式）；不可用时返回 null。
  const directReadUrl = await requestDirectPlaybackUrl(actions, uploaded.storedName, "video/mp4");
  assert.ok(directReadUrl?.startsWith(base), "读 URL 应指向同一直连基地址");
  const rangedDirect = await fetch(directReadUrl, { headers: { Range: "bytes=10-19" } });
  assert.equal(rangedDirect.status, 206, "直连播放走的就是 Range（可 seek）");
  assert.equal(await requestDirectPlaybackUrl(refusing, "x.mp4", "video/mp4"), null, "读 URL 拿不到也必须是 null");
  console.log("ok 3 - PWA：跨分片上传/进度/封面/回落信号 + 直连读 URL（Range）");
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log("\nattachment-direct: 全部通过");
