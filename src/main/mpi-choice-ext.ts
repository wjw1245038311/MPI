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
 * Env (set by pi-bridge at spawn):
 *   MPI_CHOICE_CONFIG  absolute path to <userData>/config.json (read for the
 *                      current UI language on every call, like the gate does).
 */

import { readFileSync } from "node:fs";
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
}
