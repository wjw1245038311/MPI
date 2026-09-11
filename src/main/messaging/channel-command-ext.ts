/**
 * MPI channel session bridge for pi (loaded via --extension, see channel-extension.ts).
 *
 * Gives the agent mpi_channel_* tools to manage the chat channel's active
 * session from inside a conversation: list recent sessions, switch to one, or
 * start a fresh one. The extension NEVER touches channel state directly — it
 * drops one JSON request file per call into an inbox directory that the main
 * process watches and answers with a "<id>.resp.json" (same pattern as the
 * todo bridge), so the main process stays the single writer of channel state.
 *
 * Env (set by pi-bridge at spawn):
 *   MPI_CHANNEL_INBOX_DIR    absolute path to <userData>/channel-cmd-inbox/
 *   MPI_CHANNEL_SESSION_FILE absolute path of this thread's session JSONL
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const INBOX_DIR = process.env.MPI_CHANNEL_INBOX_DIR || "";
const SESSION_FILE = process.env.MPI_CHANNEL_SESSION_FILE || "";
const POLL_MS = 100;
const TIMEOUT_MS = 5_000;

/** Thread id = the UUID part of "<timestamp>_<uuid>.jsonl". */
function sessionId(): string | null {
  const base = basename(SESSION_FILE);
  if (!base.endsWith(".jsonl")) return null;
  const m = /_(.+)\.jsonl$/.exec(base);
  return m ? m[1] : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendRequest(action: "list" | "switch" | "new", target: string | null): Promise<string> {
  const id = sessionId();
  if (!INBOX_DIR || !id) {
    return "Error: this tool only works inside a WeChat/Feishu-connected session (not in desktop or automation sessions).";
  }
  const reqId = randomUUID();
  const reqPath = join(INBOX_DIR, `${reqId}.json`);
  const respPath = join(INBOX_DIR, `${reqId}.resp.json`);
  try {
    writeFileSync(reqPath, JSON.stringify({ sessionId: id, action, target }));
  } catch (err) {
    return `Error: could not reach the MPI main process (${String(err instanceof Error ? err.message : err).slice(0, 200)}).`;
  }

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if (existsSync(respPath)) {
        const resp: any = JSON.parse(readFileSync(respPath, "utf8"));
        return formatResult(action, target, resp);
      }
    } catch {
      /* half-written response — keep polling */
    }
    await sleep(POLL_MS);
  }

  // Timeout: drop the request so a slow/dead main process cannot execute it
  // late (e.g. after a restart). An orphaned .resp.json may remain; the main
  // process prunes stale ones during ingest.
  try {
    unlinkSync(reqPath);
  } catch {
    /* already gone — fine */
  }
  return "Error: timed out waiting for the MPI main process. Tell the user the command did not go through.";
}

function formatResult(action: string, target: string | null, resp: any): string {
  if (!resp || resp.ok !== true) {
    const code = typeof resp?.error === "string" ? resp.error : "unknown error";
    if (code === "not_channel_session") {
      return "Error: this tool only works inside a WeChat/Feishu-connected session.";
    }
    // Ambiguous switch target — the main process hands back the candidates.
    if (code === "ambiguous" && Array.isArray(resp.sessions)) {
      const lines = resp.sessions.map((s: any) => `${s.index}. ${String(s.title)}`);
      return `Multiple sessions match. Ask the user which one they mean:\n${lines.join("\n")}\nThen call mpi_channel_switch_session with that number or keyword.`;
    }
    if (code === "missing_target") {
      return 'Error: a target is required — ask the user for a session number or name, then retry.';
    }
    return `Error: ${String(code).slice(0, 300)}`;
  }
  if (action === "list") {
    const sessions = Array.isArray(resp.sessions) ? resp.sessions : [];
    if (!sessions.length) return "This project has no sessions yet.";
    const lines = sessions.map((s: any) => `${s.index}. ${s.current ? "➜ " : ""}${String(s.title)}`);
    return `Recent sessions (newest first, ➜ = current):\n${lines.join("\n")}\nThe user can switch by number or title keyword.`;
  }
  if (action === "switch") {
    const title = typeof resp.switchedTo === "string" && resp.switchedTo ? resp.switchedTo : target ?? "?";
    return `Switched to session: ${title}. The user's next message will go there.`;
  }
  // new
  return "Created a fresh session. The user's next message will start in it.";
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "mpi_channel_list_sessions",
    label: "List Channel Sessions",
    description:
      "List this chat channel's recent sessions (up to 10, newest first), numbered, with ➜ marking the current one. " +
      "Use when the user asks which conversations/sessions exist (e.g. '看看有哪些会话'), or before switching when they haven't named a target.",
    parameters: Type.Object({}),

    async execute() {
      return { content: [{ type: "text", text: await sendRequest("list", null) }] };
    },
  });

  pi.registerTool({
    name: "mpi_channel_switch_session",
    label: "Switch Channel Session",
    description:
      'Switch this chat channel to another existing session — the user\'s NEXT message will be routed there. ' +
      "target is either a number from mpi_channel_list_sessions (e.g. \"2\") or a keyword of the session title (e.g. \"飞书\"). " +
      "Call ONLY when the user explicitly asked to switch to a specific session, by number or name (e.g. '切到第2个', '回到微信那个对话'). " +
      "If their intent is vague ('我想换个对话'), first call mpi_channel_list_sessions and ask which one — do not guess.",
    parameters: Type.Object({
      target: Type.String({ description: 'Session number (e.g. "2") or a keyword of its title.' }),
    }),

    async execute(_toolCallId, params) {
      const target = String(params.target ?? "").trim();
      if (!target) return { content: [{ type: "text", text: "Error: target is required (a number or title keyword)." }] };
      return { content: [{ type: "text", text: await sendRequest("switch", target.slice(0, 200)) }] };
    },
  });

  pi.registerTool({
    name: "mpi_channel_new_session",
    label: "New Channel Session",
    description:
      "Create a brand-new empty session for this chat channel; the user's next message will start in it. " +
      'Call ONLY when the user explicitly asked to start a new/fresh conversation (e.g. "新建会话", "开个新对话"). Do not use proactively.',
    parameters: Type.Object({}),

    async execute() {
      return { content: [{ type: "text", text: await sendRequest("new", null) }] };
    },
  });
}
