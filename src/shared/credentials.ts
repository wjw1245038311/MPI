/**
 * 凭据 → 环境变量的映射规则（主进程与 pi 扩展共用同一份，避免两端各写一套而漂移）。
 *
 * 设计要点（见 docs/CREDENTIALS-VAULT.md §4.2）：
 * - agent 侧只看到**变量名**，值由主进程在 spawn pi 时注入到该线程的进程环境；
 * - 只有 `silent` 级凭据会被注入 —— `confirm` / `local-only` 必须走后续阶段的
 *   broker 工具（需要逐次策略判断），不能提前落到进程环境里；
 * - 变量名必须可预测且稳定（同名凭据永远是同一个变量），也必须是合法 shell 变量名。
 */

/** 环境变量前缀。扩展按它过滤，模型按它引用。 */
export const SECRET_ENV_PREFIX = "MPI_SECRET_";

/** `aliyun-prod.root` → `MPI_SECRET_ALIYUN_PROD_ROOT`。 */
export function secretEnvName(name: string): string {
  const tail = String(name || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${SECRET_ENV_PREFIX}${tail}`;
}

/** 注入给扩展的元信息（**不含值**）：变量名 + 引用名 + 用途说明。 */
export interface SecretEnvMeta {
  env: string;
  name: string;
  hint?: string;
}

/** 作用域是否覆盖给定项目根（Windows 路径大小写/斜杠不敏感）。 */
export function scopeMatches(
  scope: { type: "global" } | { type: "project"; root: string } | undefined,
  root: string | undefined,
): boolean {
  if (!scope || scope.type === "global") return true;
  if (!root) return false;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(scope.root) === norm(root);
}

/**
 * 生成给模型的系统提示片段。**只含名称与用途，绝不含值**。
 * 由扩展在 `before_agent_start` 里追加（扩展是自包含脚本，不能 import 本文件）。
 */
export function buildSecretEnvBlock(meta: SecretEnvMeta[], zh: boolean): string {
  if (!meta.length) return "";
  const lines = meta.map((m) => `- $${m.env}${m.hint ? ` — ${m.hint}` : ""}`);
  if (zh) {
    return [
      "<credentials>",
      "本机凭据库已把下列凭据注入为环境变量（**值不在对话里，也不要尝试查看**）：",
      ...lines,
      "",
      "用法与禁令：",
      "- 需要密码/令牌时，直接在命令里引用 `$变量名`（例如 `sshpass -e ssh user@host` 配 `SSHPASS=$MPI_SECRET_X`）。",
      "- 绝不 `echo` / `printf` / `cat` / 写文件 / 写日志 把这些变量的值暴露出来；不要 `set -x`。",
      "- 不要向用户索要明文密码；用户手动添加或修改凭据在「设置 → 凭据」。",
      "- 变量名拼错会得到空值——失败时报告「该凭据未注入」，不要猜。",
      "- 若某凭据不在上面列表里，说明它被标记为「仅本机」或「远程需确认」，当前会话不能用。",
      "</credentials>",
    ].join("\n");
  }
  return [
    "<credentials>",
    "The local credential vault injected these credentials as environment variables (values are **not** in the conversation and must not be inspected):",
    ...lines,
    "",
    "Rules:",
    "- Reference `$VAR` directly in commands (e.g. `sshpass -e ssh user@host` with `SSHPASS=$MPI_SECRET_X`).",
    "- Never `echo` / `printf` / write to files or logs to reveal these values; never `set -x`.",
    "- Never ask the user for a plaintext password; they add or edit credentials in Settings → Credentials.",
    "- A misspelled variable yields an empty value — report that the credential is not injected instead of guessing.",
    "- A credential missing from this list is either local-only or requires confirmation, so it is unavailable in this session.",
    "</credentials>",
  ].join("\n");
}
