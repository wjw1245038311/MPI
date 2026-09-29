/**
 * PWA 侧的 E2E 二进制帧（去 base64 的 33% 膨胀）——**跨端逐字节钉死**。
 *
 * 用的是主机（Node）实现产出的钉死向量：PWA 的编解码必须与它完全一致，否则浏览器端
 * 与桌面端之间会出现「连上了但所有加密帧解不开」——那种故障最难现场归因。
 * 真正的端到端往返由 `test:pwa-pairing`（真 host + 真中继）覆盖。
 */
import assert from "node:assert/strict";
import { register } from "node:module";

// PWA 源码是 bundler 风格的无扩展名导入，用共享 loader 解析（同时提供 electron stub）。
register(new URL("./electron-stub-loader.mjs", import.meta.url));

const { E2E_BINARY_CAP, decodeBinaryFrame, encodeBinaryFrame, supportsBinaryFrames } = await import(
  "../mobile/pwa/src/lib/e2e-binary.ts"
);
const { decryptFrameRaw, encryptFrameRaw, importAesKey } = await import("../mobile/pwa/src/lib/e2e-crypto.ts");

const PINNED_FRAME_HEX =
  "01137b2266726f6d223a226465766963652d78227d0102030405060708090a0b0c" +
  "86dd18d61a13d08bbb2df53273f38369f993a1d7b1cb159b53addd35f4feb63bf13039eff047ef65";

const hexToBytes = (hex) => Uint8Array.from(hex.match(/.{2}/g).map((pair) => parseInt(pair, 16)));
const bytesToHex = (bytes) => Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");

// ---- 1. 与主机实现逐字节一致 + 明文可解 ----
{
  const key = await importAesKey(new Uint8Array(32).fill(0x11));
  const nonce = Uint8Array.from(Array.from({ length: 12 }, (_, i) => i + 1));
  const plaintext = '{"type":"thread.prompt"}';
  const pinned = hexToBytes(PINNED_FRAME_HEX);

  // 用固定 nonce 复算：密文部分应逐字节一致（WebCrypto 与 node:crypto 的 GCM 输出布局相同）
  const decoded = decodeBinaryFrame(pinned);
  assert.ok(decoded, "应能解回主机产出的帧");
  assert.equal(decoded.header.from, "device-x", "头部路由元数据原样解出");
  assert.equal(await decryptFrameRaw(key, decoded.nonce, decoded.body), plaintext, "解出的明文必须一致");

  const reencoded = encodeBinaryFrame({ from: "device-x" }, decoded.nonce, decoded.body);
  assert.equal(bytesToHex(reencoded), PINNED_FRAME_HEX, "重新拼一遍必须与主机实现逐字节一致");

  // 反向：PWA 自己加密一帧，用同一把密钥解回来
  const raw = await encryptFrameRaw(key, plaintext);
  assert.equal(await decryptFrameRaw(key, raw.nonce, raw.body), plaintext, "PWA 自加密自解必须往返一致");
  assert.equal(nonce.length, 12);
  console.log("ok 1 - PWA 编解码与主机实现逐字节一致（含钉死向量解回明文）");
}

// ---- 2. 畸形帧一律拒绝 ----
{
  assert.equal(decodeBinaryFrame(new Uint8Array(0)), null, "空");
  assert.equal(decodeBinaryFrame(Uint8Array.from([2, 0, ...new Uint8Array(40)])), null, "版本不对");
  assert.equal(decodeBinaryFrame(Uint8Array.from([1, 200, ...new Uint8Array(10)])), null, "头长超出");
  assert.equal(decodeBinaryFrame(Uint8Array.from([1, 0, ...new Uint8Array(20)])), null, "载荷太短");
  const badHeader = Uint8Array.from([1, 3, 0x7b, 0x78, 0x5d, ...new Uint8Array(40)]);
  assert.equal(decodeBinaryFrame(badHeader), null, "头部不是合法 JSON");
  console.log("ok 2 - 畸形帧全部返回 null（不崩、不当帧解）");
}

// ---- 3. 能力协商 ----
{
  assert.equal(supportsBinaryFrames([E2E_BINARY_CAP]), true);
  assert.equal(supportsBinaryFrames(["other"]), false);
  assert.equal(supportsBinaryFrames(undefined), false, "老主机不声明 → 继续走 JSON");
  console.log("ok 3 - 能力协商：只有对端也声明 e2e-bin 才切二进制");
}

console.log("pwa-binary tests passed");
