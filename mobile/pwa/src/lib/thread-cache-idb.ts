/**
 * `CacheStore` 的 IndexedDB 实现（浏览器侧）。纯逻辑在 `thread-cache.ts`，
 * 这里只负责「怎么存」。
 *
 * 为什么用**两个** object store：
 *   prune 只需要 `savedAt` / `bytes`。如果元数据和快照体放同一条记录里，
 *   `getAll(hostId)` 会把最多 32MB 的快照体一起读进内存——每次写缓存都来一次。
 *   拆开后 prune 只扫小表，删的时候再从两张表里按同一个复合键删。
 *
 * 键用复合主键 `[hostId, threadId]`（IDB 原生支持数组 keyPath），避免自己拼字符串
 * 时被分隔符撞键。
 */
import type { CacheStore, SnapshotMeta, StoredSnapshot } from "./thread-cache";

const DB_NAME = "mpi-thread-cache";
const DB_VERSION = 1;
const META = "meta";
const BODIES = "bodies";
/** 复合主键：`keyPath` 需要可变 string[]（`as const` 会变成 readonly 而编不过）。 */
const KEY_PATH: string[] = ["hostId", "threadId"];
const BY_HOST = "byHost";

/** IDBRequest → Promise。 */
function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 等一次写事务真正落地（而不是只等请求排队）。 */
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: KEY_PATH }).createIndex(BY_HOST, "hostId");
      }
      if (!db.objectStoreNames.contains(BODIES)) {
        db.createObjectStore(BODIES, { keyPath: KEY_PATH });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class IdbStore implements CacheStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  /** 懒开库；失败时清掉缓存的 promise，下次调用可重试（隐私模式 / 配额异常）。 */
  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDb().catch((error) => {
        this.dbPromise = null;
        throw error;
      });
    }
    return this.dbPromise;
  }

  async read(hostId: string, threadId: string): Promise<StoredSnapshot | null> {
    const db = await this.db();
    const tx = db.transaction([META, BODIES], "readonly");
    // 两个请求**同步**发起再一起 await：事务在让出宏任务时会被自动提交，
    // 逐个 await 会让第二个请求落在已提交的事务上。
    const [meta, body] = await Promise.all([
      wrap<SnapshotMeta | undefined>(tx.objectStore(META).get([hostId, threadId])),
      wrap<{ json?: string } | undefined>(tx.objectStore(BODIES).get([hostId, threadId])),
    ]);
    if (!meta || !body || typeof body.json !== "string") return null;
    return { meta, json: body.json };
  }

  async write(entry: StoredSnapshot): Promise<void> {
    const db = await this.db();
    const tx = db.transaction([META, BODIES], "readwrite");
    tx.objectStore(META).put(entry.meta);
    tx.objectStore(BODIES).put({ hostId: entry.meta.hostId, threadId: entry.meta.threadId, json: entry.json });
    await committed(tx);
  }

  async listMeta(hostId: string): Promise<SnapshotMeta[]> {
    const db = await this.db();
    const tx = db.transaction(META, "readonly");
    return (await wrap(tx.objectStore(META).index(BY_HOST).getAll(hostId))) as SnapshotMeta[];
  }

  async remove(hostId: string, threadId: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction([META, BODIES], "readwrite");
    tx.objectStore(META).delete([hostId, threadId]);
    tx.objectStore(BODIES).delete([hostId, threadId]);
    await committed(tx);
  }

  async clear(): Promise<void> {
    const db = await this.db();
    const tx = db.transaction([META, BODIES], "readwrite");
    tx.objectStore(META).clear();
    tx.objectStore(BODIES).clear();
    await committed(tx);
  }
}
