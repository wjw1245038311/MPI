import type { RemoteFileInput, RemoteImageInput, RemotePermission, RemoteThreadEventPayload, RemoteThreadSnapshot } from "./protocol";

/**
 * 线程事件订阅者。**第二个参数是该事件的线程序号**（见 [RemoteEventHub.publish]）。
 * 只关心事件本身的订阅者（如消息通道）可以只声明第一个参数。
 */
export type RemoteThreadEventListener = (event: RemoteThreadEventPayload, seq: number) => void;

export class RemoteEventHub {
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

  subscribe(threadId: string, listener: RemoteThreadEventListener): () => void {
    const entries = this.listeners.get(threadId) || new Set<RemoteThreadEventListener>();
    entries.add(listener);
    this.listeners.set(threadId, entries);
    return () => {
      entries.delete(listener);
      if (entries.size === 0) this.listeners.delete(threadId);
    };
  }

  publish(threadId: string, event: RemoteThreadEventPayload): void {
    const entries = this.listeners.get(threadId);
    // 无人订阅时保持原有语义：静默丢弃，且**不推进序号**（客户端每次
    // applySnapshot 后都会用首个实时事件重建基线，所以推进与否都安全；
    // 保持原样是为了不在无人订阅的时段白白消耗序号）。
    if (!entries || entries.size === 0) return;
    const seq = (this.sequences.get(threadId) || 0) + 1;
    this.sequences.set(threadId, seq);
    for (const listener of entries) listener(event, seq);
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
    private readonly promptFn: (threadId: string, text: string, images?: RemoteImageInput[], files?: RemoteFileInput[]) => Promise<unknown>,
    private readonly steerFn: (threadId: string, text: string, images?: RemoteImageInput[], files?: RemoteFileInput[]) => Promise<unknown>,
    private readonly followUpFn: (threadId: string, text: string, images?: RemoteImageInput[], files?: RemoteFileInput[]) => Promise<unknown>,
    private readonly abortFn: (threadId: string) => Promise<unknown>,
  ) {}

  get(threadId: string): Promise<RemoteThreadSnapshot> { return this.getFn(threadId); }
  create(projectId: string, name?: string, permission?: RemotePermission): Promise<RemoteThreadSnapshot> { return this.createFn(projectId, name, permission); }
  prompt(threadId: string, text: string, images?: RemoteImageInput[], files?: RemoteFileInput[]): Promise<unknown> { return this.promptFn(threadId, text, images, files); }
  steer(threadId: string, text: string, images?: RemoteImageInput[], files?: RemoteFileInput[]): Promise<unknown> { return this.steerFn(threadId, text, images, files); }
  followUp(threadId: string, text: string, images?: RemoteImageInput[], files?: RemoteFileInput[]): Promise<unknown> { return this.followUpFn(threadId, text, images, files); }
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
