/**
 * MPI 待办任务 bridge for pi (loaded via --extension, see todo-extension.ts).
 *
 * Lets the agent add persistent todos to the MPI desktop app's 待办任务 panel.
 * The extension NEVER writes todos.json directly — it drops one JSON file per
 * todo into an inbox directory that the main process watches and ingests, so
 * the main process stays the single writer of todos.json (no cross-process
 * races). Listing reads todos.json directly; a slightly stale view is fine.
 *
 * Env (set by pi-bridge at spawn):
 *   MPI_TODO_FILE         absolute path to <userData>/todos.json
 *   MPI_TODO_INBOX_DIR    absolute path to <userData>/todos-inbox/
 *   MPI_TODO_SESSION_FILE absolute path of this thread's session JSONL (optional)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TODO_FILE = process.env.MPI_TODO_FILE || "";
const INBOX_DIR = process.env.MPI_TODO_INBOX_DIR || "";
const SESSION_FILE = process.env.MPI_TODO_SESSION_FILE || "";

function configured(): boolean {
  return !!TODO_FILE && !!INBOX_DIR;
}

/** Validate a local "YYYY-MM-DD" date (calendar-valid, not just shaped right). */
function validDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]);
}

function readTodos(): Array<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(TODO_FILE, "utf8"));
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  } catch {
    return []; // no file yet — normal for a fresh profile
  }
}

const AddParams = Type.Object({
  title: Type.String({ description: "Todo title (short imperative phrase)" }),
  dueDate: Type.Optional(
    Type.String({ description: 'Due date as local "YYYY-MM-DD" (e.g. "2026-09-15"). Omit when the user gave no date.' })
  ),
  note: Type.Optional(Type.String({ description: "Optional short note/extra detail for the todo." })),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "mpi_todo_add",
    label: "Add Todo",
    description:
      "Record a persistent personal todo in the MPI desktop app's 待办任务 panel for the current project. " +
      "Use ONLY when the user asks to record/remember a task or todo (e.g. '记个待办：周五前发报告'). " +
      "Do not use proactively, and do not use for your own in-session planning steps.",
    parameters: AddParams,

    async execute(_toolCallId, params) {
      if (!configured()) {
        return { content: [{ type: "text", text: "Todo integration is not configured (missing MPI_TODO_FILE / MPI_TODO_INBOX_DIR)." }] };
      }
      const title = String(params.title || "").trim().slice(0, 500);
      if (!title) {
        return { content: [{ type: "text", text: "Error: title is required." }] };
      }
      let dueDate: string | null = null;
      if (params.dueDate !== undefined) {
        if (!validDate(params.dueDate)) {
          return {
            content: [
              { type: "text", text: `Error: dueDate must be a valid local date in "YYYY-MM-DD" format, got "${String(params.dueDate)}".` },
            ],
          };
        }
        dueDate = params.dueDate;
      }
      const note = typeof params.note === "string" && params.note.trim() ? params.note.trim().slice(0, 2000) : undefined;

      try {
        mkdirSync(INBOX_DIR, { recursive: true });
        const item = {
          id: randomUUID(),
          title,
          ...(note ? { note } : {}),
          cwd: process.cwd(),
          dueDate,
          done: false,
          createdAt: Date.now(),
          completedAt: null,
          source: "agent",
          ...(SESSION_FILE ? { sessionFile: SESSION_FILE } : {}),
        };
        writeFileSync(join(INBOX_DIR, `${item.id}.json`), JSON.stringify(item));
      } catch (e) {
        return { content: [{ type: "text", text: `Failed to record todo: ${String(e instanceof Error ? e.message : e)}` }] };
      }

      const when = dueDate ? ` (due ${dueDate})` : "";
      return {
        content: [
          {
            type: "text",
            text: `Recorded in MPI 待办任务: "${title}"${when}. It will appear in the app's todo panel shortly.`,
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "mpi_todo_list",
    label: "List Todos",
    description:
      "List open persistent todos from the MPI desktop app's 待办任务 panel for the current project. " +
      "Use to check what tasks are already tracked before adding a new one.",
    parameters: Type.Object({}),

    async execute() {
      if (!configured()) {
        return { content: [{ type: "text", text: "Todo integration is not configured (missing MPI_TODO_FILE / MPI_TODO_INBOX_DIR)." }] };
      }
      const cwd = process.cwd();
      const open = readTodos().filter((t) => t.done !== true && (typeof t.cwd === "string" ? t.cwd : "") === cwd);
      if (open.length === 0) {
        return { content: [{ type: "text", text: "No open todos for this project." }] };
      }
      const lines = open.slice(0, 25).map((t) => {
        const due = typeof t.dueDate === "string" && t.dueDate ? ` (due ${t.dueDate})` : "";
        return `- [${typeof t.source === "string" && t.source === "agent" ? "AI" : "user"}] ${String(t.title)}${due}`;
      });
      const more = open.length > 25 ? `\n... and ${open.length - 25} more` : "";
      return { content: [{ type: "text", text: `Open todos for this project (${open.length}):${more}\n${lines.join("\n")}` }] };
    },
  });
}
