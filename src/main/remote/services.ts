import type { RemoteFileInput, RemoteImageInput, RemoteMediaInput, RemotePermission, RemoteThreadEventPayload, RemoteThreadSnapshot, RemoteVideoInput } from "./protocol";
import type { PromptSource } from "../prompt-source";
import { appendDiagLog } from "../diag-log";

/**
 * 线程事件订阅者。**第二个参数是该事件的线程序号**（见 [RemoteEventHub.publish]）。
 * 只关心事件本身的订阅者（如消息通道）可以只声明第一个参数。
 */
export type RemoteThreadEventListener = (event: RemoteThreadEventPayload, seq: number) => void;

/** `subscribe()` 的返回值：退订句柄 + 「断线期间漏掉的事件能不能补齐」。 */
export interface RemoteSubscription {
  unsubscribe: () => void;
  /**
   * true = 从 `sinceSeq + 1` 到当前序号的事件**已全部补发**给这个订阅者
   * （含补发 0 条：客户端本来就追平了）。调用方据此**跳过昂贵的全量快照**。
   *
   * false = 没带 `sinceSeq`，或缓冲里缺了中间一段（超预算被挤掉 / 主机重启）
   * ——按老规矩拉快照。
   */
  covered: boolean;
  /** 本次实际补发的事件条数。 */
  replayed: number;
}

/** 每条线程最多留多少个事件（一次长回合的增量可能上千条）。 */
const MAX_BUFFERED_EVENTS = 2_000;
/** 每条线程缓冲的字节预算（估算值；文本增量按 delta 长度算，其余走 JSON 长度）。 */
const MAX_BUFFERED_BYTES = 1_500_000;
/** 最多同时留住多少条线程的缓冲（长时间挂在后台的会话不该无限占内存）。 */
const MAX_BUFFERED_THREADS = 16;

interface BufferedEvent {
  seq: number;
  event: RemoteThreadEventPayload;
  bytes: number;
}

/** 缓冲预算（测试可注入更小的值，不靠改常量 + 重启）。 */
export interface RemoteEventHubOptions {
  maxBufferedEvents?: number;
  maxBufferedBytes?: number;
  maxBufferedThreads?: number;
}

/** 估算一个事件的字节数（只求量级正确：文本/思考增量占绝对多数）。 */
function roughEventBytes(event: RemoteThreadEventPayload): number {
  const delta = (event as { data?: { event?: { delta?: unknown } } })?.data?.event?.delta;
  if (typeof delta === "string") return 200 + delta.length;
  try {
    return 200 + JSON.stringify(event).length;
  } catch {
    return 1_000;
  }
}

export class RemoteEventHub {
  private readonly maxBufferedEvents: number;
  private readonly maxBufferedBytes: number;
  private readonly maxBufferedThreads: number;

  constructor(options: RemoteEventHubOptions = {}) {
    this.maxBufferedEvents = options.maxBufferedEvents ?? MAX_BUFFERED_EVENTS;
    this.maxBufferedBytes = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
    this.maxBufferedThreads = options.maxBufferedThreads ?? MAX_BUFFERED_THREADS;
  }

  private readonly listeners = new Map<string, Set<RemoteThreadEventListener>>();

  /**
   * 每线程的事件序号。
   *
   * **必须在这里递增，不能在订阅者回调里递增。**一个事件会被 fan-out 给该线程的
   * 所有订阅者，序号属于「事件」本身。曾经把它写在每个连接的订阅回调内，后果是：
   * N 个订阅者时，同一个事件触发 N 次递增，各自拿到 seq=1 / 2 / … N，于是每个
   * 订阅者看到的都是等差序列（步长 N）→ 客户端把**每一个事件**都判成「缺号」→
   * 触发 `thread.resync` → 而 resync 先把 `ready` 置 false，消息区被打回「加载中」
   * → 下一个事件又缺号……变成无限 resync 风暴（同时开手机端 + 桌面网页看同一个
   * 会话即可复现，主机 diag 日志表现为 subs=2 与成串 remote-req resync）。
   * 客户端假设的语义是「per-thread counter, monotonic across subscribers」。
   */
  private readonly sequences = new Map<string, number>();

  /**
   * 最近事件缓冲（按线程）：**断线/丢帧之后补发增量用**，替代「重拉 1~2MB 快照」。
   *
   * 为什么必须有：`publish` 以前对无订阅者的会话**直接丢**，手机断线十几秒就永久
   * 丢失这段时间的全部事件，只能靠重连后的全量快照补齐——而快照是磁盘历史（不含
   * 正在流式输出的那半条），且这个仓库的现场会话动辄 1.6MB，于是用户看到的是
   * 「桌面写了一大段、手机停在旧内容」。现在事件先进环形缓冲，客户端带着
   * `sinceSeq` 重订阅/重同步时按序补发，能补上就**不拉快照**。
   */
  private readonly buffers = new Map<string, BufferedEvent[]>();
  /** 每条线程缓冲的字节数（与 buffers 同步维护）。 */
  private readonly bufferBytes = new Map<string, number>();
  /** 无人订阅期间丢掉的发布次数（诊断用；`subs=0` 时事件真的没人收）。 */
  private readonly missed = new Map<string, number>();

  /**
   * 订阅某条线程的事件。
   *
   * @param sinceSeq 客户端**已经处理到**的序号。带上且缓冲能覆盖 → 立刻按序补发
   *   `sinceSeq + 1 … 当前` 的事件，并返回 `covered: true`（调用方据此跳过快照）。
   *   不带 / 补不齐 → 返回 `covered: false`，行为与旧版完全一致。
   */
  subscribe(threadId: string, listener: RemoteThreadEventListener, sinceSeq?: number): RemoteSubscription {
    const entries = this.listeners.get(threadId) || new Set<RemoteThreadEventListener>();
    entries.add(listener);
    this.listeners.set(threadId, entries);
    const unsubscribe = () => {
      entries.delete(listener);
      if (entries.size === 0) this.listeners.delete(threadId);
    };

    if (typeof sinceSeq !== "number" || !Number.isFinite(sinceSeq) || sinceSeq < 0) {
      return { unsubscribe, covered: false, replayed: 0 };
    }
    const current = this.sequences.get(threadId) || 0;
    // 已经追平：没有要补的，也算覆盖——别为了 0 条事件拉快照。
    if (sinceSeq === current) return { unsubscribe, covered: true, replayed: 0 };
    if (sinceSeq > current) {
      // 客户端比主机走得还快 = 主机重启/序号清零过（客户端拿的是上一个进程的基线）。
      // **不能当“已追平”**：那会让客户端一直不拉快照，而后续事件的 seq 永远小于它的
      // 期望值，全被当成重复丢掉——手机上就是永远停在旧内容。
      appendDiagLog(
        `remote-events replay-miss thread=${threadId.slice(0, 12)} since=${sinceSeq} current=${current} reason=counter-reset`,
      );
      return { unsubscribe, covered: false, replayed: 0 };
    }

    const buffered = this.buffers.get(threadId) || [];
    const oldest = buffered.length ? buffered[0].seq : current + 1;
    if (oldest > sinceSeq + 1) {
      // 中间那段已经被预算挤掉了：老实回快照，别给客户端一个断头的增量。
      appendDiagLog(
        `remote-events replay-miss thread=${threadId.slice(0, 12)} since=${sinceSeq} oldest=${oldest} current=${current}`,
      );
      return { unsubscribe, covered: false, replayed: 0 };
    }
    // 注册监听在前、补发在后，且全部同步执行——publish 也在同步路径上，
    // 所以补发期间不可能插进一条新事件（既不会重复，也不会乱序）。
    let replayed = 0;
    for (const item of buffered) {
      if (item.seq <= sinceSeq) continue;
      listener(item.event, item.seq);
      replayed += 1;
    }
    appendDiagLog(
      `remote-events replay thread=${threadId.slice(0, 12)} since=${sinceSeq} n=${replayed} current=${current}`,
    );
    return { unsubscribe, covered: true, replayed };
  }

  publish(threadId: string, event: RemoteThreadEventPayload): void {
    // 序号**永远递增**（哪怕此刻无人订阅）：缓冲里的事件要带着稳定序号才能在重连后
    // 按序补发；客户端也靠「连续序号」判缺口。无人订阅时不再「白扣序号」——扣掉的
    // 那点计数换来的是一条可补发的历史，值。
    const seq = (this.sequences.get(threadId) || 0) + 1;
    this.sequences.set(threadId, seq);
    this.remember(threadId, seq, event);

    const entries = this.listeners.get(threadId);
    if (!entries || entries.size === 0) {
      this.noteMiss(threadId, event);
      return;
    }
    for (const listener of entries) listener(event, seq);
  }

  /** 当前序号（不含缓冲）——诊断与客户端基线对照用。 */
  currentSeq(threadId: string): number {
    return this.sequences.get(threadId) || 0;
  }

  /** 写入环形缓冲并按预算裁剪（超条数 / 超字节都从最旧的开始丢）。 */
  private remember(threadId: string, seq: number, event: RemoteThreadEventPayload): void {
    const bytes = roughEventBytes(event);
    const buffered = this.buffers.get(threadId) || [];
    buffered.push({ seq, event, bytes });
    let total = (this.bufferBytes.get(threadId) || 0) + bytes;
    while (buffered.length > this.maxBufferedEvents || (total > this.maxBufferedBytes && buffered.length > 1)) {
      const dropped = buffered.shift();
      total -= dropped?.bytes ?? 0;
    }
    this.buffers.set(threadId, buffered);
    this.bufferBytes.set(threadId, total);
    // 保持 MRU 顺序：把本条挪到队尾（Map 的迭代序 = 插入序）
    this.buffers.delete(threadId);
    this.buffers.set(threadId, buffered);
    // 线程数超上限：丢掉最久没动静的那条。刚插入的那条在队尾，不会被自己挤掉。
    while (this.buffers.size > this.maxBufferedThreads) {
      const stale = this.buffers.keys().next();
      if (stale.done) break;
      this.buffers.delete(stale.value);
      this.bufferBytes.delete(stale.value);
    }
  }

  /** 无人订阅的发布：计数 + 低频诊断行（每 50 条打一次，避免刷屏）。 */
  private noteMiss(threadId: string, event: RemoteThreadEventPayload): void {
    const count = (this.missed.get(threadId) || 0) + 1;
    this.missed.set(threadId, count);
    if (count === 1 || count % 50 === 0) {
      appendDiagLog(
        `remote-pub-miss thread=${threadId.slice(0, 12)} kind=${String((event as { kind?: unknown }).kind || "?")} ` +
          `missed=${count} buffered=${(this.buffers.get(threadId) || []).length}`,
      );
    }
  }

  /**
   * 取证用：当前该会话的订阅者数量。
   *
   * `publish` 对没有订阅者的会话是**静默丢弃**的——真机「整条消息一起晚到」
   * 就是这种情形（手机断线期间主机照常 publish，事件全丢，靠重连后的
   * resync 快照补齐）。把发布时刻的订阅者数写进 diag 日志，才能区分
   * 「主机没发」和「发的时候手机没订阅」。
   */
  subscriberCount(threadId: string): number {
    return this.listeners.get(threadId)?.size ?? 0;
  }

  clear(): void {
    this.listeners.clear();
    this.sequences.clear();
    this.buffers.clear();
    this.bufferBytes.clear();
    this.missed.clear();
  }
}
export class ProjectService {
  constructor(
    private readonly listFn: () => Promise<unknown>,
    private readonly getFn: (projectId: string) => Promise<unknown>,
    private readonly threadsFn: (projectId: string) => Promise<unknown>,
  ) {}

  list(): Promise<unknown> { return this.listFn(); }
  get(projectId: string): Promise<unknown> { return this.getFn(projectId); }
  listThreads(projectId: string): Promise<unknown> { return this.threadsFn(projectId); }
}

export class ThreadService {
  constructor(
    private readonly getFn: (threadId: string) => Promise<RemoteThreadSnapshot>,
    private readonly createFn: (projectId: string, name?: string, permission?: RemotePermission) => Promise<RemoteThreadSnapshot>,
    private readonly promptFn: (threadId: string, text: string, images: RemoteImageInput[] | undefined, files: RemoteFileInput[] | undefined, videos: RemoteVideoInput[] | undefined, media: RemoteMediaInput[] | undefined, source: PromptSource | undefined) => Promise<unknown>,
    private readonly steerFn: (threadId: string, text: string, images: RemoteImageInput[] | undefined, files: RemoteFileInput[] | undefined, videos: RemoteVideoInput[] | undefined, media: RemoteMediaInput[] | undefined) => Promise<unknown>,
    private readonly followUpFn: (threadId: string, text: string, images: RemoteImageInput[] | undefined, files: RemoteFileInput[] | undefined, videos: RemoteVideoInput[] | undefined, media: RemoteMediaInput[] | undefined) => Promise<unknown>,
    private readonly abortFn: (threadId: string) => Promise<unknown>,
  ) {}

  get(threadId: string): Promise<RemoteThreadSnapshot> { return this.getFn(threadId); }
  create(projectId: string, name?: string, permission?: RemotePermission): Promise<RemoteThreadSnapshot> { return this.createFn(projectId, name, permission); }
  // videos 必填（`X | undefined`）——见 service.ts RemoteBackend 上的说明：少传一个参数
  // 在可选参数下是静默的，2026-09-28 就是这么把视频丢掉的。
  prompt(threadId: string, text: string, images: RemoteImageInput[] | undefined, files: RemoteFileInput[] | undefined, videos: RemoteVideoInput[] | undefined, media: RemoteMediaInput[] | undefined, source: PromptSource | undefined): Promise<unknown> { return this.promptFn(threadId, text, images, files, videos, media, source); }
  steer(threadId: string, text: string, images: RemoteImageInput[] | undefined, files: RemoteFileInput[] | undefined, videos: RemoteVideoInput[] | undefined, media: RemoteMediaInput[] | undefined): Promise<unknown> { return this.steerFn(threadId, text, images, files, videos, media); }
  followUp(threadId: string, text: string, images: RemoteImageInput[] | undefined, files: RemoteFileInput[] | undefined, videos: RemoteVideoInput[] | undefined, media: RemoteMediaInput[] | undefined): Promise<unknown> { return this.followUpFn(threadId, text, images, files, videos, media); }
  abort(threadId: string): Promise<unknown> { return this.abortFn(threadId); }
}

export class FilePreviewService {
  constructor(
    private readonly treeFn: (projectId: string, relativePath?: string) => Promise<unknown>,
    private readonly previewFn: (projectId: string, relativePath: string) => Promise<unknown>,
  ) {}

  tree(projectId: string, relativePath?: string): Promise<unknown> { return this.treeFn(projectId, relativePath); }
  preview(projectId: string, relativePath: string): Promise<unknown> { return this.previewFn(projectId, relativePath); }
}
