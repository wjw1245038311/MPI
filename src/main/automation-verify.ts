import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/**
 * 定时任务的产物校验。
 *
 * 解决的问题（minibox 2026-11-26 邮件第 2 条）：以前「成功」的唯一判据是模型
 * 自己说完了（`getAssistantFailure()` 只看最后一条助手消息的 stopReason）。
 * 实测反例：`review.py` 在台账未回写时只打印「尚无持仓」，退出码 0，模型回一句
 * 「跑完了」就算成功——无人值守场景下这条链会让「什么都没做」被记成完成。
 *
 * 设计要点：
 *   - **全部规则 AND**：任何一条不过即整次运行失败，并给出可读原因。
 *   - **相对路径基于本次运行的 cwd**（worktree 隔离时就是工作树），不是
 *     应用安装目录——否则校验的是错的文件。
 *   - **`fileNewerThan` 只在给了 `startedAt` 时检查**：没有基准时退化为
 *     「文件存在」，避免把所有历史任务一次性判失败。
 *   - 命令类规则（`command`）在超时后记为失败而不是挂起：无人值守不能等。
 *   - 校验本身出错（路径非法、命令无法启动）也算失败——静默放行等于没校验。
 */

export type VerifyRule =
  /** 上一条命令/进程的退出码必须等于该值（默认 0 才通过）。 */
  | { kind: "exitCode"; expected: number }
  /** 文件或目录必须存在（相对 cwd 或绝对路径）。 */
  | { kind: "fileExists"; path: string }
  /** 文件必须存在，且 mtime 晚于本次运行开始时刻（证明是这次写的）。 */
  | { kind: "fileNewerThan"; path: string }
  /** 文件内容必须包含指定子串（纯文本匹配，大小写敏感）。 */
  | { kind: "fileContains"; path: string; text: string }
  /** 文件字节数必须 ≥ 阈值。 */
  | { kind: "minBytes"; path: string; bytes: number }
  /** 跑一条命令，退出码必须为 0（在 cwd 下、不经过 shell）。 */
  | { kind: "command"; command: string; args?: string[]; timeoutMs?: number };

/** 单条规则的检查结果。 */
export interface VerifyOutcome {
  ok: boolean;
  /** 给用户看的失败原因（通过时为 undefined）。 */
  reason?: string;
  /** 原始规则，便于面板回显「哪条规则没过」。 */
  rule: VerifyRule;
}

export interface VerifyContext {
  /** 本次运行的工作目录（worktree 隔离时是工作树路径）。 */
  cwd: string;
  /** 本次运行开始时刻（毫秒）。缺省时不检查 mtime 新旧。 */
  startedAt?: number;
  /** 模型侧报告的进程退出码（若有）。 */
  exitCode?: number;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

function displayPath(rule: VerifyRule): string {
  if (rule.kind === "fileExists" || rule.kind === "fileNewerThan" || rule.kind === "fileContains" || rule.kind === "minBytes") {
    return rule.path;
  }
  return "";
}

/**
 * 把规则里的路径解析成绝对路径。
 *
 * 相对路径一律基于 `ctx.cwd`：任务在项目目录（或隔离工作树）里跑，模型写的
 * 产物也就在那儿。用 process.cwd()（应用安装目录）会校验错地方且通常不存在，
 * 这种「永远失败」比不校验更糟——用户会开始忽略校验结果。
 */
export function resolveRulePath(path: string, cwd: string): string {
  const base = resolve(cwd || ".");
  return isAbsolute(path) ? path : join(base, path);
}

/** 检查单条规则。 */
export function checkRule(rule: VerifyRule, ctx: VerifyContext): VerifyOutcome {
  switch (rule.kind) {
    case "exitCode": {
      if (typeof ctx.exitCode !== "number") {
        return { ok: false, reason: "没有拿到进程退出码，无法校验", rule };
      }
      if (ctx.exitCode !== rule.expected) {
        return { ok: false, reason: `退出码 ${ctx.exitCode}，期望 ${rule.expected}`, rule };
      }
      return { ok: true, rule };
    }

    case "fileExists": {
      const target = resolveRulePath(rule.path, ctx.cwd);
      if (!existsSync(target)) {
        return { ok: false, reason: `文件不存在：${displayPath(rule)}`, rule };
      }
      return { ok: true, rule };
    }

    case "fileNewerThan": {
      const target = resolveRulePath(rule.path, ctx.cwd);
      if (!existsSync(target)) {
        return { ok: false, reason: `文件不存在：${displayPath(rule)}`, rule };
      }
      // 没有基准时间时退化为「存在即可」：否则给旧任务加这条规则会一次性全红。
      if (typeof ctx.startedAt !== "number") return { ok: true, rule };
      let mtime: number;
      try {
        mtime = statSync(target).mtimeMs;
      } catch (e: any) {
        return { ok: false, reason: `读不到修改时间：${e?.message || e}`, rule };
      }
      // 容忍 2 秒时钟抖动：文件系统的 mtime 精度与 Date.now() 可能差几毫秒。
      if (mtime + 2000 < ctx.startedAt) {
        return {
          ok: false,
          reason: `文件未更新（修改时间早于本次运行开始）：${displayPath(rule)}`,
          rule,
        };
      }
      return { ok: true, rule };
    }

    case "fileContains": {
      const target = resolveRulePath(rule.path, ctx.cwd);
      if (!existsSync(target)) {
        return { ok: false, reason: `文件不存在：${displayPath(rule)}`, rule };
      }
      let text: string;
      try {
        text = readFileSync(target, "utf8");
      } catch (e: any) {
        return { ok: false, reason: `读不到文件内容：${e?.message || e}`, rule };
      }
      if (!text.includes(rule.text)) {
        return { ok: false, reason: `文件里没有指定内容：${displayPath(rule)}`, rule };
      }
      return { ok: true, rule };
    }

    case "minBytes": {
      const target = resolveRulePath(rule.path, ctx.cwd);
      if (!existsSync(target)) {
        return { ok: false, reason: `文件不存在：${displayPath(rule)}`, rule };
      }
      let size: number;
      try {
        size = statSync(target).size;
      } catch (e: any) {
        return { ok: false, reason: `读不到文件大小：${e?.message || e}`, rule };
      }
      if (size < rule.bytes) {
        return { ok: false, reason: `文件只有 ${size} 字节，要求至少 ${rule.bytes}`, rule };
      }
      return { ok: true, rule };
    }

    case "command": {
      const command = String(rule.command || "").trim();
      if (!command) return { ok: false, reason: "校验命令为空", rule };
      const timeout = Math.max(1000, Math.min(600_000, rule.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS));
      const run = spawnSync(command, Array.isArray(rule.args) ? rule.args : [], {
        cwd: resolve(ctx.cwd || "."),
        encoding: "utf8",
        timeout,
        windowsHide: true,
      });
      if (run.error) {
        const msg = (run.error as any)?.message || String(run.error);
        // 超时与「命令根本起不来」要分开说：前者可能是任务本身慢，后者是配置错。
        const isTimeout = /ETIMEDOUT|timed? ?out/i.test(msg);
        return {
          ok: false,
          reason: isTimeout ? `校验命令超时（${Math.round(timeout / 1000)}s）` : `校验命令无法执行：${msg}`,
          rule,
        };
      }
      if (run.status !== 0) {
        const stderr = String(run.stderr || "").trim().split("\n").slice(-3).join(" ");
        return {
          ok: false,
          reason: `校验命令退出码 ${run.status}${stderr ? `：${stderr.slice(0, 300)}` : ""}`,
          rule,
        };
      }
      return { ok: true, rule };
    }

    default:
      return { ok: false, reason: `未知的校验规则类型：${(rule as any)?.kind}`, rule };
  }
}

/** 依次检查全部规则；任一条不过即返回第一个失败（AND 语义）。 */
export function runVerifyRules(rules: readonly VerifyRule[], ctx: VerifyContext): VerifyOutcome {
  for (const rule of rules) {
    const outcome = checkRule(rule, ctx);
    if (!outcome.ok) return outcome;
  }
  return { ok: true, rule: { kind: "command", command: "" } };
}

/** 人类可读的规则描述（面板回显与失败信息用）。 */
export function describeVerifyRule(rule: VerifyRule, language: "en" | "zh"): string {
  const zh = language === "zh";
  switch (rule.kind) {
    case "exitCode":
      return zh ? `退出码 = ${rule.expected}` : `exit code = ${rule.expected}`;
    case "fileExists":
      return zh ? `文件存在：${rule.path}` : `file exists: ${rule.path}`;
    case "fileNewerThan":
      return zh ? `文件本次有更新：${rule.path}` : `file updated this run: ${rule.path}`;
    case "fileContains":
      return zh ? `文件包含「${rule.text}」：${rule.path}` : `file contains "${rule.text}": ${rule.path}`;
    case "minBytes":
      return zh ? `文件至少 ${rule.bytes} 字节：${rule.path}` : `file ≥ ${rule.bytes} bytes: ${rule.path}`;
    case "command": {
      const args = Array.isArray(rule.args) && rule.args.length ? ` ${rule.args.join(" ")}` : "";
      return zh ? `命令成功：${rule.command}${args}` : `command succeeds: ${rule.command}${args}`;
    }
    default:
      return zh ? "未知规则" : "unknown rule";
  }
}
