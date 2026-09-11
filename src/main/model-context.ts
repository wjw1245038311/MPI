import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ModelDef, ProviderDef } from "../renderer/src/lib/types";

/**
 * P1-11 — automatic contextWindow resolution for models.json entries.
 *
 * Pi itself has no detection: `modelFromJson` falls back to a fixed 128000
 * when the field is missing (verified in runtime 0.84.1 provider-composer.js).
 * MPI resolves the value before writing, using this chain (first hit wins):
 *
 *   1. Built-in catalog lookup — pi-ai ships a full model directory under
 *      `<runtime>/pi/node_modules/@earendil-works/pi-ai/dist/providers/data/*.json`
 *      (~604K). Offline, zero cost. Matches exact ids and the suffix after `/`.
 *   2. API probe (only when the catalog misses): OpenAI-compatible /models
 *      (`context_length`/`max_context_tokens`), LM Studio native REST
 *      (/api/v1/models — its OpenAI-compat endpoint has no context field),
 *      Ollama /api/show (best effort). Local hosts only for 2./3.
 *   3. Nothing found → leave undefined; pi's 128K default applies and the UI
 *      says so explicitly.
 *
 * Semantics (user-confirmed): a model that already has a contextWindow value
 * is never re-resolved on save — only empty + `contextWindowAuto` models are.
 */

export interface ContextResolution {
  /** Resolved window in tokens, when found. */
  value?: number;
  source: "catalog" | "api" | "none";
  /** Human-readable origin for the UI badge (e.g. endpoint host). */
  detail?: string;
}

const PROBE_TIMEOUT_MS = 8000;

/* ---------------- built-in catalog index ---------------- */

/**
 * Candidate data dirs relative to a pi cli.js path:
 *   packaged runtime: <root>/pi/dist/cli.js + <root>/pi/node_modules/...
 *   npm global:       .../@earendil-works/pi-coding-agent/dist/cli.js, sibling pi-ai package
 */
export function findCatalogDataDir(cliPath: string | null | undefined): string | null {
  if (!cliPath) return null;
  const candidates = [
    join(dirname(cliPath), "..", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data"),
    join(dirname(cliPath), "..", "..", "pi-ai", "dist", "providers", "data"),
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return resolve(c);
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Build a `modelId → contextWindow` index from the pi-ai data files. Each file
 * maps provider name → model map; keys may be bare ("deepseek-v4-flash") or
 * namespaced ("qwen/qwen3-max"). Both the full key and its `/` suffix are
 * indexed (first writer wins on suffix collisions).
 */
export function loadCatalogIndex(dataDir: string): Map<string, number> {
  const map = new Map<string, number>();
  let files: string[] = [];
  try {
    files = readdirSync(dataDir).filter((f) => f.endsWith(".json"));
  } catch {
    return map;
  }
  for (const file of files) {
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(join(dataDir, file), "utf8"));
    } catch {
      continue;
    }
    if (!doc || typeof doc !== "object") continue;
    for (const providerMap of Object.values(doc as Record<string, unknown>)) {
      if (!providerMap || typeof providerMap !== "object" || Array.isArray(providerMap)) continue;
      for (const [key, entry] of Object.entries(providerMap as Record<string, any>)) {
        const cw = entry?.contextWindow;
        if (typeof cw !== "number" || cw <= 0) continue;
        map.set(key, cw);
        const slash = key.lastIndexOf("/");
        if (slash >= 0 && !map.has(key.slice(slash + 1))) map.set(key.slice(slash + 1), cw);
      }
    }
  }
  return map;
}

const catalogCache = new Map<string, Map<string, number>>();

function getCatalogIndex(dataDir: string): Map<string, number> {
  let idx = catalogCache.get(dataDir);
  if (!idx) {
    idx = loadCatalogIndex(dataDir);
    catalogCache.set(dataDir, idx);
  }
  return idx;
}

/**
 * Discover the active pi runtime and its bundled catalog. Lazy dynamic import:
 * pi-bridge transitively imports electron, which must not enter this module's
 * static graph (node-based tests inject a catalogMap instead).
 */
async function loadCatalogMap(): Promise<Map<string, number>> {
  try {
    const { resolvePiRuntime } = await import("./pi-bridge");
    const rt = await resolvePiRuntime();
    const dir = findCatalogDataDir(rt.cli);
    return dir ? getCatalogIndex(dir) : new Map<string, number>();
  } catch {
    return new Map<string, number>();
  }
}

/** Exact id match first, then the suffix after `/` (for namespaced user ids). */
export function lookupContextInMap(map: Map<string, number>, modelId: string): number | undefined {
  if (!modelId) return undefined;
  const exact = map.get(modelId);
  if (exact !== undefined) return exact;
  const slash = modelId.lastIndexOf("/");
  if (slash >= 0) return map.get(modelId.slice(slash + 1));
  return undefined;
}

/* ---------------- API probes ---------------- */

function isLocalHost(u: URL): boolean {
  const h = u.hostname;
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
  const m = h.match(/^(\d+)\.(\d+)/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function pickContextNumber(entry: any): number | undefined {
  // num_ctx: Ollama /api/show options (runtime context, best effort).
  for (const key of ["context_length", "max_context_tokens", "max_input_tokens", "num_ctx"]) {
    const v = entry?.[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.round(v);
  }
  return undefined;
}

const normalizeId = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<any | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers });
    if (!res.ok) return null;
    return (await res.json()) as any;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe the provider's own endpoints for a context window. Best effort: every
 * step fails soft, and non-local hosts are only ever hit on their documented
 * OpenAI-compatible /models path (no extra requests to public APIs).
 */
export async function probeApiContext(provider: ProviderDef, model: ModelDef): Promise<ContextResolution | null> {
  const base = (model.baseUrl ?? provider.baseUrl)?.trim();
  if (!base || !model.id) return null;
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return null;
  }

  const headers: Record<string, string> = {};
  const key = provider.apiKey?.trim();
  if (key && !key.startsWith("$") && !key.startsWith("!")) {
    // pi config values may be $ENV / !cmd references — only literal keys are usable here.
    headers[provider.authHeader === false ? "x-api-key" : "Authorization"] =
      provider.authHeader === false ? key : `Bearer ${key}`;
  }

  const idNorm = normalizeId(model.id);
  // Absolute join: new URL("models", base) would replace the /v1 segment.
  const modelsUrl = `${u.origin}${u.pathname.replace(/\/+$/, "")}/models`;

  // 1) OpenAI-compatible /models (OpenRouter & most gateways expose context_length).
  try {
    const j = await fetchJson(modelsUrl, headers);
    const arr: any[] | null = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : null;
    if (arr) {
      // Gateways often namespace ids ("openai/gpt-5") while the user's model id
      // is bare ("gpt-5") — match exact, normalized, or suffix after "/".
      const hit = arr.find((e) => {
        const eid = String(e?.id ?? "");
        if (eid === model.id || normalizeId(eid) === idNorm) return true;
        const slash = eid.lastIndexOf("/");
        return slash >= 0 && normalizeId(eid.slice(slash + 1)) === idNorm;
      });
      const v = hit ? pickContextNumber(hit) : undefined;
      if (v) return { value: v, source: "api", detail: `${u.host}/models` };
    }
  } catch {
    /* fall through */
  }

  // 2) LM Studio native REST — its OpenAI-compat /v1/models has no context field.
  if (isLocalHost(u)) {
    try {
      const j = await fetchJson(`http://${u.host}/api/v1/models`);
      const arr: any[] | null = Array.isArray(j?.data) ? j.data : null;
      if (arr && arr.length > 0) {
        let hit = arr.find((e) => e?.key === model.id || e?.display_name === model.id);
        if (!hit)
          hit = arr.find(
            (e) => normalizeId(String(e?.key ?? "")) === idNorm || normalizeId(String(e?.display_name ?? "")) === idNorm,
          );
        if (!hit && arr.length === 1) hit = arr[0]; // single loaded model — best effort
        const v = hit ? pickContextNumber(hit) : undefined;
        if (v) return { value: v, source: "api", detail: `LM Studio ${u.host}` };
      }
    } catch {
      /* fall through */
    }

    // 3) Ollama /api/show — num_ctx is a runtime option; weak guarantee.
    if (u.port === "11434" || base.toLowerCase().includes("ollama")) {
      try {
        const origin = `${u.protocol}//${u.host}`;
        const j = await fetchJson(`${origin}/api/show?name=${encodeURIComponent(model.id)}`);
        const v = pickContextNumber(j?.options ?? {}) ?? (typeof j?.details?.num_ctx === "number" ? j.details.num_ctx : undefined);
        if (v) return { value: Math.round(v), source: "api", detail: `Ollama ${u.host}` };
      } catch {
        /* give up */
      }
    }
  }

  return null;
}

/* ---------------- public resolution chain ---------------- */

/**
 * Resolve a model's context window. Pass `catalogMap` to skip runtime discovery
 * (tests); otherwise the index is loaded from the active pi runtime and cached.
 */
export async function resolveModelContext(
  providerId: string,
  provider: ProviderDef,
  model: ModelDef,
  opts?: { catalogMap?: Map<string, number> },
): Promise<ContextResolution> {
  if (!model?.id) return { source: "none" };

  let map = opts?.catalogMap;
  if (map === undefined) map = await loadCatalogMap();

  const fromCatalog = lookupContextInMap(map, model.id);
  if (fromCatalog !== undefined) return { value: fromCatalog, source: "catalog", detail: providerId };

  try {
    const probed = await probeApiContext(provider, model);
    if (probed) return probed;
  } catch {
    /* probes are best effort */
  }
  return { source: "none" };
}

/**
 * Save-time hook: deep-copy the provider map and resolve every model that is
 * marked `contextWindowAuto` but has no value yet. Models with an existing
 * value (manual or previously resolved) are left untouched — user-confirmed
 * semantics: 有值不解析。
 */
export async function autoResolveContextWindows(
  providers: Record<string, ProviderDef>,
  opts?: { catalogMap?: Map<string, number> },
): Promise<Record<string, ProviderDef>> {
  const out = JSON.parse(JSON.stringify(providers)) as Record<string, ProviderDef>;

  // Test injection skips runtime discovery (which would pull in electron).
  const map = opts?.catalogMap ?? (await loadCatalogMap());

  // Resolve all pending models concurrently — API probes are the slow part
  // (≤8s each) and a save with several empty+auto models must not serialize.
  const jobs: Array<Promise<void>> = [];
  for (const [providerId, provider] of Object.entries(out)) {
    for (const model of provider.models ?? []) {
      const hasValue = typeof model.contextWindow === "number" && model.contextWindow > 0;
      if (model.contextWindowAuto !== true || hasValue) continue;
      jobs.push(
        (async () => {
          let res: ContextResolution;
          try {
            res = await resolveModelContext(providerId, provider, model, { catalogMap: map });
          } catch {
            res = { source: "none" };
          }
          if (res.value !== undefined) {
            model.contextWindow = res.value;
            model.contextWindowSource = res.source;
            model.contextWindowDetail = res.detail;
          } else {
            model.contextWindowSource = "none";
            delete model.contextWindowDetail;
          }
        })(),
      );
    }
  }
  await Promise.all(jobs);
  return out;
}
