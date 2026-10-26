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

/** 交接文档的建议小节（顺序即举例；2026-10-26 起**不再强制**——内容少的会话不必凑五段）。
 *  桌面/手机同一份；校验只看「不是空壳」，见 inspectHandoffDoc。 */
export const HANDOFF_DOC_SECTIONS_ZH = ["目标", "已完成", "关键决定", "未完成 / 下一步", "注意事项"] as const;
export const HANDOFF_DOC_SECTIONS_EN = ["Goal", "Done", "Key decisions", "Next steps", "Cautions"] as const;

/** 文档至少这么多字才算「写成了」——低于这个数多半是模型只说了一句「已写入」。 */
export const HANDOFF_DOC_MIN_CHARS = 60;

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

/** 自定义模板里的落盘路径占位符（设置 → 对话设置 → 交接文档指令）。 */
export const HANDOFF_PROMPT_PATH_TOKEN = "{{path}}";

/**
 * 给源会话的指令：写一份交接文档到指定路径。
 *
 * 刻意做到「自包含」，但只保留**改动前后都不变**的硬要求：路径、write 落盘、不回贴正文、
 * 禁凭证。其他一律交给 session 自己判断——用户 2026-10-26：「有些会话要交接的内容很少，
 * 不用这么复杂的结构」。（之前那版 8 条编号 + 五段强制，篇幅约 700 字，还逼着小会话凑段落。）
 *
 * `custom` = 用户自己的指令模板（Settings → 对话配置 → 交接文档指令）；空/未写就用内置默认。
 * 模板里的 `{{path}}` 会被替成真正的落盘路径；没写占位符就往末尾自动补上「写到哪 / 怎么回」。
 */
export function buildHandoffDocInstruction(
  docPath: string,
  language: "zh" | "en" = "zh",
  custom?: string,
): string {
  const tpl = String(custom || "").trim();
  if (tpl) return fillHandoffTemplate(tpl, docPath, language);
  return fillHandoffTemplate(builtinHandoffTemplate(language), docPath, language);
}

/** 内置默认模板（用 `{{path}}` 占位）：设置面板做占位提示与「恢复默认」，也供测试比对。
 *
 * 2026-10-26 用户定稿：只留**必要**三行——事实与未知、H1（当会话名）、禁凭证 + 落盘。
 * 字数上限 / 分节建议 / 不贴代码 / 不回贴正文这些**风格要求全删**（用户：「这几句可以不要」）。
 */
export function builtinHandoffTemplate(language: "zh" | "en" = "zh"): string {
  if (language === "en") {
    return [
      "Write the handoff document for THIS session (a new session will take over). Facts only, no speculation; write \"unknown\" when unsure.",
      "First line: one `#` heading summarizing this handoff (it becomes the new session's title).",
      `Never include API keys, tokens, passwords or authorization codes. Use the write tool to save it at ${HANDOFF_PROMPT_PATH_TOKEN} (overwrite if it exists).`,
    ].join("\n");
  }
  return [
    "把本会话写成交接文档（随后由新会话接着做）。只写事实、不推测；不确定的写「未知」。",
    `第一行用一个 \`#\` 一级标题概括这次交接（它会成为新会话的会话名）。`,
    `不要写密钥、令牌、密码、授权码。用 write 工具写到 ${HANDOFF_PROMPT_PATH_TOKEN}（已存在就覆盖）。`,
  ].join("\n");
}

/**
 * 把模板填成真指令：替换 `{{path}}`；模板没写占位符时，把「写到哪 / 怎么回」补在末尾
 * （否则 agent 拿不到落盘路径，交接会直接失败）。
 */
export function fillHandoffTemplate(tpl: string, docPath: string, language: "zh" | "en" = "zh"): string {
  const text = String(tpl || "").trim();
  if (text.includes(HANDOFF_PROMPT_PATH_TOKEN)) {
    return text.split(HANDOFF_PROMPT_PATH_TOKEN).join(docPath);
  }
  const tail =
    language === "en"
      ? [
          "Use the write tool to save it at this exact path (overwrite if it exists), then reply with one line only",
          `(done: ${docPath}). Do NOT paste the document into the chat.`,
        ]
      : ["用 write 工具写到这个路径（已存在就覆盖），写完只回一行「已写入：<路径>」，不要把文档正文贴进对话：", `  ${docPath}`];
  return `${text}\n${tail.join("\n")}`;
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
 * 校验 agent 写出来的文档像不像一份交接文档（纯函数，可单测）。
 *
 * **只拦「空壳」**：扣掉「已写入：<路径>」这类回执行之后，正文长度得够。
 * 不再要求固定小节结构——2026-10-26 用户：内容少的会话不必凑五段。`missing` 仍返回，
 * 只作诊断信息（哪些建议小节没写），不影响 ok。
 */
export function inspectHandoffDoc(text: string, language: "zh" | "en" = "zh"): {
  ok: boolean;
  missing: string[];
  chars: number;
} {
  const body = String(text || "");
  const sections = language === "en" ? HANDOFF_DOC_SECTIONS_EN : HANDOFF_DOC_SECTIONS_ZH;
  const missing = sections.filter((name) => !new RegExp(`^#{1,3}\\s*${escapeRe(name)}\\s*$`, "m").test(body));
  // 回执行不算内容：模型只写了一句「已写入：…」时不能被当成文档。
  const stripped = body
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:已写入|done)\s*[:：]/i.test(line))
    .join("\n");
  const chars = stripped.trim().length;
  return { ok: chars >= HANDOFF_DOC_MIN_CHARS, missing: [...missing], chars };
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
