/**
 * MPI 任务模式 behaviour bridge for pi (loaded via --extension, see taskmode-extension.ts).
 *
 * While a task mode with behavioural content is active on this thread, the main
 * process writes <userData>/taskmodes/<sessionUuid>.json:
 *   { "instructions": "...", "specFile": "/abs/path/to/spec.md",
 *     "enforce": "readonly" }
 * This extension hooks `before_agent_start` (fires after each user prompt,
 * before the agent loop) and appends that content to the system prompt for the
 * turn — so switching modes takes effect on the very next message with NO pi
 * process restart. The session uuid is derived from our own --session file
 * name (..._<uuid>.jsonl), which main keys the state file by as well.
 *
 * `enforce: "readonly"` (built-in research/review modes) additionally hides the
 * write/edit tools via pi.setActiveTools() while active, so the model cannot
 * even attempt them. The permission gate enforces the same floor on every
 * tool call — this hiding is belt-and-braces plus token savings.
 *
 * Visibility is reconciled on EVERY tool call as well (mtime/size-cached state
 * read): when an approved mpi_request_mode_switch deletes the state file while
 * a turn is still running, write/edit come back within that same turn — pi
 * re-reads the active tool set before each model request. Without this the
 * model would fall back to bash for writes and pop a sandbox approval card per
 * command until the next user prompt.
 *
 * This file is bundled into the main process as a raw string and written
 * standalone into userData, so it must stay self-contained (no local imports).
 */

import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Hard cap for spec documents injected per turn (~5k tokens of headroom). */
const SPEC_MAX_CHARS = 20_000;

/** System-fixed contract prepended to every enforced read-only mode (research/
 * review). It lives in code rather than the user-editable instruction text so
 * that ALL threads get it after an app update — stored configs keep their own
 * (possibly stale) instructions and are never migrated. Bilingual like the
 * block header: the agent reads both.
 *
 * Why: 2026-09 review-mode test — a request clearly beyond the mode's power
 * ("generate a txt file") was not reported to the user in the first reply; the
 * model trial-and-errored four blocked commands before explaining. The stored
 * instructions also understate what is blocked (network requests and
 * non-whitelisted shell commands, not just writes), so the model cannot predict
 * which attempts will fail. This contract fixes both: an accurate block list +
 * a hard "report the conflict immediately, never attempt blocked ops" rule. */
const ENFORCED_READONLY_CONTRACT = [
  "## 强制只读契约 / Enforced read-only contract（系统固定，优先于下方指令）",
  "- 本模式下列操作被系统硬拦截：文件写入/编辑、网络请求（curl/wget/invoke-webrequest 等）、非白名单 shell 命令、子智能体及其他扩展工具；仅允许读取代码与文件及只读白名单命令（ls/dir/cat/type/rg/grep/head/tail/git status|diff|log 等）。",
  "- 若用户的请求超出本模式能力（需要写文件、联网或执行任何操作）：必须在第一条回复中明确告知用户「当前任务模式无法完成该请求」，说明被拦截的内容并给出选项（切换任务模式/权限后继续，或由用户提供所需数据）；不要尝试任何会被拦截的操作。",
  "- File writes/edits, network requests (curl/wget/invoke-webrequest), non-whitelisted shell commands, subagents and other extension tools are hard-blocked in this mode; only reading code/files and whitelisted read-only commands (ls/dir/cat/type/rg/grep/head/tail/git status|diff|log, …) work.",
  "- If the user's request exceeds what this mode can do (needs file writes, network access or any execution): your FIRST reply MUST clearly tell the user that \"the current task mode cannot fulfil this request\", state what is blocked and offer options (switch task mode/permission first, or have the user provide the needed data). Do NOT attempt any operation that will be blocked.",
].join("\n");

interface TaskModeState {
  instructions?: string;
  specFile?: string;
  /** Hard read-only floor (overrides the permission pill, incl. full). */
  enforce?: "readonly";
}

// mtime+size-cached parse (same pattern as the permission gate): main rewrites
// the state file on every apply/clear, so a cheap stat detects changes and the
// JSON is only re-read when the file actually changed. The tool_call hook runs
// this on every call, so it must stay O(1) in the common (unchanged) case.
let stateCache: { file: string; mtimeMs: number; size: number; parsed: TaskModeState | null } | null =
  null;

function readState(dir: string, sessionFile: string): TaskModeState | null {
  const m = /_(.+)\.jsonl$/.exec(basename(sessionFile));
  if (!m) return null;
  const file = join(dir, `${m[1]}.json`);
  let st;
  try {
    st = statSync(file);
  } catch {
    stateCache = null; // no state file → this thread has no behavioural mode active
    return null;
  }
  if (
    stateCache &&
    stateCache.file === file &&
    stateCache.mtimeMs === st.mtimeMs &&
    stateCache.size === st.size
  ) {
    return stateCache.parsed;
  }
  let parsed: TaskModeState | null = null;
  try {
    const obj = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const state: TaskModeState = {};
    if (typeof obj.instructions === "string" && obj.instructions.trim()) {
      state.instructions = obj.instructions.trim();
    }
    if (typeof obj.specFile === "string" && obj.specFile.trim()) {
      state.specFile = obj.specFile.trim();
    }
    if (obj.enforce === "readonly") state.enforce = "readonly";
    parsed = state.instructions || state.specFile || state.enforce ? state : null;
  } catch {
    parsed = null; // corrupt state file → behave as if no mode is active
  }
  stateCache = { file, mtimeMs: st.mtimeMs, size: st.size, parsed };
  return parsed;
}

// Per-process tool-visibility bookkeeping (each MPI thread owns its pi process,
// so module state never crosses threads). Reconciled on every turn.
let enforced = false;
let toolsBeforeEnforce: string[] | null = null;

/** Hide write/edit while the mode enforces read-only; restore when it clears.
 * Feature-checked: older pi runtimes without setActiveTools simply skip this —
 * the permission gate still blocks every mutation, so enforcement holds. */
function reconcileEnforcedTools(pi: ExtensionAPI, wantEnforce: boolean): void {
  const api = pi as unknown as { getActiveTools?: () => string[]; setActiveTools?: (names: string[]) => void };
  if (typeof api.setActiveTools !== "function") return;
  try {
    if (wantEnforce && !enforced) {
      toolsBeforeEnforce = typeof api.getActiveTools === "function" ? [...api.getActiveTools()] : null;
      const active = toolsBeforeEnforce ?? [];
      api.setActiveTools(active.filter((t) => t !== "write" && t !== "edit"));
      enforced = true;
    } else if (!wantEnforce && enforced) {
      // After a process restart the captured list is gone — fall back to the
      // current active set and re-add the two hidden tools explicitly.
      const base = toolsBeforeEnforce ?? (typeof api.getActiveTools === "function" ? [...api.getActiveTools()] : []);
      api.setActiveTools([...new Set([...base, "write", "edit"])]);
      enforced = false;
      toolsBeforeEnforce = null;
    }
  } catch {
    // Never break the agent loop over a tool-visibility problem.
  }
}

export default function mpiTaskMode(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event, ctx) => {
    try {
      const dir = process.env.MPI_TASKMODE_DIR || "";
      if (!dir) return;
      const sessionFile = ctx.sessionManager?.getSessionFile?.();
      if (!sessionFile) return; // brand-new draft thread: no session file yet

      const state = readState(dir, sessionFile);
      // Reconcile tool visibility BEFORE the early return — a CLEARED mode
      // (state null) must re-enable write/edit again.
      reconcileEnforcedTools(pi, state?.enforce === "readonly");
      if (!state) return;

      const parts: string[] = [];
      // System-fixed conflict-reporting contract for enforced read-only modes —
      // first in the block so it outranks any user-editable workflow text.
      if (state.enforce === "readonly") parts.push(ENFORCED_READONLY_CONTRACT);
      if (state.instructions) parts.push(state.instructions);
      if (state.specFile) {
        let spec = "";
        try {
          spec = readFileSync(state.specFile, "utf8");
        } catch {
          // Spec doc deleted/moved since the mode was saved — skip it rather
          // than failing the turn; the management dialog shows a missing badge.
        }
        if (spec.trim()) {
          const truncated = spec.length > SPEC_MAX_CHARS;
          parts.push(
            `## 模式说明书 / Mode specification\n${truncated ? spec.slice(0, SPEC_MAX_CHARS) + "\n[…文档过长已截断 / document truncated…]" : spec}`,
          );
        }
      }
      if (!parts.length) return;

      // Bilingual header: the agent reads both; no need to read config for language.
      const block = `# 当前任务模式指令 / Active task-mode instructions\n${parts.join("\n\n")}`;
      return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
    } catch {
      // Never break the agent loop over a mode-injection problem.
      return;
    }
  });

  // Mid-turn enforcement changes must reconcile tool visibility immediately.
  // The main path today: an approved mpi_request_mode_switch deletes the state
  // file while this turn is still running — without this hook, write/edit stay
  // hidden until the next user prompt and the model falls back to bash for
  // writes (a sandbox approval card per command). pi re-reads the active tool
  // set before every model request (prepareNextTurnWithContext), so a
  // setActiveTools() here takes effect on the very next iteration of this turn.
  // The reverse direction (mode applied mid-turn) is covered too; the gate's
  // hard floor keeps safety intact regardless of visibility. Always returns
  // undefined — blocking decisions belong to the permission gate, not here.
  pi.on("tool_call", (_event: unknown, ctx: any) => {
    try {
      const dir = process.env.MPI_TASKMODE_DIR || "";
      if (!dir) return;
      const sessionFile = ctx.sessionManager?.getSessionFile?.();
      if (!sessionFile) return; // draft thread without a session file yet
      reconcileEnforcedTools(pi, readState(dir, sessionFile)?.enforce === "readonly");
    } catch {
      // Never break the agent loop over a mode-lookup problem.
    }
  });
}
