import type { ModelInfo } from "./types";

export function formatClock(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function modelShort(m: ModelInfo | null | undefined): string {
  if (!m) return "model";
  const n = m.name || m.id || "";
  return n.length > 22 ? n.slice(0, 21) + "…" : n;
}

/**
 * 模型显示名解析（2026-10-19）。
 *
 * 会话文件里只存裸 id（`"model":"deepseek-flash"`），消息底部又是直接渲染这个字符串；
 * 所以必须过一个映射：按 id（有 provider 时一并校验）在会话的模型列表里找 `name`，
 * 找不到才回落 id —— 宁可显示 id，也不能显示空白。
 */
export function modelLabel(
  value: { provider?: string; id?: string; name?: string } | string | null | undefined,
  models?: Array<{ provider?: string; id?: string; name?: string }> | null,
): string {
  if (!value) return "";
  const id = typeof value === "string" ? value : value.id || "";
  const provider = typeof value === "string" ? "" : value.provider || "";
  const ownName = typeof value === "string" ? "" : value.name || "";
  if (!id) return ownName;
  const hit = (models || []).find(
    (m) => m && String(m.id || "") === id && (!provider || !m.provider || m.provider === provider),
  );
  return ownName || (hit?.name || "") || id;
}

export function formatBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

/** Compact token count, e.g. 1234567 -> "1.23M", 68353 -> "68.4k". */
export function formatTokens(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

export function basename(p: string): string {
  const s = p.replace(/\\/g, "/");
  return s.split("/").filter(Boolean).pop() || p;
}
