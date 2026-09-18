/**
 * MPI 方案选择 bridge for pi (loaded via --extension, see choice-extension.ts).
 *
 * Gives the agent an `mpi_ask_choice` tool: when it presents several alternative
 * plans/options, it calls this tool and the options surface as a clickable card
 * in the MPI chat (the existing extension-UI select dialog, rendered above the
 * composer). The user clicks one option; the selection comes back here as the
 * tool result so the agent continues with that plan in the SAME turn — no need
 * for the user to type anything.
 *
 * This file is bundled into the main process as a raw string and written
 * standalone into userData, so it must stay self-contained (no local imports).
 * The heading prefix + result texts below are the cross-process contract with
 * src/main/choice-logic.ts (main) and src/renderer/src/lib/choice.ts
 * (renderer history card) — keep them in sync.
 *
 * It also registers `mpi_request_mode_switch`: after presenting a plan while an
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
 * Env (set by pi-bridge at spawn):
 *   MPI_CHOICE_CONFIG  absolute path to <userData>/config.json (read for the
 *                      current UI language on every call, like the gate does).
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CONFIG_FILE = process.env.MPI_CHOICE_CONFIG || "";

// ---- contract (keep in sync with src/main/choice-logic.ts) ------------------

function language(): "zh" | "en" {
  if (!CONFIG_FILE) return "en";
  try {
    const config = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    return config?.language === "zh" ? "zh" : "en";
  } catch {
    return "en";
  }
}

function heading(question: string): string {
  const q = String(question || "").trim();
  return language() === "zh" ? `方案选择：${q}` : `Plan choice: ${q}`;
}

function resultText(choice: string | null): string {
  if (!choice) {
    return language() === "zh"
      ? "用户未做出选择（对话框已关闭）。不要擅自选择任何方案；用文字询问用户想要哪个。"
      : "The user did not select any option (dialog closed). Do NOT pick an option on your own; ask in plain text which one they want.";
  }
  return language() === "zh" ? `用户已选择：「${choice}」。请按此选项继续执行。` : `User selected: "${choice}". Proceed with this option.`;
}

// ---- tool --------------------------------------------------------------------

// An option is either a plain string label, or an object with a longer
// `detail` explanation that the card shows behind an expandable “细节/Detail”
// toggle. In RPC mode pi forwards `options` verbatim in the extension_ui_request
// payload (no string coercion), so objects reach the renderer intact.
const OptionObject = Type.Object({
  label: Type.String({ description: "Concise one-line summary of this option (ideally ≤ ~40 chars)." }),
  detail: Type.Optional(
    Type.String({
      description:
        "Optional longer explanation (1-3 sentences, key trade-offs) shown in an expandable section on the card.",
    }),
  ),
});

const Params = Type.Object({
  question: Type.String({
    description: "Short question shown as the card title, e.g. '用哪个实现方式？' / 'Which approach should I use?'",
  }),
  options: Type.Array(Type.Union([Type.String(), OptionObject]), {
    minItems: 2,
    maxItems: 6,
    description:
      "The alternative plans/options for the user to pick from. Each option is a concise one-line label (ideally ≤ ~40 chars), or an object {label, detail} when the option needs more than a line of explanation — `detail` (1-3 sentences) appears in an expandable section on the card so the user can compare without scrolling back through your message.",
  }),
});

export default function mpiChoice(pi: ExtensionAPI) {
  pi.registerTool({
    name: "mpi_ask_choice",
    label: "Ask Choice",
    description:
      "Present several alternative plans/options to the user as clickable buttons in the MPI chat, instead of asking them to type a reply. " +
      "Use when you have finished analyzing a task and are offering 2-6 distinct options for the user to choose from (e.g. design proposals A/B/C after '先出方案让我选'). " +
      "For MULTIPLE related decisions in one round (e.g. an interview/grilling round), do NOT call this tool once per question — emit ONE fenced block in your message text instead: a line ```choices, then a JSON array of {\"title\",\"options\"} objects (2-6 options each; option = string or {label, detail}), then a closing ``` fence. MPI renders it as an inline multi-question panel and sends all selections back as one user message starting with 我的选择：/My choices:. Use this tool for a SINGLE decision. " +
      "Write the full comparison/analysis as normal message text FIRST, then call this tool with concise one-line labels per option; if you recommend one, mark it in its label like '（推荐）'. " +
      "When an option needs more than a line of explanation, pass {label, detail} so the user can expand the details on the card. " +
      "The card also offers an “其它/Other” input where the user can type their own plan — treat that text as the chosen option and follow it. " +
      "The tool returns the user's selection (or that no choice was made) so you can continue immediately. " +
      "Do NOT use for simple yes/no questions, single-path situations, or when the user already stated a preference.",
    parameters: Params,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const question = String(params.question || "").trim().slice(0, 300);
      // Accept string | {label, detail?} per option; normalize + dedupe.
      type NormOption = { label: string; detail?: string };
      const options: NormOption[] = [];
      for (const item of Array.isArray(params.options) ? params.options : []) {
        let label = "";
        let detail = "";
        if (typeof item === "string") {
          label = item;
        } else if (item && typeof item === "object" && !Array.isArray(item)) {
          const o = item as Record<string, unknown>;
          label = String(o.label ?? "");
          detail = String(o.detail ?? "");
        }
        label = label.replace(/\s+/g, " ").trim();
        detail = detail.trim().slice(0, 1200);
        if (label && !options.some((x) => x.label === label)) options.push(detail ? { label, detail } : { label });
      }
      if (!question || options.length < 2) {
        return {
          content: [
            { type: "text", text: "Error: mpi_ask_choice needs a question and at least two non-empty option labels." },
          ],
        };
      }

      if (!ctx.hasUI) {
        // Headless run (print/json mode): no one can click. Fall back to plain text.
        const list = options.map((o, i) => `${i + 1}. ${o.label}${o.detail ? ` — ${o.detail}` : ""}`).join("\n");
        return {
          content: [
            {
              type: "text",
              text: `No interactive UI is available (headless run). Present the options in plain text and wait for the user's reply:\n${list}`,
            },
          ],
        };
      }

      // Blocks until the user clicks an option, types a custom plan in the
      // card's “其它/Other” input, or closes it. Closing / channel auto-cancel
      // resolves to undefined — never pick on their behalf.
      // Wire format: plain labels stay strings (TUI-safe); only options with a
      // detail become {label, detail} objects (RPC mode forwards them verbatim).
      const wire = options.map((o) => (o.detail ? { label: o.label, detail: o.detail } : o.label));
      const choice = await ctx.ui.select(heading(question), wire);
      return { content: [{ type: "text", text: resultText(choice) }] };
    },
  });

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
