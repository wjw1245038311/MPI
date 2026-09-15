/**
 * 上下文用量的显示口径（纯函数，与桌面端 Composer 的 ring 完全一致）。
 *
 * 三个必须一致的点：
 *   1. 压缩后 pi 会把 `contextUsage.tokens` 报成 null（只信任压缩之后的 assistant
 *      usage），此时要用主机带来的 `estimatedTokens` 回退——否则手机上显示 0%，
 *      用户以为窗口空了。
 *   2. `percent` 可用时优先用 pi 的值（它是相对**真实窗口**算的），否则用
 *      tokens / contextWindow 自算。
 *   3. 阈值带决定颜色与「该不该压缩」的建议：≤60 绿 / 60-74 黄 / 75-89 橙 / ≥90 红。
 */
import type { RemoteContextUsage } from "../../../shared/protocol";

export type ContextBand = "low" | "warn" | "mid" | "hi";

export interface ContextReading {
  /** 是否有可信数字（窗口未知或既无 tokens 也无估算值时 false → 界面显示「—」）。 */
  hasValue: boolean;
  /** 使用的 token 数（压缩后为估算值）。 */
  used: number;
  /** 上下文窗口大小（tokens；0 = 未知）。 */
  total: number;
  /** 0-100 的百分比。 */
  percent: number;
  /** 该数值来自压缩后的估算（界面要加提示）。 */
  isEstimate: boolean;
  band: ContextBand;
}

export function contextBand(percent: number): ContextBand {
  if (percent >= 90) return "hi";
  if (percent >= 75) return "mid";
  if (percent >= 60) return "warn";
  return "low";
}

export function readContextUsage(usage: RemoteContextUsage | null | undefined): ContextReading {
  const total = usage?.contextWindow ?? 0;
  const isEstimate = !!usage && typeof usage.tokens !== "number";
  const used = !usage ? 0 : typeof usage.tokens === "number" ? usage.tokens : (usage.estimatedTokens ?? 0);
  const hasValue = !!usage && total > 0 && (typeof usage.tokens === "number" || typeof usage.estimatedTokens === "number");
  const percent = hasValue
    ? Math.min(100, typeof usage?.percent === "number" ? usage.percent : (used / total) * 100)
    : 0;
  return { hasValue, used, total, percent, isEstimate, band: contextBand(percent) };
}

/** 132400 → "132k"；4200 → "4.2k"；880 → "880"。 */
export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
}
