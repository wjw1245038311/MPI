/**
 * MPI mode-switch bridge for pi (loaded via --extension, see choice-extension.ts).
 *
 * Registers `mpi_request_mode_switch`: after presenting a plan while an
 * enforced read-only task mode is active, the agent asks to switch permission
 * so it can execute. Main intercepts the dialog + response and performs the
 * live switch (gate mode file + task-mode state); this tool renders the card,
 * reports the outcome, and — on approval — restores write/edit visibility
 * immediately (F1: main responds to our select() BEFORE applying the switch,
 * and the task-mode extension only reconciles on tool_call / next turn, so
 * without this the first post-approval model request is still blind to
 * write/edit and the model keeps writing via bash — one approval card per
 * command).
 *
 * This file is bundled into the main process as a raw string and written
 * standalone into userData, so it must stay self-contained (no local imports).
 * The title prefix + option labels below are the cross-process contract with
 * src/main/choice-logic.ts (main) — keep them in sync.
 *
 * (The former `mpi_ask_choice` plan-choice card was removed: decisions of any
 * size now use the inline ```choices panel rendered from message text, which
 * works in every mode and needs no blocking dialog.)
 *
 * Env (set by pi-bridge at spawn):
 *   MPI_CHOICE_CONFIG  absolute path to <userData>/config.json (read for the
 *                      current UI language on every call, like the gate does).
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CONFIG_FILE = process.env.MPI_CHOICE_CONFIG || "";

// ---- shared helpers ---------------------------------------------------------

function language(): "zh" | "en" {
  if (!CONFIG_FILE) return "en";
  try {
    const config = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    return config?.language === "zh" ? "zh" : "en";
  } catch {
    return "en";
  }
}

export default function mpiChoice(pi: ExtensionAPI) {

  // ---- mode-switch request (contract with src/main/choice-logic.ts) --------

  /** Restore write/edit visibility right after an approved switch. Verifies
   * the enforced floor is actually lifted first (main applies the switch just
   * after responding to us — any ordering race self-corrects: if the state
   * file still says enforce, the task-mode extension's tool_call hook will
   * reconcile on the next call). Feature-checked like mpi-taskmode-ext. */
  const restoreWriteToolsIfUnenforced = (ctx: { sessionManager?: { getSessionFile?(): string | undefined } }) => {
    const api = pi as unknown as { getActiveTools?: () => string[]; setActiveTools?: (names: string[]) => void };
    if (typeof api.setActiveTools !== "function") return;
    try {
      const dir = process.env.MPI_TASKMODE_DIR || "";
      let enforced = false;
      if (dir) {
        const m = /_(.+)\.jsonl$/.exec(basename(ctx.sessionManager?.getSessionFile?.() || ""));
        if (m) {
          try {
            const state = JSON.parse(readFileSync(join(dir, `${m[1]}.json`), "utf8")) as Record<string, unknown>;
            enforced = state.enforce === "readonly";
          } catch {
            /* no state file → not enforced */
          }
        }
      }
      if (enforced) return; // switch not applied yet — tool_call hook will reconcile
      const current = typeof api.getActiveTools === "function" ? [...api.getActiveTools()] : [];
      if (!current.includes("write") || !current.includes("edit")) {
        api.setActiveTools([...new Set([...current, "write", "edit"])]);
      }
    } catch {
      /* never break the tool over a visibility problem */
    }
  };

  const PERMISSION_NAMES: Record<string, { zh: string; en: string }> = {
    readonly: { zh: "只读", en: "Read-only" },
    strict: { zh: "严格", en: "Strict" },
    sandbox: { zh: "沙盒", en: "Sandbox" },
    full: { zh: "完全权限", en: "Full access" },
  };

  const SwitchParams = Type.Object({
    to: Type.String({
      description:
        'Target permission level: one of "sandbox", "strict", "readonly", "full". Use sandbox for normal execution; full only when the plan genuinely needs unrestricted operations.',
    }),
    reason: Type.String({
      description:
        "One short sentence shown on the confirmation card: what you will do once switched (e.g. '按调研方案部署语音模块' / 'deploy the voice module per the research plan').",
    }),
  });

  pi.registerTool({
    name: "mpi_request_mode_switch",
    label: "Request Mode Switch",
    description:
      "Ask the user to switch this thread's permission level so you can execute a plan — use it ONLY after you have presented a complete research/plan report while an enforced read-only task mode (调研/审查) is active. " +
      "The user sees a confirmation card; on approval MPI switches the permission live and clears the read-only enforcement, then this tool returns so you can continue executing in the same turn. " +
      "If denied or closed, stay read-only: do NOT attempt write operations — ask in plain text how to proceed. " +
      "Do not use for simple questions, and never request 'full' unless the plan truly needs it (sandbox is enough for most execution).",
    parameters: SwitchParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const to = String(params.to || "").trim();
      if (!PERMISSION_NAMES[to]) {
        return {
          content: [
            { type: "text", text: `Error: mpi_request_mode_switch needs a valid target level (readonly/strict/sandbox/full), got "${to}".` },
          ],
        };
      }
      const zh = language() === "zh";
      const name = PERMISSION_NAMES[to][zh ? "zh" : "en"];
      if (!ctx.hasUI) {
        return {
          content: [
            {
              type: "text",
              text: zh
                ? `当前没有可交互界面，无法请求权限切换。请用文字告知用户：如需执行方案，请在输入框左侧的权限菜单中手动切换到「${name}」并退出调研/审查模式。`
                : `No interactive UI is available, so a permission switch cannot be requested. Tell the user in plain text: to execute the plan, switch the permission menu (left of the composer) to "${name}" and leave the research/review mode manually.`,
            },
          ],
        };
      }

      const reason = String(params.reason || "").replace(/\s+/g, " ").trim().slice(0, 300);
      // Stable prefix + fixed option labels: main matches them to perform the
      // actual switch (see choice-logic.ts MODE_SWITCH_* constants).
      const title = zh ? `模式切换请求：切换到「${name}」权限 — ${reason}` : `Mode switch request: switch to "${name}" — ${reason}`;
      const approve = zh ? "同意并切换" : "Approve & switch";
      const deny = zh ? "拒绝" : "Deny";
      const choice = await ctx.ui.select(title, [approve, deny]);

      let text: string;
      if (!choice) {
        text = zh
          ? `用户未做出选择（对话框已关闭）。不要擅自假设已获批准；用文字询问用户是否同意切换到「${name}」权限以执行方案。`
          : `The user did not select any option (dialog closed). Do NOT assume approval; ask in plain text whether they agree to switch to "${name}" so the plan can be executed.`;
      } else if (choice === approve) {
        restoreWriteToolsIfUnenforced(ctx);
        text = zh
          ? `用户已同意，系统已将本会话切换到「${name}」权限并解除强制只读（write/edit 工具已恢复可用）。现在可以继续执行方案：写文件请优先使用 write/edit 工具；如执行中发现仍需更高权限，可再次调用本工具请求。`
          : `The user approved; MPI has switched this thread to "${name}" and lifted the enforced read-only floor (the write/edit tools are available again). You may now execute the plan — prefer the write/edit tools for file changes; if you discover a higher level is needed, call this tool again.`;
      } else {
        text = zh
          ? `用户拒绝了本次权限切换请求。保持当前只读状态，不要尝试任何写操作；用文字询问用户希望如何继续（例如调整方案、补充调研，或由用户手动切换权限）。`
          : `The user denied this permission switch request. Stay read-only and do NOT attempt write operations; ask in plain text how to proceed (refine the plan, research more, or have the user switch manually).`;
      }
      return { content: [{ type: "text", text }] };
    },
  });
}
