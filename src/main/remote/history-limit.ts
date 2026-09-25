/**
 * 手机端历史下发上限（纯逻辑，便于单测）。
 *
 * 背景：这里原来写死 `slice(-80)`，是用户「对话往上拉不动」的直接原因——
 * 更早的消息根本没下发给手机。现在放宽到 400 条，并用字节预算兜底：
 * 超大历史（多轮长工具输出/图片）从最旧的开始丢，保证单帧远低于 relay 的
 * MAX_FRAME_BYTES(32MB) 与手机端的解码/内存能力。
 */
import type { RemoteMessage } from "./protocol";

/**
 * 原始 pi 条目上限（含 toolResult / 中间 assistant 消息）。
 *
 * ⚠️ 这不是"用户能看到多少"——一个回合里 agent 可能产生上百条 toolResult，
 * 它们会被 remoteMessages() 折叠进同一个 assistant 回合。2026-09-16 真机取证：
 * total=400 原始条目 → rendered=17 条会话消息，用户「往上拉两页就不行」。
 * 所以这里要放宽（只为控制解析成本），能拉多远由 MAX_RENDERED_MESSAGES 决定。
 */
export const MAX_REMOTE_RAW_MESSAGES = 6000;

/** 下发到手机的会话条目上限——**这个才是"能往上拉多远"**。 */
export const MAX_RENDERED_MESSAGES = 300;

/**
 * 客户端「解密后的内层 envelope」硬上限。
 *
 * 2026-09-25 从 2MB 提到 **8MB**（A′ 第 3 步）：先把两侧客户端都提到 8MB 并确认可用
 * （见 [CLIENT_MAX_ENVELOPE_BYTES]），最后才改这里。此刻 net 预算从 1.6MB 变成 7.6MB，
 * 那个 899 条会话（完整约 2.05MB）因此**不再被裁剪**。
 *
 * ⚠️ 这个值不能超过客户端愿接受的上限：客户端在 `Envelope.parse` 里对解密的明文
 * envelope 做硬校验，**超了一律抛 PAYLOAD_TOO_LARGE 丢帧**。2026-09-24 真机取证：
 * 历史涨到 2.02MB 后，`thread.subscribe` 的响应每一条都被手机丢掉 → 10s 超时 →
 * 重握手 → 订阅被清 → 再订阅……形成 ~10s 一轮的重连风暴。
 * `scripts/test-remote-history-limit.mjs` 断言本条 ≤ 客户端实际值。
 */
export const MAX_INNER_ENVELOPE_BYTES = 8_000_000;

/** 给 envelope 其它字段（sessionId/model/thinkingLevels…）与 JSON 转义留的余量。 */
export const SNAPSHOT_HEADROOM_BYTES = 400_000;

/**
 * 单次历史响应的净字节预算（估算值，用于快速预裁）。
 *
 * 必须**低于**手机端硬上限并留出余量；`remoteMessageSize` 只是个估算
 * （不计 JSON 转义与字段名），真正的硬保证由 [trimRemoteHistoryByEncodedSize]
 * 用实际序列化长度完成。
 */
export const REMOTE_HISTORY_BYTE_BUDGET = MAX_INNER_ENVELOPE_BYTES - SNAPSHOT_HEADROOM_BYTES;

/** 估算单条消息下发后的字节数（正文长度 + 图片 base64 长度 + 固定开销）。 */
export function remoteMessageSize(message: RemoteMessage): number {
  let size = 200;
  for (const block of message.blocks || []) {
    size += (block.text?.length || 0) + (block.result?.length || 0) + (block.data?.length || 0) + 40;
  }
  size += message.text?.length || 0;
  return size;
}

/** 条数上限：从最新往回保留 MAX_RENDERED_MESSAGES 条会话条目。 */
export function capRenderedHistory(messages: RemoteMessage[]): RemoteMessage[] {
  return messages.length > MAX_RENDERED_MESSAGES ? messages.slice(-MAX_RENDERED_MESSAGES) : messages;
}

/** 从最旧的开始丢，直到总量进预算（**至少保留最后一条**——空历史比超预算更糟）。 */
export function trimRemoteHistory(
  messages: RemoteMessage[],
  budget = REMOTE_HISTORY_BYTE_BUDGET,
): RemoteMessage[] {
  const sizes = messages.map(remoteMessageSize);
  let total = sizes.reduce((sum, size) => sum + size, 0);
  let start = 0;
  while (start < messages.length - 1 && total > budget) {
    total -= sizes[start];
    start += 1;
  }
  return start === 0 ? messages : messages.slice(start);
}

/**
 * 按**真实序列化长度**兜底裁剪——这是「单帧一定进得了手机端上限」的硬保证。
 *
 * 为什么不能只靠 [trimRemoteHistory]：`remoteMessageSize` 是估算，不计 JSON 转义
 * （代码/多行文本里的换行、引号会翻倍）、字段名与 envelope 其它字段。2026-09-24
 * 真机事故就是估算 2.02MB 而实际 envelope 更大，手机整帧丢弃。
 *
 * 从最旧的开始丢（至少保留最后一条）。复杂度 O(总字节)：每条只 stringify 一次。
 */
export function trimRemoteHistoryByEncodedSize(
  messages: RemoteMessage[],
  limit = MAX_INNER_ENVELOPE_BYTES - SNAPSHOT_HEADROOM_BYTES,
): RemoteMessage[] {
  if (messages.length <= 1) return messages;
  const sizes = messages.map((message) => JSON.stringify(message).length + 1); // +1 = 数组逗号
  let total = sizes.reduce((sum, size) => sum + size, 0) + 2; // +2 = []
  let start = 0;
  while (start < messages.length - 1 && total > limit) {
    total -= sizes[start];
    start += 1;
  }
  return start === 0 ? messages : messages.slice(start);
}

/**
 * 客户端**能接受**的上限（= `Envelope.kt` 的 `MAX_ENVELOPE_BYTES` / PWA protocol.ts 的校验值）。
 *
 * 2026-09-25 决定：不做能力协商，改用**发布顺序**保证安全——
 * 先把两侧客户端都提到 8MB（此时主机仍只发 1.6MB，行为零变化），
 * 确认能正常用之后，最后一步才把主机侧 [MAX_INNER_ENVELOPE_BYTES] 也提到 8MB。
 * 这样不存在"主机发出客户端接不住的帧"的时间窗，也就不需要往协议里加字段。
 *
 * 中继实际允许 32MB（加密帧），传输层从来不是瓶颈：2MB 只是客户端自己写死的
 * 遗留值（`Envelope.kt` 的注释甚至写成"与 relay 的 MAX_FRAME_BYTES 一致"，差 16 倍）。
 */
export const CLIENT_MAX_ENVELOPE_BYTES = 8_000_000;

/** 收缩时每个字段保留的地板（低于此值就不再砍，避免把消息攒成空壳）。 */
const SHRINK_FLOOR = 2_000;
export const SHRINK_MARKER = "\n…[内容过大，已截断]";

const SHRINKABLE_KEYS = ["text", "result", "data"] as const;

/**
 * 单帧硬保证的第二级：裁剪后**仍**超预算时，收缩消息**内部**的块。
 *
 * 为什么必须有它：`trimRemoteHistoryByEncodedSize` 的出口是「至少保留最后一条」，
 * 所以当**单条消息自己**就超过预算时（模型吐一段几 MB 的思考、一个巨型工具结果），
 * 它只能原样放行 → 整帧超过客户端上限 → 客户端抛 `PAYLOAD_TOO_LARGE` 丢帧 →
 * `onStaleConnection` 重握手 → 2026-09-24 那场 ~10s 一轮的重连风暴。
 *
 * 在此之前这个出口是安全的，靠的是逐块上限本身（≤80 块 × 12,000 字符 + 图片 400KB
 * ≈ 单条 ≤1.36MB）。**去掉 thinking 的逐块上限后，那道隐式保证就没了**，所以由这里
 * 显式兜住：反复把「最大的可收缩字段」砍半，直到进预算或所有字段都到地板。
 *
 * 只动副本（不回写调用方对象）；复杂度 O(总字节) 一次 + 每轮 O(字段数)。
 */
export function shrinkToBudget<T extends RemoteMessage>(messages: T[], limit: number, maxPasses = 200): T[] {
  if (messages.length === 0) return messages;
  const copy = messages.map((message) => ({ ...message, blocks: message.blocks?.map((block) => ({ ...block })) })) as T[];
  const sizes = copy.map((message) => JSON.stringify(message).length + 1); // +1 = 数组逗号
  let total = sizes.reduce((sum, size) => sum + size, 0) + 2; // +2 = []

  for (let pass = 0; pass < maxPasses && total > limit; pass++) {
    let target: { index: number; path: string; length: number } | null = null;
    const consider = (index: number, path: string, value: unknown) => {
      if (typeof value !== "string" || value.length <= SHRINK_FLOOR) return;
      if (target && value.length <= target.length) return;
      target = { index, path, length: value.length };
    };
    copy.forEach((message, index) => {
      consider(index, "text", message.text);
      message.blocks?.forEach((block, blockIndex) => {
        for (const key of SHRINKABLE_KEYS) {
          consider(index, `blocks.${blockIndex}.${key}`, (block as Record<string, unknown>)[key]);
        }
      });
    });
    if (!target) break; // 所有字段都到地板了

    const slot = target as { index: number; path: string; length: number };
    const before = sizes[slot.index];
    const half = Math.max(SHRINK_FLOOR, Math.floor(slot.length / 2));
    if (slot.path === "text") {
      (copy[slot.index] as RemoteMessage).text = `${String(copy[slot.index].text).slice(0, half)}${SHRINK_MARKER}`;
    } else {
      const [, blockIndex, key] = slot.path.split(".");
      const block = copy[slot.index].blocks![Number(blockIndex)] as unknown as Record<string, unknown>;
      block[key] = `${String(block[key]).slice(0, half)}${SHRINK_MARKER}`;
    }
    sizes[slot.index] = JSON.stringify(copy[slot.index]).length + 1;
    total += sizes[slot.index] - before;
  }
  return copy;
}

/**
 * 快照兜底：**回合不在进行中**时，把工具块的 `running` 一律清掉。
 *
 * 为什么需要：`remoteMessages` 对没有 toolResult 的 toolCall 一律标 `running: true`。
 * 若该工具是被**中断**的（用户点停止 / 进程退出），toolResult 永远不会落到会话文件里，
 * 于是远程视图**每次重载都会显示一行永远转圈的工具**。真机数据里已存在实例：
 * 2026-09-23 那个 1755 条会话的 entry#821（孤儿 toolCall，位于会话中间）。
 *
 * 只在 `state !== "running"` 时清：线程正在跑时工具确实可能真在途，不能乱清。
 * （等价于「只有正在跑的回合才可能有在飞的工具」这个不变量。）
 */
export function settleToolsOutsideRunningTurn<T extends RemoteMessage>(messages: T[], state: string): T[] {
  if (state === "running") return messages;
  let touched = false;
  const out = messages.map((message) => {
    if (!message.blocks?.some((block) => block.type === "tool" && block.running)) return message;
    touched = true;
    return {
      ...message,
      blocks: message.blocks.map((block) => (block.type === "tool" && block.running ? { ...block, running: false } : block)),
    };
  });
  return touched ? out : messages;
}

/**
 * 下发前的完整裁剪流水线（主机侧**只**应该调这一个）。
 *
 * 顺序（便宜的先做）：
 *   1. 条数上限
 *   2. `trimRemoteHistory` —— 估算快速预裁
 *   3. `trimRemoteHistoryByEncodedSize` —— 按真实序列化长度丢最旧的
 *   4. `shrinkToBudget` —— **单帧硬保证**：还是超就收缩消息内部
 *
 * 返回值一定满足 `JSON.stringify(result).length <= limit`，除非连"地板级"的单条都
 * 塞不下（那时返回尽力而为的结果）。
 */
export function prepareRemoteHistory(
  messages: RemoteMessage[],
  limit = REMOTE_HISTORY_BYTE_BUDGET,
  rawLimit = MAX_RENDERED_MESSAGES,
): RemoteMessage[] {
  const stage1 = messages.length > rawLimit ? messages.slice(-rawLimit) : messages;
  const stage2 = trimRemoteHistory(stage1, limit);
  const stage3 = trimRemoteHistoryByEncodedSize(stage2, limit);
  return shrinkToBudget(stage3, limit);
}
