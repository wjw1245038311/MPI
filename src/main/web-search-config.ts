/**
 * pi-web-access (联网搜索) flow management — "扩展自动选模" (Settings → Conversation).
 *
 * The pi-web-access extension opens an external browser curation window on every
 * web_search call and asks the user to pick a summary model. MPI removes that
 * friction by managing two documented keys in the extension's own config file
 * (~/.pi/web-search.json, shared with terminal pi):
 *
 *   workflow: "auto-summary"          → no browser popup; the search returns an
 *                                       AI-generated summary directly
 *   summaryModel: "<provider>/<id>"   → that summary uses THIS conversation's
 *                                       current model (kept in sync per turn)
 *   summaryGenerationDeadlineMs       → raised so slower local models don't hit
 *                                       the 30s default and degrade to a
 *                                       deterministic fallback
 *
 * Safety rules:
 * - read-modify-write preserves every other key (API keys etc.) untouched;
 * - on first touch the original values of the managed keys are backed up to a
 *   sidecar in MPI's config dir; disabling the feature restores them exactly
 *   (null = the key did not exist before);
 * - an unparseable web-search.json is NEVER overwritten (same policy as mcp.json).
 *
 * The module also answers extension UI "select" dialogs whose options are a
 * list of models with the thread's current model, so future plugins that ask
 * for a model via ctx.ui.select don't pop up either.
 *
 * No Electron imports — plain node builtins only (unit-testable).
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Workflow that skips the interactive browser curator entirely. */
export const WEB_SEARCH_AUTO_WORKFLOW = "auto-summary";
/** 5 minutes — pi-web-access clamps to [1, 600_000]; default is 30s which slow
 * local models (the usual "current conversation model") would blow through. */
export const WEB_SEARCH_SUMMARY_DEADLINE_MS = 300_000;

const MANAGED_KEYS = ["workflow", "summaryModel", "summaryGenerationDeadlineMs"] as const;

/** Sidecar holding the pre-MPI state (null key value = key was absent;
 * fileExisted=false → restore deletes the file MPI created). */
interface OrigBackup {
  fileExisted: boolean;
  workflow: string | null;
  summaryModel: string | null;
  summaryGenerationDeadlineMs: number | null;
}

export interface ModelRef {
  provider: string;
  id: string;
}

/**
 * Resolve web-search.json exactly like pi-web-access's getWebSearchConfigDir():
 * PI_CODING_AGENT_DIR wins, then XDG_CONFIG_HOME/pi (when it already holds the
 * file), then ~/.pi. Must stay in sync with the extension or MPI would manage
 * a file nobody reads.
 */
export function webSearchConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_CODING_AGENT_DIR) return join(env.PI_CODING_AGENT_DIR, "web-search.json");
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg) {
    const xdgFile = join(xdg, "pi", "web-search.json");
    if (existsSync(xdgFile)) return xdgFile;
    const legacyFile = join(homedir(), ".pi", "web-search.json");
    if (existsSync(legacyFile)) return legacyFile;
    return xdgFile;
  }
  return join(homedir(), ".pi", "web-search.json");
}

function sidecarPath(configDir: string): string {
  return join(configDir, "web-search-orig.json");
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch (err) {
    // Missing file is a normal state ({}); anything else is corruption and we
    // must not clobber it.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(`[web-search] refusing to touch unparseable ${path}:`, err);
    }
    return null;
  }
}

function writeJsonAtomic(path: string, obj: object): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export interface WebSearchFlow {
  /** Write workflow/summaryModel/deadline for the given conversation model.
   * No-op when `model` is unknown (workflow still applied). Returns false if
   * the file was corrupt and left untouched. */
  sync(model: ModelRef | null): boolean;
  /** Restore the pre-MPI values of the managed keys (sidecar) and drop it.
   * No-op when MPI never touched the file. */
  restore(): boolean;
}

export function createWebSearchFlow(configDir: string, env: NodeJS.ProcessEnv = process.env): WebSearchFlow {
  let lastWrittenJson: string | null = null;

  const backupOriginals = (obj: Record<string, unknown>, fileExisted: boolean): OrigBackup => ({
    fileExisted,
    workflow: typeof obj.workflow === "string" ? obj.workflow : null,
    summaryModel: typeof obj.summaryModel === "string" ? obj.summaryModel : null,
    summaryGenerationDeadlineMs:
      typeof obj.summaryGenerationDeadlineMs === "number" && Number.isFinite(obj.summaryGenerationDeadlineMs)
        ? obj.summaryGenerationDeadlineMs
        : null,
  });

  return {
    sync(model) {
      const path = webSearchConfigPath(env);
      let obj: Record<string, unknown>;
      if (existsSync(path)) {
        const parsed = readJson(path);
        if (!parsed) return false; // corrupt — never overwrite
        obj = parsed;
      } else {
        obj = {};
      }

      // First touch: remember what was there so restore() can undo us.
      const sidecar = sidecarPath(configDir);
      if (!existsSync(sidecar)) {
        try {
          writeJsonAtomic(sidecar, backupOriginals(obj, existsSync(path)));
        } catch (err) {
          console.error("[web-search] failed to back up original web-search.json values:", err);
        }
      }

      obj.workflow = WEB_SEARCH_AUTO_WORKFLOW;
      obj.summaryGenerationDeadlineMs = WEB_SEARCH_SUMMARY_DEADLINE_MS;
      if (model && model.provider && model.id) {
        obj.summaryModel = `${model.provider}/${model.id}`;
      }

      const json = JSON.stringify(obj, null, 2) + "\n";
      if (json === lastWrittenJson) return true; // nothing changed since last write
      try {
        writeJsonAtomic(path, obj);
        lastWrittenJson = json;
        return true;
      } catch (err) {
        console.error(`[web-search] failed to write ${path}:`, err);
        return false;
      }
    },

    restore() {
      const sidecar = sidecarPath(configDir);
      if (!existsSync(sidecar)) return true; // MPI never touched the file
      let orig: OrigBackup | null = null;
      try {
        const parsed: unknown = JSON.parse(readFileSync(sidecar, "utf8"));
        if (parsed && typeof parsed === "object") orig = parsed as OrigBackup;
      } catch (err) {
        console.error("[web-search] unreadable backup sidecar, leaving web-search.json as-is:", err);
        return false;
      }
      if (!orig) return true;

      const path = webSearchConfigPath(env);
      let obj: Record<string, unknown>;
      if (existsSync(path)) {
        const parsed = readJson(path);
        if (!parsed) return false; // corrupt — never overwrite
        obj = parsed;
      } else {
        obj = {};
      }

      for (const key of MANAGED_KEYS) {
        const value = orig[key];
        if (value === null || value === undefined) delete obj[key];
        else obj[key] = value;
      }

      try {
        const remaining = Object.keys(obj).length > 0;
        if (!orig.fileExisted && !remaining) {
          // MPI created the file and nothing else lives in it → exact restore
          // is deleting it again. (If the user added their own keys meanwhile,
          // keep those instead.)
          if (existsSync(path)) unlinkSync(path);
        } else {
          writeJsonAtomic(path, obj);
        }
        unlinkSync(sidecar);
        lastWrittenJson = null;
        return true;
      } catch (err) {
        console.error(`[web-search] failed to restore ${path}:`, err);
        return false;
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * Extension UI model-select auto-answer
 * ------------------------------------------------------------------ */

/** "provider/model-id" — the shape pi-web-access (and pi in general) uses for
 * model selectors. Allows dots, dashes, underscores and @ (quantized local
 * model ids like qwen3.8-27b@q5_k_m). */
const MODEL_OPTION_RE = /^[\w.@-]+\/[\w.@-]+$/;

export interface ExtUiLikeRequest {
  id: string;
  method?: unknown;
  options?: unknown;
}

/** Conservative heuristic: a "select" dialog whose options are ALL plain
 * provider/model strings is treated as a model picker. Anything else (labels,
 * result lists like `[abc123] "query" - 5m ago`, single options) is left to
 * the normal UI path. */
export function isLikelyModelSelect(req: ExtUiLikeRequest | null | undefined): boolean {
  if (!req || req.method !== "select") return false;
  const opts = req.options;
  if (!Array.isArray(opts) || opts.length < 2) return false;
  return opts.every((o) => typeof o === "string" && MODEL_OPTION_RE.test(o));
}

/** Minimal bridge surface (PiBridge satisfies it structurally). */
export interface ModelSelectBridge {
  getState(): Promise<unknown>;
  respondExtUi(id: string, payload: Record<string, unknown>): void;
}

/**
 * If the request is a model picker and this thread's current model is among
 * the options, answer it immediately with that model. Returns true when the
 * dialog was auto-answered (the caller must NOT forward it to any UI); false
 * means "show it normally". Never throws.
 */
export async function autoAnswerModelSelect(
  bridge: ModelSelectBridge,
  req: ExtUiLikeRequest,
): Promise<boolean> {
  if (!isLikelyModelSelect(req)) return false;
  try {
    const state = (await bridge.getState()) as { model?: ModelRef | null } | null;
    const model = state?.model;
    if (!model || !model.provider || !model.id) return false;
    const value = `${model.provider}/${model.id}`;
    const opts = req.options as string[];
    if (!opts.includes(value)) return false;
    bridge.respondExtUi(req.id, { value });
    console.log(`[web-search] auto-answered extension model select with ${value}`);
    return true;
  } catch (err) {
    console.error("[web-search] model-select auto-answer failed:", err);
    return false;
  }
}
