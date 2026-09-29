/**
 * 附件分片的**应用层加密**（v1）—— 为「手机不装 Tailscale」准备的传输方案。
 *
 * 背景（2026-09-29 抓包定案）：国内链路上的 DPI 会**按 TLS 握手指纹**给连接注入 RST
 * （安卓 OkHttp 517B hello、Windows schannel 188B hello 被掐；Chrome / OpenSSL 的 ~1.5KB hello
 * 放行），换端口（10443 / 443）都一样。所以这条路只能走**明文 HTTP**，把安全性交给应用层：
 *
 *   密钥 = HKDF-SHA256(
 *            ikm  = 已有的 E2E 会话密钥（配对时 X25519 协商出来的，**从不经过网络**）
 *            salt = 附件令牌 token（随 URL 明文传输 → 只当标识/命名空间，不承担保密职责）
 *            info = "mpi-attachment-v1|<up|down>|<附件名>"
 *          ) → 32B AES-256-GCM 密钥
 *
 *   帧   = nonce(12B) || ciphertext || tag(16B)
 *   AAD  = "v1|<up|down>|<附件名>|<offset>|<明文长度>"
 *
 * 为什么 AAD 要带方向与分片位置：把「这是第几片、往哪个方向」绑进认证，中间人无法把分片
 * 重排、丢弃后伪装成完整文件，也无法把上行密文回放成下行——改了任一字段就解不开（GCM tag 校验失败）。
 *
 * 为什么 key 用会话密钥而不是 token：明文传输下 token 会被人看到；若密钥可由 token 推出，
 * 加密就形同虚设。会话密钥在配对时建立，此后只存在于两端内存/本地存储里。
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/** 客户端用 `X-MPI-Enc: v1` 头声明本次请求/响应体是加密的（不带则按明文处理，旧客户端照常工作）。 */
export const ATTACHMENT_ENC_HEADER = "x-mpi-enc";
export const ATTACHMENT_ENC_VERSION = "v1";

/** 12B GCM nonce + 16B tag 的开销；明文长度 = 帧长 - 28。 */
export const ATTACHMENT_ENC_OVERHEAD = 28;

export type AttachmentDirection = "up" | "down";

/** info string —— 必须与安卓/ PWA 两端逐字节一致。 */
export function attachmentInfoString(direction: AttachmentDirection, name: string): string {
  return `mpi-attachment-v1|${direction}|${name}`;
}

/**
 * AAD —— 同时被两端用于加密与解密；任何一方算错都会失败（这正是我们要的防篡改）。
 *
 * @param plaintextLength 该次载荷的**明文**字节数（GET 的 Range 同理）
 */
export function attachmentAad(
  direction: AttachmentDirection,
  name: string,
  offset: number,
  plaintextLength: number,
): string {
  return `${ATTACHMENT_ENC_VERSION}|${direction}|${name}|${offset}|${plaintextLength}`;
}

/** HKDF-SHA256 → 32B 密钥。ikm 是会话密钥（不是 token）。 */
export function deriveAttachmentKey(
  sessionKey: Buffer,
  token: string,
  direction: AttachmentDirection,
  name: string,
): Buffer {
  const key = hkdfSync("sha256", sessionKey, Buffer.from(token, "utf8"), Buffer.from(attachmentInfoString(direction, name), "utf8"), 32);
  return Buffer.isBuffer(key) ? key : Buffer.from(key as unknown as ArrayBuffer);
}

/** 明文 → 帧（nonce||ct||tag）。 */
export function encryptAttachmentBody(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

/** 帧 → 明文；被篡改 / AAD 不符 / 密钥不对 一律抛错（调用方按 400 处理）。 */
export function decryptAttachmentBody(key: Buffer, body: Buffer, aad: string): Buffer {
  if (body.length < ATTACHMENT_ENC_OVERHEAD) throw new Error("attachment frame too short");
  const nonce = body.subarray(0, 12);
  const tag = body.subarray(body.length - 16);
  const ct = body.subarray(12, body.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** 请求是否声明了加密（大小写不敏感）。 */
export function wantsEncryption(headerValue: string | string[] | undefined): boolean {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return (value || "").trim().toLowerCase() === ATTACHMENT_ENC_VERSION;
}
