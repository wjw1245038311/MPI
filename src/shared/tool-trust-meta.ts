/**
 * Tool-name classification shared by main (observed-tools registry) and the
 * renderer (Settings → Permissions trusted-tools picker).
 *
 * The permission gate (permission-gate-ext.ts) is bundled as a raw string into
 * pi subprocesses, so it cannot import this module — its SAFE_TOOLS set must
 * be kept in sync with NO_APPROVAL_TOOL_NAMES below manually (same convention
 * as ALWAYS_ALLOW_LABELS between ipc.ts and the gate).
 */

/** Tools that always require confirmation and can never enter the trust list. */
export const NEVER_TRUSTABLE_TOOL_NAMES: readonly string[] = ["bash", "write", "edit"];

/**
 * Tools the gate lets through without approval in every mode — trusting them
 * would be a no-op, so the picker shows them as “no approval needed”. Keep in
 * sync with SAFE_TOOLS in permission-gate-ext.ts.
 */
export const NO_APPROVAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "mpi_ask_choice",
  "mpi_request_mode_switch",
  "mpi_todo_add",
  "mpi_todo_list",
  "ask_question",
  "plan_question",
  "plan_complete",
  "plan_step_complete",
  "consult_advisor",
  "ask_llm",
  "web_search",
  "source_check",
  "fetch_content",
  "get_search_content",
]);

export type ToolTrustKind = "trusted" | "trustable" | "never-trustable" | "no-approval";

/**
 * Classify a tool name for the picker. “trusted” wins over everything else so
 * a (mis)configured entry stays visible and removable; never-trustable and
 * no-approval are informational, trustable is the actionable bucket.
 */
export function classifyToolName(name: string, trustedList: readonly string[]): ToolTrustKind {
  if (trustedList.includes(name)) return "trusted";
  if ((NEVER_TRUSTABLE_TOOL_NAMES as readonly string[]).includes(name)) return "never-trustable";
  if (NO_APPROVAL_TOOL_NAMES.has(name)) return "no-approval";
  return "trustable";
}
