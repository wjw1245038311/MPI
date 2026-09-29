/**
 * 附件直连服务（附件 HTTP 服务）的**能力令牌**。
 *
 * 背景（2026-09-29，P1）：附件字节不再走"整帧 base64 内联"的协议通道，而是由客户端
 * 直接向主机要字节/传字节（`GET`/`PUT`，见 attachment-server.ts）。直连必须自带授权：
 *
 *   - 连接本身由 **Tailscale（WireGuard）** 保护，但 tailnet 里可能有用户自己的其它设备，
 *     所以不能"能连上就给"；令牌把权限限定到 **(会话, 附件, 设备, 方向, 时限)**。
 *   - 令牌只由**现有的 E2E 通道**签发（`attachment.url` 请求）：客户端不能自己造 URL，
 *     也无法把别人的附件名换个 host 就去拉。
 *
 * 为什么不用 HMAC 签名而是服务端内存表：令牌需要**一次性/可撤销**（上传完成后即失效、
 * 取消即回收），而签名令牌天生无状态；内存表的代价是"主机重启后所有临时 URL 失效"——
 * 这正是我们想要的语义（URL 的寿命是"这一次传输"）。
 */
import { randomBytes } from "node:crypto";

export type AttachmentTokenMode = "read" | "write";

export interface AttachmentToken {
  token: string;
  mode: AttachmentTokenMode;
  /** 所属会话（作用域校验的边界；写令牌据此在完成时登记）。 */
  threadId: string;
  /** 签发给的设备（token 泄露给别的设备也用不上——服务端会比对）。 */
  deviceId: string;
  /** 目标附件名（读：已存在的；写：主机预分配的）。 */
  name: string;
  /** 写令牌：客户端声明的原始字节数（用于收齐判定与限额）。 */
  size?: number;
  /**
   * 内容寻址（P1）：客户端**先算好**的整文件 SHA-256（小写 hex）。
   *
   * 给了它就表示这是内容寻址的上传：临时文件按令牌命名、收齐后主机自己算一遍哈希比对
   * （不符则拒收），成品进 `objects/` 并且 `name` 就是这把 key（见 docs/attachment-content-addressing.md）。
   */
  sha256?: string;
  /** 可读的原文件名（key 本身没有可读信息，界面展示靠它）。 */
  label?: string;
  /**
   * 「降落到工作区」（P3-S2）：收齐后除了进对象库，还要**复制一份到会话工作目录的 `mpi-inbox/`**，
   * 并在完成响应里回报 `workspacePath`。
   *
   * 为什么需要：给 agent 读的文件必须是**磁盘上的真实路径**（它用文件工具去读），而内联通道
   * 撞 8MB 信封上限（手机上 >6MB 的文件根本发不出去），落在剪贴板临时目录也不适合长期引用。
   */
  workspace?: boolean;
  /** 写令牌：已收字节数（最后一个分片落盘后仍会写一次）。 */
  received: number;
  mimeType?: string;
  /** 读令牌已完成请求数（只用于诊断）。 */
  hits: number;
  expiresAt: number;
}

export interface MintAttachmentTokenInput {
  mode: AttachmentTokenMode;
  threadId: string;
  deviceId: string;
  name: string;
  size?: number;
  mimeType?: string;
  sha256?: string;
  label?: string;
  workspace?: boolean;
}

/** 令牌默认寿命：足够传完一个大文件，又不会长期有效。 */
export const ATTACHMENT_TOKEN_TTL_MS = 15 * 60 * 1000;

export class AttachmentTokenStore {
  private readonly tokens = new Map<string, AttachmentToken>();

  constructor(
    private readonly ttlMs: number = ATTACHMENT_TOKEN_TTL_MS,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  mint(input: MintAttachmentTokenInput): AttachmentToken {
    this.sweep();
    const token: AttachmentToken = {
      // 24 字节随机 → URL 不可猜（这就是能力 URL 的全部安全性来源）。
      token: randomBytes(24).toString("base64url"),
      mode: input.mode,
      threadId: input.threadId,
      deviceId: input.deviceId,
      name: input.name,
      ...(input.size ? { size: input.size } : {}),
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      ...(input.sha256 ? { sha256: input.sha256.toLowerCase() } : {}),
      ...(input.label ? { label: input.label } : {}),
      ...(input.workspace ? { workspace: true } : {}),
      received: 0,
      hits: 0,
      expiresAt: this.clock() + this.ttlMs,
    };
    this.tokens.set(token.token, token);
    return token;
  }

  /** 取令牌（过期即删并返回 null）。**不校验设备**——那是调用方的事（这里保持纯逻辑）。 */
  get(token: string): AttachmentToken | null {
    if (!token) return null;
    const entry = this.tokens.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= this.clock()) {
      this.tokens.delete(token);
      return null;
    }
    return entry;
  }

  revoke(token: string): void {
    this.tokens.delete(token);
  }

  /** 已签发且未过期的数量（配额的粗护栏）。 */
  size(): number {
    this.sweep();
    return this.tokens.size;
  }

  /** 清掉过期令牌（每次签发与读取时顺手做，不需要定时器）。 */
  sweep(): number {
    const now = this.clock();
    let removed = 0;
    for (const [token, entry] of this.tokens) {
      if (entry.expiresAt <= now) {
        this.tokens.delete(token);
        removed += 1;
      }
    }
    return removed;
  }
}

/**
 * 解析上传分片的偏移声明。
 *
 * 接受两种客户端习惯：标准 `Content-Range: bytes 0-1023/2048`，以及简化头
 * `X-MPI-Offset: 1024`（只给起点）。返回 { offset, total }；无法解析 → null
 * （调用方按 400 处理，而不是猜一个偏移写坏文件）。
 */
export function parseUploadOffset(
  contentRange: string | null,
  simpleOffset: string | null,
): { offset: number; total: number | null } | null {
  if (contentRange) {
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange.trim());
    if (!match) return null;
    const offset = Number(match[1]);
    const end = Number(match[2]);
    const total = match[3] === "*" ? null : Number(match[3]);
    if (!Number.isFinite(offset) || !Number.isFinite(end) || end < offset) return null;
    if (total !== null && (!Number.isFinite(total) || total <= end)) return null;
    return { offset, total };
  }
  if (simpleOffset) {
    const offset = Number(simpleOffset);
    if (!Number.isFinite(offset) || offset < 0) return null;
    return { offset: Math.floor(offset), total: null };
  }
  return null;
}
