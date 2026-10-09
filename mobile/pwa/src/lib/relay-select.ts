/**
 * 多通道选路（S4，见 实施计划-C档多通道.md §六之二；S6 起调整顺序规则）。
 *
 * 规则（两端一致）：
 *   候选顺序 = **主机下发的 `relayUrls` 原序**（首个 = 首选）→ `lastGoodRelayUrl` → 单值 `relayUrl`
 *     —— S6 起「**主机顺序优先**」：桌面改通道后手机重连即跟随，不再粘在「上次可用」那条上。
 *     `lastGoodRelayUrl` 退为**回落点**（上次降级连上的地址 / 旧记录里的唯一线索），排在主机列表之后。
 *   逐条尝试、每条短超时；全失败才报错。
 *
 * 这里只放**纯函数**：顺序计算、`host.info` 列表合并、与「逐条试、超时降级」的循环骨架
 * （注入连接函数，便于单测）。
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
  // S6：主机顺序优先（首个 = 首选）——「桌面选哪条、手机跟哪条」。
  for (const url of input.relayUrls ?? []) push(url);
  // 上次可用只作回落；主机列表缺失（旧记录）时它自然成为首位，S4 老行为不破。
  push(input.lastGoodRelayUrl);
  push(input.relayUrl);
  return ordered;
}

/**
 * S6：把主机 `host.info` 下发的**有序**通道列表合并进本地配对记录。
 *
 * - 顺序以主机为准（首个 = 首选）；去空、去重。
 * - `lastGoodRelayUrl` 只表示「上次**降级**连上的地址」：直连主机首选成功就清掉它，
 *   否则保留本次实际连上的那条（作为下次回落的快速入口）。
 * - 主机没给有效列表时原样返回（不动本地）。
 */
export function mergeHostRelayInfo<T extends { relayUrl?: string; relayUrls?: string[]; lastGoodRelayUrl?: string }>(
  record: T,
  hostRelayUrls: string[],
  options: { connectedUrl?: string } = {},
): T {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const raw of hostRelayUrls ?? []) {
    const url = (raw || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  if (urls.length === 0) return record;

  const primary = urls[0];
  const connected = (options.connectedUrl || "").trim();
  const next = { ...record, relayUrls: urls };
  const degraded = connected ? connected !== primary : (record.lastGoodRelayUrl || "").trim() !== primary;
  if (degraded) {
    next.lastGoodRelayUrl = connected || record.lastGoodRelayUrl;
  } else {
    delete (next as { lastGoodRelayUrl?: string }).lastGoodRelayUrl;
  }
  return next;
}

/** 本次连接该用哪个地址（重连热路径）：候选首位 = 主机首选；旧记录则回落上次可用。 */
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
