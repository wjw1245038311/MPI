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

const FENCE = /^```(.*)$/;

export function parseSegments(raw: string): TextSegment[] {
  const text = typeof raw === "string" ? raw : "";
  if (!text) return [];
  // 没有围栏就不做任何加工（绝大多数消息走这条路）。
  if (!/^[ \t]*```/m.test(text)) return [{ type: "text", text }];

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
        lang = (match[1] || "").trim().toLowerCase();
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
  const key = (lang || "").trim().toLowerCase();
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
