/**
 * Trusted extension tools (“始终允许该工具”) — shared by the Settings UI and its
 * L1 test.
 *
 * Only *extension* tools can be trusted: the permission gate
 * (permission-gate-ext.ts) runs bash/write/edit through its own classification
 * and never honours trust for them, so we reject those names here as defence in
 * depth. Subagent tools (run_subagent / resume_subagent / convene_council) are
 * also excluded — the gate requests them with `allowAlways: false` (session-only
 * approval), so offering them as permanently trustable would mislead the user.
 */

/** Tool names that can never be trusted, no matter what the user configures. */
export const NEVER_TRUSTABLE_TOOLS: readonly string[] = ["bash", "write", "edit"];

/** A one-click preset shown at the top of the trusted-tools list. */
export interface CommonExtensionTool {
  /** Exact tool name as the extension registers it. */
  name: string;
  /** Chinese one-line description. */
  zh: string;
  /** English one-line description. */
  en: string;
}

/**
 * Extension tools most sessions end up approving. Keep this list short and
 * accurate — only add a tool when it (a) would otherwise prompt under
 * sandbox/strict and (b) supports “always allow” (`allowAlways` in the gate).
 */
export const COMMON_EXTENSION_TOOLS: readonly CommonExtensionTool[] = [
  {
    name: "mem0_memory",
    zh: "记忆读写（本地 mem0 服务，跨会话长期记忆）",
    en: "Memory read/write (local mem0 service, cross-session recall)",
  },
  {
    name: "memory_note",
    zh: "写入记忆池（知芽：立即记住一条偏好/决定/教训）",
    en: "Write to the memory pool (Zhiya: remember a preference/decision/lesson now)",
  },
];

/** True when `name` is a non-empty tool name that may be trusted. */
export function isTrustableToolName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  return !NEVER_TRUSTABLE_TOOLS.includes(trimmed);
}

/** Whether `name` is currently in the trusted list (trim-insensitive). */
export function isTrustedTool(list: readonly string[] | undefined, name: string): boolean {
  const target = name.trim();
  if (!target || !list) return false;
  return list.some((t) => t.trim() === target);
}

/**
 * Add `name` when trustable and missing, remove it when already present (the
 * one-click toggle). Never mutates the input; empty names and never-trustable
 * tools are ignored (returning the normalised list unchanged).
 */
export function toggleTrustedTool(list: readonly string[] | undefined, name: string): string[] {
  const current = [...(list || [])].map((t) => t.trim()).filter(Boolean);
  const target = name.trim();
  if (!isTrustableToolName(target)) return current;
  if (current.includes(target)) return current.filter((t) => t !== target);
  return [...current, target];
}
