/**
 * 快照里视频的**封面回填判定**（纯逻辑，便于单测）。
 *
 * 背景（2026-09-29，阶段2）：快照不再下发视频本体（那是几 MB 级的字节，会把快照撑爆、
 * 还会把更早的历史从裁剪里挤掉），只下发一张**首帧封面**（≤160KB）+ 名字 + 大小；
 * 原片由客户端点开时按需拉（`attachment.fetch`）。
 *
 * 这条判定有五个容易写错的地方，所以从 ipc.ts 里抽出来单独测：
 *
 *   1. **size 必须无条件写入**，哪怕没有封面——卡片尺寸与拉取进度条全靠它；
 *   2. 封面预算按**最新优先**分配（列表倒序遍历），否则用户最近发的视频反而没封面；
 *   3. 封面读取失败不能连累视频本身（没封面只是深色卡片，视频照样可点开拉）；
 *   4. 预算不足与「没有封面」要用同一句「点开按需获取」——对用户而言两件事没区别
 *      （卡片都能点开），区分它们只会在气泡里多出一句用户读不懂的话；
 *   5. 视频文件不在（被 mtime 清理掉了）必须明说是「已被清理」，否则排查会一直往预算方向查。
 */
import { VIDEO_POSTER_BASE64_BUDGET, VIDEO_POSTER_MAX_BYTES, posterMimeForName } from "./video-refs";

/** 一个待回填封面的视频块（由 ipc.ts 从 `pendingVideos` 映射而来）。 */
export interface VideoPosterCandidate {
  /** 磁盘上的视频路径（取大小用）。 */
  videoPath: string;
  /** 磁盘上的封面路径；没有封面时传 undefined。 */
  posterPath?: string;
  setSize: (size: number) => void;
  setPoster: (base64: string, mimeType: string) => void;
  setNote: (text: string) => void;
}

export interface VideoPosterOptions {
  /** 读文件大小；文件不在 → 抛错。 */
  sizeOf: (path: string) => number;
  /** 读整个文件为 base64。 */
  readBase64: (path: string) => string;
  /** 本次快照可用的 base64 预算（字符）。 */
  budget?: number;
  /** 单张封面的原始字节上限（超过视为不可用）。 */
  posterMaxBytes?: number;
}

export interface VideoPosterResult {
  /** 回填了封面的视频数，以及封面原始字节合计（写 diag 日志用）。 */
  posters: number;
  posterBytes: number;
}

/** 占位块上给用户看的一句话：无论「没封面」还是「封面超预算」，用户能做的事都一样。 */
export const LAZY_VIDEO_NOTE = "点开按需获取";
export const MISSING_VIDEO_NOTE = "附件已被清理";

/**
 * 从**末尾往前**回填（候选人按消息顺序排列 → 倒序即最新优先）。
 *
 * 所有状态都通过 candidate 的 setter 写回；返回值只用于统计/日志。
 */
export function fillVideoPosters(candidates: VideoPosterCandidate[], options: VideoPosterOptions): VideoPosterResult {
  const posterMaxBytes = options.posterMaxBytes ?? VIDEO_POSTER_MAX_BYTES;
  let budget = options.budget ?? VIDEO_POSTER_BASE64_BUDGET;
  let posters = 0;
  let posterBytes = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    let size = 0;
    try {
      size = options.sizeOf(candidate.videoPath);
    } catch {
      candidate.setNote(MISSING_VIDEO_NOTE);
      continue;
    }
    if (size <= 0) {
      candidate.setNote(MISSING_VIDEO_NOTE);
      continue;
    }
    // 先把尺寸写进去：卡片与进度条都要它，与有没有封面无关。
    candidate.setSize(size);
    candidate.setNote(LAZY_VIDEO_NOTE);
    if (!candidate.posterPath || budget <= 0) continue;
    try {
      const posterSize = options.sizeOf(candidate.posterPath);
      if (posterSize <= 0 || posterSize > posterMaxBytes) continue;
      const data = options.readBase64(candidate.posterPath);
      if (!data.length || data.length > budget) continue;
      budget -= data.length;
      posterBytes += posterSize;
      posters += 1;
      candidate.setPoster(data, posterMimeForName(candidate.posterPath));
    } catch {
      // 封面读不到/被清理：不影响视频本身（仍可点开按需拉）。
    }
  }
  return { posters, posterBytes };
}
