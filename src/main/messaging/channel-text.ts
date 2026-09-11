/**
 * Shared chat-channel copy (bilingual) + shared text helpers. The two channels
 * (Feishu / WeChat) differ only in how a reply arrives — streaming update of
 * the ack message vs a fresh message with a typing indicator — so
 * buildChannelTexts takes those few overrides and fills everything else from
 * one common table. Kept dependency-free like feishu-text.ts so it stays
 * importable by the strip-types test runner.
 */

export interface ChannelTexts {
  thinking: string;
  busy: string;
  unsupported: string;
  errorPrefix: string;
  noOutput: string;
  timeoutNote: string;
  truncatedNote: string;
  newDone: string;
  listHeader: string;
  noSessions: string;
  useHint: string;
  useDone: string;
  useNotFound: string;
  useAmbiguous: string;
  backNone: string;
  help: string;
}

export interface ChannelTextOverrides {
  /** Display name in the /help header, e.g. "飞书接入" / "Feishu bridge". */
  titleZh: string;
  titleEn: string;
  thinkingZh: string;
  thinkingEn: string;
  /** Last help line — how a plain-text reply arrives on this channel. */
  deliveryZh: string;
  deliveryEn: string;
}

export function buildChannelTexts(o: ChannelTextOverrides): { zh: ChannelTexts; en: ChannelTexts } {
  return {
    zh: {
      thinking: o.thinkingZh,
      busy: "⏳ 上一条消息还在处理中，请稍后再发。",
      unsupported: "目前只支持文本消息（图片/文件暂不支持）。",
      errorPrefix: "出错了：",
      noOutput: "（任务已完成，但没有产生文字输出）",
      timeoutNote: "等待超时（30 分钟），结果可能仍在 MPI 中生成。",
      truncatedNote: "已截断，完整内容见 MPI",
      newDone: "✅ 已新建会话，后续消息将进入新会话。",
      listHeader: "📋 本项目最近会话（最多 10 条，➜ = 当前）：",
      noSessions: "本项目还没有会话。",
      useHint: "用 /use <序号>（或说「切到第N个」）切换，例如 /use 2",
      useDone: "✅ 已切换到会话：",
      useNotFound: "没找到对应会话——先用 /list 看看列表。",
      useAmbiguous: "找到多个匹配的会话，用 /use <序号> 指定：",
      backNone: "没有可返回的会话。",
      help: [
        `MPI ${o.titleZh} · 可用命令：`,
        "/new — 新建一个会话（旧会话保留）",
        "/list — 列出本项目最近会话",
        "/use <序号> — 切换到指定会话（如 /use 2）",
        "/help — 显示本帮助",
        "手机上也可以直接说：新建会话 / 看看有哪些会话 / 切到第2个 / 回到上一个",
        "其它说法也行——直接告诉 agent（如“我想换个对话”），它会帮你列/切会话。",
        o.deliveryZh,
      ].join("\n"),
    },
    en: {
      thinking: o.thinkingEn,
      busy: "⏳ The previous message is still being processed, please wait.",
      unsupported: "Only text messages are supported for now (no images/files).",
      errorPrefix: "Error: ",
      noOutput: "(Task finished but produced no text output)",
      timeoutNote: "Timed out after 30 minutes; the result may still be finishing in MPI.",
      truncatedNote: "truncated — full content in MPI",
      newDone: "✅ New session created. Further messages go to it.",
      listHeader: "📋 Recent sessions in this project (up to 10, ➜ = current):",
      noSessions: "No sessions in this project yet.",
      useHint: "Switch with /use <number> (or just say 'switch to 2'), e.g. /use 2",
      useDone: "✅ Switched to session: ",
      useNotFound: "Session not found — run /list to see the list.",
      useAmbiguous: "Multiple sessions match — pick one with /use <number>:",
      backNone: "No session to go back to.",
      help: [
        `MPI ${o.titleEn} · commands:`,
        "/new — start a fresh session (the old one is kept)",
        "/list — list recent sessions in this project",
        "/use <n> — switch to that session (e.g. /use 2)",
        "/help — show this help",
        "Natural language works too, e.g.: 'new session' / 'list sessions' / 'switch to 2' / 'go back'",
        'Anything else — just tell the agent (e.g. "I want to switch sessions"); it will list/switch for you.',
        o.deliveryEn,
      ].join("\n"),
    },
  };
}

/** Truncates long agent output for chat delivery, appending a note when cut. */
export function truncateForChat(text: string, maxChars: number, note?: string): string {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean;
  const suffix = note ? `\n…${note}` : "\n…";
  const budget = Math.max(10, maxChars - suffix.length);
  return `${clean.slice(0, budget)}${suffix}`;
}
