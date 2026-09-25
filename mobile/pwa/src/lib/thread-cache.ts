/**
 * 会话快照的持久缓存（PWA Tier 2）——对齐原生端 `ThreadCache` 的「本地缓存 A 方案」。
 *
 * 定位与原生一致：**缓存是加速手段，不是数据源**。
 *   - 写失败绝不打扰用户（磁盘满 / 配额超限 / 隐私模式都当没有缓存）；
 *   - 读失败即删（损坏的缓存留着只会每次启动都重试解析）；
 *   - 三层容量上限：单条 / 每主机条数 / 每主机总量，超了从最旧开始删。
 *
 * 存的是 **快照的原始 JSON 文本**（与原生存原始快照同一个理由：线格式已被严格解析过
 * 才写入，升级协议时旧缓存最多解析失败被丢弃，不会把坏数据喂给归约器）。
 *
 * 为什么把存储后端抽成 `CacheStore`：Node 里没有 IndexedDB，而本项目约定不引入
 * `fake-indexeddb` 之类的依赖。抽出后端后，容量 / prune / 失败静默这些**真正容易错**
 * 的逻辑就能在 Node 里测（见 `scripts/test-pwa-thread-cache.mjs` 的 MemoryStore）。
 */
import type { RemoteThreadSnapshot } from "../../../shared/protocol";

export interface SnapshotMeta {
  hostId: string;
  threadId: string;
  /** 写入时刻（毫秒）。UI 靠它显示「本地缓存（x 分钟前）」。 */
  savedAt: number;
  /** 容量计量用的粗糙大小（UTF-16 码元数）。策略只需可比，不需要精确字节数。 */
  bytes: number;
}

export interface StoredSnapshot {
  meta: SnapshotMeta;
  /** 快照的原始 JSON 文本。 */
  json: string;
}

export interface CachedThread {
  snapshot: RemoteThreadSnapshot;
  savedAt: number;
}

/** 存储后端。实现见 `thread-cache-idb.ts`（浏览器）与测试里的 MemoryStore。 */
export interface CacheStore {
  read(hostId: string, threadId: string): Promise<StoredSnapshot | null>;
  write(entry: StoredSnapshot): Promise<void>;
  /** 只列**元数据**：prune 绝不能把所有快照体读进内存（总量上限 32MB）。 */
  listMeta(hostId: string): Promise<SnapshotMeta[]>;
  remove(hostId: string, threadId: string): Promise<void>;
  clear(): Promise<void>;
}

export interface ThreadCacheLimits {
  /** 每台主机最多留几条（原生默认 20）。 */
  maxEntries?: number;
  /** 单条超过此大小就不缓存（原生默认 4MB；通常是一屏塞满 base64 图片的会话）。 */
  maxBytesPerEntry?: number;
  /** 每台主机累计上限，超了从最旧开始删（原生默认 32MB）。 */
  maxBytesTotal?: number;
}

export const DEFAULT_MAX_ENTRIES = 20;
export const DEFAULT_MAX_BYTES_PER_ENTRY = 4 * 1024 * 1024;
export const DEFAULT_MAX_BYTES_TOTAL = 32 * 1024 * 1024;

export class ThreadCache {
  private readonly maxEntries: number;
  private readonly maxBytesPerEntry: number;
  private readonly maxBytesTotal: number;

  constructor(
    private readonly store: CacheStore,
    limits: ThreadCacheLimits = {},
  ) {
    this.maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytesPerEntry = limits.maxBytesPerEntry ?? DEFAULT_MAX_BYTES_PER_ENTRY;
    this.maxBytesTotal = limits.maxBytesTotal ?? DEFAULT_MAX_BYTES_TOTAL;
  }

  /** 读出可用的快照；任何异常 / 形状不对都返回 null，并顺手把这条坏缓存删掉。 */
  async read(hostId: string, threadId: string): Promise<CachedThread | null> {
    try {
      const hit = await this.store.read(hostId, threadId);
      if (!hit) return null;
      const snapshot = JSON.parse(hit.json) as RemoteThreadSnapshot;
      // 形状校验：协议升级后旧缓存可能残缺 —— 宁可丢掉也不能喂给归约器。
      if (!snapshot || typeof snapshot.id !== "string" || !Array.isArray(snapshot.messages)) {
        await this.store.remove(hostId, threadId);
        return null;
      }
      return { snapshot, savedAt: hit.meta.savedAt };
    } catch {
      // 读失败即删：损坏的缓存留着只会每次启动都重试解析（对齐原生 ThreadCache）。
      try {
        await this.store.remove(hostId, threadId);
      } catch { /* 删不掉也不能影响主流程 */ }
      return null;
    }
  }

  /** 写入一份快照。**永不抛出**——缓存写失败不该被用户看见。 */
  async write(
    hostId: string,
    threadId: string,
    snapshot: RemoteThreadSnapshot,
    savedAt = Date.now(),
  ): Promise<void> {
    try {
      const json = JSON.stringify(snapshot);
      const bytes = json.length;
      // 单条太大就整个跳过（原生同样的取舍）：这种会话缓存进去只会撑爆配额。
      if (bytes > this.maxBytesPerEntry) return;
      await this.store.write({ meta: { hostId, threadId, savedAt, bytes }, json });
      await this.prune(hostId);
    } catch { /* 缓存是加速手段，不是数据源 */ }
  }

  /**
   * 每台主机：按 savedAt 从新到旧累计，遇到「第 maxEntries 条之后」或「累计超
   * maxBytesTotal」就开始删（对齐原生 `prune()` 的判定顺序）。
   */
  private async prune(hostId: string): Promise<void> {
    const metas = await this.store.listMeta(hostId);
    metas.sort((a, b) => b.savedAt - a.savedAt);
    let total = 0;
    for (let index = 0; index < metas.length; index++) {
      total += metas[index].bytes;
      if (index >= this.maxEntries || total > this.maxBytesTotal) {
        await this.store.remove(metas[index].hostId, metas[index].threadId);
      }
    }
  }

  /** 撤销某台主机的绑定时调用（对齐原生 `deleteHost`）。 */
  async deleteHost(hostId: string): Promise<void> {
    try {
      for (const meta of await this.store.listMeta(hostId)) {
        await this.store.remove(meta.hostId, meta.threadId);
      }
    } catch { /* 同上：失败不打扰用户 */ }
  }

  async clear(): Promise<void> {
    try {
      await this.store.clear();
    } catch { /* ignore */ }
  }
}
