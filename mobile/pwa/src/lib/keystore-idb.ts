/** IndexedDB-backed KeyStore (browser only — node tests use MemoryKeyStore). */
import type { DeviceRecord, KeyStore, PairingRecord } from "./keystore";

const DB_NAME = "mpi-pwa";
const DB_VERSION = 1;
const KV_STORE = "kv";
const PAIRINGS_STORE = "pairings";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
      if (!db.objectStoreNames.contains(PAIRINGS_STORE)) db.createObjectStore(PAIRINGS_STORE, { keyPath: "hostId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("failed to open IndexedDB"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export class IdbKeyStore implements KeyStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= openDb();
    return this.dbPromise;
  }

  async getDevice(): Promise<DeviceRecord | null> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction(KV_STORE).objectStore(KV_STORE).get("device");
      request.onsuccess = () => resolve((request.result as DeviceRecord | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  async saveDevice(record: DeviceRecord): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(KV_STORE, "readwrite");
    tx.objectStore(KV_STORE).put(record, "device");
    await txDone(tx);
  }

  async getPairing(hostId: string): Promise<PairingRecord | null> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction(PAIRINGS_STORE).objectStore(PAIRINGS_STORE).get(hostId);
      request.onsuccess = () => resolve((request.result as PairingRecord | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  async savePairing(record: PairingRecord): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(PAIRINGS_STORE, "readwrite");
    tx.objectStore(PAIRINGS_STORE).put(record);
    await txDone(tx);
  }

  async deletePairing(hostId: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(PAIRINGS_STORE, "readwrite");
    tx.objectStore(PAIRINGS_STORE).delete(hostId);
    await txDone(tx);
  }

  async listPairings(): Promise<PairingRecord[]> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction(PAIRINGS_STORE).objectStore(PAIRINGS_STORE).getAll();
      request.onsuccess = () => resolve((request.result as PairingRecord[]) ?? []);
      request.onerror = () => reject(request.error);
    });
  }
}
