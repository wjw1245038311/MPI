/**
 * 桌面端取「聊天里的视频附件」字节的 URL 拼装（主机侧 handler 见
 * `src/main/chat-attachment-protocol.ts`）。
 *
 * 为什么名字走 query 而不是 hostname：standard 协议的 hostname 会被 URL 解析器**小写化**，
 * 而落盘名可能含大写。
 *
 * 引用信封（`<file … attach="video" … />`）到「视频附件」的解析在 `store.ts` 的
 * `parseUserMessage`（它本来就在做 `<file>` 信封 → 附件的转换，不该在这里再来一遍）。
 */

import type { ViewAttachment } from "./types";

export function chatAttachmentUrl(name: string): string {
  return `chatatt://attachment/?name=${encodeURIComponent(name)}`;
}

// ---- agent 主动递交的附件引用（mpi_attach_file）------------------------------

/** `<file … />` 信封（只取自闭合的那种）。 */
const AGENT_FILE_TAG = /<file\b[^>]*?\/>/g;

function readAttr(tag: string, name: string): string | undefined {
  // String.raw 是必需的：普通模板字符串会把 \s 吃成字面 s，属性就永远读不出来。
  const match = tag.match(new RegExp(String.raw`(?:^|\s)${name}="([^"]*)"`, "i"));
  return match?.[1];
}

/** 字节数成人话（卡片副标题用；不引 format.ts 是为了让这个模块保持零依赖可单测）。 */
export function attachmentSizeText(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export interface AgentMediaRefs {
  text: string;
  attachments: ViewAttachment[];
}

/**
 * 把 **agent 写的**媒体引用信封剥成附件卡片。
 *
 * 为什么单独一个函数：`store.ts` 的 `parseUserMessage` 只管用户气泡，而 agent 回复里的
 * 引用走的是另一条渲染路径（Chat.tsx 的 AssistantBlock），那里原本会把 `<file … />`
 * 原样当 Markdown 显示——用户就会看到一整行 XML。
 *
 * 只认带 `attach="media"` / `attach="video"` 标记的信封：没有标记的 `<file path=…>` 是
 * 「给模型读的输入文件」说明，本来就该以文本形式留在正文里。
 *
 * 流式安全：标签可能只输出了半个，尾部未闭合的 `<file …` 先裁掉，避免逐字露出 XML；
 * 等这一轮写完，完整信封会被正常解析成卡片。
 */
export function parseAgentMediaRefs(text: string): AgentMediaRefs {
  const raw = text || "";
  // 快速路径只看 attach= 存在：流式中标签可能只写了一半，它也得进来被裁掉。
  if (!raw.includes("attach=")) return { text: raw, attachments: [] };
  const attachments: ViewAttachment[] = [];
  let cleaned = raw.replace(AGENT_FILE_TAG, (tag) => {
    const attach = readAttr(tag, "attach") ?? "";
    if (attach !== "media" && attach !== "video") return tag;
    const name = readAttr(tag, "name");
    if (!name) return tag; // 没有 name 就不是我们写的信封，别吞别人的文本
    const label = readAttr(tag, "label");
    const path = readAttr(tag, "path");
    const size = Number.parseInt(readAttr(tag, "size") || "", 10);
    const sizeText = Number.isFinite(size) && size > 0 ? attachmentSizeText(size) : "";
    attachments.push({
      name: label || name,
      ...(path ? { path } : {}),
      ...(sizeText ? { note: sizeText } : {}),
      kind: attach === "video" ? "video" : "file",
    });
    return "";
  });
  const dangling = /<file\b[^>]*$/i.exec(cleaned);
  if (dangling && /attach=/.test(dangling[0])) cleaned = cleaned.slice(0, dangling.index);
  return { text: cleaned.replace(/\n{3,}/g, "\n\n").trimEnd(), attachments };
}
