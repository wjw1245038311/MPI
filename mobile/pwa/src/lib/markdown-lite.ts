/**
 * 轻量 markdown 分段（只做最影响可读性的一件事：代码围栏）。
 *
 * 手机端原本把整段文本按 `white-space: pre-wrap` 原样打印，于是 fenced code 会连
 * ``` 一起显示成正文（对比 Qoder：代码块有语言标签、可复制、可折叠）。这里只做
 * 「按 ``` 围栏切成 文本 / 代码 两段」，不引入 markdown 依赖——其余语法（粗体、
 * 列表）在纯文本下已经可读。
 *
 * 流式渲染要能容忍**未闭合**的围栏：模型正在吐代码时后面的内容都应算作代码段
 * （closed=false），闭合后再重排，不会闪回正文。
 */
export interface TextSegment {
  type: "text" | "code";
  text: string;
  /** 代码段：围栏后的语言标记（原样小写，可能为空）。 */
  lang?: string;
  /** 代码段：围栏是否已闭合（流式中为 false）。 */
  closed?: boolean;
}

/**
 * 围栏行：三个以上反引号**或浪加号**，前面允许一个 markdown 列表符号。
 * 两种宽忍都是模型的真实写法（2026-11-06：`~~~` 闭合、把提问写在 `- ` 列表项里），
 * 与桌面端 choice-block 的 CHOICES_LIST_OPEN_RE / choiceCloseReFor 同一口径；
 * 区别是这里是**全局**生效（所有代码块），因为切分只发生在这一层。
 */
const FENCE = /^(?:(?:[-*+]|\d+[.)])[ \t]+)?([`~]{3,})(.*)$/;
/** 快速路径用：文本里到底有没有围栏行（没有就一个字不用改）。 */
const HAS_FENCE = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?[`~]{3,}/m;

export function parseSegments(raw: string): TextSegment[] {
  const text = typeof raw === "string" ? raw : "";
  if (!text) return [];
  // 没有围栏就不做任何加工（绝大多数消息走这条路）。
  if (!HAS_FENCE.test(text)) return [{ type: "text", text }];

  const lines = text.split("\n");
  const out: TextSegment[] = [];
  let buffer: string[] = [];
  let mode: "text" | "code" = "text";
  let lang = "";

  const flush = (closed = true) => {
    const body = buffer.join("\n");
    if (mode === "code") out.push({ type: "code", text: body, lang, closed });
    else if (body.trim() || out.length === 0) out.push({ type: "text", text: body });
    buffer = [];
  };

  for (const line of lines) {
    const match = FENCE.exec(line.trim());
    if (match) {
      if (mode === "text") {
        flush();
        mode = "code";
        // 整段信息串原样留着（choices 面板需要从里面取「与围栏同行的正文」），
        // 展示名由 languageLabel 只取第一个词。
        lang = (match[2] || "").trim().toLowerCase();
      } else {
        flush();
        mode = "text";
        lang = "";
      }
      continue;
    }
    buffer.push(line);
  }
  flush(mode !== "code"); // 未闭合的代码段标记 closed=false
  return out.filter((segment) => segment.type === "code" || segment.text.trim().length > 0);
}

/** 语言标记 → 展示名（Qoder 风格的首字母大写 + 常见别名）。 */
export function languageLabel(lang?: string): string {
  // 只取第一个词：`choices [{"title":…}]` 这种同行正文不能跟着当成标签显示。
  const key = (lang || "").trim().split(/[\s[{(]/)[0].toLowerCase();
  if (!key) return "代码";
  const aliases: Record<string, string> = {
    py: "Python",
    python: "Python",
    js: "JavaScript",
    javascript: "JavaScript",
    ts: "TypeScript",
    typescript: "TypeScript",
    tsx: "TSX",
    jsx: "JSX",
    sh: "Shell",
    bash: "Shell",
    zsh: "Shell",
    powershell: "PowerShell",
    ps1: "PowerShell",
    json: "JSON",
    yml: "YAML",
    yaml: "YAML",
    toml: "TOML",
    md: "Markdown",
    html: "HTML",
    css: "CSS",
    scss: "SCSS",
    sql: "SQL",
    go: "Go",
    rs: "Rust",
    java: "Java",
    kt: "Kotlin",
    c: "C",
    cpp: "C++",
    cs: "C#",
    rb: "Ruby",
    php: "PHP",
    diff: "Diff",
    ini: "INI",
    xml: "XML",
  };
  return aliases[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}
