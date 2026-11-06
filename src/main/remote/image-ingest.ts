/**
 * **内联图片的后台落库队列**（2026-11-06，docs/MOBILE-IMAGE-KEY.md §13 A2）。
 *
 * 背景：客户端声明 `imageKeys` 后，快照里的 image 块只发元数据（key + 缩略图名）。
 * 但 agent 直接内联在 tool result / assistant 正文里的图（ComfyUI 产物最典型）
 * 只有 base64、没有内容 key —— 而给它落库要「base64 解码 + 算 sha256 + 缩放生成缩略图」，
 * 一次 30 张同步做会把主进程卡住 1–2 秒（快照是同步函数，手机端表现为「打开会话转圈」）。
 *
 * 所以分成两条时序：
 *   - **快照（同步）**：只做一次 sha256 查表。
 *     命中 → 本次就用 key 发元数据；没命中 → 入队，本次仍走老路径（内联缩略图）。
 *   - **队列（后台）**：逐张落库 + 生成 thumb/LQIP，下次快照自然走新路径。
 *
 * 为什么用「base64 的 sha256」当指纹：它便宜（~500MB/s）、稳定，且不依赖对象库内部实现。
 * 超过 [maxBase64Chars] 的单张直接放弃（同步哈希本身就会拖一下主进程），记为 dropped。
 *
 * 纯逻辑（无 electron）：落库与缩略图生成由调用方注入，便于单测。
 */
import { createHash } from "node:crypto";

/** 内联图片解码结果。 */
export interface InlineImage {
  bytes: Buffer;
  mime: string | null;
}

/**
 * pi 消息里的图片 base64 → 字节。
 *
 * 两种形态都会遇到：裸 base64（JSONL 里的原样）与带前缀的 `data:image/png;base64,...`。
 * 解不出来（截断/非图片）→ null，绝不抛。
 */
export function decodeInlineImageData(data: string): InlineImage | null {
  const raw = String(data || "").trim();
  if (!raw) return null;
  const comma = raw.startsWith("data:") ? raw.indexOf(",") : -1;
  const meta = comma > 0 ? raw.slice(5, comma) : "";
  const base64 = comma > 0 ? raw.slice(comma + 1) : raw;
  const mime = meta.split(";")[0] || null;
  try {
    const bytes = Buffer.from(base64, "base64");
    return bytes.length > 0 ? { bytes, mime } : null;
  } catch {
    return null;
  }
}

/** 落库结果（`thumbName`/`lqipName` 缺省 = 这张图生成失败，客户端只能拉原图）。 */
export interface ImageIngestStored {
  key: string;
  thumbName: string | null;
  lqipName: string | null;
}

export interface ImageIngestOptions {
  /** 落库 + 生成派生图（同步；调用方自己保证不重入）。返回 null = 放弃。 */
  store: (input: { bytes: Buffer; mimeType: string | null; label?: string }) => ImageIngestStored | null;
  log?: (line: string) => void;
  /** 单张 base64 上限（字符）。默认 6M ≈ 4.5MB 二进制。 */
  maxBase64Chars?: number;
  /** 记住多少组「指纹 → key」（LRU）。默认 600。 */
  maxRemembered?: number;
  /** 队列积压上限（超过丢最旧的）。默认 200。 */
  maxQueue?: number;
}

const DEFAULT_MAX_BASE64_CHARS = 6_000_000;
const DEFAULT_MAX_REMEMBERED = 600;
const DEFAULT_MAX_QUEUE = 200;

interface QueueItem {
  fingerprint: string;
  data: string;
  mimeType?: string;
  label?: string;
}

export class ImageIngestQueue {
  private readonly known = new Map<string, string>();
  private readonly pending = new Set<string>();
  private readonly queue: QueueItem[] = [];
  private running = false;
  private idleResolvers: Array<() => void> = [];
  private dropped = 0;
  private failed = 0;
  private stored = 0;

  private readonly options: ImageIngestOptions;

  // 不用 TS 参数属性（`constructor(private readonly x)`）：node 的 strip-only 模式会拒，
  // 那样这个纯逻辑模块就没法被单测直接 import（与 test-remote-image-ingest.mjs 同源）。
  constructor(options: ImageIngestOptions) {
    this.options = options;
  }

  /** base64 的 sha256（快照侧与队列共用同一套，才可能命中）。 */
  fingerprint(data: string): string {
    return createHash("sha256").update(data).digest("hex");
  }

  /**
   * 快照侧查询：这张内联图是否**已经**落库、key 是什么。
   *
   * 命中会把条目提到 LRU 末尾（会话里反复出现的图不会过期）。
   */
  lookup(data: string): string | undefined {
    if (!data || data.length > this.maxBase64Chars) return undefined;
    const fingerprint = this.fingerprint(data);
    const key = this.known.get(fingerprint);
    if (!key) return undefined;
    this.known.delete(fingerprint);
    this.known.set(fingerprint, key);
    return key;
  }

  /** 快照侧：没命中就入队（同一张图重复入队会被指纹去重）。 */
  enqueue(data: string, mimeType?: string, label?: string): void {
    if (!data) return;
    if (data.length > this.maxBase64Chars) {
      this.dropped += 1;
      this.options.log?.(`image-ingest skip=too-large chars=${data.length}`);
      return;
    }
    const fingerprint = this.fingerprint(data);
    if (this.known.has(fingerprint) || this.pending.has(fingerprint)) return;
    if (this.queue.length >= this.maxQueue) {
      const evicted = this.queue.shift();
      if (evicted) this.pending.delete(evicted.fingerprint);
      this.dropped += 1;
    }
    this.pending.add(fingerprint);
    this.queue.push({ fingerprint, data, mimeType, label });
    void this.drain();
  }

  /** 等队列跑空（单测与优雅退出用）。 */
  whenIdle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  stats(): { stored: number; failed: number; dropped: number; queued: number; remembered: number } {
    return {
      stored: this.stored,
      failed: this.failed,
      dropped: this.dropped,
      queued: this.queue.length,
      remembered: this.known.size,
    };
  }

  private get maxBase64Chars(): number {
    return this.options.maxBase64Chars ?? DEFAULT_MAX_BASE64_CHARS;
  }

  private get maxRemembered(): number {
    return this.options.maxRemembered ?? DEFAULT_MAX_REMEMBERED;
  }

  private get maxQueue(): number {
    return this.options.maxQueue ?? DEFAULT_MAX_QUEUE;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        const started = Date.now();
        try {
          const decoded = decodeInlineImageData(item.data);
          if (!decoded) {
            this.failed += 1;
            this.options.log?.(`image-ingest fail=decode chars=${item.data.length}`);
            continue;
          }
          const result = this.options.store({
            bytes: decoded.bytes,
            mimeType: item.mimeType ?? decoded.mime,
            label: item.label,
          });
          if (result?.key) {
            this.remember(item.fingerprint, result.key);
            this.stored += 1;
            this.options.log?.(
              `image-ingest ok key=${result.key.slice(0, 8)} thumb=${result.thumbName ? 1 : 0} lqip=${result.lqipName ? 1 : 0} ms=${Date.now() - started}`,
            );
          } else {
            this.failed += 1;
            this.options.log?.(`image-ingest fail=store chars=${item.data.length}`);
          }
        } catch (error) {
          this.failed += 1;
          this.options.log?.(`image-ingest fail=exception ${(error as Error)?.message || error}`);
        } finally {
          this.pending.delete(item.fingerprint);
        }
        // 让出事件循环：连续解码+缩放几张大图会把 UI 拖死（主进程与渲染同一进程）。
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      this.running = false;
      if (this.queue.length === 0) {
        const resolvers = this.idleResolvers;
        this.idleResolvers = [];
        for (const resolve of resolvers) resolve();
      }
    }
  }

  private remember(fingerprint: string, key: string): void {
    this.known.delete(fingerprint);
    this.known.set(fingerprint, key);
    while (this.known.size > this.maxRemembered) {
      const oldest = this.known.keys().next().value;
      if (oldest === undefined) break;
      this.known.delete(oldest);
    }
  }
}
