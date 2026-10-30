/**
 * 「回合停在等你回复」的判定（纯函数）——与桌面端 `src/renderer/src/lib/awaiting-reply.ts`、
 * Android `ui/AwaitingReplyLogic.kt` **同一判据**，改规则时三端同步（`test-awaiting-reply`
 * 有 parity 断言）。
 *
 * 背景（2026-10-30，minibox 会话 `session-01a1885c`）：模型干完当轮活后，把需要用户拍板的事
 * 写成**正文提问**收尾，既没有 choices 围栏、也没有报错。会话文件里完全干净
 * （`stopReason=stop`），界面与「任务已做完」一模一样，用户 7 小时后才发现任务停在等签字。
 *
 * 判据刻意保守（误显示只是多一条弱提示，漏显示只是回到旧行为）：
 *   1. 已经写了 choices 围栏 → 不提示（面板本身就是提示）；
 *   2. 尾部（最后 400 字）去掉装饰符后以 `?` / `？` 结尾 → 提示；
 *   3. 尾部出现明确的「等你 / 需要你 / 请确认 / let me know」类等待语 → 提示；
 *   4. 其它一律不提示（正常汇报、以代码块/表格收尾的都不算）。
 */

/** 明确的等待语（大小写不敏感）。 */
const WAIT_PHRASES = [
  "等你",
  "待你",
  "需要你",
  "请你确认",
  "请确认",
  "你决定后",
  "你确认后",
  "你来定",
  "awaiting your",
  "waiting for your",
  "let me know",
];

/** choices 围栏（行首三个以上反引号 + choices）。 */
const CHOICE_FENCE_RE = /^[ \t]{0,3}`{3,}[ \t]*choices/im;

/** 尾部窗口：模型常在问句后跟一段收尾清单，400 字够覆盖，又不会把长文开头的问题算进来。 */
const TAIL_CHARS = 400;

/** 去掉尾部装饰符后的最后一个实义字符是不是问号。 */
function endsWithQuestion(tail: string): boolean {
  const cleaned = tail.replace(/[\s"'”’）)】\]。．.,，、…~～*_|]+$/u, "");
  return /[?？]$/u.test(cleaned);
}

/**
 * 这段 assistant 文本是否在「等用户回复」。
 * 调用方负责再确认：它是本回合最后一条消息、且回合已经结束（没有流式、没有在跑的工具）。
 */
export function looksAwaitingReply(text: string): boolean {
  const body = String(text ?? "").trim();
  if (!body) return false;
  if (CHOICE_FENCE_RE.test(body)) return false;
  const tail = body.length > TAIL_CHARS ? body.slice(-TAIL_CHARS) : body;
  if (endsWithQuestion(tail)) return true;
  const lower = tail.toLowerCase();
  return WAIT_PHRASES.some((phrase) => lower.includes(phrase.toLowerCase()));
}
