package com.mpi.app.ui

import com.mpi.app.protocol.BlockType
import com.mpi.app.protocol.MessageBlock

/**
 * 多图九宫格聚合（纯函数，可单测）。与网页版 `lib/image-grid.ts` 同规则：
 *
 * 国内 IM 的强预期是一条消息发 9 张图 = 一格网格，而不是 9 个满宽气泡；
 * 超过 9 张只显示前 8 张，第 9 格是「+N」。只合并**连续**的图片块——
 * 中间夹了正文/工具行就断开（图文混排语义优先）。
 */
internal const val IMAGE_GRID_MAX = 9

internal sealed interface MessageItem {
    data class Single(val block: MessageBlock) : MessageItem
    data class ImageGrid(val blocks: List<MessageBlock>) : MessageItem
}

internal data class ImageGridData(
    /** 网格列数：≤4 张用 2 列，≥5 张用 3 列。 */
    val cols: Int,
    /** 实际占格子的图（>9 张时是前 8 张，第 9 格留给「+N」）。 */
    val visible: List<MessageBlock>,
    /** 被「+N」代表的张数（0 = 全部显示）。 */
    val hidden: Int,
    val total: Int,
)

internal fun buildImageGrid(blocks: List<MessageBlock>): ImageGridData? {
    val total = blocks.size
    if (total < 2) return null
    val cols = if (total <= 4) 2 else 3
    val visibleCount = if (total > IMAGE_GRID_MAX) IMAGE_GRID_MAX - 1 else total
    return ImageGridData(
        cols = cols,
        visible = blocks.take(visibleCount),
        hidden = total - visibleCount,
        total = total,
    )
}

internal fun groupImageBlocks(blocks: List<MessageBlock>): List<MessageItem> {
    val out = ArrayList<MessageItem>(blocks.size)
    val pending = ArrayList<MessageBlock>()
    fun flush() {
        if (pending.isEmpty()) return
        if (pending.size == 1) out += MessageItem.Single(pending[0])
        else out += MessageItem.ImageGrid(pending.toList())
        pending.clear()
    }
    for (block in blocks) {
        if (block.type == BlockType.Image) {
            pending += block
            continue
        }
        flush()
        out += MessageItem.Single(block)
    }
    flush()
    return out
}
