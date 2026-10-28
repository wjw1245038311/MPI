/**
 * 「这一轮 prompt 从哪里来」的单一来源（P1c）。
 *
 * 为什么需要：远程策略（凭据分级、以后的确认卡片）必须知道是人坐在主机前发的，
 * 还是手机/网页/聊天通道发来的。以前 `prompt` 链路完全没有来源概念。
 *
 * 约定（沿用 2026-09-28 「videos 被静默吞掉」的教训）：**形参一律必填但可为
 * `undefined`**（`source: PromptSource | undefined`），这样新增/漏传在编译期就爆，
 * 不会像可选参数那样静默少传。
 *
 * 目前只做「记录最近一次来源」：P1c 阶段策略本身在 spawn 时就按凭据级别定死了
 * （只有 silent 级进环境变量），source 是给 P2 的确认卡片与审计用的地基。
 */

export type PromptSource =
  | { kind: "desktop" }
  | { kind: "remote"; deviceId: string }
  | { kind: "channel"; channel: string };

const lastSource = new Map<string, PromptSource>();

/** 记录某线程最近一次 prompt 的来源（按线程 id；切线程不影响其它线程）。 */
export function notePromptSource(threadId: string, source: PromptSource | undefined): void {
  if (!threadId || !source) return;
  lastSource.set(threadId, source);
}

/** 取最近一次来源；没记录过返回 undefined（旧客户端/内部调用）。 */
export function lastPromptSource(threadId: string): PromptSource | undefined {
  return lastSource.get(threadId);
}

/** 审计/日志用的短标签（不含敏感信息）。 */
export function promptSourceTag(source: PromptSource | undefined): string {
  if (!source) return "unknown";
  if (source.kind === "desktop") return "desktop";
  if (source.kind === "remote") return `remote:${source.deviceId.slice(0, 8)}`;
  return `channel:${source.channel}`;
}

/** 测试用。 */
export function __clearPromptSources(): void {
  lastSource.clear();
}
