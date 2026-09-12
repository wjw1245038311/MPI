#!/usr/bin/env node
/**
 * MPI 用户手册同步差分工具。
 *
 * 读取 changelog.md 与 .pi/manual-sync.json，列出「自上次同步以来」的变更条目，
 * 并给出「用户可见 / 内部」的初步判定与「目标章节」建议。供 user-manual skill 使用。
 *
 * 用法：
 *   node scripts/manual-sync.mjs            # 人类可读报告
 *   node scripts/manual-sync.mjs --json     # 结构化 JSON
 *   node scripts/manual-sync.mjs --mark-done <sig> [<sig> ...]   # 把条目标记为已同步
 *
 * 纯函数可从其它脚本 import（见 scripts/test-manual-sync.mjs）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CHANGELOG_PATH = join(ROOT, "changelog.md");
export const STATE_PATH = join(ROOT, ".pi", "manual-sync.json");

/** 条目标题签名：去 markdown 粗体、折叠空白、截断。用标题而非编号（发版会重置编号）。 */
export function signature(title) {
  return String(title)
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .replace(/[（(].*$/, "")
    .trim()
    .slice(0, 40);
}

/**
 * 解析 changelog.md → [{ title, items: [{ number, title, signature }] }]
 * 条目 = 行首 `N. `；其后的缩进/续行忽略。
 */
export function parseChangelog(text) {
  const lines = String(text).split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = { title: heading[1], items: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const item = line.match(/^(\d+)\.\s+(.+?)\s*$/);
    if (item) {
      const title = item[2].replace(/\*\*/g, "").trim();
      current.items.push({ number: Number(item[1]), title, signature: signature(item[2]) });
    }
  }
  return sections;
}

const INTERNAL_PATTERNS = [
  /测试注册表|测试面板|测试运行器|test-registry|test-runner/,
  /E2E|e2e|端到端测试|harness/,
  /开发工具|dev 一键发布|devtools|dev release|GitHub Actions/,
  /测试文档|FEATURE-TESTING|E2E-TESTING/,
  /用户手册 ?skill|manual-sync|同步手册/,
  /^重构|重构[:：]|重构 \/|纯内部|内部字段|类型定义/,
  /CI\b|构建脚本|发布脚本|依赖升级/,
];

const CHAPTER_HINTS = [
  [/任务模式|行为指令|模式切换|模式预设|调研|审查|强制只读/, "6. 与智能体对话（任务模式）"],
  [/会话选择卡片|提问卡片|消息渲染|工具调用|智能体对话|toa?st/, "6. 与智能体对话"],
  [/权限模式|只读|严格模式|沙盒|完全权限|工具信任|permission/, "8. 权限模式"],
  [/提供商|API Key|thinkingLevelMap|思考默认值|思考档位|模型/g, "4. 配置模型"],
  [/语音|STT|TTS|朗读/, "7. 语音系统"],
  [/上下文|压缩|摘要|token/, "9. 上下文管理"],
  [/预览|HTML 元素|批注|Markdown 目录/, "10. 文件预览与 HTML 元素引用"],
  [/定时任务|调度|cron/, "11. 定时任务"],
  [/待办|todo|收件箱/i, "12. 待办任务"],
  [/扩展包|技能|skill|MCP|扩展功能/i, "13. 扩展功能"],
  [/TUI|终端模式/, "14. Pi TUI 终端模式"],
  [/全局搜索|Ctrl\+K/i, "15. 全局搜索"],
  [/归档|回收站/, "16. 归档与回收站"],
  [/设置页|设置参考|主题模式|主题色|外观|窗口缩放|头像|用户画像|备份与恢复|诊断|通知/, "17. 设置参考"],
  [/安装|首次启动|运行时|应用更新/, "2. 安装与首次启动 / 17.8 关于 MPI"],
  [/项目 |会话管理|新建会话|重命名/, "5. 项目与会话管理"],
  [/数据位置|迁移|存储目录/, "21. 数据与配置位置"],
  [/Android|远程控制|手机/, "18. Android 手机远程控制"],
  [/消息接入|飞书|微信|钉钉/, "19. 消息接入"],
  [/快捷键/, "20. 快捷键速查"],
];


/** 初步判定是否面向普通用户（dev-only / 测试 / 文档等内部项为 false）。 */
export function classifyUserFacing(title) {
  return !INTERNAL_PATTERNS.some((re) => re.test(String(title)));
}

/** 根据主题关键词打分给出建议章节；无法判断返回 "?"。 */
export function suggestChapter(title) {
  const t = String(title);
  let best = "?";
  let bestScore = 0;
  for (const [re, chapter] of CHAPTER_HINTS) {
    const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
    const matches = t.match(new RegExp(re.source, flags));
    const score = matches ? matches.length : 0;
    if (score > bestScore) {
      bestScore = score;
      best = chapter;
    }
  }
  return best;
}

/** 默认同步状态。 */
export function defaultState() {
  return {
    syncedThrough: "v0.6.9",
    unreleased: [],
    updatedAt: new Date().toISOString().slice(0, 10),
    notes: "手册覆盖到 v0.6.9；Unreleased 中已逐条同步的条目签名记录在 unreleased。",
  };
}

export function loadState(path = STATE_PATH) {
  if (!existsSync(path)) return defaultState();
  try {
    return { ...defaultState(), ...JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return defaultState();
  }
}

/**
 * 计算待同步条目。
 * @returns {{ syncedThrough: string, pending: object[], skipped: object[], unknownVersion: boolean }}
 */
export function computePending(sections, state) {
  const synced = state.syncedThrough;
  const unreleasedSigs = new Set(state.unreleased || []);
  const matchVersion = (t) => t === synced || t.startsWith(synced + "（") || t.startsWith(synced + "(");
  const idx = sections.findIndex((s) => matchVersion(s.title.trim()));
  const unknownVersion = synced !== "Unreleased" && idx === -1;

  // 比 syncedThrough 更新（排在它上面）的已发布分节（剔除 Unreleased）+ Unreleased。
  const newerReleased = idx > 0
    ? sections.slice(0, idx).filter((s) => s.title.trim().toLowerCase() !== "unreleased")
    : [];
  const unreleased = sections.find((s) => s.title.trim().toLowerCase() === "unreleased");

  const pending = [];
  const skipped = [];

  const push = (sectionTitle, item) => {
    const entry = {
      section: sectionTitle,
      signature: item.signature,
      title: item.title,
      userFacing: classifyUserFacing(item.title),
      suggestedChapter: suggestChapter(item.title),
    };
    (entry.userFacing ? pending : skipped).push(entry);
  };

  for (const section of newerReleased) {
    for (const item of section.items) push(section.title, item);
  }
  if (unreleased) {
    for (const item of unreleased.items) {
      if (unreleasedSigs.has(item.signature)) continue;
      push(unreleased.title, item);
    }
  }

  return { syncedThrough: synced, pending, skipped, unknownVersion };
}

/** 把签名加入 unreleased 已同步列表并落盘。 */
export function markDone(sigs, path = STATE_PATH) {
  const state = loadState(path);
  const set = new Set(state.unreleased || []);
  for (const s of sigs) set.add(s);
  state.unreleased = [...set];
  state.updatedAt = new Date().toISOString().slice(0, 10);
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf8");
  return state;
}

function renderReport(result) {
  const out = [];
  out.push(`同步基准：${result.syncedThrough}${result.unknownVersion ? "（⚠ 在 changelog 中找不到该版本分节）" : ""}`);
  out.push("");
  out.push(`待同步（用户可见，${result.pending.length}）:`);
  if (!result.pending.length) out.push("  （无）");
  for (const p of result.pending) {
    out.push(`  • [${p.section}] ${p.title.slice(0, 70)}`);
    out.push(`      章节建议: ${p.suggestedChapter}   签名: ${p.signature}`);
  }
  out.push("");
  out.push(`跳过（内部，${result.skipped.length}）:`);
  if (!result.skipped.length) out.push("  （无）");
  for (const s of result.skipped) out.push(`  ◦ [${s.section}] ${s.title.slice(0, 70)}`);
  return out.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const sections = parseChangelog(readFileSync(CHANGELOG_PATH, "utf8"));
  const state = loadState();

  const markIdx = args.indexOf("--mark-done");
  if (markIdx !== -1) {
    const sigs = args.slice(markIdx + 1).filter((a) => !a.startsWith("--"));
    if (!sigs.length) {
      console.error("用法：node scripts/manual-sync.mjs --mark-done <signature> [...]");
      process.exit(2);
    }
    const next = markDone(sigs);
    console.log(`已标记 ${sigs.length} 条为已同步；unreleased 现含 ${next.unreleased.length} 条。`);
    return;
  }

  const result = computePending(sections, state);
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderReport(result));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
