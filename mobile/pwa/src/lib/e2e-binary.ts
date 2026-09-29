/**
 * E2E 帧的**二进制**编码（2026-09-30）——去掉 base64 的 33% 膨胀。
 *
 * 与主机 `src/main/remote/e2e-binary.ts`、安卓 `protocol/E2eBinary.kt` 逐字节一致：
 * ```
 *   [0]      版本 = 1
 *   [1]      头部长度 N（0..255）
 *   [2..2+N] 头部 JSON（UTF-8）：路由元数据（中继要读）{"to":…} / {"from":…}
 *   [2+N..]  12B nonce ‖ 密文 ‖ 16B tag
 * ```
 * 只有两端在配对时都声明了 [E2E_BINARY_CAP] 才切二进制，否则继续走 JSON 版（老端不变）。
 * 纯编码改动，密码学一行没动。
 */
export const E2E_BINARY_VERSION = 1;
export const E2E_BINARY_CAP = "e2e-bin";

export interface BinaryE2EFrame {
  header: Record<string, unknown>;
  nonce: Uint8Array;
  body: Uint8Array;
}

/** 拼一条二进制帧。 */
export function encodeBinaryFrame(header: Record<string, unknown>, nonce: Uint8Array, body: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify(header));
  if (head.length > 255) throw new Error("E2E frame header too large");
  const out = new Uint8Array(2 + head.length + nonce.length + body.length);
  out[0] = E2E_BINARY_VERSION;
  out[1] = head.length;
  out.set(head, 2);
  out.set(nonce, 2 + head.length);
  out.set(body, 2 + head.length + nonce.length);
  return out;
}

/** 解析一条二进制帧；不是本格式 → null（调用方忽略）。 */
export function decodeBinaryFrame(bytes: Uint8Array): BinaryE2EFrame | null {
  if (bytes.length < 2 || bytes[0] !== E2E_BINARY_VERSION) return null;
  const headerLength = bytes[1];
  if (bytes.length < 2 + headerLength + 12 + 16) return null;
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(2, 2 + headerLength))) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!header || typeof header !== "object") return null;
  const nonceStart = 2 + headerLength;
  return {
    header,
    nonce: bytes.subarray(nonceStart, nonceStart + 12),
    body: bytes.subarray(nonceStart + 12),
  };
}

/** 远端是否声明支持二进制帧（能力协商）。 */
export function supportsBinaryFrames(caps: unknown): boolean {
  return Array.isArray(caps) && caps.some((cap) => String(cap) === E2E_BINARY_CAP);
}
