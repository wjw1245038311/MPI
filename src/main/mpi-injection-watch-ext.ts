/**
 * 提示注入监测器：在**最终发往模型的请求体**里检查有没有可疑的外来注入标签，
 * 命中就把完整请求体落盘（可复查），并在日志里记一行。
 *
 * 为什么用它
 * ----------
 * 2026-11-10 排查一个跨设备现象：模型在压缩后自称「系统说 exceeds the 180000-tokens context budget」，
 * 而另一台设备（thinkbook16p）收到过 `<system_context>Current stage: default ; context used:
 * 168239 / 168000 (99% used)</system_context>` 这类注入，同一批还有 `<environment_context>`、
 * `<system_instruction>`、`<current_bash_exec>`、`<context_agent_usage>`。
 *
 * 排查已经证明：pi 本体、pi 扩展、MPI 源码/二进制/全历史、strata 服务端**都没有**这些字面量，
 * 而且 MPI 自己的 `<environment_context>` 模板只有 os/shell/shell_path/shell_version/cwd/shell_source
 * 六个字段（不认识 automator / reasoning effort / en-us 这类内容）。
 * 也就是说：如果这些标签出现在发出去的请求里，它们的拼装发生在**本机之外的某一步**，
 * 或者由某个我们还没识别出来的组件完成。
 *
 * 与其继续猜，不如**在最终出口留一只眼睛**：`before_provider_request` 拿到的 payload
 * 就是真正要发给模型的东西（此时所有 transformContext / addendum 都已合入）。
 * 命中即落盘成完整 JSON，之后无论何时复现都能拿实证。
 *
 * 代价很小：只在命中时写文件；未命中只记一行长度，正常会话日志可忽略。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 要盯的标签。前四个来自 thinkbook16p 那次注入；
 * 后三个是同一套体系里出现过的兄弟标签——一起盯，命中任何一个都能定位。
 */
const WATCHED = [
  "system_context",
  "environment_context",
  "system_instruction",
  "current_bash_exec",
  "context_agent_usage",
  "Current stage",
  "context used",
  "CONTEXT COMPACTION",
  "Context left",
] as const;

/** 落盘目录名。放在 userData 下，避免污染工程目录。 */
const OUT_DIR = "injection-watch";

/** 抓包保留上限：超过就删最老的（一份请求体常有 0.5–1.5 MB，不封顶会吃满磁盘）。 */
const MAX_DUMPS = 40;

/**
 * 系统提示所在的角色。不同 provider 走不同角色：
 * `supportsDeveloperRole: true` 的 provider（本机 strata / basalt）发的是 **developer**，
 * 其它发 **system**。环境块本来就在这两类里，扫描时必须一起排除，否则每轮必中。
 */
const PROMPT_ROLES = new Set(["system", "developer"]);

export interface ScanResult {
  /** 命中的标签（去重、按 WATCHED 顺序） */
  hits: string[];
  /** 消息条数，便于判断是哪一轮 */
  messageCount: number;
  /** 请求体字符长度 */
  bytes: number;
}

/**
 * 扫描一次 payload。
 *
 * 只看 messages：系统提示里出现 `environment_context` 是**正常**的（MPI 的 shell 策略就在那），
 * 它本来就在 system（或 developer）段。真正可疑的是它出现在**对话消息**里（thinkbook16p 观察到的是
 * 「随 user 消息一起到达」）。所以这里刻意把提示段排除掉，避免每次请求都误报。
 *
 * 注意：早先只排除 `system`，而本机 provider 带 `supportsDeveloperRole: true`，
 * 提示实际走 `developer` 角色 —— 结果 1262 次请求里 751 次都是误报（已实测）。
 */
export function scanPayload(payload: unknown): ScanResult {
  const messages = (payload as { messages?: unknown })?.messages;
  const list = Array.isArray(messages) ? messages : [];
  // 提示段（system / developer）合法持有 environment_context，扫描时剔除。
  const conversation = list.filter((m) => !PROMPT_ROLES.has(String((m as { role?: string })?.role ?? "")));
  const text = JSON.stringify(conversation);
  const hits = WATCHED.filter((needle) => text.includes(needle));
  return { hits, messageCount: list.length, bytes: text.length };
}

/** 命中时把完整 payload 存盘，返回文件路径。 */
export function dumpPayload(userDataDir: string, payload: unknown, hits: string[]): string {
  const dir = join(userDataDir, OUT_DIR);
  mkdirSync(dir, { recursive: true });
  pruneDumps(dir, MAX_DUMPS - 1); // 先腾位，保证总量不超上限
  // 文件名用「时间戳 + 毫秒」保证唯一：同一毫秒内的两次请求不能互相覆盖。
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `payload-${stamp}-${Math.random().toString(36).slice(2, 6)}.json`);
  writeFileSync(file, JSON.stringify({ capturedAt: new Date().toISOString(), hits, payload }, null, 2), "utf8");
  return file;
}

/**
 * 只保留最新的 `keep` 份抓包，多出来的按文件名（含 ISO 时间戳）从旧到新删。
 * 宁可少留几份，也不能像这次一样堆到 462 MB / 751 份。
 */
export function pruneDumps(dir: string, keep: number): number {
  if (keep < 0) return 0;
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith("payload-") && n.endsWith(".json"));
  } catch {
    return 0;
  }
  if (names.length <= keep) return 0;
  names.sort(); // ISO 时间戳前缀 ⇒ 字典序 = 时间序
  const stale = names.slice(0, names.length - keep);
  let removed = 0;
  for (const n of stale) {
    try {
      unlinkSync(join(dir, n));
      removed++;
    } catch {
      // 删不掉就留着，不影响下一个
    }
  }
  return removed;
}

export default function mpiInjectionWatch(pi: ExtensionAPI): void {
  // 落盘目录必须由主进程显式指定（MPI_INJECTION_WATCH_DIR）。
  // 早先回落到 process.cwd()，而主进程从不设 MPI_USER_DATA ⇒ 抓包直接写进**仓库根**。
  // 没配就干脆不抓：宁可没有证据，也不要再往工程目录里倒垃圾。
  const userDataDir = process.env.MPI_INJECTION_WATCH_DIR || "";
  if (!userDataDir) return;
  const logFile = join(userDataDir, OUT_DIR, "watch.log");

  pi.on("before_provider_request", (event: unknown) => {
    try {
      const payload = (event as { payload?: unknown })?.payload;
      if (payload === undefined || payload === null) return;

      const result = scanPayload(payload);

      mkdirSync(join(userDataDir, OUT_DIR), { recursive: true });
      if (result.hits.length === 0) {
        // 未命中只记一行，方便确认「监测器确实在每个请求上跑过」。
        appendFileSync(
          logFile,
          `${new Date().toISOString()} msgs=${result.messageCount} bytes=${result.bytes} clean\n`,
        );
        return;
      }

      const file = dumpPayload(userDataDir, payload, result.hits);
      appendFileSync(
        logFile,
        `${new Date().toISOString()} msgs=${result.messageCount} bytes=${result.bytes} HIT=${result.hits.join("|")} -> ${file}\n`,
      );
    } catch {
      // 监测器绝不能影响正常请求：任何异常（目录不可写、payload 循环引用）都只是少一条日志。
      return;
    }
  });
}
