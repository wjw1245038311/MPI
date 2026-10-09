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

/**
 * 页面是不是安全上下文（HTTPS / localhost）。
 *
 * 为什么需要：**HTTPS 页面里浏览器会直接拦掉 `ws://`（混合内容）**，它永远不会成功。
 * 不跳过的代价不只是报错 —— 它会白占一个候选位，让降级看门狗干等一整个超时
 * （2026-10-09 实测：minibox 上每刷新一次就要白等 8 秒才轮到 wss）。
 * node 测试环境没有 `location`，当作非安全上下文（不过滤）。
 */
function isSecureContext(): boolean {
  return typeof location !== "undefined" && location.protocol === "https:";
}

/** 从记录/载荷里算出候选地址顺序（去空、去重、上次可用优先；HTTPS 页面剔掉 `ws://`）。 */
export function relayCandidates(
  input: { relayUrl?: string; relayUrls?: string[]; lastGoodRelayUrl?: string },
  options: { secureContext?: boolean } = {},
): string[] {
  const secure = options.secureContext ?? isSecureContext();
  const seen = new Set<string>();
  const ordered: string[] = [];
  const push = (raw?: string) => {
    const url = (raw || "").trim();
    if (!url || seen.has(url)) return;
    if (secure && url.startsWith("ws://")) return; // 浏览器会拦，跳过
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

/**
 * S4 缺口补齐（降级重试用）：候选顺序不变，但去掉**已经试过**的地址。
 * 看门狗每超时一次就换下一条（逐条短超时），直到候选耗尽。
 */
export function remainingCandidates(
  input: { relayUrl?: string; relayUrls?: string[]; lastGoodRelayUrl?: string },
  tried: readonly string[],
  options: { secureContext?: boolean } = {},
): string[] {
  const done = new Set(tried.map((url) => (url || "").trim()));
  return relayCandidates(input, options).filter((url) => !done.has(url));
}

/** 本次连接该用哪个地址（重连热路径）：候选首位 = 主机首选；旧记录则回落上次可用。 */
export function pickRelayUrl(
  input: { relayUrl: string; relayUrls?: string[]; lastGoodRelayUrl?: string },
  options: { secureContext?: boolean } = {},
): string {
  const candidates = relayCandidates(input, options);
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
