/**
 * 会话交接文档（handoff doc）——纯逻辑，不依赖 electron，可直接单测。
 *
 * 背景（2026-10-25 用户定稿）：右上角的「新建会话」改成「交接新对话」——不是把旧会话的
 * 上下文整段塞进新会话，而是：
 *   1. 用**当前会话的模型**把旧会话写成一份交接文档（Markdown，固定结构）；
 *   2. 新会话的首条提示词只带一句「先读这份文档」，细节留在文件里按需读。
 * 这样做的好处：新会话不会被旧上下文撑爆，文档可审计、可回滚，也符合「文件为真相源」。
 *
 * 设计取舍：
 *   - 文档落盘到项目内 `.mpi/handoff/`（隐藏目录，不污染根目录，随项目走）。
 *   - 模型不可用/超时 → **退化**为「最近几轮原文」写进同一份文档，交接不因模型失败而失败。
 *   - 摘要提示词明确禁止输出密钥/令牌/密码。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 参与交接的对话条数上限（只收 user / assistant 的文本，工具调用与思考不进）。 */
export const HANDOFF_MAX_MESSAGES = 40;
/** 单条消息截断（字符）。 */
export const HANDOFF_PER_MESSAGE_CHARS = 2000;
/** 整个转录的字符预算。 */
export const HANDOFF_TRANSCRIPT_CHARS = 30000;
/** 生成的交接文档长度上限（字符）。 */
export const HANDOFF_DOC_CHARS = 6000;

export interface HandoffMessage {
  role: string;
  text: string;
}

/** 从会话消息里挑出可用于交接的片段（user/assistant 文本，跳过空内容）。 */
export function pickHandoffMessages(messages: unknown): HandoffMessage[] {
  if (!Array.isArray(messages)) return [];
  const out: HandoffMessage[] = [];
  for (const m of messages as any[]) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const text = textOfContent(m.content);
    if (!text.trim()) continue;
    out.push({ role: m.role, text });
  }
  return out.slice(-HANDOFF_MAX_MESSAGES);
}

/** content 可能是字符串或 [{type:"text",text}] 块数组（tool/thinking 块忽略）。 */
export function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content as any[]) {
    if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

/** 拼成给模型的转录文本（按字符预算从**最新**往回取，最后再按时间正序）。 */
export function buildTranscript(messages: HandoffMessage[], budget = HANDOFF_TRANSCRIPT_CHARS): string {
  const picked: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const label = m.role === "user" ? "用户" : "助手";
    const body = m.text.length > HANDOFF_PER_MESSAGE_CHARS ? m.text.slice(0, HANDOFF_PER_MESSAGE_CHARS) + "…" : m.text;
    const line = `${label}：${body}`;
    if (used + line.length > budget && picked.length > 0) break;
    picked.push(line);
    used += line.length + 2;
  }
  return picked.reverse().join("\n\n");
}

/** 生成「让模型写交接文档」的提示词。 */
export function buildHandoffPrompt(projectName: string, transcript: string, language: "zh" | "en" = "zh", todos: string[] = []): string {
  if (language === "en") {
    return [
      `You are writing a handoff document for a NEW session in project "${projectName}".`,
      "Below is the transcript of the previous session.",
      "",
      "Output Markdown only, with exactly these sections:",
      "# Handoff (project " + projectName + ")",
      "## Goal",
      "## Done",
      "## Key decisions",
      "## Next steps",
      "## Notes",
      "",
      "Rules:",
      "- Facts only; mark anything uncertain as unknown. Do not invent.",
      "- NEVER include secrets, API keys, tokens, passwords or credentials.",
      "- Keep it under 800 words.",
      ...(todos.length ? ["", "Open todos (from the todo panel; keep titles, fold into Next steps):", ...todos] : []),
      "",
      "Transcript:",
      transcript,
    ].join("\n");
  }
  return [
    `你在为一个新会话写交接文档。项目：${projectName}。`,
    "下面是上一个会话的对话记录。",
    "",
    "只输出 Markdown，结构固定：",
    `# 交接文档（项目 ${projectName}）`,
    "## 目标",
    "## 已完成",
    "## 关键决定",
    "## 未完成 / 下一步",
    "## 注意事项",
    "",
    "要求：",
    "- 只写事实，不推测；不确定的写「未知」。",
    "- 绝对不要包含密钥、令牌、密码、授权码等凭证。",
    "- 总长不超过 800 字。",
    ...(todos.length ? ["", "当前未完成待办（来自待办面板，保留标题，整合进「未完成 / 下一步」）：", ...todos] : []),
    "",
    "对话记录：",
    transcript,
  ].join("\n");
}

/** 模型不可用时的退化文档：仍是一份可读的文件，而不是让交接失败。 */
export function buildFallbackDoc(projectName: string, messages: HandoffMessage[], language: "zh" | "en" = "zh", todos: string[] = []): string {
  const transcript = buildTranscript(messages.slice(-8), 12000);
  const todoBlock = todos.length ? ["", language === "en" ? "## Open todos" : "## 未完成待办", ...todos] : [];
  if (language === "en") {
    return [`# Handoff (project ${projectName})`, "", "> The model was unavailable; this is the raw recent transcript.", ...todoBlock, "", transcript].join("\n");
  }
  return [`# 交接文档（项目 ${projectName}）`, "", "> 模型不可用，以下为最近几轮原文（未做摘要）。", ...todoBlock, "", transcript].join("\n");
}

/** 归一化模型输出：去掉代码围栏、裁到上限。 */
export function normalizeDoc(raw: string): string {
  let text = String(raw || "").trim();
  text = text.replace(/^```(?:markdown|md)?\s*\n/i, "").replace(/\n```\s*$/i, "").trim();
  return text.slice(0, HANDOFF_DOC_CHARS);
}

/** 写入 `<cwd>/.mpi/handoff/YYYYMMDD-HHmmss.md`，返回绝对路径。 */
export function writeHandoffDoc(cwd: string, content: string, at: Date = new Date()): string {
  const dir = join(cwd, ".mpi", "handoff");
  mkdirSync(dir, { recursive: true });
  const pad = (n: number) => String(n).padStart(2, "0");
  const name = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}.md`;
  const file = join(dir, name);
  writeFileSync(file, content.endsWith("\n") ? content : content + "\n", "utf8");
  return file;
}

/** 新会话的首条提示词：只指向文档，不塞正文。 */
export function buildHandoffKickoff(docPath: string, language: "zh" | "en" = "zh"): string {
  if (language === "en") {
    return [
      "This session continues from a previous one.",
      `Read the handoff document first: ${docPath}`,
      "Then pick up from its \"Next steps\" section; ask me if something is unclear.",
    ].join("\n");
  }
  return ["本会话从上一个会话交接而来。", `先读交接文档：${docPath}`, "然后从文档里的「未完成 / 下一步」接着做；有不清楚的地方先问我。"].join("\n");
}
