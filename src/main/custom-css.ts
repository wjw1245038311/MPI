import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./config";

/**
 * User-defined stylesheet (custom.css) — ported from p-a-d #29 / PR #29.
 *
 * The file lives next to config.json in the app's userData dir, so it is
 * per-profile like every other MPI setting. The renderer injects its content
 * into a <style> tag appended at the end of <head>, i.e. after all built-in
 * stylesheets — user rules win at equal specificity. A directory watcher
 * pushes live updates to the windows, so edits apply without a restart.
 */

export function customCssPath(): string {
  return join(getConfigDir(), "custom.css");
}

/** Current content; empty string when the file is missing or unreadable. */
export function readCustomCss(): string {
  try {
    const file = customCssPath();
    if (!existsSync(file)) return "";
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Create the annotated template on first use. Never overwrites an existing file. */
export function ensureCustomCssTemplate(language: "en" | "zh"): { path: string; created: boolean } {
  const file = customCssPath();
  if (existsSync(file)) return { path: file, created: false };
  writeFileSync(file, templateFor(language), "utf8");
  return { path: file, created: true };
}

/**
 * Watch the userData dir for changes to custom.css. Watching the directory
 * (not the file) also covers first-time creation and editor saves that replace
 * the inode; events are debounced so a save burst yields one callback.
 */
export function watchCustomCss(onChange: () => void): () => void {
  let timer: NodeJS.Timeout | null = null;
  const watcher: FSWatcher = watch(getConfigDir(), (_event, name) => {
    if (name && String(name).toLowerCase() !== "custom.css") return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 150);
  });
  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}

function templateFor(language: "en" | "zh"): string {
  if (language === "zh") {
    return `/* =============================================================
 *  MPI 自定义样式表 · custom.css
 * ------------------------------------------------------------
 *  - 在所有内置样式之后加载，同优先级下你的规则覆盖默认值
 *  - 保存即生效（实时热更新），无需重启；删除本文件或清空内容即还原
 *  - 只写你想改的属性，其余保持原样
 * ============================================================= */

/* ---- 主题变量：最省事，一行改变整站外观 ----
 *   --bg 背景        --text 主文字      --accent 强调色
 *   --code-bg 代码块底色  --radius 圆角    --sidebar-w 侧栏宽度
 *   --font UI 字体     --mono 等宽（代码）字体
 */
/* :root {
  --accent: #b3541e;
  --radius: 8px;
} */

/* ---- 仅暗色主题生效（浅色不受影响）---- */
/* :root[data-theme="dark"] {
  --bg: #0f1210;
} */

/* ---- 字体与字号 ---- */
/* body { font-size: 15px; }                            全局基础字号（默认 14px）
.md p, .msg-user-text { line-height: 1.7; }             消息行距
pre, code { font-family: "JetBrains Mono", var(--mono); } */

/* ---- 布局与间距 ---- */
/* .msg { margin-bottom: 20px; }                        消息之间的垂直间距 */

/* ---- 隐藏不需要的元素（示例）---- */
/* .user-message-nav { display: none; }                 右侧消息快速跳转点 */
`;
  }
  return `/* =============================================================
 *  MPI custom stylesheet · custom.css
 * ------------------------------------------------------------
 *  - Loaded after all built-in styles; at equal specificity your rules win
 *  - Save to apply live (hot reload), no restart needed; delete this file
 *    (or empty it) to restore the defaults
 *  - Only write the properties you want to change
 * ============================================================= */

/* ---- Theme variables: cheapest way to restyle the whole app ----
 *   --bg background     --text main text      --accent accent color
 *   --code-bg code bg   --radius corner radius --sidebar-w sidebar width
 *   --font UI font      --mono monospace (code) font
 */
/* :root {
  --accent: #b3541e;
  --radius: 8px;
} */

/* ---- Dark theme only (light theme unaffected) ---- */
/* :root[data-theme="dark"] {
  --bg: #0f1210;
} */

/* ---- Fonts & sizes ---- */
/* body { font-size: 15px; }                            base size (default 14px)
.md p, .msg-user-text { line-height: 1.7; }             message line height
pre, code { font-family: "JetBrains Mono", var(--mono); } */

/* ---- Layout & spacing ---- */
/* .msg { margin-bottom: 20px; }                        vertical gap between messages */

/* ---- Hide elements you don't need (example) ---- */
/* .user-message-nav { display: none; }                 right-side message jump dots */
`;
}
