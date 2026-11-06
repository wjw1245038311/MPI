// 多图九宫格聚合（PWA）：分组规则与「+N」计算，纯函数。
//
// 国内 IM 的强预期：一条消息发 9 张图是一格网格，不是 9 个满宽气泡；
// 超过 9 张显示前 8 张 + 第 9 格「+N」。只合并**连续**图片块（图文混排语义优先）。
import assert from "node:assert/strict";

const { IMAGE_GRID_MAX, buildImageGrid, groupImageBlocks } = await import("../mobile/pwa/src/lib/image-grid.ts");

const img = (id) => ({ type: "image", data: `b64-${id}` });
const text = (t) => ({ type: "text", text: t });
const tool = (id) => ({ type: "tool", id, name: "bash" });

// --- 1. 单图不建网格（保留原来的满宽样式）-----------------------------------
{
  assert.equal(buildImageGrid([img(1)]), null);
  assert.equal(buildImageGrid([]), null);
}

// --- 2. 列数与「+N」分档 -----------------------------------------------------
{
  const grid2 = buildImageGrid([img(1), img(2)]);
  assert.equal(grid2.cols, 2, "两张：2 列");
  assert.equal(grid2.visible.length, 2);
  assert.equal(grid2.hidden, 0);

  const grid4 = buildImageGrid([img(1), img(2), img(3), img(4)]);
  assert.equal(grid4.cols, 2, "四张：仍 2 列");
  assert.equal(grid4.visible.length, 4);

  const grid5 = buildImageGrid(Array.from({ length: 5 }, (_, i) => img(i)));
  assert.equal(grid5.cols, 3, "五张起：3 列");

  const grid9 = buildImageGrid(Array.from({ length: 9 }, (_, i) => img(i)));
  assert.equal(grid9.cols, 3);
  assert.equal(grid9.visible.length, 9, "正好 9 张全显示");
  assert.equal(grid9.hidden, 0);

  const grid10 = buildImageGrid(Array.from({ length: 10 }, (_, i) => img(i)));
  assert.equal(grid10.total, 10);
  assert.equal(grid10.visible.length, IMAGE_GRID_MAX - 1, "超过 9 张：前 8 张占格子");
  assert.equal(grid10.hidden, 2, "第 9 格是 +2");
  assert.equal(grid10.visible[0].data, "b64-0", "按原顺序取前 8 张");
}

// --- 3. 分组：只合并连续图片块 ---------------------------------------------
{
  const items = [
    { kind: "block", block: text("说明") },
    { kind: "block", block: img(1) },
    { kind: "block", block: img(2) },
    { kind: "block", block: tool("t1") },
    { kind: "block", block: img(3) },
    { kind: "block", block: text("结尾") },
  ];
  const out = groupImageBlocks(items);
  assert.deepEqual(
    out.map((item) => (item.kind === "block" ? `block:${item.block.type}` : item.kind)),
    ["block:text", "imageGrid", "block:tool", "block:image", "block:text"],
    "连续两张成网格；单张仍是普通块；工具行打断聚合",
  );
  const grid = out.find((item) => item.kind === "imageGrid");
  assert.equal(grid.blocks.length, 2);
}

// --- 4. 全是图片：一条消息 → 一个网格 --------------------------------------
{
  const out = groupImageBlocks(Array.from({ length: 3 }, (_, i) => ({ kind: "block", block: img(i) })));
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "imageGrid");
  assert.equal(out[0].blocks.length, 3);
}

// --- 5. 没有图片：原样返回（工具分组结果一个不动）-------------------------
{
  const items = [
    { kind: "block", block: text("a") },
    { kind: "block", block: tool("t1") },
  ];
  assert.deepEqual(groupImageBlocks(items), items);
}

console.log("pwa image grid checks passed");
