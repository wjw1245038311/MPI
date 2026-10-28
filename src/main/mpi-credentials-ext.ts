/**
 * MPI 凭据注入 bridge（pi 扩展，加载方式见 credentials-extension.ts）。
 *
 * 干什么
 * ------
 * 主进程在 spawn 这个线程的 pi 时，把「silent 级 + 作用域匹配」的凭据解密后写进
 * **进程环境**（`MPI_SECRET_<NAME>`），并把「变量名 + 引用名 + 用途」的元信息放进
 * `MPI_SECRET_META`（JSON，**不含值**）。本扩展只做一件事：把这批变量名与使用规则
 * 追加到系统提示里，让模型知道「有凭据可用、怎么引用、不许把值打印出来」。
 *
 * 为什么不让主进程改命令参数
 * --------------------------
 * pi 的 `tool_call` hook 只能拦截（`{block:true}`），没有「改写入参」的契约
 * （见 docs/CREDENTIALS-VAULT.md §4.2）——所以展开点只能是执行环境（这里 = 环境变量）。
 *
 * 自包含约束
 * ----------
 * 这个文件会被当**纯文本**写进 userData 再交给 `pi --extension` 执行，**不能 import
 * 项目里的模块**，所以 `buildBlock` 是 `src/shared/credentials.ts` 的拷贝（双语文案以
 * 本文件为准，那边的版本供主进程/测试使用；改动时两处同步）。
 */

const META_ENV = "MPI_SECRET_META";
const BLOCKED_ENV = "MPI_SECRET_BLOCKED";
const CONFIG_FILE = process.env.MPI_CHOICE_CONFIG || "";
const MARKER = "<credentials>";

interface SecretMeta {
  env: string;
  name: string;
  hint?: string;
}

/** 与 src/shared/credentials.ts 的 SecretBlocked 同构（本文件自包含，不能 import）。 */
interface SecretBlocked {
  name: string;
  hint?: string;
  reason: "level-confirm" | "level-local-only" | "scope";
}

function language(): "zh" | "en" {
  if (!CONFIG_FILE) return "en";
  try {
    // 动态取，避免在没有 config 文件的环境（如单元测试）里抛错。
    const fs = require("node:fs") as typeof import("node:fs");
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return config?.language === "zh" ? "zh" : "en";
  } catch {
    return "en";
  }
}

function readMeta(): SecretMeta[] {
  const raw = process.env[META_ENV];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m: unknown): m is SecretMeta =>
        !!m && typeof m === "object" && typeof (m as SecretMeta).env === "string" && (m as SecretMeta).env.length > 0,
    );
  } catch {
    return [];
  }
}

function readBlocked(): SecretBlocked[] {
  const raw = process.env[BLOCKED_ENV];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (b: unknown): b is SecretBlocked => !!b && typeof b === "object" && typeof (b as SecretBlocked).name === "string",
    );
  } catch {
    return [];
  }
}

function blockedReason(b: SecretBlocked, zh: boolean): string {
  if (b.reason === "level-confirm") return zh ? "标记为「远程需确认」，当前会话不能用" : "marked remote-confirm, unavailable here";
  if (b.reason === "level-local-only") return zh ? "标记为「仅本机」，远程会话不能使用" : "marked local-only, refused for remote sessions";
  return zh ? "属于其它项目，当前项目不可用" : "belongs to another project, unavailable here";
}

function buildBlock(meta: SecretMeta[], blocked: SecretBlocked[], zh: boolean): string {
  const lines = meta.map((m) => `- $${m.env}${m.hint ? ` — ${m.hint}` : ""}`);
  const unavailable = blocked.map((b) => `- ${b.name}${b.hint ? `（${b.hint}）` : ""} —— ${blockedReason(b, zh)}`);
  if (zh) {
    return [
      MARKER,
      meta.length
        ? "本机凭据库已把下列凭据注入为环境变量（**值不在对话里，也不要尝试查看**）："
        : "本会话**没有**被注入任何凭据，不要假设密码可用，也不要向用户索要明文。",
      ...(meta.length ? lines : []),
      ...(blocked.length ? ["", "以下凭据存在但当前会话不可用（告诉用户原因，不要尝试，也不要索要明文）：", ...unavailable] : []),
      "",
      "用法与禁令：",
      "- 需要密码/令牌时，直接在命令里引用 `$变量名`（例如 `SSHPASS=$MPI_SECRET_X sshpass -e ssh user@host`）。",
      "- 绝不 `echo` / `printf` / `cat` / 写文件 / 写日志 把这些变量的值暴露出来；不要 `set -x`。",
      "- 不要向用户索要明文密码；用户手动添加或修改凭据在「设置 → 凭据」。",
      "- 变量名拼错会得到空值——失败时报告「该凭据未注入」，不要猜。",
      "</credentials>",
    ].join("\n");
  }
  return [
    MARKER,
    meta.length
      ? "The local credential vault injected these credentials as environment variables (values are **not** in the conversation and must not be inspected):"
      : "**No** credentials were injected into this session; do not assume a password is available and never ask the user for plaintext.",
    ...(meta.length ? lines : []),
    ...(blocked.length
      ? ["", "These credentials exist but are unavailable here (tell the user why; do not attempt, do not ask for plaintext):", ...unavailable]
      : []),
    "",
    "Rules:",
    "- Reference `$VAR` directly in commands (e.g. `SSHPASS=$MPI_SECRET_X sshpass -e ssh user@host`).",
    "- Never `echo` / `printf` / write to files or logs to reveal these values; never `set -x`.",
    "- Never ask the user for a plaintext password; they add or edit credentials in Settings → Credentials.",
    "- A misspelled variable yields an empty value — report that the credential is not injected instead of guessing.",
    "</credentials>",
  ].join("\n");
}

export default function credentialsBridge(pi: any) {
  pi.on("before_agent_start", (event: any) => {
    try {
      const meta = readMeta();
      const blocked = readBlocked();
      if (meta.length === 0 && blocked.length === 0) return; // 没东西可说 → 不碰提示词
      const prompt = String(event?.systemPrompt || "");
      if (prompt.includes(MARKER)) return; // 已经加过
      return { systemPrompt: `${prompt}\n\n${buildBlock(meta, blocked, language() === "zh")}` };
    } catch {
      // 提示词注入永远不能打断 agent 主循环
      return;
    }
  });
}
