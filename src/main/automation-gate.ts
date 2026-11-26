import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";

/**
 * 定时任务的前置门控。
 *
 * 解决的问题（minibox 2026-11-26 邮件第 3 条）：以前只能在提示词里叮嘱模型
 * 「今天该不该跑」——模型可能判断错，而且无论跑没跑都会被记成一次执行。现在把
 * 这件事前移到调度层：触发前先过门控，不过就记 `skipped`（不算失败、不告警）。
 *
 * 两个维度，互不耦合：
 *   1. 前置条件命令：跑一条命令，退出 0 才继续。非 0 视为「今天不适用」。
 *      命令怎么写由用户决定，本模块不认识任何业务概念。
 *   2. 跳过日期：一份日期清单（内联或外部文件），命中就不跑。
 *      清单由用户/外部系统产出，本模块只做「日期是否在清单里」的判断。
 *
 * 设计原则：**不内置任何日历表**。内置一份日期表既过时又需要维护，且必然只对
 * 某一类场景成立；通用做法是给一个清单入口，让调用方自己填。
 */

/** 跳过日期的来源。 */
export type SkipDatesSource =
  /** 内联清单：`YYYY-MM-DD` 数组。 */
  | { kind: "inline"; dates: string[] }
  /** 外部文件：每行一个 `YYYY-MM-DD`，`#` 开头为注释，空行忽略。 */
  | { kind: "file"; path: string };

export interface TaskGate {
  /** 前置条件命令：退出 0 才执行任务；非 0 记为跳过。 */
  precondition?: { command: string; args?: string[]; timeoutMs?: number };
  /** 跳过日期来源；缺省 = 不按日期跳过。 */
  skipDates?: SkipDatesSource;
}

export type GateDecision =
  /** 通过：可以执行。 */
  | { kind: "run"; reason?: undefined }
  /** 跳过：前置条件不满足或日期命中清单。不算失败。 */
  | { kind: "skip"; reason: string };

const DEFAULT_PRECONDITION_TIMEOUT_MS = 30_000;
const MAX_PRECHECK_MS = 300_000;

/** 解析并校验 `YYYY-MM-DD`；非法返回 null。 */
export function parseSkipDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // 回读校验：挡掉 2026-02-31 这种「形状合法但日子不存在」的值。
  const at = new Date(y, mo - 1, d);
  if (at.getMonth() !== mo - 1 || at.getDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** 本地日期串 `YYYY-MM-DD`（门控比较的粒度是「日」，不是时刻）。 */
export function localDateString(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/**
 * 读出跳过日期集合。
 *
 * 文件读不到时返回空集合而不是报错：清单通常由外部任务产出，首次运行时文件
 * 还不存在是正常状态；因为「文件没生成」而让任务永不执行，比不跳过更糟。
 */
export function loadSkipDates(source: SkipDatesSource | undefined, cwd: string): Set<string> {
  const out = new Set<string>();
  if (!source) return out;

  if (source.kind === "inline") {
    for (const raw of Array.isArray(source.dates) ? source.dates : []) {
      const d = parseSkipDate(raw);
      if (d) out.add(d);
    }
    return out;
  }

  const target = isAbsolute(source.path) ? source.path : join(resolve(cwd || "."), source.path);
  if (!existsSync(target)) return out;
  let text: string;
  try {
    text = readFileSync(target, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // 允许行内注释：`2026-01-01  # 元旦`
    const datePart = trimmed.split(/\s+/)[0];
    const d = parseSkipDate(datePart);
    if (d) out.add(d);
  }
  return out;
}

/** 跑前置条件命令。返回 null = 通过，字符串 = 跳过原因。 */
function runPrecondition(
  precondition: NonNullable<TaskGate["precondition"]>,
  cwd: string,
): string | null {
  const command = String(precondition.command || "").trim();
  if (!command) return "前置条件命令为空";
  const timeoutMs = Math.max(1000, Math.min(MAX_PRECHECK_MS, precondition.timeoutMs ?? DEFAULT_PRECONDITION_TIMEOUT_MS));
  const args = Array.isArray(precondition.args) ? precondition.args : [];

  const run = spawnSync(command, args, {
    cwd: resolve(cwd || "."),
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });

  if (run.error) {
    const msg = (run.error as any)?.message || String(run.error);
    // 超时 = 条件本身没给出结论，保守起见按「不跑」处理（无人值守不该硬闯）。
    const timedOut = /ETIMEDOUT|timed? ?out/i.test(msg);
    return timedOut
      ? `前置条件命令超时（${Math.round(timeoutMs / 1000)}s）`
      : `前置条件命令无法执行：${msg}`;
  }
  if (run.status !== 0) {
    const detail = String(run.stdout || run.stderr || "").trim().split(/\r?\n/).slice(-2).join(" ");
    return `前置条件不满足（退出码 ${run.status}）${detail ? `：${detail.slice(0, 200)}` : ""}`;
  }
  return null;
}

/**
 * 判定本次触发是否该执行。
 *
 * 顺序：先查跳过日期（纯本地、快），再跑前置条件命令（可能有副作用/耗时）。
 * 日期命中时不必去跑命令——那可能是一次昂贵的查询。
 */
export function evaluateGate(gate: TaskGate | undefined, ctx: { cwd: string; now: Date }): GateDecision {
  if (!gate) return { kind: "run" };

  if (gate.skipDates) {
    const today = localDateString(ctx.now);
    const dates = loadSkipDates(gate.skipDates, ctx.cwd);
    if (dates.has(today)) {
      return { kind: "skip", reason: `今天是跳过日期（${today}）` };
    }
  }

  if (gate.precondition) {
    const reason = runPrecondition(gate.precondition, ctx.cwd);
    if (reason) return { kind: "skip", reason };
  }

  return { kind: "run" };
}

/** 人类可读的门控描述（面板回显用）。 */
export function describeGate(gate: TaskGate | undefined, language: "en" | "zh"): string {
  const zh = language === "zh";
  if (!gate) return zh ? "不门控" : "No gate";
  const parts: string[] = [];
  if (gate.precondition) {
    const args = Array.isArray(gate.precondition.args) && gate.precondition.args.length
      ? ` ${gate.precondition.args.join(" ")}`
      : "";
    parts.push((zh ? "前置条件：" : "Precondition: ") + gate.precondition.command + args);
  }
  if (gate.skipDates) {
    const who = gate.skipDates.kind === "inline"
      ? `${gate.skipDates.dates.length}${zh ? " 个日期" : " dates"}`
      : gate.skipDates.path;
    parts.push((zh ? "跳过日期：" : "Skip dates: ") + who);
  }
  return parts.length ? parts.join(" · ") : zh ? "不门控" : "No gate";
}
