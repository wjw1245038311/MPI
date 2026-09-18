/**
 * The full --append-system-prompt text for a spawned pi bridge: Zhiya
 * persona/assets (files under ~/.pi/agent/zhiya/) + the Q&A-mode instruction
 * from Settings → 对话设置. Both construction sites (interactive threads in
 * ipc.ts, automation runs) must use buildAppendSystemPrompt so they stay in
 * sync; appendPromptFingerprint drives warm-bridge staleness checks.
 */
import { createHash } from "node:crypto";
import { getConfig } from "./config";
import { qaModeInstruction } from "./choice-logic";
import { buildZhiyaPrompt } from "./zhiya";

/** The combined injection text; undefined when there is nothing to inject. */
export function buildAppendSystemPrompt(): string | undefined {
  const cfg = getConfig();
  const parts = [buildZhiyaPrompt(), qaModeInstruction(cfg.qaMode || "inline", cfg.language === "en" ? "en" : "zh")].filter(
    (p): p is string => Boolean(p),
  );
  return parts.length ? parts.join("\n\n") : undefined;
}

/** Fingerprint of the injected text (not raw files): comment-only persona edits
 * do not change it, so they must not force a warm-bridge restart. */
export function appendPromptFingerprint(): string {
  return createHash("sha256").update(buildAppendSystemPrompt() ?? "").digest("hex");
}
