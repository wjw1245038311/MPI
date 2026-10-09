/**
 * 附件**中继分片上传**（2026-10-09）：走加密通道的分片上传，替代「必须有公网 HTTP 入口」的直连。
 *
 * 它与 HTTP 直连共用同一套能力令牌与落盘/校验逻辑，所以这里只钉死三件事：
 *   1. **授权**：只有 write 令牌能传；read 令牌、伪造令牌一律拒；
 *   2. **分片拼装 + 内容寻址**：收齐后主机自己算一遍 SHA-256 与客户端声明比对，不符拒收且不留成品；
 *   3. **收尾**：收齐才回调 `onUploadComplete`（会话快照据此认得这个附件）。
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./electron-stub-loader.mjs", import.meta.url));

// 沙盒：附件区必须隔离，否则会读写真实机器上的 userData。
const TEMP = join(tmpdir(), `mpi-attach-relay-${process.pid}-${randomUUID().slice(0, 8)}`);
rmSync(TEMP, { recursive: true, force: true });
process.env.MPI_TEST_USER_DATA = TEMP;
process.env.MPI_TEST_TEMP = join(TEMP, "sys-temp");
mkdirSync(join(TEMP, "chat-attachments"), { recursive: true });
mkdirSync(process.env.MPI_TEST_TEMP, { recursive: true });

const { AttachmentTokenStore } = await import("../src/main/remote/attachment-tokens.ts");
const { uploadAttachmentChunk } = await import("../src/main/remote/attachment-relay-upload.ts");
const store = await import("../src/main/chat-attachment-store.ts");

const tokens = new AttachmentTokenStore(60_000);
const completed = [];
const deps = {
  tokens,
  onUploadComplete: (info) => completed.push(info),
  log: () => {},
};
const CHUNK = 64 * 1024;

// ---- ① 内容寻址：多片 → 校验通过 → 落对象库 + 回调登记 ----
{
  const source = Buffer.alloc(3 * CHUNK + 1234, 9);
  source[source.length - 1] = 77;
  const sha = createHash("sha256").update(source).digest("hex");
  const token = tokens.mint({
    mode: "write",
    threadId: "t-1",
    deviceId: "dev-1",
    name: "upload.bin",
    size: source.length,
    sha256: sha,
    label: "照片.jpg",
    mimeType: "image/jpeg",
  });

  let offset = 0;
  let last = null;
  while (offset < source.length) {
    const chunk = source.subarray(offset, offset + CHUNK);
    last = await uploadAttachmentChunk(deps, {
      token: token.token,
      offset,
      dataBase64: chunk.toString("base64"),
      last: offset + chunk.length >= source.length,
    });
    offset += chunk.length;
  }
  assert.equal(last.done, true, "最后一片应报 done");
  assert.equal(last.received, source.length, "累计字节数应等于原文长度");
  assert.equal(last.size, source.length);
  assert.ok(last.name && last.name !== "upload.bin", "内容寻址时成品名应是 SHA-256 key");
  assert.ok(store.hasObject(last.name), "对象库应能按 key 取到成品");
  assert.equal(completed.length, 1, "收齐后应回调 onUploadComplete");
  assert.equal(completed[0].name, last.name);
  assert.equal(completed[0].threadId, "t-1");
  assert.equal(completed[0].deviceId, "dev-1");
}

// ---- ② 校验和不符 → 拒收，且不留成品 ----
{
  const source = Buffer.alloc(CHUNK, 3);
  const token = tokens.mint({
    mode: "write",
    threadId: "t-2",
    deviceId: "dev-2",
    name: "bad.bin",
    size: source.length,
    sha256: "0".repeat(64),
  });
  await assert.rejects(
    () => uploadAttachmentChunk(deps, { token: token.token, offset: 0, dataBase64: source.toString("base64"), last: true }),
    /checksum/,
    "声明哈希与实际不符必须拒",
  );
  assert.equal(completed.length, 1, "被拒的上传不该触发登记");
}

// ---- ③ 授权：read 令牌 / 伪造令牌都不能写 ----
{
  const readToken = tokens.mint({ mode: "read", threadId: "t-3", deviceId: "dev-3", name: "x.bin" });
  const payload = Buffer.from("hello").toString("base64");
  await assert.rejects(
    () => uploadAttachmentChunk(deps, { token: readToken.token, offset: 0, dataBase64: payload, last: true }),
    /invalid or expired/,
    "读令牌不能用于上传",
  );
  await assert.rejects(
    () => uploadAttachmentChunk(deps, { token: "not-a-real-token", offset: 0, dataBase64: payload, last: true }),
    /invalid or expired/,
    "伪造令牌必须拒",
  );
}

// ---- ④ 边界：越界 / 非法偏移 / 空片 ----
{
  const token = tokens.mint({ mode: "write", threadId: "t-4", deviceId: "dev-4", name: "size.bin", size: 10 });
  await assert.rejects(
    () => uploadAttachmentChunk(deps, { token: token.token, offset: 8, dataBase64: Buffer.alloc(5).toString("base64"), last: true }),
    /exceeds declared size/,
    "超出声明总长必须拒（否则能写出比声明更大的文件）",
  );
  await assert.rejects(
    () => uploadAttachmentChunk(deps, { token: token.token, offset: -1, dataBase64: "aGk=", last: false }),
    /offset/,
  );
  await assert.rejects(() => uploadAttachmentChunk(deps, { token: token.token, offset: 0, dataBase64: "", last: false }), /empty/);
}

rmSync(TEMP, { recursive: true, force: true });
console.log("attachment-relay-upload tests passed");
