/**
 * 运行时版本判定（纯函数，不依赖 electron —— 单测直接跑）。
 *
 * 背景（2026-11-03）：安装包里内置的 Pi 运行时只在「userData 里没有可用运行时」时
 * 才会被解压（`ensureRuntimePackage`）；升级 MPI 本体后，机器上那份旧的继续用着，
 * 内置的新版本静默躺着，用户不点「更新 Pi」就永远用不上。这里给出「要不要跟上内置」
 * 的判定，安装动作仍在 `runtime-package.ts`（需要 electron / tar）。
 */

/** 语义化版本比较（只比较数字段，忽略 `-rc` 之类的预发布标记，够用于运行时目录名）。 */
export function compareRuntimeVersions(a: string | null | undefined, b: string | null | undefined): number {
  const parse = (value: string | null | undefined): number[] =>
    String(value || "")
      .trim()
      .replace(/^v/i, "")
      .split(".")
      .map((part) => parseInt(part, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const delta = (pa[i] || 0) - (pb[i] || 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * 是否该把内置运行时换上。
 *
 * 规则刻意保守：
 *   - 没有内置版本（dev 模式 / 旧安装包）→ 不动；
 *   - **完全没有**可用运行时 → 交给首次解压的既有路径处理（这里返回 false，
 *     避免启动时两处并发安装同一份归档）；
 *   - 只有内置**严格更新**才换：同版本或更旧一律不碰（不降级）。
 */
export function shouldAdoptEmbeddedRuntime(activeVersion: string | null, embeddedVersion: string | null): boolean {
  if (!embeddedVersion) return false;
  if (!activeVersion) return false;
  return compareRuntimeVersions(embeddedVersion, activeVersion) > 0;
}
