/**
 * 中继通道模型（实施计划-C档多通道.md §三）。
 *
 * 把「中继地址」从**两个固定字段**升级为**通道列表 + 模式**：
 *
 *   RelayChannel[]       每条通道：手机侧地址（进配对票）+ 主机侧上行（可推导）+ 可选准入 token
 *   relayMode = manual   只挂「选中那条」——行为可预期、开销最小
 *   relayMode = auto     每条启用的通道都挂上，票里带全部地址（由设备端选路）
 *
 * 设计要点：
 *  · **能推导的就不让用户填**：`kind=local|lane` 的上行由上下文推导（见 `hostUrlFor`），
 *    因此常见情况下一条通道只需填 1 个地址。
 *  · **不删旧字段**：`fromLegacy()` 只读合成；用户首次保存时才落盘（`relayChannelsVersion`）。
 *  · **同址只允许一条**：同一主机上行地址启用两次 = 同 hostId 在同一中继注册两次会互顶
 *    （见 `validateChannels`）。
 *
 * 本模块只做纯计算，不碰 IPC / 网络，便于单测钉住行为。
 */

/** 通道类型：决定主机上行地址怎么推导。 */
export type RelayChannelKind = "local" | "lan" | "remote";

export interface RelayChannel {
  /** 稳定 id（迁移与引用用；不含特殊字符）。 */
  id: string;
  /** 显示名（「本机（CF）」「ECS」「局域网」）。 */
  label: string;
  /** 手机侧地址（公网可达；写进配对票）。 */
  phoneUrl: string;
  /** 主机侧上行地址。**留空 = 按 kind 推导**。 */
  hostUrl?: string;
  /** 准入 token（只用于 host→relay 注册，绝不进配对票）。 */
  token?: string;
  /** 列表中可临时关掉。 */
  enabled: boolean;
  kind: RelayChannelKind;
}

export type RelayMode = "manual" | "auto";

/** 推导上下文（由主进程从运行时状态与配置取）。 */
export interface ChannelContext {
  /** 本机中继端口。 */
  localRelayPort: number;
  /** 局域网广告地址（`lanModeStatus().url`；未开启局域网时为 null）。 */
  lanPhoneUrl: string | null;
  /** 局域网内网 IP（`lanModeStatus().address`；取不到为 null）。 */
  lanAddress: string | null;
}

/** 只关心公网通道时的占位上下文（自更新源推导用不上局域网信息：local/lan 通道都不算镜像源）。 */
export const REMOTE_CHANNEL_CTX: ChannelContext = { localRelayPort: 0, lanPhoneUrl: null, lanAddress: null };

/** `ws(s)://host:port/path` → 同 host 的另一种协议（ws↔wss）。解析失败返回 null。 */
export function flipScheme(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "ws:") parsed.protocol = "wss:";
    else if (parsed.protocol === "wss:") parsed.protocol = "ws:";
    else return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * 主机侧上行地址：显式填了就用；否则按 `kind` 推导。
 *
 * - `local` → `ws://127.0.0.1:<port>/ws`（本机中继；S0 起常驻）
 * - `lan`   → `ws://<内网IP>:<port>/ws`
 * - 其它    → 用 `phoneUrl` 原样（可能不是主机直达地址，需要用户显式填 `hostUrl`）
 */
export function hostUrlFor(channel: RelayChannel, ctx: ChannelContext): string {
  const explicit = (channel.hostUrl || "").trim();
  if (explicit) return explicit;
  if (channel.kind === "local") return `ws://127.0.0.1:${ctx.localRelayPort}/ws`;
  if (channel.kind === "lan") {
    return ctx.lanAddress ? `ws://${ctx.lanAddress}:${ctx.localRelayPort}/ws` : "";
  }
  return (channel.phoneUrl || "").trim();
}

/**
 * 旧的固定字段 → 通道列表（**只读合成**，不写回配置）。
 *
 * 旧字段：`remoteRelayUrl`（主机上行/主中继）、`mobileRelayUrl`（手机地址）、
 * `remoteRelayToken`、`remoteRelayFallbackEnabled`、`mobileRelayFallbackUrl`。
 */
export function fromLegacy(legacy: {
  remoteRelayUrl?: string;
  mobileRelayUrl?: string;
  remoteRelayToken?: string;
  remoteRelayFallbackEnabled?: boolean;
  mobileRelayFallbackUrl?: string;
}): RelayChannel[] {
  const channels: RelayChannel[] = [];
  const hostUrl = (legacy.remoteRelayUrl || "").trim();
  const phoneUrl = (legacy.mobileRelayUrl || "").trim() || hostUrl;
  if (hostUrl || phoneUrl) {
    channels.push({
      id: "primary",
      label: "主中继",
      phoneUrl,
      // 旧字段里主机上行是显式值 → 保留（可能是 tailnet wss，与手机地址不同）
      ...(hostUrl ? { hostUrl } : {}),
      ...(legacy.remoteRelayToken ? { token: legacy.remoteRelayToken } : {}),
      enabled: true,
      kind: "remote",
    });
  }
  const fallbackPhone = (legacy.mobileRelayFallbackUrl || "").trim();
  const fallbackEnabled = legacy.remoteRelayFallbackEnabled !== false;
  // 只有「确实配过中继」时才合成本机通道：全新安装（什么都没配）不该凭空多出一条。
  if (fallbackEnabled && (hostUrl || phoneUrl || fallbackPhone)) {
    channels.push({
      id: "local",
      label: "本机（CF）",
      phoneUrl: fallbackPhone,
      // 留空 → 推导为 ws://127.0.0.1:<port>/ws
      enabled: true,
      kind: "local",
    });
  }
  return channels;
}

/** 局域网通道（由运行时状态合成，不进配置）。 */
export function lanChannel(ctx: ChannelContext): RelayChannel | null {
  if (!ctx.lanPhoneUrl) return null;
  return {
    id: "lan",
    label: "局域网直连",
    phoneUrl: ctx.lanPhoneUrl,
    enabled: true,
    kind: "lan",
  };
}

/**
 * 生效的通道列表：配置里的（或旧字段合成的）+ 运行时合成的局域网通道。
 * 局域网**排在最前**（同网段最快，设备端按序选路时优先）。
 */
export function effectiveChannels(stored: RelayChannel[] | undefined, legacy: Parameters<typeof fromLegacy>[0], ctx: ChannelContext): RelayChannel[] {
  const base = stored && stored.length ? stored : fromLegacy(legacy);
  const lan = lanChannel(ctx);
  return lan ? [lan, ...base] : [...base];
}

/** 模式决定主机要挂哪几条：手动 = 选中那条；自动 = 全部启用。 */
export function uplinkChannels(channels: RelayChannel[], mode: RelayMode, activeChannelId?: string): RelayChannel[] {
  if (mode === "manual") {
    const active = channels.find((c) => c.id === activeChannelId) || channels.find((c) => c.enabled);
    return active ? [active] : [];
  }
  return channels.filter((c) => c.enabled);
}

/**
 * 配对票里给手机的地址（有序）。
 * 自动模式带**全部**（局域网优先）；手动模式只带选中那条。
 * 空地址一律剔除（例如本机通道还没填公网域名时）。
 */
/**
 * 桌面自更新用的中继来源：取**第一条启用的公网（remote）通道**的主机上行地址。
 *
 * 为什么不能用旧的 `remoteRelayUrl`：S5 之后中继由通道列表管理，那个字段在新装机上是空字符串
 * —— 结果是自更新直接跳过中继镜像去查 GitHub，而小版本不推 GitHub，于是「检查更新」
 * 永远停在旧版本号（2026-10-09 minibox 实测：当前 0.9.11，却显示“最新版本 v0.9.7”）。
 *
 * 只取 remote：local 是 `ws://127.0.0.1:<port>`（回环地址做不了镜像源），
 * lan 是内网地址（换个网络就打不开）。
 */
export function pickRelayFeedUrl(channels: RelayChannel[], ctx: ChannelContext): string {
  for (const channel of channels) {
    if (!channel.enabled || channel.kind !== "remote") continue;
    const url = hostUrlFor(channel, ctx);
    if (url) return url;
  }
  return "";
}

export function ticketAddresses(channels: RelayChannel[], mode: RelayMode, activeChannelId?: string): string[] {
  const picked = mode === "manual" ? uplinkChannels(channels, mode, activeChannelId) : channels.filter((c) => c.enabled);
  return picked.map((c) => (c.phoneUrl || "").trim()).filter(Boolean);
}

export interface ChannelProblem {
  channelId: string;
  reason: string;
}

/**
 * 校验（保存时用）：
 *  1. 同一**主机上行地址**只允许一条启用——否则同 hostId 会在同一中继注册两次、互相顶掉；
 *  2. 手机地址为空且模式需要它 → 提示。
 */
export function validateChannels(channels: RelayChannel[], ctx: ChannelContext, mode: RelayMode): ChannelProblem[] {
  const problems: ChannelProblem[] = [];
  for (const channel of channels) {
    if (channel.id === "lan") continue; // 运行时合成，不参与校验
    // 注：**不再**报「主机上行地址重复」。同一台中继可以配多条通道，只暴露不同的手机地址
    // （典型场景：同一台上再提供 TLS 与明文两个入口 —— PWA 只能连 wss，原生 App 走明文）。
    // 运行期 `applyRelayUplinkConfig` 已按 hostUrl 去重、只挂**先出现**的那条 uplink，
    // 所以同址不会真的注册两次（2026-10-09：ECS 中继同时监听 9443/TLS + 10445/明文）。
    if (channel.enabled && mode === "auto" && !(channel.phoneUrl || "").trim()) {
      problems.push({ channelId: channel.id, reason: "自动模式下每条启用的通道都要有手机地址（否则票里带不上它）" });
    }
  }
  return problems;
}
