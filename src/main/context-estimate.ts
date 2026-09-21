/**
 * 压缩后上下文估算（CJK 感知）。
 *
 * pi 在压缩完成、下次有效 assistant usage 出现之前会把 contextUsage.tokens 报成 null，
 * 它自己给的 estimatedTokensAfter 用 chars/4 估算——中文场景低估约 3–4 倍。本模块从
 * 会话条目重建「便签 + 保留区」上下文，用与 smart-compact 相同的 CJK 感知
 * estimateTokens（mpi-smart-compact-ext.ts）重算真实 token 数：
 *
 *  - thread:open / fork / clone 响应携带 contextEstimate → renderer 合并时保留，
 *    重连/重启后不再显示 0；
 *  - compaction_end 之后异步补发修正值（context_estimate 事件 + 手机端 map），
 *    圆环压缩后立即显示真实占比，下次回复不再跳变。
 *
 * 分支遍历与上下文重建逐条镜像 pi 的 buildSessionPath / buildContextEntries /
 * getContextUsage（dist/core/session-manager.js、agent-session.js）。
 */

type Entry = { id?: string; type?: string; parentId?: string | null; [k: string]: unknown };

/**
 * CJK 感知 token 估算——与 mpi-smart-compact-ext.ts 的 estimateTokens 保持同步
 * （该文件以 ?raw 字符串形式交给 pi 加载、依赖 @earendil-works/pi-ai，不能直接 import；
 * 改权重时两处一起改）。
 */
function estimateTokens(text: string): number {
  let cjk = 0;
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (
      (cp >= 0x3000 && cp <= 0x9fff) || // CJK punctuation + unified ideographs (+ext A)
      (cp >= 0xf900 && cp <= 0xfaff) || // compatibility ideographs
      (cp >= 0xff00 && cp <= 0xffef) || // fullwidth forms
      (cp >= 0x20000 && cp <= 0x3fffd) // ext B+
    ) {
      cjk++;
    } else if (cp < 0x80) {
      ascii++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk * 0.8 + ascii / 4 + other * 0.75);
}

/** pi 把图片按 4800 chars / 4 计 → 1200 tokens，保持一致。 */
const IMAGE_TOKENS = 1200;

export type PostCompactionEstimate = { compactionId: string; tokens: number };

// ---------------------------------------------------------------------------
// 分支遍历（镜像 pi buildSessionPath）
// ---------------------------------------------------------------------------

export function branchPath(entries: Entry[], leafId: string | null): Entry[] {
  const byId = new Map<string, Entry>();
  for (const e of entries) if (e?.id) byId.set(e.id, e);
  let current: Entry | undefined = leafId ? byId.get(leafId) : undefined;
  current ??= entries[entries.length - 1];
  const path: Entry[] = [];
  while (current) {
    path.push(current);
    current = current.parentId ? byId.get(current.parentId as string) : undefined;
  }
  return path.reverse();
}

// ---------------------------------------------------------------------------
// pi getContextUsage 的守卫：压缩后是否已有有效 assistant usage？
// 有 → pi 会报真实 tokens，无需估算。
// ---------------------------------------------------------------------------

function hasPostCompactionUsage(path: Entry[], compactionIdx: number): boolean {
  for (let i = path.length - 1; i > compactionIdx; i--) {
    const e = path[i];
    if (e.type !== "message") continue;
    const m = e.message as any;
    if (!m || m.role !== "assistant") continue;
    if (m.stopReason === "aborted" || m.stopReason === "error") continue;
    const u = m.usage;
    if (!u) continue;
    const total = u.totalTokens || u.input + u.output + u.cacheRead + u.cacheWrite;
    if (typeof total === "number" && total > 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// CJK 感知 token 估算（结构镜像 pi estimateTokens，权重换成 estimateTokens）
// ---------------------------------------------------------------------------

/** user / toolResult / custom_message 的 content：字符串或 [text|image] 块。 */
function textImageContentTokens(content: unknown): number {
  if (typeof content === "string") return estimateTokens(content);
  let tokens = 0;
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as any;
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string") tokens += estimateTokens(b.text);
      else if (b.type === "image") tokens += IMAGE_TOKENS;
    }
  }
  return tokens;
}

function messageTokens(m: any): number {
  if (!m || typeof m !== "object") return 0;
  switch (m.role) {
    case "user":
    case "toolResult":
    case "custom":
      return textImageContentTokens(m.content);
    case "assistant": {
      let tokens = 0;
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          const b = block as any;
          if (!b || typeof b !== "object") continue;
          if (b.type === "text" && typeof b.text === "string") tokens += estimateTokens(b.text);
          else if (b.type === "thinking" && typeof b.thinking === "string") tokens += estimateTokens(b.thinking);
          else if (b.type === "toolCall") {
            let args = "";
            try {
              args = JSON.stringify(b.arguments ?? {});
            } catch {
              args = String(b.arguments ?? "");
            }
            tokens += estimateTokens(String(b.name ?? "") + args);
          }
        }
      } else if (typeof m.content === "string") {
        tokens += estimateTokens(m.content);
      }
      return tokens;
    }
    case "bashExecution":
      return estimateTokens(`${m.command ?? ""}\n${m.output ?? ""}`);
    default:
      return 0;
  }
}

/** 单个会话条目折算的上下文 token（镜像 pi sessionEntryToContextMessages）。 */
function entryTokens(e: Entry): number {
  switch (e.type) {
    case "message":
      return messageTokens((e as any).message);
    case "custom_message":
      // 注意：普通 custom 条目是展示/状态条目，不进上下文（pi 返回 []）。
      return textImageContentTokens((e as any).content);
    case "branch_summary": {
      const s = (e as any).summary;
      return typeof s === "string" ? estimateTokens(s) : 0;
    }
    case "compaction": {
      const s = (e as any).summary;
      return typeof s === "string" ? estimateTokens(s) : 0;
    }
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// 主入口（纯函数，可单测）
// ---------------------------------------------------------------------------

/**
 * 从会话条目计算压缩后上下文 token 估算。
 * 返回 undefined = 无需修正：分支上没有 compaction，或压缩后已有有效 assistant usage
 * （pi 会报真实 tokens）。
 */
export function postCompactionEstimateFromEntries(
  entries: unknown,
  leafId: string | null | undefined,
): PostCompactionEstimate | undefined {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const list = (entries as Entry[]).filter((e) => e && typeof e === "object" && e.type !== "session");
  const path = branchPath(list, typeof leafId === "string" ? leafId : null);
  if (path.length === 0) return undefined;
  // 要分支上最新的 compaction（镜像 getLatestCompactionEntry）。
  let latestIdx = -1;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].type === "compaction") {
      latestIdx = i;
      break;
    }
  }
  if (latestIdx < 0) return undefined;
  const compaction = path[latestIdx] as any;
  if (!hasPostCompactionUsage(path, latestIdx)) {
    // 重建上下文：[compaction] + firstKeptEntryId 起至压缩前 + 压缩后全部（镜像 buildContextEntries）。
    let tokens = entryTokens(compaction);
    let foundFirstKept = false;
    for (let i = 0; i < latestIdx; i++) {
      const e = path[i];
      if (e.id === compaction.firstKeptEntryId) foundFirstKept = true;
      if (foundFirstKept) tokens += entryTokens(e);
    }
    for (let i = latestIdx + 1; i < path.length; i++) tokens += entryTokens(path[i]);
    return { compactionId: String(compaction.id ?? ""), tokens };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 「更早的对话」——活跃上下文之外的分支条目（供 UI 展示，只读）
// ---------------------------------------------------------------------------

/**
 * 计算分支上「更早的对话」条目：pi buildContextEntries 省略掉的那部分。
 * 镜像 pi 语义：分支上有 compaction 时，活跃 = [最新压缩] + firstKeptEntryId..压缩前
 * + 压缩后全部；更早 = firstKeptEntryId 之前的全部（含更旧的消息与更旧的摘要）。
 * 无 compaction → 空数组。多次压缩自然支持（旧摘要都在保留区之前）。
 */
export function earlierEntriesFromEntries(entries: unknown, leafId?: string | null): Entry[] {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const list = (entries as Entry[]).filter((e) => e && typeof e === "object" && e.type !== "session");
  const path = branchPath(list, typeof leafId === "string" ? leafId : null);
  let latestIdx = -1;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].type === "compaction") {
      latestIdx = i;
      break;
    }
  }
  if (latestIdx < 0) return [];
  const compaction = path[latestIdx] as any;
  let firstKeptIdx = -1;
  for (let i = 0; i < latestIdx; i++) {
    if (path[i].id === compaction?.firstKeptEntryId) {
      firstKeptIdx = i;
      break;
    }
  }
  // firstKeptEntryId 不在路径上 → 活跃无保留区，压缩前全部算「更早」。
  return path.slice(0, firstKeptIdx >= 0 ? firstKeptIdx : latestIdx);
}

/**
 * 「更早的对话」条目 → 可展示消息（镜像 pi sessionEntryToContextMessages）：
 * message 原样、custom_message/branch_summary/compaction 转伪消息。
 * 返回顺序 = 时间序，可直接喂给 renderer 的 historyToView。
 */
export function earlierDisplayMessages(entries: unknown, leafId?: string | null): any[] {
  const out: any[] = [];
  for (const e of earlierEntriesFromEntries(entries, leafId)) {
    if (e.type === "message" && e.message) {
      out.push(e.message);
    } else if (e.type === "custom_message") {
      // pi createCustomMessage 形状
      out.push({
        role: "custom",
        customType: e.customType,
        content: e.content ?? [],
        display: e.display,
        details: e.details,
        timestamp: typeof e.timestamp === "string" ? new Date(e.timestamp).getTime() : (e.timestamp as number),
      });
    } else if (e.type === "branch_summary" && e.summary) {
      // pi createBranchSummaryMessage 形状
      out.push({ role: "branchSummary", summary: e.summary, fromId: e.fromId, timestamp: typeof e.timestamp === "string" ? new Date(e.timestamp).getTime() : (e.timestamp as number) });
    } else if (e.type === "compaction") {
      // pi createCompactionSummaryMessage 形状（renderer 渲染成分隔条）
      out.push({ role: "compactionSummary", summary: e.summary, tokensBefore: e.tokensBefore, timestamp: typeof e.timestamp === "string" ? new Date(e.timestamp).getTime() : (e.timestamp as number) });
    }
    // 其它条目（session/model_change/…）不进上下文，跳过。
  }
  return out;
}

// ---------------------------------------------------------------------------
// 异步包装：经 bridge.getEntries() 取条目，按 threadId+compactionId 缓存
// （compaction_end 修正与手机端轮询共用；新压缩 → 新 id → 自动失效）。
// ---------------------------------------------------------------------------

const cache = new Map<string, PostCompactionEstimate>();
const CACHE_MAX = 100;

/**
 * 经 bridge.getEntries() 计算并缓存（按 threadId）。
 * - 默认命中即返回，不再取条目（手机端轮询路径：避免反复序列化大会话）；
 *   新压缩发生时 compaction_end 修正路径会带 refresh:true 强制重算，所以缓存不会陈旧。
 * - 分支上无 compaction / 已有有效 usage → 不写缓存（状态临近变化，下次再算）。
 */
export async function cachedPostCompactionEstimate(
  bridge: { getEntries(): Promise<unknown> },
  threadId: string,
  opts?: { refresh?: boolean },
): Promise<PostCompactionEstimate | undefined> {
  if (!opts?.refresh) {
    const hit = cache.get(threadId);
    if (hit) return { ...hit };
  }
  const res: any = await bridge.getEntries();
  const entries = Array.isArray(res?.entries) ? res.entries : [];
  const leafId = typeof res?.leafId === "string" ? res.leafId : null;
  const fresh = postCompactionEstimateFromEntries(entries, leafId);
  if (fresh) {
    cache.set(threadId, fresh);
    while (cache.size > CACHE_MAX) {
      const firstKey = cache.keys().next().value;
      if (firstKey === undefined) break;
      cache.delete(firstKey);
    }
  }
  return fresh;
}
