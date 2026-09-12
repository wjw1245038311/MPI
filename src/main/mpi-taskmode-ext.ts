/**
 * MPI 任务模式 behaviour bridge for pi (loaded via --extension, see taskmode-extension.ts).
 *
 * While a task mode with behavioural content is active on this thread, the main
 * process writes <userData>/taskmodes/<sessionUuid>.json:
 *   { "instructions": "...", "specFile": "/abs/path/to/spec.md" }
 * This extension hooks `before_agent_start` (fires after each user prompt,
 * before the agent loop) and appends that content to the system prompt for the
 * turn — so switching modes takes effect on the very next message with NO pi
 * process restart. The session uuid is derived from our own --session file
 * name (..._<uuid>.jsonl), which main keys the state file by as well.
 *
 * This file is bundled into the main process as a raw string and written
 * standalone into userData, so it must stay self-contained (no local imports).
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Hard cap for spec documents injected per turn (~5k tokens of headroom). */
const SPEC_MAX_CHARS = 20_000;

interface TaskModeState {
  instructions?: string;
  specFile?: string;
}

function readState(dir: string, sessionFile: string): TaskModeState | null {
  const m = /_(.+)\.jsonl$/.exec(basename(sessionFile));
  if (!m) return null;
  let raw: string;
  try {
    raw = readFileSync(join(dir, `${m[1]}.json`), "utf8");
  } catch {
    return null; // no state file → this thread has no behavioural mode active
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const state: TaskModeState = {};
    if (typeof parsed.instructions === "string" && parsed.instructions.trim()) {
      state.instructions = parsed.instructions.trim();
    }
    if (typeof parsed.specFile === "string" && parsed.specFile.trim()) {
      state.specFile = parsed.specFile.trim();
    }
    return state.instructions || state.specFile ? state : null;
  } catch {
    return null; // corrupt state file → behave as if no mode is active
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
      if (!state) return;

      const parts: string[] = [];
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
}
