/**
 * E2E 帧的**二进制**编码（2026-09-30）——去掉 base64 的 33% 膨胀。
 *
 * 现状（JSON 版）：数据帧是 `{"e":1,"n":"<base64url nonce>","c":"<base64url 密文+tag>"}`，
 * base64 让字节数涨 33%。实测：1MB 帧在 1MB/s 链路上多约 0.33s，5MB/s 上多约 70ms
 * ——网络好时感知不到，弱网/大帧时是实打实的成本。而 AES-GCM 本身只要 ~1ms/MB（可忽略），
 * 所以这里只改**编码**，不动密码学。
 *
 * 帧布局（WebSocket 二进制消息）：
 * ```
 *   [0]      版本 = 1
 *   [1]      头部长度 N（0..255）
 *   [2..2+N] 头部 JSON（UTF-8）：{"to":"device-x"}（设备→主机可省，{"from":…} 由中继补）
 *   [2+N..]  12B nonce ‖ 密文 ‖ 16B tag
 * ```
 *
 * **兼容**：两端的收发都同时认「JSON 版」与「二进制版」；发哪一种是**能力协商**决定的
 * （配对时各自在 pair.hello / pair.accepted 里报 `caps:["e2e-bin"]`）。老客户端继续走 JSON，
 * 行为与从前完全一致。
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const E2E_BINARY_VERSION = 1;
export const E2E_NONCE_BYTES = 12;
export const E2E_TAG_BYTES = 16;

/** 能力标记：在 pair.hello / pair.accepted 的 payload.caps 里出现即表示支持二进制帧。 */
export const E2E_BINARY_CAP = "e2e-bin";

export interface E2ERawFrame {
  nonce: Buffer;
  /** 密文 ‖ tag */
  body: Buffer;
}

/** 加密成原始字节（不做 base64）。 */
export function encryptFrameRaw(key: Buffer, plaintext: string): E2ERawFrame {
  const nonce = randomBytes(E2E_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { nonce, body };
}

/** 原始字节 → 明文；解不开一律抛（调用方按丢弃处理）。 */
export function decryptFrameRaw(key: Buffer, nonce: Buffer, body: Buffer): string {
  if (nonce.length !== E2E_NONCE_BYTES || body.length < E2E_TAG_BYTES) throw new Error("invalid e2e frame");
  const tag = body.subarray(body.length - E2E_TAG_BYTES);
  const ct = body.subarray(0, body.length - E2E_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** 把头部与帧拼成一条 WebSocket 二进制消息。 */
export function encodeBinaryFrame(header: Record<string, string>, frame: E2ERawFrame): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  if (headerBytes.length > 255) throw new Error("e2e frame header too large");
  return Buffer.concat([
    Buffer.from([E2E_BINARY_VERSION, headerBytes.length]),
    headerBytes,
    frame.nonce,
    frame.body,
  ]);
}

export interface DecodedBinaryFrame {
  header: Record<string, unknown>;
  frame: E2ERawFrame;
}

/** 解析一条二进制消息；不是我们的格式 → null（调用方忽略）。 */
export function decodeBinaryFrame(data: Buffer): DecodedBinaryFrame | null {
  if (data.length < 2 + E2E_NONCE_BYTES + E2E_TAG_BYTES) return null;
  if (data[0] !== E2E_BINARY_VERSION) return null;
  const headerLength = data[1];
  if (data.length < 2 + headerLength + E2E_NONCE_BYTES + E2E_TAG_BYTES) return null;
  let header: Record<string, unknown> = {};
  if (headerLength > 0) {
    try {
      header = JSON.parse(data.subarray(2, 2 + headerLength).toString("utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return {
    header,
    frame: {
      nonce: data.subarray(2 + headerLength, 2 + headerLength + E2E_NONCE_BYTES),
      body: data.subarray(2 + headerLength + E2E_NONCE_BYTES),
    },
  };
}

/** 远端是否声明支持二进制帧（能力协商）。 */
export function supportsBinaryFrames(caps: unknown): boolean {
  return Array.isArray(caps) && caps.some((cap) => String(cap) === E2E_BINARY_CAP);
}
