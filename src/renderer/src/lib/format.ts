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
