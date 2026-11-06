/**
 * 一条消息里多张图的**九宫格聚合**（纯函数，便于单测）。
 *
 * 国内 IM 的强预期：发 9 张图是一条消息 + 一个 3×3 网格，不是 9 个满宽气泡；
 * 超过 9 张时只显示前 8 张，第 9 格是「+N」。
 *
 * 聚合规则保守：只合并**连续**的 image 块。中间夹了正文/工具行就断开——
 * 图文混排的语义比"少几个格子"重要，而且这与微信/飞书的观感一致。
 */
import type { ViewBlock } from "./thread-session";
import type { RenderItem } from "./tool-groups";

/** 超过这个张数就折叠（3×3）。 */
export const IMAGE_GRID_MAX = 9;

export interface ImageGrid {
  /** 网格列数：2 张以内/中等数量用 2 列，5 张以上用 3 列。 */
  cols: number;
  /** 实际占格子的图（>9 张时是前 8 张，第 9 格留给「+N」）。 */
  visible: ViewBlock[];
  /** 被「+N」角标代表的张数（0 = 全部显示）。 */
  hidden: number;
  total: number;
}

/**
 * 一组连续的图片块 → 网格模型。少于 2 张返回 null（单图仍走原来的满宽样式）。
 */
export function buildImageGrid(blocks: ViewBlock[]): ImageGrid | null {
  const total = blocks.length;
  if (total < 2) return null;
  const cols = total <= 4 ? 2 : 3;
  // >9 张：前 8 张占格子，最后那格显示 +N（N = 剩余张数）
  const visibleCount = total > IMAGE_GRID_MAX ? IMAGE_GRID_MAX - 1 : total;
  return {
    cols,
    visible: blocks.slice(0, visibleCount),
    hidden: total - visibleCount,
    total,
  };
}

/** 消息级渲染项：在工具分组之后再把连续图片合成网格。 */
export type MessageItem = RenderItem | { kind: "imageGrid"; blocks: ViewBlock[] };

export function groupImageBlocks(items: RenderItem[]): MessageItem[] {
  const out: MessageItem[] = [];
  let pending: ViewBlock[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    // 单图不建网格：让调用方沿用原来的满宽渲染（保持既有观感与行为）。
    if (pending.length === 1) {
      out.push({ kind: "block", block: pending[0] });
    } else {
      out.push({ kind: "imageGrid", blocks: pending });
    }
    pending = [];
  };
  for (const item of items) {
    if (item.kind === "block" && item.block.type === "image") {
      pending.push(item.block);
      continue;
    }
    flush();
    out.push(item);
  }
  flush();
  return out;
}
