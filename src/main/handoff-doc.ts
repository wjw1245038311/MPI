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
 * 主进程只负责：发指令 → 等这一轮结束 → **找回文档** → 校验它像不像一份交接文档。
 *
 * ## 文件写到哪（2026-10-26 二次定稿）
 *
 * 指令里**不再指定绝对路径**——用户原话：「指令里带路径这件事」太复杂，他手打时从不指定，
 * 生成的内容也不差。现在让模型自己放到项目里合适的位置（`docs/HANDOFF-<日期>.md` 之类），
 * 主进程按四级兜底把文件找回来，顺序见 `src/main/ipc.ts` 的 `resolveHandoffDocPath`：
 *   ① 回执里的路径（`已写入：<路径>`，见 parseHandoffDocPath）
 *   ② `<cwd>/.mpi/handoff/` 里这一轮新出的
 *   ③ 项目内文件名含 handoff / 交接 的新 md（findNamedHandoffDocs）
 *   ④ 都没有 = 明确报失败
 * 代价是多一次可能失败的机会（模型漏写回执且不按命名习惯写），换来指令里没有路径噪音。
 */
import { mkdirSync, readdirSync, statSync, type Dirent } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

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

/** 主进程算的**建议**落盘路径 `<cwd>/.mpi/handoff/YYYYMMDD-HHmmss.md`。
 *  2026-10-26 起默认指令不再使用它（位置由模型自选）；只有自定义模板里写了 `{{path}}`
 *  才用它，另外它也是找回文档时的第二级兜底。 */
export function handoffDocPath(cwd: string, at: Date = new Date()): string {
  const dir = join(cwd, ".mpi", "handoff");
  mkdirSync(dir, { recursive: true });
  const pad = (n: number) => String(n).padStart(2, "0");
  const name = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}.md`;
  return join(dir, name);
}

/** 自定义模板里的落盘路径占位符（设置 → 对话设置 → 交接文档指令）。
 *  写了它就替换成主进程算好的固定路径（想要固定落点的人用）；不写就走「模型自选 + 回执」。 */
export const HANDOFF_PROMPT_PATH_TOKEN = "{{path}}";

/**
 * 给源会话的指令：写一份交接文档。
 *
 * 只保留**必要**的硬要求：事实/未知、H1（当会话名）、禁凭证、回执。其他一律交给 session
 * 自己判断——用户 2026-10-26：「有些会话要交接的内容很少，不用这么复杂的结构」。
 * **路径不在指令里**（用户二次定稿）：模型自己选位置，用回执告诉主进程（见文件头注释）。
 *
 * `custom` = 用户自己的指令模板（Settings → 对话配置 → 交接文档指令）；空白 = 内置默认。
 * 模板里若写 `{{path}}`，会替换成主进程算好的固定路径；没写回执要求时自动补一行。
 */
export function buildHandoffDocInstruction(
  docPath: string,
  language: "zh" | "en" = "zh",
  custom?: string,
): string {
  const tpl = String(custom || "").trim();
  if (!tpl) return builtinHandoffTemplate(language);
  return fillHandoffTemplate(tpl, docPath, language);
}

/** 内置默认模板（已带回执要求，可直接发给模型）：设置面板的「恢复默认」与测试都以它为准。
 *
 * 2026-10-26 用户定稿：事实与未知、H1（当会话名）、禁凭证 + 位置、回执。
 * 字数上限 / 分节建议 / 不贴代码这些**风格要求全删**（用户：「这几句可以不要」）。
 */
export function builtinHandoffTemplate(language: "zh" | "en" = "zh"): string {
  if (language === "en") {
    return [
      'Write the handoff document for THIS session (a new session will take over). Facts only, no speculation; write "unknown" when unsure.',
      "First line: one `#` heading summarizing this handoff (it becomes the new session's title).",
      "Never include API keys, tokens, passwords or authorization codes. Use the write tool to save it somewhere sensible in the project (e.g. docs/HANDOFF-<date>.md).",
      `When done, reply with one line only: ${RECEIPT_HINT_EN} — do not paste the document.`,
    ].join("\n");
  }
  return [
    "把本会话写成交接文档（随后由新会话接着做）。只写事实、不推测；不确定的写「未知」。",
    "第一行用一个 `#` 一级标题概括这次交接（它会成为新会话的会话名）。",
    "不要写密钥、令牌、密码、授权码。用 write 工具写到项目里合适的位置（如 docs/HANDOFF-<日期>.md）。",
    `写完只回一行：${RECEIPT_HINT_ZH}，不要贴正文。`,
  ].join("\n");
}

/** 回执行里路径部分的写法（parseHandoffDocPath 认这个前缀）。 */
const RECEIPT_HINT_ZH = "已写入：<相对项目根的路径>";
const RECEIPT_HINT_EN = "done: <path relative to the project root>";

/** 回执行的正则：`已写入：xxx` / `done: xxx`（行内最后一个匹配为准）。 */
const RECEIPT_RE = /(?:已写入|done)\s*[:：]\s*(.+)$/i;

/**
 * 把自定义模板填成真指令：替换 `{{path}}`；模板没要求回执时补一行回执要求
 * （否则主进程只能靠扫目录找文件，交接成功率明显下降）。
 */
export function fillHandoffTemplate(tpl: string, docPath: string, language: "zh" | "en" = "zh"): string {
  const text = String(tpl || "").trim();
  const filled = text.includes(HANDOFF_PROMPT_PATH_TOKEN) ? text.split(HANDOFF_PROMPT_PATH_TOKEN).join(docPath) : text;
  if (/(?:已写入|done)\s*[:：]/i.test(filled)) return filled; // 用户自己写了回执要求
  return `${filled}\n${language === "en" ? `When done, reply with one line only: ${RECEIPT_HINT_EN} — do not paste the document.` : `写完只回一行：${RECEIPT_HINT_ZH}，不要贴正文。`}`;
}

/**
 * 从模型这一轮的回复里取回执路径（纯函数，可单测）。
 *
 * 规则：取**最后一个** `已写入：…` / `done: …` 行 → 去掉包裹的反引号/引号/句末标点 →
 * 相对路径按 cwd 解析 → **必须在 cwd 内**（写到 cwd 外面一律不认，避免抓错文件）。
 * 不像路径的（如「已写入：完成」）返回 null。
 */
export function parseHandoffDocPath(replyText: string, cwd: string): string | null {
  if (!replyText || !cwd) return null;
  let raw = "";
  for (const line of String(replyText).split(/\r?\n/)) {
    const m = RECEIPT_RE.exec(line.trim());
    if (m) raw = m[1];
  }
  const cleaned = raw.replace(/^[`'"“”‘’\s]+/, "").replace(/[`'"“”‘’\s。，,；;]+$/, "").trim();
  if (!cleaned) return null;
  // 必须是「像路径」的东西：带目录分隔符，或以文档扩展名结尾。
  if (!/[\\/]/.test(cleaned) && !/\.(?:md|markdown|txt)$/i.test(cleaned)) return null;
  const abs = isAbsolute(cleaned) ? resolve(cleaned) : resolve(cwd, cleaned);
  const rel = relative(resolve(cwd), abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
}

/** 扫目录时跳过的重目录（node_modules 这种深进去纯浪费时间）。 */
const HANDOFF_SCAN_SKIP = new Set([
  "node_modules", "out", "dist", "release", "tempfile", "build", ".next", "coverage", "venv", ".venv",
]);

/**
 * 项目内「按命名习惯写的交接文档」：文件名含 handoff / 交接 的 md，且是这一轮之后写/改的。
 * 按 mtime 从新到旧返回（调用方逐个校验）。深度默认 2 层（`docs/`、`docs/sub/`），
 * 跳过重目录与所有隐藏目录（`.git`、`.mpi` 等——`.mpi/handoff` 有专门的兜底）。
 */
export function findNamedHandoffDocs(cwd: string, sinceMs: number, maxDepth = 2): string[] {
  if (!cwd) return [];
  const found: { path: string; mtimeMs: number }[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      const full = join(dir, name);
      if (entry.isDirectory()) {
        if (depth >= maxDepth) continue;
        if (name.startsWith(".") || HANDOFF_SCAN_SKIP.has(name.toLowerCase())) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/\.(?:md|markdown)$/i.test(name) || !/handoff|交接/i.test(name)) continue;
      try {
        const st = statSync(full);
        if (st.mtimeMs >= sinceMs - 2000) found.push({ path: full, mtimeMs: st.mtimeMs });
      } catch {
        /* 读不到 stat 就跳过 */
      }
    }
  };
  walk(cwd, 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.path);
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
 * 路径守卫：交接文档必须落在**本项目内**（2026-10-26 起不再限定 `.mpi/handoff/`——
 * 位置由模型自选，`docs/HANDOFF-<日期>.md` 也算）。给客户端/旧文档传来的任意字符串做校验用。
 */
export function isHandoffDocPath(cwd: string, candidate: string): boolean {
  if (!cwd || !candidate) return false;
  const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate);
  const rel = relative(resolve(cwd), abs);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel) && /\.(?:md|markdown)$/i.test(abs);
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
