/**
 * 思考等级（thinking level）的单一真值规则 —— 纯函数，主进程 / 渲染端共用。
 *
 * 背景（2026-10-15 梳理）：这个参数原先散在 8 处、可选档位有 4 种各自推导：
 *   - pi `get_available_thinking_levels` 的原始返回**不一致**：有的模型含 `off`
 *     （strata 那台 5 档），有的不含（LM Studio 那台只有 minimal…max 6 档）；
 *   - 桌面 Composer 自己 `["off", ...levels]` 补一个 off；
 *   - 手机端把主机列表原样用（`ThreadToolbar.kt`）→ 那些不带 off 的模型在手机上
 *     **没有「关」这一项**；
 *   - 设置页又按 `thinkingLevelMap[level] !== null` 自己算一套。
 * 另外切模型时 pi 会按新模型的 `thinkingLevelMap` **夹紧**当前档位且不会复位
 * （实测：high → 切到另一模型变 low → 切回来还是 low），用户的本意就此丢失。
 *
 * 所以这里定下三条规则，三端都从这里取：
 *   1. 可选档位一律经 {@link normalizeThinkingLevels}：去重、标准顺序、**必含 off**；
 *   2. 「用户本意」（intent）单独记在 `config.threadThinking[uuid]`，切模型后能复位就复位；
 *   3. 桥没开时用 {@link thinkingLevelsFromMap} 从 models.json 推，别再硬编码 `["off"]`。
 *
 * 不依赖 electron / DOM，可被测试直接 import。Kotlin 侧的标准档位见
 * `mobile/app/.../ui/ThreadToolbar.kt`（改这里要同步改它）。
 */

/** pi 的标准思考档位，数组顺序即界面展示顺序。 */
export const THINKING_LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVEL_ORDER)[number];

/** 「关」——所有模型都能选，包括 pi 只返回空列表的。 */
export const THINKING_OFF: ThinkingLevel = "off";

function orderIndex(level: string): number {
  const i = (THINKING_LEVEL_ORDER as readonly string[]).indexOf(level);
  return i === -1 ? THINKING_LEVEL_ORDER.length : i;
}

/**
 * 归一化「可选档位」列表：过滤非字符串、去重、按标准顺序排、**保证含 off**。
 *
 * 未知取值（自定义映射出来的服务商档位）保留并排在末尾——不隐藏用户自己配的东西。
 * 传入空/非法时按 `["off"]` 处理（等价于「该模型不支持思考」）。
 */
export function normalizeThinkingLevels(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw.filter((level): level is string => typeof level === "string" && level.trim().length > 0).map((level) => level.trim())
    : [];
  const unique = new Set<string>([THINKING_OFF, ...list]);
  return [...unique].sort((a, b) => {
    const ia = orderIndex(a);
    const ib = orderIndex(b);
    return ia !== ib ? ia - ib : a.localeCompare(b);
  });
}

/**
 * 由 models.json 的 `thinkingLevelMap` 推导某模型的可选档位（桥没开时的替代来源）。
 *
 * 语义与设置页一致：`reasoning` 为假 → 只有 off；map 里显式 `null` 表示「隐藏该档」。
 * **但 off 不可隐藏**：map 里的 `off: null` 只意味着「关的时候不发任何字段」（LM Studio
 * 那台就是这样），并不是「不能关」——而 pi 把它当成不支持、从
 * `get_available_thinking_levels` 里剔掉了，这就是手机端列表缺 off 的来源。
 * map 缺失（未指定）时给出标准全档位——真实可选项仍以 pi 实时上报为准。
 */
export function thinkingLevelsFromMap(
  map?: Record<string, string | null> | null,
  reasoning?: boolean,
): string[] {
  if (reasoning === false) return [THINKING_OFF];
  const levels = THINKING_LEVEL_ORDER.filter((level) => !map || map[level] !== null);
  return normalizeThinkingLevels(levels);
}

/** 该档位是否可选（off 永远可选）。 */
export function isThinkingLevelAllowed(level: string, levels: unknown): boolean {
  return normalizeThinkingLevels(levels).includes(level);
}

/** {@link planThinkingAfterModelSwitch} 的结果。 */
export interface ThinkingSwitchPlan {
  /** 需要复位到的档位；null = 不用动。 */
  restore: string | null;
  /** 复位后应对外显示的档位（pi 夹紧后的实际值，或即将复位的 intent）。 */
  effective: string | null;
  /** intent 存在但新模型不支持、只能接受夹紧结果 → true（界面提示一次用）。 */
  downgraded: boolean;
}

/**
 * 切模型之后该怎么处理思考等级。
 *
 * - `intent`（用户本意）在新模型可用 → 复位回去（这就是「切模型不丢档位」）；
 * - intent 不可用 → 接受 pi 的夹紧结果并标记 `downgraded`，**intent 不清空**，
 *   这样切回支持的模型时还能自动恢复；
 * - 没有 intent（例如新会话从没手动选过）→ 完全跟随 pi。
 */
export function planThinkingAfterModelSwitch(input: {
  intent?: string | null;
  clamped?: string | null;
  levels?: string[] | null;
}): ThinkingSwitchPlan {
  const intent = typeof input.intent === "string" && input.intent ? input.intent : null;
  const clamped = typeof input.clamped === "string" && input.clamped ? input.clamped : null;
  if (!intent) return { restore: null, effective: clamped, downgraded: false };
  // 列表未知（桥没上报）时不要乱动：pi 已经给过值，复位失败只会更糟。
  if (!Array.isArray(input.levels) || input.levels.length === 0) return { restore: null, effective: clamped, downgraded: false };
  const allowed = normalizeThinkingLevels(input.levels);
  if (!allowed.includes(intent)) return { restore: null, effective: clamped, downgraded: clamped !== intent };
  if (clamped === intent) return { restore: null, effective: intent, downgraded: false };
  return { restore: intent, effective: intent, downgraded: false };
}
