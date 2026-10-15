import type { Language } from "./i18n";
import { thinkingLevelLabel } from "../../../shared/thinking-levels";

/**
 * 思考档位的显示名。
 *
 * 真值在 `src/shared/thinking-levels.ts`（主进程、任务模式摘要、手机端都从那里取）；
 * 这里只保留历史调用方用的函数名，别再在本文件里加一份标签表。
 */
export function reasoningLevelLabel(level: string | undefined, language: Language): string {
  return thinkingLevelLabel(level, language);
}
