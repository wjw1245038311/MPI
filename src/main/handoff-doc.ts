/**
 * 会话交接文档（handoff doc）——纯逻辑，不依赖 electron，可直接单测。
 *
 * ## 为什么改成「让源会话自己写」
 *
 * 2026-10-26 用户定稿：**唯一路径 = 在源会话里跑一轮**，由它自己把本会话写成交接文档。
 *
 * 之前的做法是主进程旁路发一次 HTTP chat completion：只把会话里最后 40 条 user/assistant
 * **纯文本**（单条截 2000 字、总预算 30000 字，工具调用与思考全丢）喂给模型，没有工具、
 * 读不了文件、核不了事实；任何一步失败还**静默退化**成「最近 8 轮原文 + 整个项目待办」。
 * 实测三份文档全是这种退化版（模型 id 与 models.json 对不上 → 4xx），而文档里悄悄塞进了
 * 项目里几个月前的陈旧待办——看起来像「越界读取」，实际是退化产物。
 *
 * 改成会话内一轮之后：
 *   - 模型看到的是**完整会话**（不是截断片段），能自己读文件核对、能自己查待办面板；
 *   - 那一轮**在对话里可见**（用户 2026-10-26 选定）：能看见它读了什么、写了什么；
 *   - 失败就**明说失败**，不再有「看起来成功、其实是原文堆砌」的产物。
 *
 * 主进程只负责：算好落盘路径 → 发指令 → 等这一轮结束 → 校验文件像不像一份交接文档。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** 交接文档的固定小节（顺序即要求）。桌面/手机同一份。 */
export const HANDOFF_DOC_SECTIONS_ZH = ["目标", "已完成", "关键决定", "未完成 / 下一步", "注意事项"] as const;
export const HANDOFF_DOC_SECTIONS_EN = ["Goal", "Done", "Key decisions", "Next steps", "Cautions"] as const;

/** 文档至少这么多字才算「写成了」——低于这个数多半是模型只说了一句「已写入」。 */
export const HANDOFF_DOC_MIN_CHARS = 120;

/**
 * 等这一轮写完的上限。客户端（PWA / 安卓）对 `thread.handoff` 的请求超时是 180s，
 * 主机必须**更早**收手，才能把「超时」当成一条正常错误回给客户端，而不是让客户端
 * 自己超时——那样手机端只会看到一句「等主机回应超时」。
 */
export const HANDOFF_TURN_TIMEOUT_MS = 150_000;

/** `<cwd>/.mpi/handoff/YYYYMMDD-HHmmss.md`（路径由主进程决定，agent 只管往里写）。 */
export function handoffDocPath(cwd: string, at: Date = new Date()): string {
  const dir = join(cwd, ".mpi", "handoff");
  mkdirSync(dir, { recursive: true });
  const pad = (n: number) => String(n).padStart(2, "0");
  const name = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}.md`;
  return join(dir, name);
}

/**
 * 给源会话的指令：写一份交接文档到指定路径。
 *
 * 刻意做到「自包含」：用户可能开着只读/自定义任务模式，也不一定装了待办扩展，
 * 所以指令里不假设任何工具一定可用（待办查不到就跳过），但路径与结构是硬要求。
 */
export function buildHandoffDocInstruction(docPath: string, language: "zh" | "en" = "zh"): string {
  if (language === "en") {
    return [
      "Write the handoff document for THIS session — a new session will take over from it.",
      "",
      "Requirements:",
      "1. Facts only, drawn from this session. Never speculate; write \"unknown\" when unsure.",
      "2. Start with one `#` heading naming what this handoff is about (specific, one line). It becomes the",
      "   new session's title——do not write a bare \"Handoff document\".",
      "3. Fixed Markdown structure, exactly these five `##` headings in this order:",
      ...HANDOFF_DOC_SECTIONS_EN.map((s) => `   ## ${s}`),
      "4. \"Next steps\": carry over what is still open from this session. If the todo panel has open",
      "   items that clearly belong to this session (use the todo list tool when available), fold them in;",
      "   unrelated project todos must stay out.",
      "5. Never include API keys, tokens, passwords or authorization codes. No long code dumps —",
      "   conclusions and file paths are enough.",
      `6. At most 800 words.`,
      "7. Use the write tool to save it at this exact path (overwrite if it exists):",
      `   ${docPath}`,
      `8. Do NOT paste the document into the chat. When done, reply with a single line:`,
      `   done: ${docPath}`,
    ].join("\n");
  }
  return [
    "把**本会话**写成交接文档——随后会有一个新会话接着做。",
    "",
    "要求：",
    "1. 只写本会话里确实发生过的事实，不推测；不确定的写「未知」。",
    "2. 第一行用 `#` 一级标题一句话概括这次交接在做什么（具体一点）。",
    "   它会直接成为新会话的会话名，所以别只写「交接文档」。",
    "3. 结构固定，五个二级标题，顺序如下：",
    ...HANDOFF_DOC_SECTIONS_ZH.map((s) => `   ## ${s}`),
    "4. 「未完成 / 下一步」：把本会话里还没做完的事写清楚；待办面板里**明显属于本会话**的未完成项",
    "   （有 todo 查询工具时查一下）一并整合进来，与本会话无关的项目待办不要带。",
    "5. 绝对不要写入密钥、令牌、密码、授权码；不要贴大段代码，给结论和文件路径即可。",
    "6. 篇幅不超过 800 字。",
    "7. 用 write 工具写到下面这个确切路径（已存在就覆盖）：",
    `   ${docPath}`,
    "8. 不要把文档正文贴进对话。写完只回一行：",
    `   已写入：${docPath}`,
  ].join("\n");
}

/**
 * 从交接文档里取标题（第一个 `# ` 一级标题），用作**新会话的会话名**。
 *
 * 用户 2026-10-26：交接文档的标题通常写得很好，直接拿它当会话名最方便，也自带连续性
 * （链式交接时一眼看出上一段做了什么）。所以不自己造标题，只做两件事：
 *   ① 去掉泛标题（「交接文档」「交接文档（项目 X）」——这类没信息量，不如回落到兜底值）；
 *   ② 截断到侧栏能显示的尺度。
 * 文档没写 H1、或只写了泛标题时用 `fallback`（调用方给时间戳一类）。
 */
export function handoffDocTitle(text: string, fallback: string, maxChars = 60): string {
  const h1 = /^#\s+(.+)$/m.exec(String(text || ""))?.[1] || "";
  // 去掉 markdown 强调符号与结尾标点；标题只要纯文字。
  let title = h1
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+#+\s*$/, "")
    .replace(/[。；;\s]+$/, "")
    .trim();
  // 泛标题（含只写了项目名的情况）不算：对「这条会话在干什么」零信息。
  const generic = /^(?:交接文档|交接|handoff(?:\s+document)?)(?:\s*[（(].*[）)])?$/i;
  if (generic.test(title)) title = "";
  const value = (title || fallback || "").replace(/\s+/g, " ").trim();
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

/** 文档里没有像样的一级标题时的兜底会话名（取文件名里的时间戳）。 */
export function handoffFallbackTitle(docPath: string, language: "zh" | "en" = "zh"): string {
  const m = /(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(String(docPath || ""));
  if (!m) return language === "en" ? "Handoff" : "交接";
  const [, y, mo, d, h, mi] = m;
  return language === "en" ? `Handoff ${y}-${mo}-${d} ${h}:${mi}` : `交接 ${y}-${mo}-${d} ${h}:${mi}`;
}

/**
 * 校验一条新会话的首条提示词里引用的路径——交接文档必须落在本项目内。
 * （路径由主进程算，但客户端/旧文档可能传回任意字符串。）
 */
export function isHandoffDocPath(cwd: string, candidate: string): boolean {
  if (!cwd || !candidate) return false;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(candidate).startsWith(`${norm(cwd)}/.mpi/handoff/`);
}

/**
 * 校验 agent 写出来的文档像不像一份交接文档（纯函数，可单测）：
 * 五个小节标题至少出现 3 个、正文长度够、不是只有一句「已写入」。
 */
export function inspectHandoffDoc(text: string, language: "zh" | "en" = "zh"): {
  ok: boolean;
  missing: string[];
  chars: number;
} {
  const body = String(text || "");
  const sections = language === "en" ? HANDOFF_DOC_SECTIONS_EN : HANDOFF_DOC_SECTIONS_ZH;
  const missing = sections.filter((name) => !new RegExp(`^#{1,3}\\s*${escapeRe(name)}\\s*$`, "m").test(body));
  const chars = body.trim().length;
  return { ok: chars >= HANDOFF_DOC_MIN_CHARS && missing.length <= sections.length - 3, missing: [...missing], chars };
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
