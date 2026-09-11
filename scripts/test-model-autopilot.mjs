import assert from "node:assert/strict";
import { register } from "node:module";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const {
  inferQualityTier,
  HealthTracker,
  classifyError,
  probeModel,
  selectBest,
  beatsCurrent,
  ModelAutopilot,
  DEFAULT_POLICY,
} = await import("../src/main/model-autopilot.ts");

let passed = 0;
const ok = (label) => {
  passed++;
  console.log(`  ✓ ${label}`);
};

/* ---------------- tier inference ---------------- */
{
  // Frontier table → high.
  for (const id of ["gpt-5", "openai/gpt-5", "claude-opus-4", "kimi-k3", "qwen/qwen3-max", "deepseek-v4-pro", "glm-5.3", "gemini-2.5-pro"]) {
    assert.equal(inferQualityTier(id), "high", `${id} should be high`);
  }
  ok("frontier table → high (incl. namespaced ids)");

  // Cap keywords clamp to ≤ mid.
  assert.equal(inferQualityTier("gpt-5-flash"), "mid");
  assert.equal(inferQualityTier("gemini-2.5-flash"), "mid");
  ok("-flash/-mini cap → at most mid");

  // Size signals: dense ≥14B = mid, <14B = low; MoE active <8B = low.
  assert.equal(inferQualityTier("qwen3.8-27b@q5_k_m"), "mid", "local 27B dense → mid (the user's baseline)");
  assert.equal(inferQualityTier("mistral-small-24b"), "mid");
  assert.equal(inferQualityTier("llama-3.1-8b-instruct"), "low");
  assert.equal(inferQualityTier("qwen3.6-35b-a3b@q4_k_s"), "low", "MoE with only 3B active → low");
  ok("size signals: dense ≥14B mid, <14B low, MoE active <8B low");

  // Cost band fallback + conservative default.
  assert.equal(inferQualityTier("mystery-model", 0.6), "high");
  assert.equal(inferQualityTier("deepseek-v4-flash", 0.14), "mid");
  assert.equal(inferQualityTier("tiny-free-thing", 0.01), "low");
  assert.equal(inferQualityTier("unknown-model-no-cost"), "low", "undeterminable → conservative low");
  ok("cost band fallback; unknown → low (overridable in pool editor)");
}

/* ---------------- health tracker ---------------- */
{
  const h = new HealthTracker();
  const p = { ...DEFAULT_POLICY }; // factor 3, minMs 15000, streak 2

  assert.equal(h.isHardFailed("m"), false);
  assert.equal(h.isSoftDegraded("m", p), false);
  h.record("m", { ttftMs: 3000, ok: true, at: 1 });
  h.record("m", { ttftMs: 3200, ok: true, at: 2 });
  assert.equal(h.isSoftDegraded("m", p), false, "need streak+1 samples for a baseline");
  h.record("m", { ttftMs: 3100, ok: true, at: 3 });
  assert.equal(h.isSoftDegraded("m", p), false);
  h.record("m", { ttftMs: 20_000, ok: true, at: 4 }); // >3×median(≈3.1s) and >15s
  assert.equal(h.isSoftDegraded("m", p), false, "only one slow turn yet (streak=2)");
  h.record("m", { ttftMs: 25_000, ok: true, at: 5 });
  assert.equal(h.isSoftDegraded("m", p), true, "two consecutive turns >3×median and >15s → degraded");
  ok("soft degradation: dual condition (relative + absolute) over a streak");

  // Absolute floor alone is not enough when the model is naturally slow.
  const h2 = new HealthTracker();
  for (const v of [40_000, 41_000, 40_500]) h2.record("slow", { ttftMs: v, ok: true, at: v });
  assert.equal(h2.isSoftDegraded("slow", p), false, "consistently slow model is not 'degraded' (no relative jump)");
  ok("naturally-slow model does not trigger soft degradation");

  // Hard failure + window cap.
  const h3 = new HealthTracker();
  for (let i = 0; i < 7; i++) h3.record("x", { ttftMs: 1000, ok: true, at: i });
  assert.equal(h3.recent("x").length, 5, "rolling window keeps last 5");
  h3.record("x", { ok: false, errorClass: "network", at: 99 });
  assert.equal(h3.isHardFailed("x"), true);
  ok("hard failure detection + rolling window cap");

  // Error classification.
  assert.equal(classifyError({ stopReason: "error", errorMessage: "HTTP 401 invalid api key" }), "auth");
  assert.equal(classifyError({ stopReason: "error", errorMessage: "429 rate limit exceeded" }), "rate_limit");
  assert.equal(classifyError({ stopReason: "error", errorMessage: "request timed out after 60s" }), "timeout");
  assert.equal(classifyError({ stopReason: "error", errorMessage: "fetch failed ECONNREFUSED" }), "network");
  assert.equal(classifyError({ stopReason: "error", errorMessage: "HTTP 529 overloaded" }), "server");
  ok("error classification (401/429/timeout/network/5xx)");
}

/* ---------------- selection rule ---------------- */
{
  const p = { ...DEFAULT_POLICY };
  const C = (over = {}) => ({ provider: "p", modelId: "m", paid: false, tier: "mid", healthy: true, recentTtftMs: null, poolIndex: 0, ...over });

  // Free first — even when a higher-tier paid candidate exists.
  let res = selectBest([C({ provider: "paid", modelId: "gpt-5", tier: "high", paid: true }), C({ provider: "free", modelId: "qwen3-max" })], "mid", p);
  assert.equal(res.pick?.modelId, "qwen3-max");
  assert.equal(res.usedPaid, false);
  ok("free preferred over higher-tier paid (user rule)");

  // No free meets the floor → best paid + usedPaid flag.
  res = selectBest([C({ provider: "paid", modelId: "gpt-5", tier: "high", paid: true })], "mid", p);
  assert.equal(res.pick?.modelId, "gpt-5");
  assert.equal(res.usedPaid, true);
  ok("paid fallback with usedPaid flag when no free meets the floor");

  // Tier floor blocks downgrades; rescue unless strictly forbidden.
  res = selectBest([C({ tier: "low" })], "mid", p);
  assert.equal(res.pick?.tier, "low");
  assert.equal(res.reason, "rescue");
  const strict = { ...p, strictNoDowngrade: true };
  res = selectBest([C({ tier: "low" })], "mid", strict);
  assert.equal(res.pick, null);
  ok("tier floor + rescue downgrade (or strict forbid)");

  // All unhealthy → nothing.
  res = selectBest([C({ healthy: false }), C({ tier: "high", healthy: false })], "low", p);
  assert.equal(res.pick, null);
  ok("no healthy candidate → no switch");

  // Same tier + cost class: lower recent TTFT wins, then pool order.
  res = selectBest([C({ modelId: "slow", recentTtftMs: 20_000, poolIndex: 1 }), C({ modelId: "fast", recentTtftMs: 5_000, poolIndex: 3 })], "mid", p);
  assert.equal(res.pick?.modelId, "fast");
  res = selectBest([C({ modelId: "a", poolIndex: 1 }), C({ modelId: "b", poolIndex: 2 })], "mid", p);
  assert.equal(res.pick?.modelId, "a");
  ok("tie-breaks: TTFT asc → pool order");

  // beatsCurrent for recovery.
  const cur = { tier: "mid", paid: false };
  assert.equal(beatsCurrent(C({ tier: "high" }), cur), true);
  assert.equal(beatsCurrent(C({ tier: "mid" }), cur), false, "equal free model is not 'better'");
  const curPaid = { tier: "mid", paid: true };
  assert.equal(beatsCurrent(C({ tier: "mid" }), curPaid), true, "same-tier free beats current paid");
  ok("recovery comparator (higher tier / same-tier free-over-paid)");
}

/* ---------------- probeModel (fetch stubbed) ---------------- */
const realFetch = globalThis.fetch;
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {}, body: init?.body });
    return handler(String(url), init);
  };
  return calls;
}
const jsonRes = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

{
  // openai-completions success + Bearer auth.
  const calls = stubFetch(() => jsonRes({ choices: [] }));
  const res = await probeModel({ baseUrl: "https://api.example.com/v1", apiKey: "sk-test" }, { id: "m1" });
  assert.equal(res.ok, true);
  assert.match(calls[0].url, /\/v1\/chat\/completions$/);
  assert.equal(calls[0].headers.authorization, "Bearer sk-test");
  ok("openai-completions probe: endpoint + auth header");

  // $ENV key reference resolved from the environment.
  process.env.MPI_TEST_KEY = "env-key-value";
  const calls2 = stubFetch(() => jsonRes({ choices: [] }));
  await probeModel({ baseUrl: "https://api.example.com/v1", apiKey: "$MPI_TEST_KEY" }, { id: "m1" });
  assert.equal(calls2[0].headers.authorization, "Bearer env-key-value");
  delete process.env.MPI_TEST_KEY;
  ok("$ENV key reference resolved (never sent as literal)");

  // Error classification by status.
  stubFetch(() => jsonRes({}, 429));
  assert.equal((await probeModel({ baseUrl: "https://api.example.com/v1" }, { id: "m1" })).errorClass, "rate_limit");
  stubFetch(() => jsonRes({}, 503));
  assert.equal((await probeModel({ baseUrl: "https://api.example.com/v1" }, { id: "m1" })).errorClass, "server");
  ok("429 → rate_limit, 5xx → server");

  // anthropic-messages: x-api-key + version header on /messages.
  const calls3 = stubFetch(() => jsonRes({ content: [] }));
  await probeModel(
    { baseUrl: "https://api.anthropic.com/v1", apiKey: "sk-ant" },
    { id: "claude-opus-4", api: "anthropic-messages" },
  );
  assert.match(calls3[0].url, /\/v1\/messages$/);
  assert.equal(calls3[0].headers["x-api-key"], "sk-ant");
  assert.ok(calls3[0].headers["anthropic-version"]);
  ok("anthropic-messages probe: x-api-key + anthropic-version");

  // openai-responses: /responses 404 → falls back to /chat/completions.
  const calls4 = stubFetch((url) => (url.endsWith("/responses") ? jsonRes({}, 404) : jsonRes({ choices: [] })));
  const resR = await probeModel(
    { baseUrl: "https://api.openai.com/v1" },
    { id: "gpt-5", api: "openai-responses" },
  );
  assert.equal(resR.ok, true);
  assert.equal(calls4.length, 2);
  ok("openai-responses probe falls back to /chat/completions on 404");

  // Network failure → network class, never throws.
  stubFetch(() => Promise.reject(new Error("fetch failed ECONNREFUSED")));
  const resN = await probeModel({ baseUrl: "http://192.168.1.50:1234/v1" }, { id: "local-model" });
  assert.equal(resN.ok, false);
  assert.equal(resN.errorClass, "network");
  ok("network failure → network class (no throw)");

  globalThis.fetch = realFetch;
}

/* ---------------- orchestrator ---------------- */
{
  const providers = {
    local: { baseUrl: "http://192.168.1.50:1234/v1", models: [{ id: "qwen3.8-27b@q5_k_m" }] },
    cloud: { baseUrl: "https://api.example.com/v1", apiKey: "sk-x", models: [{ id: "gpt-5" }] },
  };

  function makePilot(pool, policyPatch = {}) {
    const events = [];
    const setModelCalls = [];
    const pilot = new ModelAutopilot({
      getProviders: () => providers,
      setModel: async (threadId, provider, modelId) => {
        setModelCalls.push({ threadId, provider, modelId });
      },
      notify: (p) => events.push(p),
    });
    pilot.setConfig(pool, policyPatch);
    return { pilot, events, setModelCalls };
  }

  const failTurn = (threadId, errorClass = "network") => {
    // message_end with stopReason=error is what marks a hard failure.
    pilotRef.onAgentEvent(threadId, { type: "message_start", message: { role: "assistant" } });
    pilotRef.onAgentEvent(threadId, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
    pilotRef.onAgentEvent(threadId, { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: errorClass === "network" ? "fetch failed ECONNREFUSED" : `HTTP 429 ${errorClass}` } });
  };

  // --- hard failover to the healthy free candidate -------------------------
  let pilotRef;
  {
    const { pilot, events, setModelCalls } = makePilot([
      { provider: "local", modelId: "qwen3.8-27b@q5_k_m" }, // mid (27B dense), free — current
      { provider: "cloud", modelId: "gpt-5" }, // high, free
    ]);
    pilotRef = pilot;
    stubFetch(() => jsonRes({ choices: [] })); // cloud probe ok

    pilot.setAuto("t1", true, { provider: "local", id: "qwen3.8-27b@q5_k_m" });
    assert.equal(pilot.isAuto("t1"), true);
    failTurn("t1");
    await new Promise((r) => setTimeout(r, 20)); // let evaluate() run

    assert.deepEqual(setModelCalls[0], { threadId: "t1", provider: "cloud", modelId: "gpt-5" });
    assert.equal(events[0]?.kind, "switch");
    assert.equal(events[0]?.reason, "hard-fail");
    assert.equal(events[0]?.usedPaid, false);
    ok("hard failure → failover to healthy free candidate + switch notify");

    // --- cooldown: immediate second failure must not re-switch -------------
    pilotRef.onAgentEvent("t1", { type: "message_start", message: { role: "assistant" } });
    pilotRef.onAgentEvent("t1", { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "x" } });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(setModelCalls.length, 1, "cooldown blocks immediate re-switch");
    ok("cooldown prevents flapping right after a switch");

    // --- non-auto threads pay zero overhead ---------------------------------
    pilot.setAuto("t2", true, { provider: "local", id: "qwen3.8-27b@q5_k_m" });
    pilot.setAuto("t2", false, { provider: "cloud", id: "gpt-5" }); // exit auto → monitoring stops
    const fetchCalls = stubFetch(() => jsonRes({ choices: [] }));
    pilot.onAgentEvent("t2", { type: "message_start", message: { role: "assistant" } });
    pilot.onAgentEvent("t2", { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "boom" } });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(fetchCalls.length, 0, "exited-auto thread triggers no probes");
    ok("non-auto / exited-auto threads: zero monitoring overhead");

    // --- free-first failover (paid higher tier must NOT win) ---------------
    const { pilot: p2, setModelCalls: s2 } = makePilot([
      { provider: "cloud", modelId: "gpt-5", paid: true }, // high but PAID
      { provider: "local", modelId: "qwen3.8-27b@q5_k_m" }, // mid free — current
    ]);
    pilotRef = p2;
    stubFetch(() => jsonRes({ choices: [] }));
    p2.setAuto("t3", true, { provider: "local", id: "qwen3.8-27b@q5_k_m" });
    // Local fails; only candidate is paid-high → usedPaid toast expected.
    failTurn("t3");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(s2[0], { threadId: "t3", provider: "cloud", modelId: "gpt-5" });
    ok("paid candidate used when it is the only one meeting the floor");

    // --- strict no-downgrade ------------------------------------------------
    const { pilot: p3, setModelCalls: s3, events: e3 } = makePilot(
      [{ provider: "local", modelId: "tiny-7b" }], // low — below current mid floor
      { strictNoDowngrade: true },
    );
    pilotRef = p3;
    stubFetch(() => jsonRes({ choices: [] }));
    p3.setAuto("t4", true, { provider: "local", id: "qwen3.8-27b@q5_k_m" });
    failTurn("t4");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(s3.length, 0, "strict mode never downgrades");
    assert.ok(e3.some((e) => e.kind === "warn"));
    ok("strictNoDowngrade: no switch + warning");

    // --- rescue downgrade (default) with warning ----------------------------
    const { pilot: p4, setModelCalls: s4, events: e4 } = makePilot([
      { provider: "local", modelId: "tiny-7b" }, // low free — below floor
    ]);
    pilotRef = p4;
    stubFetch(() => jsonRes({ choices: [] }));
    p4.setAuto("t5", true, { provider: "local", id: "qwen3.8-27b@q5_k_m" });
    failTurn("t5");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(s4[0], { threadId: "t5", provider: "local", modelId: "tiny-7b" });
    assert.equal(e4.find((e) => e.kind === "switch")?.reason, "hard-fail");
    ok("rescue downgrade allowed by default (救急) with switch notify");

    // --- initial selection for a new session --------------------------------
    const { pilot: p5, setModelCalls: s5 } = makePilot([
      { provider: "local", modelId: "qwen3.8-27b@q5_k_m" }, // mid free
      { provider: "cloud", modelId: "gpt-5" }, // high free
    ]);
    stubFetch(() => jsonRes({ choices: [] }));
    const initial = await p5.resolveInitial("t6", { provider: "drifted", id: "whatever" });
    assert.deepEqual(initial, { provider: "cloud", id: "gpt-5" }, "best healthy free wins at init");
    assert.equal(s5.length, 1);
    ok("new session (messageCount=0): explicit setModel to best healthy free");

    // --- failed probes are not hammered: retry gate + hourly budget ---------
    const { pilot: p6 } = makePilot([
      { provider: "cloud", modelId: "gpt-5" },
      { provider: "local", modelId: "qwen3.8-27b@q5_k_m" },
    ]);
    const budgetCalls = stubFetch(() => jsonRes({}, 500)); // all probes fail
    p6.setAuto("t7", true, { provider: "drifted", id: "x" });
    await p6.resolveInitial("t7", { provider: "drifted", id: "x" }); // probes both models once (2 calls)
    await p6.resolveInitial("t7", { provider: "drifted", id: "y" }); // failed probes gated for 60s → no new calls
    assert.equal(budgetCalls.length, 2, "failed probes are not retried within the retry window");
    ok("probe throttling: one probe per model per decision round (budget + retry gate)");

    // --- recovery: switch BACK to preferred once it is healthy again --------
    {
      const { pilot: p7, setModelCalls: s7, events: e7 } = makePilot(
        [
          { provider: "local", modelId: "qwen3.8-27b@q5_k_m" }, // mid free — current + preferred
          { provider: "cloud", modelId: "gpt-5" }, // high free
        ],
        { cooldownMin: 0 }, // no anti-flap wait in this test
      );
      stubFetch(() => jsonRes({ choices: [] })); // every probe succeeds (local is up)
      p7.setAuto("t8", true, { provider: "local", id: "qwen3.8-27b@q5_k_m" });

      pilotRef = p7;
      failTurn("t8"); // local hard-fails → failover to cloud-high
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(s7[0], { threadId: "t8", provider: "cloud", modelId: "gpt-5" });

      // Local is healthy again (probe ok) → recovery returns to preferred,
      // even though it is a LOWER tier than the current cloud model.
      await p7.recoveryTick();
      assert.deepEqual(s7[s7.length - 1], { threadId: "t8", provider: "local", modelId: "qwen3.8-27b@q5_k_m" });
      const rec = e7.filter((e) => e.reason === "recovery");
      assert.equal(rec.length, 1);
      assert.equal(rec[0].kind, "switch");
      ok("recovery: switches back to preferred (original) model once healthy — even from a higher tier");

      // Already on preferred → no-op.
      const before = s7.length;
      await p7.recoveryTick();
      assert.equal(s7.length, before, "no switch while already on preferred");
      ok("recovery: no-op while already on the preferred model");
    }

    globalThis.fetch = realFetch;
  }
}

console.log(`\nmodel-autopilot: ${passed} groups passed`);
