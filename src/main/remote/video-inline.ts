/**
 * 快照里视频字节的**内联判定**（纯逻辑，便于单测）。
 *
 * 背景（2026-09-28）：视频字节不再一律内联。小视频照旧内联（开箱即播、零往返），
 * 大视频只留 `name` + `size` 的占位块，客户端点开时按需拉（`attachment.fetch`）。
 * 这条判定有四个容易写错的地方，所以从 ipc.ts 里抽出来单独测：
 *
 *   1. **size 必须无条件写入**，哪怕不下发字节——懒加载卡片的尺寸/进度条全靠它；
 *   2. 预算按**最新优先**分配（列表是从末尾往前遍历），否则用户最近发的视频反而被省略；
 *   3. 读取失败（附件被清理）要说清是「没了」而不是「超出预算」——否则排查时会一直
 *      往预算方向查；
 *   4. 超过内联阈值时给的是「点开按需获取」而不是「未下发」：这两种措辞对应完全不同的
 *      客户端行为（可点开的卡片 vs 死占位）。
 */
import { REMOTE_VIDEO_INLINE_MAX_BYTES } from "./video-refs";

/** 一个待回填字节的视频块（由 ipc.ts 从 `pendingVideos` 映射而来）。 */
export interface InlineVideoCandidate {
  /** 磁盘上的绝对路径（附件区）。 */
  path: string;
  /** 附件原始字节数（大小未知时不调用）。 */
  setSize: (size: number) => void;
  /** base64 本体（决定内联时调用）。 */
  setData: (base64: string) => void;
  /** 给用户看的一句话说明（懒加载 / 已被清理时调用）。 */
  setNote: (text: string) => void;
}

export interface InlineVideoOptions {
  /** 读文件大小；文件不在 → 抛错（由调用方决定怎么处理）。 */
  sizeOf: (path: string) => number;
  /** 读整个文件为 base64。 */
  readBase64: (path: string) => string;
  /** 本次快照可用的 base64 预算（字符）。 */
  budget: number;
  /** 可内联的原始字节上限（默认取 video-refs.ts 的常量）。 */
  inlineMaxBytes?: number;
}

export interface InlineVideoResult {
  /** 内联成功的视频数与原始字节合计（写 diag 日志用）。 */
  inlinedCount: number;
  inlinedBytes: number;
}

/** 懒加载占位块上给用户看的一句话（超阈值与超预算要能区分开）。 */
export const LAZY_VIDEO_NOTE = "点开按需获取";
export const LAZY_VIDEO_NOTE_BUDGET = "点开按需获取（超出本次快照预算）";
export const MISSING_VIDEO_NOTE = "附件已被清理";

/**
 * 从**末尾往前**回填（候选人按消息顺序排列 → 倒序即最新优先）。
 *
 * 返回统计值；所有状态都通过 candidate 的 setter 写回，调用方不需要再判断。
 */
export function fillInlineVideoBytes(candidates: InlineVideoCandidate[], options: InlineVideoOptions): InlineVideoResult {
  const inlineMaxBytes = options.inlineMaxBytes ?? REMOTE_VIDEO_INLINE_MAX_BYTES;
  let budget = options.budget;
  let inlinedCount = 0;
  let inlinedBytes = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    let size = 0;
    try {
      size = options.sizeOf(candidate.path);
    } catch {
      candidate.setNote(MISSING_VIDEO_NOTE);
      continue;
    }
    if (size <= 0) {
      candidate.setNote(MISSING_VIDEO_NOTE);
      continue;
    }
    // 先把尺寸写进去：懒加载卡片与进度条都要它，与是否内联无关。
    candidate.setSize(size);
    if (size > inlineMaxBytes) {
      candidate.setNote(LAZY_VIDEO_NOTE);
      continue;
    }
    if (budget <= 0) {
      candidate.setNote(LAZY_VIDEO_NOTE_BUDGET);
      continue;
    }
    let data = "";
    try {
      data = options.readBase64(candidate.path);
    } catch {
      candidate.setNote(MISSING_VIDEO_NOTE);
      continue;
    }
    if (data.length > budget) {
      candidate.setNote(LAZY_VIDEO_NOTE_BUDGET);
      continue;
    }
    budget -= data.length;
    inlinedBytes += size;
    inlinedCount += 1;
    candidate.setData(data);
  }
  return { inlinedCount, inlinedBytes };
}
