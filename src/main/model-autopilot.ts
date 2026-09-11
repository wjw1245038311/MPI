import type { ModelDef, ProviderDef } from "../renderer/src/lib/types";

/**
 * P1-12 — auto model switching (模型「auto」模式).
 *
 * Design (user-approved 2026-09-10, see improvement-suggestions.md P1-12):
 * - Global candidate pool; each entry has a `paid` mark (default free) and an
 *   optional tier override. Pool order is only a tie-breaker within equal rank.
 * - Quality tiers high/mid/low are auto-inferred (frontier table → size signal
 *   → catalog cost band → conservative low). Local qwen3.8-27b ≈ mid is the
 *   "never worse than this" baseline.
 * - Selection: free first; within a cost class by tier desc, recent TTFT asc,
 *   pool order. Only switch to ≥ current model's tier; if nothing meets the
 *   floor → rescue downgrade (allowed + warning, or strictly forbidden).
 * - Health is passive: per-turn TTFT + error classification from live agent
 *   events of AUTO threads only (non-auto threads pay zero overhead).
 * - Failover on hard failure / soft degradation; recovery re-probes better
 *   candidates every interval with a cooldown to prevent flapping.
 *
 * The pure parts (tier inference, health window, selection) are exported for
 * unit tests; the orchestrator takes injected callbacks so it never imports
 * electron-dependent modules.
 */

export type QualityTier = "high" | "mid" | "low";
const TIER_RANK: Record<QualityTier, number> = { high: 3, mid: 2, low: 1 };

export interface PoolEntry {
  provider: string;
  modelId: string;
  /** Billed endpoint? Default false (free). Never auto-inferred — the same
   * model id can be free on a gateway and paid at the official API. */
  paid?: boolean;
  tierOverride?: QualityTier;
}

export interface AutoPolicy {
  /** Soft degradation: TTFT > factor × own median … */
  softDegradeFactor: number; // default 3
  /** … AND absolute value above this (ms). */
  softDegradeMinMs: number; // default 15000
  /** … for this many consecutive turns. */
  softDegradeStreak: number; // default 2
  /** Re-probe better candidates every N minutes while a fallback is active. */
  recoveryIntervalMin: number; // default 5
  /** Minimum gap between auto switches on one thread (anti-flap). */
  cooldownMin: number; // default 10
  /** true = never switch below the current tier, even as rescue. */
  strictNoDowngrade: boolean; // default false
  notify: boolean; // default true
}

export const DEFAULT_POLICY: AutoPolicy = {
  softDegradeFactor: 3,
  softDegradeMinMs: 15_000,
  softDegradeStreak: 2,
  recoveryIntervalMin: 5,
  cooldownMin: 10,
  strictNoDowngrade: false,
  notify: true,
};

export interface ModelRef {
  provider: string;
  id: string;
}

/* ---------------- quality tier inference ---------------- */

/** Cap keywords: these variants are at most mid even when other rules say high. */
const CAP_KEYWORDS = ["-flash", "-mini", "-lite", "-nano", "-small", "-free"];

/** Frontier families → high (matched on the normalized id, before size/cost). */
const FRONTIER_PATTERNS: RegExp[] = [
  /^gpt-[56]/, // gpt-5 / gpt-5.x — a free gateway's gpt-5 is still gpt-5
  /^claude-(opus|sonnet)/,
  /^kimi-k(3|2\.5)/,
  /^qwen3-max/,
  /^qwen-max/,
  /^qwen3-coder/,
  /^deepseek-v4-pro/,
  /^deepseek-r1/,
  /^glm-5/,
  /^gemini-[23]/, // gemini-2.5-pro / gemini-3.x; -flash variants are capped below
];

/**
 * Infer a model's quality tier from its id (and optional configured cost).
 * Order: frontier table → size signal (dense ≥14B or MoE active ≥8B = mid) →
 * catalog/configured cost band → conservative low. Cap keywords clamp to ≤mid.
 */
export function inferQualityTier(modelId: string, inputCostPerM?: number | null): QualityTier {
  // Namespaced ids ("qwen/qwen3-max") match on the bare suffix.
  const id = ((modelId || "").toLowerCase().split("/").pop() ?? "");
  let tier: QualityTier;
  if (FRONTIER_PATTERNS.some((re) => re.test(id))) {
    tier = "high";
  } else {
    // MoE active params first ("35b-a3b" → only 3B active ≈ small-model quality).
    const moe = id.match(/(\d+(?:\.\d+)?)b-a(\d+(?:\.\d+)?)b/);
    const dense = moe ? null : id.match(/(?<![a-z0-9])(\d+(?:\.\d+)?)b(?![a-z])/);
    if (moe) {
      tier = parseFloat(moe[2]) >= 8 ? "mid" : "low";
    } else if (dense) {
      tier = parseFloat(dense[1]) >= 14 ? "mid" : "low";
    } else if (typeof inputCostPerM === "number" && Number.isFinite(inputCostPerM)) {
      // Cost band fallback ($/M input tokens): frontier-priced → high, mid-range → mid.
      tier = inputCostPerM >= 0.5 ? "high" : inputCostPerM >= 0.08 ? "mid" : "low";
    } else {
      tier = "low"; // unknown — conservative; the user can override per pool entry
    }
  }
  if (CAP_KEYWORDS.some((k) => id.includes(k)) && TIER_RANK[tier] > TIER_RANK.mid) return "mid";
  return tier;
}

/* ---------------- passive health tracking ---------------- */

export type ErrorClass = "auth" | "rate_limit" | "server" | "timeout" | "network" | "other";

export interface TurnSample {
  ttftMs?: number;
  totalMs?: number;
  ok: boolean;
  errorClass?: ErrorClass;
  at: number;
}

const HEALTH_WINDOW = 5; // rolling samples per model

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Rolling per-model turn history (shared globally across auto threads). */
export class HealthTracker {
  private samples = new Map<string, TurnSample[]>();

  record(key: string, sample: TurnSample): void {
    const arr = this.samples.get(key) ?? [];
    arr.push(sample);
    while (arr.length > HEALTH_WINDOW) arr.shift();
    this.samples.set(key, arr);
  }

  recent(key: string): TurnSample[] {
    return [...(this.samples.get(key) ?? [])];
  }

  /** Latest known TTFT for the model (for selection tie-breaks). */
  latestTtft(key: string): number | null {
    const arr = this.recent(key);
    for (let i = arr.length - 1; i >= 0; i--) {
      if (typeof arr[i].ttftMs === "number") return arr[i].ttftMs!;
    }
    return null;
  }

  /** The most recent turn errored. */
  isHardFailed(key: string): boolean {
    const arr = this.recent(key);
    return arr.length > 0 && !arr[arr.length - 1].ok;
  }

  /** K consecutive turns with TTFT > factor × median AND > absolute floor. */
  isSoftDegraded(key: string, policy: AutoPolicy): boolean {
    const ttfts = this.recent(key)
      .map((s) => s.ttftMs)
      .filter((v): v is number => typeof v === "number");
    if (ttfts.length < policy.softDegradeStreak + 1) return false; // need a baseline
    const med = median(ttfts);
    if (!med || med <= 0) return false;
    const tail = ttfts.slice(-policy.softDegradeStreak);
    return tail.every((v) => v > policy.softDegradeFactor * med && v > policy.softDegradeMinMs);
  }
}

/** Classify a failed assistant message into an error class. */
export function classifyError(message: { stopReason?: string; errorMessage?: string }): ErrorClass {
  const text = `${message.stopReason ?? ""} ${message.errorMessage ?? ""}`.toLowerCase();
  if (/401|403|unauthorized|forbidden|invalid api key|authentication/i.test(text)) return "auth";
  if (/429|rate.?limit|quota|too many requests/i.test(text)) return "rate_limit";
  if (/timeout|timed out|deadline/i.test(text)) return "timeout";
  if (/econnrefused|enotfound|fetch failed|network|socket|eai_again/i.test(text)) return "network";
  if (/\b5\d\d\b|internal error|overloaded|server error/i.test(text)) return "server";
  return "other";
}

/* ---------------- active probes ---------------- */

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  errorClass?: ErrorClass;
  message?: string;
}

/** Resolve a pi config value ($ENV reference) to a literal key, or null. */
function resolveApiKey(key?: string): string | null {
  if (!key) return null;
  const k = key.trim();
  if (k.startsWith("$")) return process.env[k.slice(1)] || null;
  if (k.startsWith("!")) return null; // !cmd — never executed here
  return k;
}

function classifyStatus(status: number): ErrorClass {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "other";
}

/**
 * Minimal live probe: one tiny completion request against the provider's own
 * endpoint. Best effort — every failure path resolves, never throws.
 */
export async function probeModel(
  provider: ProviderDef,
  model: Pick<ModelDef, "id" | "api" | "baseUrl">,
  timeoutMs = 20_000,
): Promise<ProbeResult> {
  const started = Date.now();
  const fail = (errorClass: ErrorClass, message?: string): ProbeResult => ({
    ok: false,
    latencyMs: Date.now() - started,
    errorClass,
    message,
  });

  const base = (model.baseUrl ?? provider.baseUrl)?.trim();
  if (!base) return fail("other", "no endpoint configured");
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return fail("other", `invalid endpoint ${base}`);
  }
  const origin = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  const api = model.api ?? provider.api ?? "openai-completions";

  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = resolveApiKey(provider.apiKey);
  if (key) {
    if (provider.authHeader === false || api === "anthropic-messages") headers["x-api-key"] = key;
    else headers.authorization = `Bearer ${key}`;
  }

  const pingBody = (extra: Record<string, unknown> = {}) => ({ model: model.id, ...extra });
  const attempts: Array<{ url: string; body: Record<string, unknown>; extra?: Record<string, string> }> = [];
  if (api === "openai-completions") {
    attempts.push({
      url: `${origin}/chat/completions`,
      body: pingBody({ messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
    });
  } else if (api === "openai-responses") {
    attempts.push({ url: `${origin}/responses`, body: pingBody({ input: "ping", max_output_tokens: 1 }) });
    // Some gateways expose the responses API but not /responses — fall back.
    attempts.push({
      url: `${origin}/chat/completions`,
      body: pingBody({ messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
    });
  } else if (api === "anthropic-messages") {
    attempts.push({
      url: `${origin}/messages`,
      body: pingBody({ max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
      extra: { "anthropic-version": "2023-06-01" },
    });
  } else if (api === "google-generative-ai") {
    attempts.push({
      url: `${origin}/models/${encodeURIComponent(model.id)}:generateContent`,
      body: { contents: [{ parts: [{ text: "ping" }] }], generationConfig: { maxOutputTokens: 1 } },
    });
  } else {
    return fail("other", `unsupported api type ${api}`);
  }

  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(a.url, {
        method: "POST",
        signal: ctrl.signal,
        headers: { ...headers, ...(a.extra ?? {}) },
        body: JSON.stringify(a.body),
      });
      clearTimeout(timer);
      if (res.ok) return { ok: true, latencyMs: Date.now() - started };
      const status = res.status;
      // 404/405 on a fallback-capable endpoint → try the next one.
      if ((status === 404 || status === 405) && i < attempts.length - 1) continue;
      return fail(classifyStatus(status), `HTTP ${status}`);
    } catch (e: any) {
      clearTimeout(timer);
      if (ctrl.signal.aborted) return fail("timeout", "probe timed out");
      return fail("network", e?.message || String(e));
    }
  }
  return fail("other", "all endpoints failed");
}

/* ---------------- selection rule ---------------- */

export interface CandidateInfo {
  provider: string;
  modelId: string;
  paid: boolean;
  tier: QualityTier;
  healthy: boolean;
  recentTtftMs?: number | null;
  poolIndex: number;
}

export type SelectionReason = "none" | "switch" | "rescue";

export interface SelectionResult {
  pick: CandidateInfo | null;
  reason: SelectionReason;
  /** The picked model is a billed endpoint (toast must say so). */
  usedPaid: boolean;
}

function sortCandidates(list: CandidateInfo[]): CandidateInfo[] {
  return [...list].sort(
    (a, b) =>
      TIER_RANK[b.tier] - TIER_RANK[a.tier] ||
      (a.recentTtftMs ?? Infinity) - (b.recentTtftMs ?? Infinity) ||
      a.poolIndex - b.poolIndex,
  );
}

/**
 * Free-first selection with the tier floor:
 * 1. healthy candidates with tier ≥ current → prefer free; within a cost class
 *    by tier desc → recent TTFT asc → pool order.
 * 2. nothing meets the floor but paid ones do → best paid (usedPaid=true).
 * 3. everything is below the floor → rescue downgrade unless strictly forbidden.
 */
export function selectBest(candidates: CandidateInfo[], currentTier: QualityTier, policy: AutoPolicy): SelectionResult {
  const healthy = candidates.filter((c) => c.healthy);
  if (!healthy.length) return { pick: null, reason: "none", usedPaid: false };

  let pool = healthy.filter((c) => TIER_RANK[c.tier] >= TIER_RANK[currentTier]);
  let rescue = false;
  if (!pool.length) {
    if (policy.strictNoDowngrade) return { pick: null, reason: "none", usedPaid: false };
    pool = healthy; // 救急降级 — free still preferred inside
    rescue = true;
  }

  const free = pool.filter((c) => !c.paid);
  const chosenPool = free.length ? free : pool;
  const pick = sortCandidates(chosenPool)[0];
  return { pick, reason: rescue ? "rescue" : "switch", usedPaid: !!pick.paid };
}

/** Recovery comparator: does c strictly beat the current model? */
export function beatsCurrent(c: CandidateInfo, current: { tier: QualityTier; paid: boolean }): boolean {
  if (TIER_RANK[c.tier] > TIER_RANK[current.tier]) return true;
  return TIER_RANK[c.tier] === TIER_RANK[current.tier] && !c.paid && current.paid;
}

/* ---------------- orchestrator ---------------- */

export interface AutoModelCallbacks {
  /** Fresh provider definitions (models.json) for probe/endpoint resolution. */
  getProviders: () => Record<string, ProviderDef>;
  /** Switch a thread's live model (bridge set_model). Throws on failure. */
  setModel: (threadId: string, provider: string, modelId: string) => Promise<void>;
  /** Push switch/warning notifications to the renderer (toast + pill state). */
  notify: (p: {
    threadId: string;
    kind: "switch" | "warn";
    from?: ModelRef;
    to?: ModelRef;
    reason: string; // hard-fail | soft-degrade | recovery | initial | all-unavailable | no-candidates | strict-no-downgrade | switch-failed
    usedPaid?: boolean;
    /** Switched below the current tier (救急降级) — toast must say so. */
    downgraded?: boolean;
  }) => void;
}

interface ThreadAutoState {
  enabled: boolean;
  current: ModelRef;
  /** The model auto mode should return to once it is healthy again (set when
   * auto is enabled / initial resolution picks; NOT updated by failover —
   * that's what makes "LAN box wakes up → switch back to local" work). */
  preferred?: ModelRef;
  msgStartAt?: number;
  firstDeltaSeen?: boolean;
  ttftMs?: number;
  busy?: boolean;
  lastSwitchAt: number;
  lastWarnAt: number;
}

const PROBE_BUDGET_PER_HOUR = 3;
const FAILED_PROBE_RETRY_MS = 60_000;
/** A successful probe stays "fresh" for one recovery interval. */
const SAMPLE_FRESH_MS = 10 * 60_000; // recent live traffic also counts as health evidence

export class ModelAutopilot {
  private pool: PoolEntry[] = [];
  private policy: AutoPolicy = { ...DEFAULT_POLICY };
  private threads = new Map<string, ThreadAutoState>();
  private health = new HealthTracker();
  private probeTimes = new Map<string, number[]>(); // modelKey → timestamps (1h window)
  private probeFreshUntil = new Map<string, number>(); // successful probe freshness
  private failedProbeAt = new Map<string, number>(); // last failed probe per key
  private cb: AutoModelCallbacks;

  constructor(cb: AutoModelCallbacks) {
    this.cb = cb;
  }

  setConfig(pool: PoolEntry[], policy?: Partial<AutoPolicy>): void {
    this.pool = Array.isArray(pool) ? pool : [];
    this.policy = { ...DEFAULT_POLICY, ...(policy ?? {}) };
  }

  get config(): { pool: PoolEntry[]; policy: AutoPolicy } {
    return { pool: [...this.pool], policy: { ...this.policy } };
  }

  keyOf(m: ModelRef): string {
    return `${m.provider}\u0000${m.id}`;
  }

  isAuto(threadId: string): boolean {
    return !!this.threads.get(threadId)?.enabled;
  }

  /** Any thread currently in auto mode (gates the recovery timer). */
  hasActiveThreads(): boolean {
    for (const st of this.threads.values()) if (st.enabled) return true;
    return false;
  }

  /** Current effective model of an auto thread (for UI snapshots). */
  currentModel(threadId: string): ModelRef | null {
    const st = this.threads.get(threadId);
    return st?.enabled ? { ...st.current } : null;
  }

  /** Enable/disable auto mode for a thread. Exiting stops monitoring entirely. */
  setAuto(threadId: string, enabled: boolean, current: ModelRef): void {
    const existing = this.threads.get(threadId);
    if (enabled) {
      // Preferred = what the user had selected when auto turned on; recovery
      // switches back to it once healthy (approved plan: “探测成功 → 切回”).
      if (existing) Object.assign(existing, { enabled: true, current, preferred: { ...current } });
      else this.threads.set(threadId, { enabled: true, current, preferred: { ...current }, lastSwitchAt: 0, lastWarnAt: 0 });
    } else if (existing) {
      existing.enabled = false; // 自动停止监测 — no further signals or probes for this thread
    }
  }

  /** Thread id changed (boot:uuid → session file): migrate state. */
  migrateThread(oldId: string, newId: string): void {
    const st = this.threads.get(oldId);
    if (!st) return;
    this.threads.delete(oldId);
    this.threads.set(newId, st);
  }

  onThreadClosed(threadId: string): void {
    this.threads.delete(threadId);
  }

  /**
   * New session with auto enabled (messageCount === 0): pick the best healthy
   * free model and set it explicitly — also fixes the "new session starts on
   * drifted pi global default" quirk for auto threads.
   */
  async resolveInitial(threadId: string, current: ModelRef): Promise<ModelRef | null> {
    this.setAuto(threadId, true, current);
    const cands = await this.candidateInfos(null, true);
    if (!cands.length) return null;
    // No tier floor at init — best healthy free wins (free-first per design).
    const res = selectBest(cands, "low", this.policy);
    if (!res.pick || (res.pick.provider === current.provider && res.pick.modelId === current.id)) return null;
    await this.applySwitch(threadId, res.pick, "initial", res.usedPaid);
    // The resolved model becomes the new preferred target for recovery.
    const st = this.threads.get(threadId);
    if (st) st.preferred = { provider: res.pick.provider, id: res.pick.modelId };
    return { provider: res.pick.provider, id: res.pick.modelId };
  }

  /** Event ingestion — only ever called for auto threads (zero overhead otherwise). */
  onAgentEvent(threadId: string, event: any): void {
    const st = this.threads.get(threadId);
    if (!st?.enabled) return;
    const key = this.keyOf(st.current);

    if (event?.type === "message_start" && event.message?.role === "assistant") {
      st.msgStartAt = Date.now();
      st.firstDeltaSeen = false;
      st.ttftMs = undefined;
    } else if (event?.type === "message_update") {
      const upd = event.assistantMessageEvent;
      if ((upd?.type === "text_delta" || upd?.type === "thinking_delta") && upd.delta && !st.firstDeltaSeen && st.msgStartAt) {
        st.firstDeltaSeen = true;
        st.ttftMs = Date.now() - st.msgStartAt;
      }
    } else if (event?.type === "message_end" && event.message?.role === "assistant") {
      const msg = event.message;
      const ok = msg.stopReason !== "error" && msg.stopReason !== "aborted";
      this.health.record(key, {
        ttftMs: st.ttftMs,
        totalMs: st.msgStartAt ? Date.now() - st.msgStartAt : undefined,
        ok,
        errorClass: ok ? undefined : classifyError(msg),
        at: Date.now(),
      });
      st.ttftMs = undefined;
      // Decide only between turns — never mid-stream.
      void this.evaluate(threadId);
    }
  }

  /* ---------------- internals ---------------- */

  private tierOf(ref: ModelRef): QualityTier {
    const entry = this.pool.find((e) => e.provider === ref.provider && e.modelId === ref.id);
    if (entry?.tierOverride) return entry.tierOverride;
    const cost = this.inputCostFor(ref);
    return inferQualityTier(ref.id, cost);
  }

  private isPoolPaid(ref: ModelRef): boolean {
    // Models outside the pool have unknown billing — treat as free so recovery
    // only ever upgrades to strictly higher tiers (conservative).
    const entry = this.pool.find((e) => e.provider === ref.provider && e.modelId === ref.id);
    return !!entry?.paid;
  }

  private inputCostFor(ref: ModelRef): number | null {
    try {
      const provider = this.cb.getProviders()[ref.provider];
      const model = (provider?.models ?? []).find((m) => m.id === ref.id);
      const cost = (model as any)?.cost;
      return typeof cost?.input === "number" ? cost.input : null;
    } catch {
      return null;
    }
  }

  private probeAllowed(key: string): boolean {
    const now = Date.now();
    const arr = (this.probeTimes.get(key) ?? []).filter((t) => now - t < 3_600_000);
    this.probeTimes.set(key, arr);
    return arr.length < PROBE_BUDGET_PER_HOUR;
  }

  private noteProbe(key: string): void {
    const now = Date.now();
    const arr = (this.probeTimes.get(key) ?? []).filter((t) => now - t < 3_600_000);
    arr.push(now);
    this.probeTimes.set(key, arr);
  }

  /** Is the model's health evidence fresh enough to trust without probing? */
  private isFreshlyHealthy(key: string): boolean {
    const now = Date.now();
    if ((this.probeFreshUntil.get(key) ?? 0) > now) return true;
    const recent = this.health.recent(key);
    for (let i = recent.length - 1; i >= 0; i--) {
      const s = recent[i];
      if (now - s.at < SAMPLE_FRESH_MS) return s.ok; // latest fresh sample decides
    }
    return false;
  }

  /** Build candidate infos for the pool, optionally verifying via probes. */
  private async candidateInfos(excludeKey: string | null, verify: boolean): Promise<CandidateInfo[]> {
    const now = Date.now();
    let providers: Record<string, ProviderDef> = {};
    try {
      providers = this.cb.getProviders() ?? {};
    } catch {
      return [];
    }

    // Pass 1 (sync): classify each entry; fire every needed probe CONCURRENTLY
    // so a dead endpoint costs one timeout (~20s), not pool-size × timeout.
    const items: Array<{
      entry: PoolEntry;
      i: number;
      key: string;
      healthy?: boolean;
      probe?: Promise<ProbeResult>;
    }> = [];
    for (let i = 0; i < this.pool.length; i++) {
      const entry = this.pool[i];
      const provider = providers[entry.provider];
      if (!provider) continue; // provider removed from models.json — skip
      const key = `${entry.provider}\u0000${entry.modelId}`;
      if (excludeKey && key === excludeKey) continue;

      let healthy: boolean | undefined;
      if ((this.failedProbeAt.get(key) ?? 0) + FAILED_PROBE_RETRY_MS > now) {
        // Recently failed probe — but a fresh live success still counts.
        const recent = this.health.recent(key);
        const freshOk = recent.some((s) => s.ok && now - s.at < SAMPLE_FRESH_MS);
        healthy = freshOk;
      } else if (this.isFreshlyHealthy(key)) {
        healthy = true;
      } else if (!verify) {
        healthy = false; // unverified and not asked to verify — conservative
      } else if (!this.probeAllowed(key)) {
        healthy = false; // budget exhausted — don't switch onto an unverified model
      }

      const item: (typeof items)[number] = { entry, i, key, healthy };
      if (healthy === undefined) {
        this.noteProbe(key);
        const modelDef = (provider.models ?? []).find((m) => m.id === entry.modelId);
        item.probe = probeModel(provider, { id: entry.modelId, api: modelDef?.api, baseUrl: modelDef?.baseUrl });
      }
      items.push(item);
    }

    // Pass 2: await all probes together, then assemble in pool order.
    const results = await Promise.all(items.map((it) => it.probe ?? null));
    const out: CandidateInfo[] = [];
    for (let n = 0; n < items.length; n++) {
      const item = items[n];
      let healthy: boolean;
      if (item.healthy !== undefined) {
        healthy = item.healthy;
      } else {
        const res = results[n] as ProbeResult;
        if (res.ok) this.probeFreshUntil.set(item.key, now + Math.max(this.policy.recoveryIntervalMin, 1) * 60_000);
        else this.failedProbeAt.set(item.key, now);
        healthy = res.ok;
      }
      out.push({
        provider: item.entry.provider,
        modelId: item.entry.modelId,
        paid: !!item.entry.paid,
        tier:
          item.entry.tierOverride ??
          inferQualityTier(item.entry.modelId, this.inputCostFor({ provider: item.entry.provider, id: item.entry.modelId })),
        healthy,
        recentTtftMs: this.health.latestTtft(item.key),
        poolIndex: item.i,
      });
    }
    return out;
  }

  private async evaluate(threadId: string): Promise<void> {
    const st = this.threads.get(threadId);
    if (!st?.enabled || st.busy) return;
    const key = this.keyOf(st.current);
    const hard = this.health.isHardFailed(key);
    const soft = !hard && this.health.isSoftDegraded(key, this.policy);
    if (!hard && !soft) return;

    // Cooldown gates re-switching after a previous auto switch (anti-flap).
    // The very first failover of an auto session is never delayed by it.
    const cooldownMs = this.policy.cooldownMin * 60_000;
    if (st.lastSwitchAt > 0 && Date.now() - st.lastSwitchAt < cooldownMs) return;

    st.busy = true;
    try {
      await this.failover(threadId, hard ? "hard-fail" : "soft-degrade");
    } finally {
      st.busy = false;
    }
  }

  private async failover(threadId: string, reason: string): Promise<void> {
    const st = this.threads.get(threadId);
    if (!st?.enabled) return;
    const curKey = this.keyOf(st.current);
    const cands = await this.candidateInfos(curKey, true);
    if (!cands.length) {
      this.warn(threadId, "no-candidates");
      return;
    }
    const res = selectBest(cands, this.tierOf(st.current), this.policy);
    if (!res.pick) {
      this.warn(threadId, cands.some((c) => !c.healthy) ? "all-unavailable" : "strict-no-downgrade");
      return;
    }
    await this.applySwitch(
      threadId,
      res.pick,
      reason === "hard-fail" ? "hard-fail" : "soft-degrade",
      res.usedPaid,
      res.reason === "rescue",
    );
  }

  /** Periodic recovery: return to the thread's preferred model once it is
   * healthy again (e.g. local box wakes up after a failover to cloud); else
   * switch up when a strictly better model is healthy. */
  async recoveryTick(): Promise<void> {
    const cooldownMs = this.policy.cooldownMin * 60_000;
    for (const [threadId, st] of [...this.threads]) {
      if (!st.enabled || st.busy) continue;
      if (Date.now() - st.lastSwitchAt < cooldownMs) continue; // anti-flap both directions
      const curKey = this.keyOf(st.current);
      let cands: CandidateInfo[];
      try {
        cands = await this.candidateInfos(curKey, true);
      } catch {
        continue;
      }
      const pref = st.preferred;
      const onPreferred = !pref || (pref.provider === st.current.provider && pref.id === st.current.id);
      if (onPreferred) continue; // home is where auto mode wants to be — only
                                  // failover (evaluate) ever leaves it, so no
                                  // upward pressure while on preferred (that
                                  // would ping-pong with the switch-back below).
      // 1) Switch back to preferred when it's healthy.
      const pc = cands.find((c) => c.provider === pref!.provider && c.modelId === pref!.id);
      if (pc?.healthy) {
        await this.applySwitch(threadId, pc, "recovery", !!pc.paid);
        continue;
      }
      // 2) Still away from home: switch up to a strictly better healthy candidate.
      const current = { tier: this.tierOf(st.current), paid: this.isPoolPaid(st.current) };
      const better = cands.filter((c) => c.healthy && beatsCurrent(c, current));
      if (!better.length) continue;
      await this.applySwitch(threadId, sortCandidates(better)[0], "recovery", !!sortCandidates(better)[0].paid);
    }
  }

  private async applySwitch(
    threadId: string,
    pick: CandidateInfo,
    reason: string,
    usedPaid: boolean,
    downgraded = false,
  ): Promise<void> {
    const st = this.threads.get(threadId);
    if (!st?.enabled) return;
    const from = { ...st.current };
    try {
      await this.cb.setModel(threadId, pick.provider, pick.modelId);
    } catch (e: any) {
      this.warn(threadId, "switch-failed");
      console.error(`[autopilot] set_model failed for ${threadId}:`, e?.message || e);
      return;
    }
    st.current = { provider: pick.provider, id: pick.modelId };
    st.lastSwitchAt = Date.now();
    this.cb.notify({ threadId, kind: "switch", from, to: { ...st.current }, reason, usedPaid, downgraded });
  }

  private warn(threadId: string, reason: string): void {
    const st = this.threads.get(threadId);
    if (!st?.enabled) return;
    // Throttle: one warning per thread per recovery interval.
    if (Date.now() - st.lastWarnAt < Math.max(this.policy.recoveryIntervalMin, 1) * 60_000) return;
    st.lastWarnAt = Date.now();
    this.cb.notify({ threadId, kind: "warn", reason });
  }
}
