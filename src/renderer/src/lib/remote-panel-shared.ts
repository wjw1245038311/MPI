/**
 * 「服务器」与「手机远程控制」两个面板共用的类型与纯函数。
 *
 * 2026-10-16 拆分：原来这些都长在 `RemotePanel.tsx` 里，而中继相关的那一半要搬到
 * 设置 →「服务器」分栏（`ServerPanel.tsx`），所以提到这里，两边 import 同一份，
 * 避免两份状态类型慢慢漂移（前端表现不对时最难查的就是这种「两个副本各说各话」）。
 */

export type Pairing = {
  hostId: string;
  fingerprint: string;
  hostPublicKeyPem: string;
  signalingUrl: string;
  stunUrls: string[];
  /** Cloud-relay URL (present when the relay is configured) — the PWA connects here. */
  relayUrl?: string;
  /** 机器名（多设备列表区分主机用）。 */
  hostName?: string;
  ticket: string;
  expiresAt: number;
  protocol: number;
};

export type RemoteStatus = {
  signalingEnabled: boolean;
  signalingUrl: string;
  signalingState: string;
  devices: Array<{ deviceId: string; name: string; connectedAt: number; authenticated: boolean }>;
  pendingPairings: Array<{ connectionId: string; deviceId: string; name: string }>;
};

export type RelayStatus = {
  state: "disabled" | "connecting" | "connected" | "error";
  relayUrl: string;
  lastError: string | null;
  /** 旧字段（S5 前的「手机通道地址」）：保留读取兼容，界面不再编辑。 */
  mobileRelayUrl?: string;
  /** **本次配对票里实际会告诉手机的地址**（局域网模式 > 手机通道地址 > relayUrl，与主机一致）。 */
  phoneRelayUrl?: string;
  /** 备用通道（阶段 ②）：手机侧备用公网地址（如 `wss://relay.whomidas.cn/ws`；空 = 不进配对票）。 */
  phoneRelayFallbackUrl?: string;
  /** 备用上行是否启用（主机额外挂在**本机中继**上，供 ECS 挂掉时顶替）。 */
  fallbackEnabled?: boolean;
  /** 各通道上行的实时状态（key = 通道 id：lan / primary / builtin / …）。 */
  channels?: Array<{ key: string } & Omit<RelayStatus, "mobileRelayUrl" | "phoneRelayUrl">>;
  /** S5：面板编辑用的生效通道列表（`hostUrl` 为**推导后**的实际值；不回传 token，只给 `hasToken`）。 */
  relayChannels?: RelayChannelRow[];
  /** S5：选路模式（manual = 只用选中那条；auto = 全部启用）。 */
  relayMode?: "manual" | "auto";
  /** S5：手动模式下选中的通道 id。 */
  activeChannelId?: string;
  /** 生效来源：`builtin` = 内置服务器（地址不外显）/ `custom` = 用户自己的中继。 */
  source?: "builtin" | "custom";
};

/** S5：渲染层通道行（`tokenDraft` 仅渲染层用：留空 = 保持现有 token，见 config.updateConfig）。 */
export type RelayChannelRow = {
  id: string;
  label: string;
  phoneUrl: string;
  hostUrl: string;
  hostUrlConfigured: boolean;
  hasToken: boolean;
  enabled: boolean;
  kind: "local" | "lan" | "remote";
  tokenDraft: string;
};

/** 局域网模式状态（P2）。 */
export type LanModeStatus = {
  enabled: boolean;
  url: string | null;
  attachmentBase: string | null;
  localUrl: string | null;
  port: number;
  address: string | null;
  bindHost: string;
  advertiseLan: boolean;
  lastError: string | null;
};

/** 中继托管的手机 App 安装包清单（/download/mpi-android.json）；中继不可达时
 *  主进程会回退到缓存副本（stale=true）并只提供 GitHub 备选源。 */
export type PhoneAppInfo =
  | {
      ok: true;
      stale: boolean;
      error: string | null;
      version: string;
      size: number;
      sha256: string;
      publishedAt: string;
      url: string;
      github: string;
    }
  | { ok: false; error: string };

export function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function pairingUri(pairing: Pairing): string {
  return `mpi://pair?payload=${base64Url(JSON.stringify(pairing))}`;
}

/** wss://host:port/ws → https://host:port（手机能直接打开的 HTTP 源）。 */
export function relayOrigin(relayUrl: string): string | null {
  try {
    const url = new URL(relayUrl);
    const scheme = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
    return `${scheme}//${url.host}`;
  } catch {
    return null;
  }
}

/** 扫码用的配对地址。用 https 链接而不是 mpi://：系统相机与绝大多数扫码器只把
 *  未知 scheme 当文本显示，而 https 链接可以直接打开——PWA 读到 #pair= 即自动
 *  开始配对，已装安卓壳则被壳的 VIEW 过滤器接管。无中继时回退到 mpi:// 链接。
 *
 * ⚠ payload 只放配对必需字段：完整对象（含 hostPublicKeyPem PEM/fingerprint/
 * signalingUrl/stunUrls）序列化后 ~650 字符 → QR version≈25（97×97 模块），
 * 手机扫码器在笔记本屏幕距离上基本识别不了（真机 bug）。精简后 ~270 字符 →
 * version 5-6，任何距离都能扫。PWA 的 parsePairingLink 对这些字段本就全部可选
 * （relay 流程的主机 E2E 公钥由 pair.accepted 下发，不从二维码取）。 */
export function pairingScanUrl(pairing: Pairing, relayHttp: string | null): string {
  const minimal = {
    hostId: pairing.hostId,
    ticket: pairing.ticket,
    expiresAt: pairing.expiresAt,
    protocol: pairing.protocol,
    ...(pairing.relayUrl ? { relayUrl: pairing.relayUrl } : {}),
    ...(pairing.hostName ? { hostName: pairing.hostName } : {}),
  };
  const payload = base64Url(JSON.stringify(minimal));
  return relayHttp ? `${relayHttp}/#pair=${payload}` : pairingUri(pairing);
}

/** 手机（没有 Tailscale）大概率连不上的地址：tailnet 域名 / 100.x CGNAT / 内网段。 */
export function unreachableForPhone(url: string): boolean {
  const value = (url || "").trim();
  if (!value) return false;
  return (
    /\.ts\.net\b/i.test(value) ||
    /\/\/(100\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.)/.test(value)
  );
}

export function statusClass(state: string): string {
  return ["connected", "connecting", "error", "disabled"].includes(state) ? state : "disabled";
}

export function statusLabel(state: string, zh: boolean): string {
  if (zh) {
    if (state === "connected") return "已连接";
    if (state === "connecting") return "连接中";
    if (state === "error") return "连接错误";
    return "未连接";
  }
  if (state === "connected") return "Connected";
  if (state === "connecting") return "Connecting";
  if (state === "error") return "Connection error";
  return "Not connected";
}

/** 通道圆点颜色（服务器面板的通道列表与状态行共用）。 */
export function channelDotColor(row: RelayChannelRow, state: string | undefined): string {
  if (row.id === "lan" || state === "connected") return "#3fb950";
  if (state === "connecting") return "#d29922";
  if (state === "error") return "#f85149";
  return row.enabled ? "#8b95a5" : "#4b5563";
}
