/**
 * 多通道选路（S4，见 实施计划-C档多通道.md §六之二）。
 *
 * 规则（两端一致）：
 *   候选顺序 = **上次可用的优先** → 票里 `relayUrls` 原序（局域网已由主机置顶）→ 单值 `relayUrl`
 *   逐条尝试、每条短超时；成功后把该地址写回 `lastGoodRelayUrl`，下次从它开始。
 *
 * 这里只放**纯函数**：顺序计算与「逐条试、超时降级」的循环骨架（注入连接函数，便于单测）。
 */

/** 从记录/载荷里算出候选地址顺序（去空、去重、上次可用优先）。 */
export function relayCandidates(input: { relayUrl?: string; relayUrls?: string[]; lastGoodRelayUrl?: string }): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const push = (raw?: string) => {
    const url = (raw || "").trim();
    if (!url || seen.has(url)) return;
    seen.add(url);
    ordered.push(url);
  };
  push(input.lastGoodRelayUrl);
  for (const url of input.relayUrls ?? []) push(url);
  push(input.relayUrl);
  return ordered;
}

/** 本次连接该用哪个地址（重连热路径）：上次可用的优先，否则候选首位。 */
export function pickRelayUrl(input: { relayUrl: string; relayUrls?: string[]; lastGoodRelayUrl?: string }): string {
  const candidates = relayCandidates(input);
  return candidates[0] || input.relayUrl;
}

export interface AttemptResult<T> {
  /** 成功的地址。 */
  url: string;
  value: T;
  /** 失败过的地址（诊断/展示用）。 */
  failed: string[];
}

/**
 * 逐条尝试，直到某条成功；每条独立超时。
 *
 * @param attempt  注入的连接函数：拿到 url，返回一个在成功/失败时 resolve/reject 的 Promise
 *                 （真实实现里 = 建 RelayClient 并等首个 open 或超时）。
 * @param timeoutMs 每条的超时（默认 4000ms：局域网几乎瞬连、ECS/CF 慢一点也够）。
 */
export async function connectFirstReachable<T>(
  candidates: string[],
  attempt: (url: string) => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<AttemptResult<T>> {
  const timeoutMs = options.timeoutMs ?? 4000;
  const failed: string[] = [];
  let lastError: unknown = null;
  for (const url of candidates) {
    try {
      const value = await withTimeout(attempt(url), timeoutMs, `连接超时（${timeoutMs}ms）：${url}`);
      return { url, value, failed };
    } catch (error) {
      failed.push(url);
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`所有通道都连不上（试过 ${candidates.length} 个）`);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
