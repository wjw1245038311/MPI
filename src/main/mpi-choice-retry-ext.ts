/**
 * choices 格式自动重试 bridge for pi（loaded via --extension，见 choice-retry-extension.ts）。
 *
 * 背景：弱模型常把 choices 围栏写坏——不是 JSON 转义，而是形态（开围栏写成 ```json、
 * 空 info 围栏后另起一行写 choices）或字段名（选项用 title 而非 label）。这类块在 MPI
 * 里会整块降级成代码块，用户拿不到可点的面板。实测（gpt-oss:20b-cloud，24 次）
 * 回喂失败原因后重试一次，9 个坏块救回 8 个。
 *
 * 做法：一轮彻底结束后（agent_settled 是 pi 唯一「不会再自动继续」的时点）
 *   1. 读本会话最后一条 assistant 文本，做**保守**判定：只有出现 choices 围栏标记
 *      却拿不出任何合法块时才算失败（宁漏判，不误判——否则会把正常纯文本提问
 *      强行改成面板）；
 *   2. 失败且本用户回合未重试过 → pi.sendMessage(display:false, triggerTurn:true)
 *      注入一条**用户不可见**的修正指令，让模型只重发围栏块。
 *
 * ⚠️ 本文件以 `?raw` 源码写进 userData 后被 pi 加载，**必须自包含**：
 *    不能 import 本仓模块（import 路径在 userData 下不存在）。
 *    判定逻辑与 src/renderer/src/lib/choice-block.ts 是两套实现——那边是完整容错，
 *    这里是保守子集，改契约时两边都要看。
 *
 * 失败策略：全程 fail-open——判定抛错、注入失败，都只写 stderr 一行，绝不影响对话。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";

/** 只在显式关掉时停用（MPI_CHOICE_RETRY=0）。 */
const ENABLED = (process.env.MPI_CHOICE_RETRY || "1") !== "0";
/** 同一条 user 消息触发的重试只做一次；换一条 user 消息才允许再试。 */
const MAX_PER_TURN = 1;
/** 只记最近这几个 key，防止长会话无限增长。 */
const SEEN_LIMIT = 64;
/** 重试指令的 customType（主进程/渲染层按它 + display:false 过滤）。 */
const RETRY_TYPE = "mpi-choice-retry";

type Failure = { reason: string };

function log(msg: string): void {
  try {
    process.stderr.write(`[mpi-choice-retry] ${msg}\n`);
  } catch {
    /* ignore */
  }
}

// ---- 设置同步：问答方式 = manual 时不重试 --------------------------------
// 「设置 → 对话设置 → 问答方式」存在 config.json 的 qaMode。manual 表示用户不要
// choices 面板，此时自动重试只会强行塞面板（与设置相反），必须停手。
// 文件很小，但每轮 settled 都读也不合适——按 mtime 缓存，设置一改立刻生效。
let qaCache: { mtimeMs: number; manual: boolean } | null = null;

/** 当前设置是不是「手动回答」；读不到配置就当成 inline（默认值）。 */
export function qaModeIsManual(configFile = process.env.MPI_CHOICE_CONFIG || ""): boolean {
  if (!configFile) return false;
  try {
    const st = statSync(configFile);
    if (qaCache && qaCache.mtimeMs === st.mtimeMs) return qaCache.manual;
    const cfg = JSON.parse(readFileSync(configFile, "utf8")) as { qaMode?: unknown };
    const manual = cfg?.qaMode === "manual";
    qaCache = { mtimeMs: st.mtimeMs, manual };
    return manual;
  } catch {
    // 配置还没落盘/正在写 → 保持上一次结论，别因为读失败把重试整个关掉。
    return qaCache?.manual ?? false;
  }
}

/** pi 的消息 content：字符串或 [text|image] 块数组。 */
export function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    const b = part as any;
    if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

/** 会话条目过滤：只保留 message 条目并转成 {role, text, entryId}。 */
export function messagesOf(entries: unknown): { role: string; text: string; id: string }[] {
  if (!Array.isArray(entries)) return [];
  const out: { role: string; text: string; id: string }[] = [];
  for (const e of entries as any[]) {
    if (!e || e.type !== "message") continue;
    const m = e.message;
    if (!m || typeof m.role !== "string") continue;
    if (m.role !== "user" && m.role !== "assistant") continue;
    // assistant 多段回复里可能含 tool_call 块，textOfContent 会自动跳过。
    out.push({ role: m.role, text: textOfContent(m.content), id: String(e.id ?? "") });
  }
  return out;
}

/** 开围栏：```choices / ```Choices / ```choices> 算；```choicesjson 也认（形态错的一种）。 */
const OPEN_RE = /^\s*(`{3,})\s*choices([^\s`]*)\s*$/i;
/** 形态错之「choices 单独一行，紧跟 ```json」或「空围栏下一行写 choices」。 */
const BARE_CHOICES_RE = /^\s*choices\s*[:：]?\s*$/i;
const ANY_FENCE_RE = /^\s*`{3,}\s*([a-zA-Z0-9_+-]*)\s*$/;

function closeReFor(len: number): RegExp {
  return new RegExp("^\\s*`{" + len + ",}\\s*$");
}

/** 结构校验：数组、每题有 title、2-6 个选项、选项是字符串或 {label}。 */
export function isValidChoicesBody(body: string): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return false;
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 6) return false;
  for (const q of raw as any[]) {
    if (!q || typeof q !== "object") return false;
    if (typeof q.title !== "string" || !q.title.trim()) return false;
    if (!Array.isArray(q.options) || q.options.length < 2) return false;
    for (const o of q.options) {
      if (typeof o === "string") {
        if (!o.trim()) return false;
      } else if (o && typeof o === "object") {
        if (typeof (o as any).label !== "string" || !(o as any).label.trim()) return false;
      } else {
        return false;
      }
    }
  }
  return true;
}

/**
 * 从一段 assistant 文本里抽出所有 choices 围栏候选。
 * 返回 { fenced: 是否有 choices 围栏标记, validBlocks: 合法块数, broken: 是否出现了解析失败块, missingShape: 形态错 }
 */
export function inspectChoices(text: string): {
  fenced: boolean;
  validBlocks: number;
  broken: boolean;
  missingShape: boolean;
} {
  const lines = String(text || "").split(/\r?\n/);
  let fenced = false;
  let validBlocks = 0;
  let broken = false;
  let missingShape = false;
  let openLen: number | null = null;
  let body: string[] = [];

  const finish = () => {
    if (openLen === null) return;
    // 与渲染层容错对齐：模型常把闭合反引号粘在 JSON 末尾，解析前先剥掉。
    const raw = body.join("\n").trim().replace(/`{3,}\s*$/, "").trim();
    if (isValidChoicesBody(raw)) validBlocks++;
    else broken = true;
    openLen = null;
    body = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (openLen !== null) {
      if (closeReFor(openLen).test(line)) {
        finish();
        continue;
      }
      body.push(line);
      continue;
    }
    const open = OPEN_RE.exec(line);
    if (open) {
      fenced = true;
      openLen = open[1].length;
      body = [];
      continue;
    }
    // 形态错：一行只有 choices，后面紧跟 ```json（模型把语言标签写到了围栏上）
    if (BARE_CHOICES_RE.test(line)) {
      const next = (lines[i + 1] || "").trim();
      const fence = ANY_FENCE_RE.exec(next);
      if (fence) missingShape = true;
      // 形态错：空围栏 + 下一行 choices（choices 落在围栏外面）
    }
    const fence = ANY_FENCE_RE.exec(line);
    if (fence && !fence[1]) {
      const next = (lines[i + 1] || "").trim();
      if (BARE_CHOICES_RE.test(next)) missingShape = true;
    }
  }
  // 开到文末没闭合：同样当坏块（MPI 只在正文能严格解析时才接受粘行闭合）
  if (openLen !== null) finish();
  return { fenced, validBlocks, broken, missingShape };
}

/**
 * 一轮回答是否需要重试。保守：出现 choices 标记、且一个合法块都没有。
 * - 有合法块：不重试（哪怕另有坏块——重试会导致面板重复出现）
 * - 没有任何 choices 痕迹：不重试（正常纯文本提问）
 */
export function detectFailure(text: string): Failure | null {
  const info = inspectChoices(text);
  if (!info.fenced && !info.missingShape) return null;
  if (info.validBlocks > 0) return null;
  if (info.broken) {
    // 能进到这里说明没有合法块，坏块的具体原因对重试提示有区分价值：
    // 先按「正文是否以 [ 开头」粗分，模型自己的报错细节意义不大。
    const looksJsonArray = /\[\s*\{/.test(String(text || ""));
    return {
      reason: looksJsonArray
        ? "围栏正文不是合法 JSON 或选项字段不对（常见：中文串里裸英文双引号；选项用 title 而不是 label）"
        : "围栏正文不是合法 JSON 数组",
    };
  }
  return { reason: "没有识别到合法的 choices 围栏（开围栏必须单独一行 ```choices，不能写成 ```json，也不能把 choices 写在围栏外面）" };
}

/** 修正指令：只给「为什么不过 + 要什么形态」，与实测 89% 修好的提示词一致。 */
export function retryHint(reason: string): string {
  return [
    "【格式修正 · 非用户消息】你上一条回复里的 choices 块没有通过格式校验，MPI 无法渲染成面板。",
    "原因：" + reason,
    "请只重新输出这一个 choices 块，不要重复正文、不要解释、不要道歉：",
    "1) 第一行单独写 ```choices（三个反引号 + 空格省略 + 单词 choices，独占一行）；",
    '2) 第二行开始是纯 JSON 数组，形如 [{"title":"问题","options":[{"label":"选项A","detail":"一句话"},"选项B"]}]；',
    "3) 选项对象必须用 label 字段（不能写 title / text / name）；",
    "4) 最后一行单独写 ```。",
  ].join("\n");
}

/** 取最后一条 assistant 文本（重试是否已在本次 user 回合发生过，由调用方判断）。 */
export function lastAssistantText(entries: unknown): string {
  const msgs = messagesOf(entries);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant") return msgs[i].text;
  }
  return "";
}

/** 本回合的 key：最后一条 user 消息的条目 id（没有则用时间戳兜底）。 */
export function turnKey(entries: unknown): string {
  const msgs = messagesOf(entries);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") return msgs[i].id || `i${i}`;
  }
  return "";
}

/** 已经从上下文里搞掉的重试指令 id（避免每轮重复 appendContextEdit）。 */
const cleanedRetryIds = new Set<string>();

/**
 * 重试指令要参与「重试那一轮」的上下文，但之后不该常驻（约 160 token/条）。
 * 一轮结束后用 pi 的 appendContextEdit(id, null) 把它从模型可见上下文里摘掉：
 * 会话文件里仍留着该条目（可审计），只是不再随每轮请求发送。
 *
 * 判定用「其后是否已经出现过 assistant 消息」：有 = 这一轮已经用过了。
 */
export function clearUsedRetryInstructions(sessionManager: any): number {
  let entries: any[];
  try {
    entries = sessionManager?.getEntries?.() ?? [];
  } catch {
    return 0;
  }
  if (!Array.isArray(entries)) return 0;

  let lastAssistant = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === "message" && e.message?.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant < 0) return 0; // 指令刚注入、重试轮还没跑 → 保留

  let n = 0;
  for (let i = 0; i < lastAssistant; i++) {
    const e = entries[i];
    if (e?.type !== "custom_message" || e.customType !== RETRY_TYPE) continue;
    const id = typeof e.id === "string" ? e.id : "";
    if (!id || cleanedRetryIds.has(id)) continue;
    try {
      sessionManager.appendContextEdit(id, null);
      cleanedRetryIds.add(id);
      n++;
    } catch {
      // 不在活动分支 / 旧会话不允许编辑 → 忽略，不影响本轮。
    }
  }
  return n;
}

export default function mpiChoiceRetry(pi: ExtensionAPI): void {
  if (!ENABLED) {
    log("MPI_CHOICE_RETRY=0 —— 自动重试已停用");
    return;
  }

  /** 已重试过的 turnKey（Map 当 LRU 用：满了就删最早的一个）。 */
  const retried = new Map<string, number>();

  pi.on("agent_settled", (_event: any, ctx: any) => {
    try {
      const sm = ctx?.sessionManager;
      // 1) 先把上一轮用过的修正指令从上下文搞掉（不删文件，只影响模型可见内容）。
      const dropped = clearUsedRetryInstructions(sm);
      if (dropped) log(`清理已用过的修正指令 ${dropped} 条（不再占上下文）`);

      // 2) 设置 → 问答方式 = 手动回答：用户不要面板，绝不自动补。
      if (qaModeIsManual()) return;

      // 3) 判定本轮回答
      const entries = sm?.getEntries?.();
      const text = lastAssistantText(entries);
      if (!text) return;
      const failure = detectFailure(text);
      if (!failure) return;

      const key = turnKey(entries) || "anon";
      const count = retried.get(key) || 0;
      if (count >= MAX_PER_TURN) {
        log(`本回合已重试过 ${count} 次，跳过（key=${key.slice(0, 8)}）`);
        return;
      }
      retried.set(key, count + 1);
      if (retried.size > SEEN_LIMIT) retried.delete(retried.keys().next().value as string);

      // display:false → pi TUI 不渲染；MPI 侧也按 display 过滤（见 ipc.ts onEvent）。
      // triggerTurn:true → 立刻起一轮，让模型只重发围栏块。
      pi.sendMessage(
        {
          customType: RETRY_TYPE,
          content: retryHint(failure.reason),
          display: false,
        },
        { triggerTurn: true },
      );
      log(`注入重试指令（key=${key.slice(0, 8)}）：${failure.reason.slice(0, 60)}`);
    } catch (e) {
      log(`重试判定失败（已忽略）：${(e as Error)?.message || String(e)}`);
    }
  });
}
