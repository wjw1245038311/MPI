/**
 * 工具块的展示折叠规则（纯函数，便于单测）。
 *
 * 真机场景：一次任务里连着十几个 `bash`，每个工具原本各占一行的卡片，滚动长度
 * 几乎全是工具行，而折叠行上只有「✓ bash」——用户看不到任何信息。这里定两条规则：
 *
 *   1. **合并**：连续的同类工具（同名、≥3 个、都不在运行中）折成一行「✓ bash ×12」，
 *      点开再列明细（每条带参数摘要与结果）。
 *   2. **丢弃无信息行**：既没有参数摘要也没有结果的工具块直接不渲染——空行就是噪声
 *      （旧主机不传 args 时整批工具都属于这种情况）。运行中/出错的行永远保留：
 *      它们是状态信号，不能因为暂时没有内容而消失。
 */
import type { ViewBlock } from "./thread-session";

export interface ToolGroup {
  name: string;
  blocks: ViewBlock[];
}

export type RenderItem =
  | { kind: "block"; block: ViewBlock }
  | { kind: "toolGroup"; group: ToolGroup };

/** 折叠行上是否有可看的信息。 */
export function hasToolInfo(block: ViewBlock): boolean {
  return Boolean((block.argsText && block.argsText.trim()) || (block.text && block.text.trim()));
}

/** 合并阈值：2 个不值得折（折了反而多一次点击）。 */
export const TOOL_GROUP_MIN = 3;

export function groupToolBlocks(blocks: ViewBlock[]): RenderItem[] {
  const items: RenderItem[] = [];
  let index = 0;
  while (index < blocks.length) {
    const block = blocks[index];
    const isTool = block.type === "tool";
    // 无信息的普通工具行：直接跳过（运行中/出错除外——那是状态，不是内容）
    if (isTool && !hasToolInfo(block) && !block.running && !block.isError) {
      index += 1;
      continue;
    }
    if (isTool && !block.running) {
      let end = index;
      while (
        end + 1 < blocks.length &&
        blocks[end + 1].type === "tool" &&
        blocks[end + 1].name === block.name &&
        !blocks[end + 1].running
      ) {
        end += 1;
      }
      const run = blocks.slice(index, end + 1);
      if (run.length >= TOOL_GROUP_MIN) {
        items.push({ kind: "toolGroup", group: { name: block.name || "tool", blocks: run } });
        index = end + 1;
        continue;
      }
    }
    items.push({ kind: "block", block });
    index += 1;
  }
  return items;
}
