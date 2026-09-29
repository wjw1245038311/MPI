/**
 * 从一行 JSON 里递归取出所有字符串（带深度与总量护栏）。
 *
 * 用途：会话 JSONL 的文件引用可能藏在任意嵌套里（消息 content 数组、工具结果、嵌套 JSON 字符串），
 * 与其为每种形状写一条路径，不如把这一行里的所有字符串**都**拿出来，再交给
 * `splitVideoRefs` 判定（它只认带 `attach="video"` 的引用，不会误伤）。
 *
 * 失败（半截写入的最后一行、非 JSON 行）→ 返回空数组，绝不抛。
 */
export function collectJsonStrings(line: string, limits: { maxStrings?: number; maxDepth?: number } = {}): string[] {
  const maxStrings = limits.maxStrings ?? 5000;
  const maxDepth = limits.maxDepth ?? 12;
  const out: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return out;
  }
  const walk = (value: unknown, depth: number): void => {
    if (out.length >= maxStrings || depth > maxDepth) return;
    if (typeof value === "string") {
      out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) walk(item, depth + 1);
    }
  };
  walk(parsed, 0);
  return out;
}
