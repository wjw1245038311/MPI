/**
 * 远端快照里「消息 id」的生成规则。
 *
 * 为什么单独抽出来：这个 id **必须与客户端从事件里自己算出来的 id 一致**，否则
 * 增量快照的锚点（`haveMessageId`）永远对不上 → 每次打开会话都返回整段历史。
 * 2026-10-29 实测：PWA 每次开/每次重连都重下 311KB～1.6MB，界面像“全量刷新”。
 *
 * pi 的消息对象**没有 id**，但有 `timestamp`（用户消息、assistant、toolResult 全都有；
 * 同一角色同一毫秒出现两条的概率可忽略）。事件通道下发的就是同一个 message 对象，
 * 所以两端用同一条规则就能算出同一串：
 *
 *   客户端（事件）   主机（快照）
 *   user-<ts>   ←→  user-<ts>
 *   assistant-<ts> ←→ assistant-<ts>（主机把连续 assistant 条目折叠成一个回合，取**第一条**的时间戳）
 *   tool-<ts>   ←→  tool-<ts>
 *
 * 回退顺序：显式 id → `role-<timestamp>` → `role-<位置>`。最后这档只服务「没有时间戳的
 * 老条目」：同一台主机上仍然稳定，只是升级后首帧会失配一次（全量一次后自愈）。
 */

/** 一个远端消息条目的最小形状（只关心 id / timestamp）。 */
export interface RemoteMessageIdSource {
  id?: unknown;
  timestamp?: unknown;
}

export function remoteMessageId(message: RemoteMessageIdSource | null | undefined, role: string, index: number): string {
  const explicit = typeof message?.id === "string" ? message.id.trim() : "";
  if (explicit) return explicit;
  const ts = message?.timestamp;
  if (typeof ts === "number" && Number.isFinite(ts)) return `${role}-${ts}`;
  return `${role}-${index}`;
}

/**
 * 这个 id 是不是「主机发的」那种稳定 id（而不是客户端本地合成的）。
 *
 * 本地合成的一律不算锚点：乐观回显 `local-N`、流式占位 `a-N`、事件里补的用户消息
 * `u-N-M`。客户端拿它们去问 `haveMessageId` 必然 miss（主机的快照里根本没有）。
 */
export function isHostMessageId(id: string): boolean {
  if (!id) return false;
  if (id.startsWith("local-") || id.startsWith("a-") || id.startsWith("u-")) return false;
  return /^(user|assistant|system|tool)-/.test(id);
}
