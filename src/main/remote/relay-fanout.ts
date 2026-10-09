/**
 * 多中继聚合器（阶段 ②「主机双中继上行」）。
 *
 * 背景：`RemoteHost` 只认**一个** `RelayOutbound`，而「ECS 主 + CF 备」要求主机
 * **同时在两条中继上在线**——这样手机用哪张配对票都能连上，ECS 挂了只需手机换票
 * （不必再去动那台电脑）。见 `Work/tempfile/2026-10-09-CF中继保底方案/改造评估-主机双中继上行.md`。
 *
 * 做法：本类实现同一个 `RelayOutbound` 接口，内部持有 N 个 `RelayUplink`，按**设备归属**路由：
 *
 * | 操作 | 路由 |
 * |---|---|
 * | `sendToDevice` | 设备当前连在哪条 → 只发那条；未知 → 广播（各自丢不掉的会丢） |
 * | `sendControl` | 帧里带 `deviceId` → 同 `sendPush`；否则广播（`ticket.register` 必须两条都注册） |
 * | `sendPush` | 只发**一条**：设备在线的那条 > 持有订阅的那条 > 主中继（防重复通知） |
 * | `storePushSubscription` | 同 `sendPush` 的目标（订阅与中继的 VAPID 密钥绑定，存到对的那条） |
 * | `deviceToken` / `e2eSessionKeyFor` | 遍历查找，命中即返回 |
 * | `activateE2E` / `deactivateE2E` / `notifyRevoked` | 设备所在的那条（未知则广播） |
 *
 * **不变量**：只有一条中继时，行为与直接使用 `RelayUplink` 完全等价
 * （钉在 `scripts/test-relay-fanout.mjs`，保证单通道安装零回归）。
 */
import type { RemotePushSubscription } from "./protocol";
import type { RelayUplinkStatus } from "./relay-uplink";

/** 聚合器需要的中继上行能力面（`RelayUplink` 结构上满足；测试里可用假实现）。 */
export interface RelayUplinkLike {
  start(): void;
  stop(): void;
  relayUrl(): string;
  getStatus(): RelayUplinkStatus;
  instanceKey(): string;
  sendToDevice(deviceId: string, frame: string): void;
  sendControl(frame: Record<string, unknown>): boolean;
  deviceToken(deviceId: string): string | null;
  notifyRevoked(deviceId: string): void;
  activateE2E(deviceId: string, deviceX25519Pub: string, caps?: unknown): void;
  deactivateE2E(deviceId: string): void;
  e2eSessionKeyFor(deviceId: string): Buffer | null;
  storePushSubscription(deviceId: string, subscription: RemotePushSubscription): void;
  sendPush(deviceId: string, push: { kind: string; title: string; body?: string; deepLink?: string }): boolean;
  getKnownDeviceIds(): string[];
  isDeviceConnected(deviceId: string): boolean;
  hasPushSubscription(deviceId: string): boolean;
}

export interface RelayFanoutOptions {
  /** 第一条 = 主中继（配对票默认用它；状态面板也以它为主）。 */
  uplinks: RelayUplinkLike[];
  log?: (line: string) => void;
}

export class RelayFanout {
  private uplinks: RelayUplinkLike[];
  private readonly log: (line: string) => void;

  constructor(options: RelayFanoutOptions) {
    this.uplinks = options.uplinks.filter(Boolean);
    this.log = options.log ?? (() => {});
  }

  /**
   * 替换通道集合（配置变更时调用）。
   * 不重建 fanout 实例：`RemoteHost` 只认一个 `RelayOutbound`，换实例会让配对的
   * 回调链断了（它只在 setRelay 时拿一次引用）。
   */
  setUplinks(uplinks: RelayUplinkLike[]): void {
    this.uplinks = uplinks.filter(Boolean);
  }

  /** 当前通道数（面板/诊断）。 */
  size(): number {
    return this.uplinks.length;
  }

  // --- lifecycle ---------------------------------------------------------------

  start(): void {
    for (const uplink of this.uplinks) {
      try {
        uplink.start();
      } catch (error) {
        this.log(`relay-fanout start failed key=${uplink.instanceKey()}: ${(error as Error)?.message || error}`);
      }
    }
  }

  stop(): void {
    for (const uplink of this.uplinks) {
      try {
        uplink.stop();
      } catch {
        /* 停机尽力而为 */
      }
    }
  }

  /** 主中继地址（配对票 / 面板回显沿用第一条）。 */
  relayUrl(): string {
    return this.uplinks[0]?.relayUrl() ?? "";
  }

  /** 主中继状态（既有面板/诊断字段保持可用）。 */
  getStatus(): RelayUplinkStatus {
    return this.uplinks[0]?.getStatus() ?? { state: "disabled", relayUrl: "", lastError: null };
  }

  /** 全部通道状态（新增：面板显示两条）。 */
  statuses(): Array<{ key: string } & RelayUplinkStatus> {
    return this.uplinks.map((uplink) => ({ key: uplink.instanceKey(), ...uplink.getStatus() }));
  }

  // --- 路由 ---------------------------------------------------------------------

  /** 设备在线的那条中继；都不在线 → 空。 */
  private connectedTo(deviceId: string): RelayUplinkLike[] {
    if (!deviceId) return [];
    return this.uplinks.filter((uplink) => uplink.isDeviceConnected(deviceId));
  }

  /**
   * 帧类操作的目标：在线的那条 → 否则广播（帧里有目标设备时由中继侧丢弃多余份）。
   */
  private frameTargets(deviceId?: string): RelayUplinkLike[] {
    if (!deviceId) return this.uplinks;
    const connected = this.connectedTo(deviceId);
    return connected.length ? connected : this.uplinks;
  }

  /**
   * 推送类操作的目标：**只挑一条**——在线的那条 > 持有订阅的那条 > 主中继。
   * 挑一条是为了避免「两条中继各投递一次」导致手机收到两条通知。
   */
  private pushTargets(deviceId: string): RelayUplinkLike[] {
    if (!deviceId) return this.uplinks.slice(0, 1);
    const connected = this.connectedTo(deviceId);
    if (connected.length) return connected.slice(0, 1);
    const subscribed = this.uplinks.filter((uplink) => uplink.hasPushSubscription(deviceId));
    if (subscribed.length) return subscribed.slice(0, 1);
    return this.uplinks.slice(0, 1);
  }

  // --- RelayOutbound -----------------------------------------------------------

  sendToDevice(deviceId: string, frame: string): void {
    for (const uplink of this.frameTargets(deviceId)) uplink.sendToDevice(deviceId, frame);
  }

  /**
   * 控制帧：带 `deviceId` 的（`pair.approved` / `push.request` / …）按推送策略只发一条；
   * 其余（`ticket.register` 等）**广播**——配对票必须在每条中继上都注册，
   * 否则手机扫到哪条票都可能「主机离线」。
   */
  sendControl(frame: Record<string, unknown>): boolean {
    const deviceId = typeof frame?.deviceId === "string" ? frame.deviceId : "";
    const targets = deviceId ? this.pushTargets(deviceId) : this.uplinks;
    let any = false;
    for (const uplink of targets) {
      try {
        if (uplink.sendControl(frame)) any = true;
      } catch (error) {
        this.log(`relay-fanout sendControl failed key=${uplink.instanceKey()}: ${(error as Error)?.message || error}`);
      }
    }
    return any;
  }

  deviceToken(deviceId: string): string | null {
    for (const uplink of this.uplinks) {
      const token = uplink.deviceToken(deviceId);
      if (token) return token;
    }
    return null;
  }

  notifyRevoked(deviceId: string): void {
    for (const uplink of this.frameTargets(deviceId)) uplink.notifyRevoked(deviceId);
  }

  activateE2E(deviceId: string, deviceX25519Pub: string, caps?: unknown): void {
    // 会话只可能建在**正在处理这次配对**的那条中继上；带 caps 时按在线归属挑，避免在无关通道上派生密钥。
    for (const uplink of this.frameTargets(deviceId)) uplink.activateE2E(deviceId, deviceX25519Pub, caps);
  }

  deactivateE2E(deviceId: string): void {
    for (const uplink of this.uplinks) uplink.deactivateE2E(deviceId);
  }

  // --- 推送（S7）----------------------------------------------------------------

  storePushSubscription(deviceId: string, subscription: RemotePushSubscription): void {
    // 订阅与「该中继的 VAPID 密钥」绑定：存到设备当前连的那条；未知则两条都存（无害）。
    for (const uplink of this.frameTargets(deviceId)) uplink.storePushSubscription(deviceId, subscription);
  }

  sendPush(deviceId: string, push: { kind: string; title: string; body?: string; deepLink?: string }): boolean {
    for (const uplink of this.pushTargets(deviceId)) {
      try {
        if (uplink.sendPush(deviceId, push)) return true;
      } catch (error) {
        this.log(`relay-fanout sendPush failed key=${uplink.instanceKey()}: ${(error as Error)?.message || error}`);
      }
    }
    return false;
  }

  getKnownDeviceIds(): string[] {
    const ids = new Set<string>();
    for (const uplink of this.uplinks) {
      for (const id of uplink.getKnownDeviceIds()) ids.add(id);
    }
    return [...ids];
  }

  // --- 附件加密（按设备查 E2E 会话密钥）----------------------------------------

  e2eSessionKeyFor(deviceId: string): Buffer | null {
    for (const uplink of this.uplinks) {
      const key = uplink.e2eSessionKeyFor(deviceId);
      if (key) return key;
    }
    return null;
  }
}
