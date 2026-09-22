/**
 * Persistence contract for the PWA (docs/MOBILE-DESIGN.md §6.1).
 * Browser uses IndexedDB (keystore-idb.ts); node tests use an in-memory store.
 */

export interface DeviceRecord {
  /** Ed25519 seed, base64url — one identity per phone, shared across hosts. */
  seedB64url: string;
  name: string;
}

export interface PairingRecord {
  hostId: string;
  relayUrl: string;
  deviceId: string;
  /** Stable token from pair.accepted — enables hello re-auth after reconnects. */
  deviceToken: string | null;
  /** Host X25519 pub (b64url) for E2E key derivation; optional for pre-S3 records. */
  hostX25519PubB64u?: string;
  pairedAt: number;
  /** 配对载荷里带来的桌面机器名（旧记录可能没有）；多设备列表用它区分主机。 */
  hostName?: string;
  /** 手机端本地重命名（显示优先于 hostName，只存本机、不影响桌面端）。空 = 用回机器名。 */
  displayName?: string;
  /** 最近一次连接时间；多设备列表按它排序、自动重连优先选最近用过的。 */
  lastSeenAt?: number;
}

export interface KeyStore {
  getDevice(): Promise<DeviceRecord | null>;
  saveDevice(record: DeviceRecord): Promise<void>;
  getPairing(hostId: string): Promise<PairingRecord | null>;
  savePairing(record: PairingRecord): Promise<void>;
  deletePairing(hostId: string): Promise<void>;
  listPairings(): Promise<PairingRecord[]>;
}

/** In-memory KeyStore for tests / non-browser environments. */
export class MemoryKeyStore implements KeyStore {
  private device: DeviceRecord | null = null;
  private pairings = new Map<string, PairingRecord>();

  async getDevice() {
    return this.device;
  }
  async saveDevice(record: DeviceRecord) {
    this.device = record;
  }
  async getPairing(hostId: string) {
    return this.pairings.get(hostId) ?? null;
  }
  async savePairing(record: PairingRecord) {
    this.pairings.set(record.hostId, record);
  }
  async deletePairing(hostId: string) {
    this.pairings.delete(hostId);
  }
  async listPairings() {
    return [...this.pairings.values()];
  }
}
