/**
 * 会话快照的本地缓存（PWA Tier 1，纯内存）。
 *
 * 为什么需要：没有缓存时，切走会话会 `detach()` 掉 ThreadSession，切回来要从零
 * `thread.subscribe`——主机得读一遍 JSONL、渲染、下发整份快照（实测单次
 * 0.3–1.6 MB），这期间界面上只有一句「加载会话…」。
 *
 * 本方案只缓存**快照数据**、不保留活着的 ThreadSession：
 *   - 切回来立刻用缓存快照把界面撑起来（感知延迟 ≈ 0），紧接着 open() 的实时快照替换；
 *   - 不动会话生命周期（不需要 LRU-detach / 后台审批可见性 / 重连懒重同步那一套）。
 * 代价说清楚：网络那一趟照旧（约 1s），省的是「白屏等待」，不是带宽。
 *
 * 与 Tier 2（IndexedDB 持久缓存）是**同一套机制**，只是存储介质不同——两者共用
 * `ThreadSession.applyCachedSnapshot()` 这条播种通路。缓存定位与原生端 ThreadCache
 * 一致：加速手段，不是数据源（协议升级时旧缓存最多解析失败被丢弃）。
 */
export interface CachedSnapshot<T> {
  payload: T;
  savedAt: number;
}

export class SnapshotCache<T> {
  /** Map 保持插入序：队首 = 最久未用。 */
  private readonly entries = new Map<string, CachedSnapshot<T>>();

  constructor(private readonly limit: number) {
    if (limit < 1) throw new Error("SnapshotCache limit must be >= 1");
  }

  get size(): number {
    return this.entries.size;
  }

  /** 命中即算「最近使用」，挪到队尾，让淘汰真的按 LRU 走。 */
  get(key: string): CachedSnapshot<T> | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  set(key: string, payload: T, savedAt = Date.now()): void {
    this.entries.delete(key);
    this.entries.set(key, { payload, savedAt });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /** 切主机 / 断连 / 卸载时调用——否则会把**另一台主机**的快照当成初值显示出来。 */
  clear(): void {
    this.entries.clear();
  }

  /** 按最近使用顺序（最久未用在前），测试与取证用。 */
  keys(): string[] {
    return [...this.entries.keys()];
  }
}
