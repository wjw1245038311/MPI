import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const {
  findCatalogDataDir,
  loadCatalogIndex,
  lookupContextInMap,
  probeApiContext,
  resolveModelContext,
  autoResolveContextWindows,
} = await import("../src/main/model-context.ts");

const dir = mkdtempSync(join(tmpdir(), "mpi-model-ctx-"));
let passed = 0;
const ok = (label) => {
  passed++;
  console.log(`  ✓ ${label}`);
};

/* ---------------- findCatalogDataDir ---------------- */
{
  // Packaged layout: <root>/pi/dist/cli.js + <root>/pi/node_modules/...
  const root = join(dir, "packaged");
  const dataA = join(root, "pi", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data");
  mkdirSync(dataA, { recursive: true });
  writeFileSync(join(dataA, "x.json"), "{}");
  ok("packaged layout resolves data dir");
  assert.equal(findCatalogDataDir(join(root, "pi", "dist", "cli.js")), dataA);

  // npm-global layout: .../@earendil-works/pi-coding-agent/dist/cli.js + sibling pi-ai
  const nm = join(dir, "npm", "node_modules", "@earendil-works");
  const dataB = join(nm, "pi-ai", "dist", "providers", "data");
  mkdirSync(dataB, { recursive: true });
  writeFileSync(join(dataB, "x.json"), "{}");
  ok("npm-global layout resolves sibling pi-ai data dir");
  assert.equal(findCatalogDataDir(join(nm, "pi-coding-agent", "dist", "cli.js")), dataB);

  assert.equal(findCatalogDataDir(null), null);
  assert.equal(findCatalogDataDir(join(dir, "nope", "cli.js")), null);
  ok("missing runtime → null");
}

/* ---------------- catalog index + matching ---------------- */
{
  const data = join(dir, "catalog");
  mkdirSync(data, { recursive: true });
  writeFileSync(
    join(data, "openrouter.json"),
    JSON.stringify({ openrouter: { "qwen/qwen3-max": { contextWindow: 262144 }, "moonshotai/kimi-k3": { contextWindow: 1048576 } } }),
  );
  writeFileSync(
    join(data, "deepseek.json"),
    JSON.stringify({ "openai-completions": { "deepseek-v4-flash": { contextWindow: 256000 }, broken: { contextWindow: -1 } } }),
  );
  const map = loadCatalogIndex(data);
  assert.equal(map.get("qwen/qwen3-max"), 262144, "full namespaced key");
  assert.equal(lookupContextInMap(map, "qwen3-max"), 262144, "suffix after / matches bare user id");
  assert.equal(lookupContextInMap(map, "kimi-k3"), 1048576);
  assert.equal(lookupContextInMap(map, "deepseek-v4-flash"), 256000, "bare key indexed directly");
  assert.equal(lookupContextInMap(map, "broken"), undefined, "non-positive contextWindow skipped");
  assert.equal(lookupContextInMap(map, "no-such-model"), undefined);
  ok("index: full keys + / suffixes + bare ids; invalid entries skipped");

  // Namespaced user id falls back to its own suffix.
  const map2 = new Map([["gpt-5", 400000]]);
  assert.equal(lookupContextInMap(map2, "openai/gpt-5"), 400000);
  ok("namespaced user id → suffix lookup");

  // Missing dir → empty map, no throw.
  assert.equal(loadCatalogIndex(join(dir, "missing")).size, 0);
  ok("missing data dir → empty index");
}

/* ---------------- API probes (fetch stubbed) ---------------- */
const realFetch = globalThis.fetch;
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    return handler(String(url), init);
  };
  return calls;
}
const jsonRes = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

{
  // OpenRouter-style /models with context_length + normalized id match.
  const calls = stubFetch((url) => {
    if (url.endsWith("/v1/models")) return jsonRes({ data: [{ id: "openai/gpt-5", context_length: 400000 }] });
    throw new Error(`unexpected url ${url}`);
  });
  const res = await probeApiContext(
    { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-test" },
    { id: "gpt-5" },
  );
  assert.deepEqual(res, { value: 400000, source: "api", detail: "openrouter.ai/models" });
  assert.equal(calls[0].headers.Authorization, "Bearer sk-or-test");
  ok("OpenAI-compat /models: context_length + normalized id match + auth header");

  // No apiKey → no Authorization header.
  stubFetch(() => jsonRes({ data: [] }));
  await probeApiContext({ baseUrl: "https://openrouter.ai/api/v1" }, { id: "gpt-5" });
  ok("no key → no auth header");

  // $ENV / !cmd config values must not be sent as literals.
  const calls2 = stubFetch(() => jsonRes({ data: [] }));
  await probeApiContext({ baseUrl: "https://openrouter.ai/api/v1", apiKey: "$OPENROUTER_KEY" }, { id: "gpt-5" });
  assert.equal(calls2[0].headers.Authorization, undefined);
  ok("$ENV key reference not leaked into headers");

  // LM Studio native REST fallback (local host; OpenAI-compat list has no context field).
  const calls3 = stubFetch((url) => {
    if (url === "http://192.168.1.5:1234/v1/models") return jsonRes({ data: [{ id: "qwen3.8-27b@q5_k_m" }] }); // no context field
    if (url === "http://192.168.1.5:1234/api/v1/models")
      return jsonRes({ data: [{ key: "qwen/qwen3-27b-gguf", display_name: "Qwen 3.8 27B", context_length: 32768 }] }); // single loaded model
    throw new Error(`unexpected url ${url}`);
  });
  const resLm = await probeApiContext({ baseUrl: "http://192.168.1.5:1234/v1" }, { id: "qwen3.8-27b@q5_k_m" });
  assert.deepEqual(resLm, { value: 32768, source: "api", detail: "LM Studio 192.168.1.5:1234" });
  ok("LM Studio native /api/v1/models fallback (single loaded model)");

  // Non-local host must NOT be probed beyond its documented /models endpoint.
  const calls4 = stubFetch(() => jsonRes({ data: [] }));
  const resRemote = await probeApiContext({ baseUrl: "https://api.deepseek.com/v1" }, { id: "deepseek-chat" });
  assert.equal(resRemote, null);
  assert.equal(calls4.length, 1, "public host gets exactly one request");
  ok("non-local host: single /models request only");

  // Ollama /api/show best effort (port 11434).
  stubFetch((url) => {
    if (url.endsWith("/v1/models")) return jsonRes({ data: [{ name: "qwen3.8-27b" }] });
    if (url.startsWith("http://localhost:11434/api/v1/models")) return jsonRes({}, 404);
    if (url.includes("/api/show?name=")) return jsonRes({ options: { num_ctx: 8192 } });
    throw new Error(`unexpected url ${url}`);
  });
  const resOllama = await probeApiContext({ baseUrl: "http://localhost:11434/v1" }, { id: "qwen3.8-27b" });
  assert.deepEqual(resOllama, { value: 8192, source: "api", detail: "Ollama localhost:11434" });
  ok("Ollama /api/show num_ctx best effort");

  // Everything fails → null (never throws).
  stubFetch(() => jsonRes({}, 500));
  assert.equal(await probeApiContext({ baseUrl: "http://192.168.1.9:1234/v1" }, { id: "x" }), null);
  ok("all probes fail → null, no throw");

  globalThis.fetch = realFetch;
}

/* ---------------- resolution chain ---------------- */
{
  const catalogMap = new Map([["qwen3-max", 262144], ["gpt-5", 400000]]);

  // Catalog hit short-circuits — no network.
  stubFetch(() => {
    throw new Error("catalog hit must not touch the network");
  });
  const resCat = await resolveModelContext("p1", { baseUrl: "https://x.example/v1" }, { id: "qwen3-max" }, { catalogMap });
  assert.equal(resCat.value, 262144);
  assert.equal(resCat.source, "catalog");
  ok("chain: catalog hit wins without network");

  // Catalog miss → API probe.
  const calls = stubFetch((url) => (url.endsWith("/models") ? jsonRes({ data: [{ id: "gpt-5", context_length: 400000 }] }) : jsonRes({}, 404)));
  const resApi = await resolveModelContext("p1", { baseUrl: "https://openrouter.ai/api/v1" }, { id: "gpt-5-renamed" }, { catalogMap });
  // "gpt-5-renamed" is not in the map; /models entry id gpt-5 does not normalize-match either → none.
  assert.equal(resApi.source, "none");
  ok("chain: miss everywhere → source none");

  const resApi2 = await resolveModelContext("p1", { baseUrl: "https://openrouter.ai/api/v1" }, { id: "gpt-5" }, new Map());
  assert.equal(resApi2.value, 400000);
  assert.equal(resApi2.source, "api");
  ok("chain: empty catalog → API probe result used");

  globalThis.fetch = realFetch;
}

/* ---------------- save-time hook ---------------- */
{
  const catalogMap = new Map([["qwen3-max", 262144]]);
  stubFetch(() => {
    throw new Error("catalog-resolved models must not touch the network");
  });

  const input = {
    "prov-a": {
      baseUrl: "https://x.example/v1",
      models: [
        { id: "qwen3-max", contextWindowAuto: true }, // auto + empty → resolved from catalog
        { id: "manual-model", contextWindow: 999999, contextWindowAuto: true }, // has value → untouched (有值不解析)
        { id: "plain-model" }, // no auto flag → untouched
      ],
    },
  };
  const inputSnapshot = JSON.stringify(input);

  const out = await autoResolveContextWindows(input, { catalogMap });
  assert.equal(out["prov-a"].models[0].contextWindow, 262144);
  assert.equal(out["prov-a"].models[0].contextWindowSource, "catalog");
  assert.equal(out["prov-a"].models[1].contextWindow, 999999, "existing value never re-resolved");
  assert.equal(out["prov-a"].models[2].contextWindow, undefined);
  assert.equal(JSON.stringify(input), inputSnapshot, "caller's draft is not mutated (deep copy)");
  ok("save hook: empty+auto resolved; has-value untouched; no-auto untouched; deep-copied");

  // Nothing found → source none, value stays undefined.
  const out2 = await autoResolveContextWindows(
    { p: { baseUrl: "https://x.example/v1", models: [{ id: "unknown-model-xyz", contextWindowAuto: true }] } },
    { catalogMap: new Map() },
  );
  assert.equal(out2.p.models[0].contextWindow, undefined);
  assert.equal(out2.p.models[0].contextWindowSource, "none");
  ok("save hook: miss → source none, value left empty (pi 128K default applies)");

  globalThis.fetch = realFetch;
}

rmSync(dir, { recursive: true, force: true });
console.log(`\nmodel-context: ${passed} groups passed`);
