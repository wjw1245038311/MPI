/**
 * Shared chat-command parsing for messaging channels (WeChat / Feishu).
 *
 * Slash commands (/new, /list, /use <n>) keep working exactly as before; on top
 * of that we accept short natural-language phrases so mobile users don't have
 * to type slash syntax. Natural language is only attempted on SHORT messages
 * and with fully anchored patterns, so ordinary questions are never hijacked —
 * e.g. "帮我写个新建用户的接口" or "切换到开发分支" stay normal questions.
 */

export type ParsedCommand =
  | { kind: "new" }
  | { kind: "list" }
  | { kind: "use"; arg: string }
  | { kind: "back" };

/** Messages longer than this (in code points) are never treated as NL commands. */
const NL_MAX_LEN = 40;

/** Chinese numerals 1–19 (the /list view only shows up to 10 sessions). */
function cnNumToInt(s: string): number | null {
  if (/^\d+$/.test(s)) return Number.parseInt(s, 10);
  const single: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s in single) return single[s];
  if (s === "十") return 10;
  const m = /^十([一二三四五六七八九])$/.exec(s); // 十一 … 十九
  if (m) return 10 + single[m[1]];
  return null;
}

/**
 * Parses a chat message into a command, or returns null for normal questions.
 * Accepts both the raw text and pre-trimmed/lowercased variants.
 */
export function parseChatCommand(rawText: string): ParsedCommand | null {
  // Trim + lowercase, then drop surrounding punctuation ("新建会话。" still works).
  const text = rawText.trim().toLowerCase().replace(/^[，,。.！!？?\s]+|[，,。.！!？?\s]+$/g, "");
  if (!text) return null;

  // --- exact slash commands (always allowed, any length) ---------------------
  if (text === "/new" || text === "新建" || text === "new") return { kind: "new" };
  if (text === "/list" || text === "列表") return { kind: "list" };
  const useMatch = /^\/use\s+(\S+)$/.exec(text);
  if (useMatch) return { kind: "use", arg: useMatch[1] };

  // --- natural language (short messages only) ---------------------------------
  if ([...text].length > NL_MAX_LEN) return null;

  // Go back to the previous session: "上一个" / "回到上一个会话" / "刚才那个".
  if (/^(?:切回|回到|返回)?(?:上|前)一个(会话|对话)?$|^刚才那个(会话|对话)?$/.test(text)) {
    return { kind: "back" };
  }

  // New session: "新建会话" / "开个新对话" / "new session".
  if (/^(请|帮我|给我|我想|我要)?(新建|新开|开|创建)(一个|个)?(?:新[的]?)?(会话|对话)$/.test(text)) {
    return { kind: "new" };
  }
  if (/^(?:start\s+)?(?:a\s+)?(?:new|fresh)\s+(?:session|chat)$/.test(text)) {
    return { kind: "new" };
  }

  // List sessions: "有哪些会话" / "看看有哪些会话" / "最近的会话列表" / "list sessions".
  if (/^有哪些(会话|对话)$/.test(text)) return { kind: "list" };
  // Optional short qualifier before the noun ("有哪些微信会话"); still anchored
  // at both ends with a required session noun, so questions stay safe.
  if (/^(?:请|帮我)?(?:看看?|列出?|显示)(?:一下)?(?:最近)?的?(?:有哪些?)?(.{0,8}?)?(会话|对话)(列表)?$/.test(text)) {
    return { kind: "list" };
  }
  if (/^list\s+(?:recent\s+)?(?:sessions|chats)$/.test(text)) return { kind: "list" };

  // Switch by number: "切到第2个" / "用第二个会话" / "switch to 3".
  const useCn = /^(?:请|帮我)?(?:切换?|换|回到|用)(?:到|回)?(?:第)?([0-9一二两三四五六七八九十]+)个?(?:的?)?(?:会话|对话)?$/.exec(text);
  if (useCn) {
    const n = cnNumToInt(useCn[1]);
    if (n !== null && n >= 1) return { kind: "use", arg: String(n) };
  }
  const useEn = /^(?:switch|go)\s+to\s+(?:session\s+|#)?(\d+)$/.exec(text);
  if (useEn) return { kind: "use", arg: useEn[1] };

  // Switch by title keyword — must end with a session noun or demonstrative so
  // real questions like "切换到开发分支" are never captured:
  //   "切到飞书那个会话" / "换回微信的对话" / "switch to the feishu session".
  const kwCn = /^(?:切换?|换|回到)(?:到|回)?(.{2,12}?)(?:(?:那个|这个)(?:的)?(?:会话|对话)?|(?:的)?(?:会话|对话))$/.exec(text);
  if (kwCn && kwCn[1]) return { kind: "use", arg: kwCn[1] };
  const kwEn = /^(?:switch|go)\s+to\s+(?:the\s+)?(.{2,30}?)(?:\s+(?:session|chat))$/.exec(text);
  if (kwEn && kwEn[1]) return { kind: "use", arg: kwEn[1] };

  // English "go back".
  if (/^(?:go\s+back|back)$/.test(text)) return { kind: "back" };

  return null;
}

export interface ThreadRef {
  id: string;
  title: string;
}

export type ThreadResolution =
  | { target: ThreadRef }
  | { candidates: ThreadRef[] };

/**
 * Resolves a /use argument against the project's threads.
 * Order: exact id → unique case-insensitive title substring → ambiguous candidates.
 */
export function resolveThreadTarget(threads: readonly ThreadRef[], arg: string): ThreadResolution | null {
  const byId = threads.find((t) => t.id === arg);
  if (byId) return { target: byId };
  const needle = arg.trim().toLowerCase();
  if (!needle) return null;
  const hits = threads.filter((t) => t.title.toLowerCase().includes(needle));
  if (hits.length === 1) return { target: hits[0] };
  if (hits.length > 1) return { candidates: hits.slice(0, 5) };
  return null;
}
