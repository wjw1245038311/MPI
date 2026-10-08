/**
 * 分片上传的**纯逻辑**（无副作用，便于 L1 测试）。
 *
 * 背景：桌面安装包 143MB，从本机单连接上传到 ECS 实测只有 ~0.68MB/s（≈3.5 分钟）；
 * 而企业出口是「单连接限速、多连接可叠加」（实测 12 条 ≈7.8MB/s）。所以大文件切成
 * N 段并发上传、ECS 侧再 cat 合并。
 */

/** 小于这个大小不分片（分片只为绕开单连接限速，小文件走 scp 更省事）。 */
export const PARALLEL_THRESHOLD_BYTES = 4 * 1024 * 1024;

/** 默认并发数：12 路是实测出「12 条 ≈7.8MB/s」的那个值。 */
export const DEFAULT_PARTS = 12;

/**
 * 把 size 字节切成 n 段，返回 [{index, start, end}]（end 含）或单段。
 *
 * 边界（有测试钉住）：size=0 → []; n<=1 或 size<阈值 → 单段；n 超过 size 时按 1 字节/段
 * 退化（不会产出空段）；最后一段吃掉余数，保证 sum(end-start+1) === size。
 */
export function planParts(size, parts = DEFAULT_PARTS, threshold = PARALLEL_THRESHOLD_BYTES) {
  const total = Math.max(0, Math.floor(Number(size) || 0));
  if (total === 0) return [];
  const wanted = Math.floor(Number(parts) || 0);
  if (wanted <= 1 || total < threshold) return [{ index: 0, start: 0, end: total - 1 }];
  const count = Math.min(wanted, total);
  const base = Math.floor(total / count);
  const out = [];
  let start = 0;
  for (let i = 0; i < count; i += 1) {
    const end = i === count - 1 ? total - 1 : start + base - 1;
    out.push({ index: i, start, end });
    start = end + 1;
  }
  return out;
}

/** 分片临时文件名：`<name>.part00`（补零，便于 cat 与排查）。 */
export function partName(name, index, width = 2) {
  return `${name}.part${String(index).padStart(width, "0")}`;
}

/** 是否需要分片。 */
export function shouldSplit(size, parts = DEFAULT_PARTS, threshold = PARALLEL_THRESHOLD_BYTES) {
  return planParts(size, parts, threshold).length > 1;
}
