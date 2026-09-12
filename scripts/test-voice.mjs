import assert from "node:assert/strict";
import { register } from "node:module";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const {
  STT_DEFAULT_MODELS,
  buildGeminiRequest,
  buildOpenAiRequest,
  makeSilentWavBase64,
  parseGeminiTranscript,
  resolveStt,
  testStt,
  transcribeAudio,
} = await import("../src/main/voice.ts");

const { cleanForSpeech, chunkText } = await import("../src/renderer/src/lib/tts.ts");
const { sttRecordErrorText, sttTranscribeErrorText } = await import("../src/renderer/src/lib/stt.ts");

let passed = 0;
const ok = (label) => {
  passed++;
  console.log(`  ✓ ${label}`);
};

/* ---------------- resolveStt ---------------- */
{
  assert.throws(() => resolveStt(undefined, {}), /voice\.stt\.not-configured/);
  assert.throws(() => resolveStt({ sttBackend: "openai" }, {}), /voice\.stt\.no-key/);
  ok("missing config / key rejected");

  const providers = {
    gpt: { baseUrl: "https://api.openai.com/v1/", apiKey: "sk-test" },
    gemini: { baseUrl: "", apiKey: "gk-test" },
  };

  const openai = resolveStt({ sttBackend: "openai", sttProviderId: "gpt" }, providers);
  assert.equal(openai.baseUrl, "https://api.openai.com/v1"); // trailing slash stripped
  assert.equal(openai.apiKey, "sk-test");
  assert.equal(openai.model, STT_DEFAULT_MODELS.openai);
  ok("openai via provider ref (live baseUrl/key, default model)");

  const gemini = resolveStt({ sttBackend: "gemini", sttProviderId: "gemini" }, providers);
  assert.equal(gemini.baseUrl, "https://generativelanguage.googleapis.com"); // fixed endpoint
  assert.equal(gemini.apiKey, "gk-test");
  assert.equal(gemini.model, STT_DEFAULT_MODELS.gemini);
  ok("gemini via provider ref (Google endpoint, default model)");

  const manual = resolveStt(
    { sttBackend: "openai", sttProviderId: "__manual__", sttBaseUrl: "https://gw.example.com/v1", sttApiKey: "sk-m", sttModel: "gpt-4o-mini-transcribe" },
    {},
  );
  assert.equal(manual.baseUrl, "https://gw.example.com/v1");
  assert.equal(manual.apiKey, "sk-m");
  assert.equal(manual.model, "gpt-4o-mini-transcribe");
  ok("manual entry (no provider ref) with explicit model");

  const proxy = resolveStt(
    { sttBackend: "gemini", sttProviderId: "__manual__", sttBaseUrl: "https://proxy.example.com/", sttApiKey: "gk" },
    {},
  );
  assert.equal(proxy.baseUrl, "https://proxy.example.com"); // override honored for gemini too
  ok("gemini proxy override");

  const explicitKey = resolveStt(
    { sttBackend: "openai", sttProviderId: "gpt", sttBaseUrl: "https://other.example/v1", sttApiKey: "sk-override" },
    providers,
  );
  assert.equal(explicitKey.apiKey, "sk-override"); // manual key wins over provider key
  ok("explicit key/baseUrl override the referenced provider");

  assert.throws(() => resolveStt({ sttBackend: "openai", sttProviderId: "nope" }, providers), /voice\.stt\.provider-missing:nope/);
  ok("unknown provider id rejected");

  assert.throws(
    () => resolveStt({ sttBackend: "openai", sttProviderId: "__manual__", sttApiKey: "k" }, {}),
    /voice\.stt\.no-base-url/,
  );
  ok("openai without base URL rejected");
}

/* ---------------- request builders ---------------- */
{
  const resolved = { backend: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-x", model: "whisper-1" };
  const req = buildOpenAiRequest(resolved, "QUJD");
  assert.equal(req.url, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(req.headers.Authorization, "Bearer sk-x");
  assert.deepEqual(req.fields, { model: "whisper-1" });
  assert.deepEqual(req.file, { name: "recording.wav", type: "audio/wav", base64: "QUJD" });
  ok("openai request descriptor (url/auth/fields/file)");

  const g = buildGeminiRequest({ backend: "gemini", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "gk", model: "gemini-2.5-flash" }, "QUJD");
  assert.equal(g.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
  assert.equal(g.headers.Authorization, "Bearer gk");
  const parts = g.bodyJson.contents[0].parts;
  assert.equal(parts[0].inline_data.mime_type, "audio/wav");
  assert.equal(parts[0].inline_data.data, "QUJD");
  assert.match(parts[1].text, /Transcribe this audio verbatim/);
  ok("gemini request descriptor (url/auth/inline data)");

  assert.equal(
    parseGeminiTranscript({ candidates: [{ content: { parts: [{ text: "你好" }, { text: "，世界" }] }}] }),
    "你好，世界",
  );
  assert.equal(parseGeminiTranscript({}), "");
  assert.equal(parseGeminiTranscript(null), "");
  ok("gemini transcript parsing (multi-part / empty)");
}

/* ---------------- silent WAV encoding ---------------- */
{
  const b64 = makeSilentWavBase64(0.5, 16_000);
  const buf = Buffer.from(b64, "base64");
  assert.equal(buf.toString("ascii", 0, 4), "RIFF");
  assert.equal(buf.toString("ascii", 8, 12), "WAVE");
  assert.equal(buf.toString("ascii", 12, 16), "fmt ");
  assert.equal(buf.readUInt16LE(22), 1); // mono
  assert.equal(buf.readUInt32LE(24), 16_000); // sample rate
  assert.equal(buf.readUInt16LE(34), 16); // bits per sample
  const dataSize = buf.readUInt32LE(40);
  assert.equal(dataSize, Math.floor(0.5 * 16_000) * 2);
  assert.equal(buf.length, 44 + dataSize);
  ok("silent WAV header (RIFF/fmt/data, 16 kHz mono 16-bit)");
}

/* ---------------- transcribeAudio (fetch stubbed) ---------------- */
{
  const realFetch = globalThis.fetch;

  // openai success — verify multipart FormData is used.
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ text: "  hello world  " }), { status: 200 });
  };
  const providers = { gpt: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" } };
  let res = await transcribeAudio(
    { dataBase64: Buffer.from("fake-wav").toString("base64") },
    { cfg: { sttBackend: "openai", sttProviderId: "gpt" }, providers, fetchImpl: globalThis.fetch },
  );
  assert.equal(res.ok, true);
  assert.equal(res.text, "hello world"); // trimmed
  assert.equal(captured.url, "https://api.openai.com/v1/audio/transcriptions");
  assert.ok(captured.init.body instanceof FormData);
  assert.equal(captured.init.body.get("model"), "whisper-1");
  const file = captured.init.body.get("file");
  assert.ok(file && typeof file.size === "number" && file.size > 0);
  ok("openai transcription (multipart, trimmed text)");

  // gemini success.
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "你好，世界" }] }}] }),
      { status: 200 },
    );
  res = await transcribeAudio(
    { dataBase64: Buffer.from("fake-wav").toString("base64") },
    { cfg: { sttBackend: "gemini", sttProviderId: "__manual__", sttApiKey: "gk" }, providers, fetchImpl: globalThis.fetch },
  );
  assert.equal(res.ok, true);
  assert.equal(res.text, "你好，世界");
  ok("gemini transcription (JSON body)");

  // gemini silence marker "-" → empty text.
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "-" }] }}] }), { status: 200 });
  res = await transcribeAudio(
    { dataBase64: Buffer.from("fake-wav").toString("base64") },
    { cfg: { sttBackend: "gemini", sttProviderId: "__manual__", sttApiKey: "gk" }, providers, fetchImpl: globalThis.fetch },
  );
  assert.equal(res.ok, true);
  assert.equal(res.text, "");
  ok("silence marker normalized to empty text");

  // HTTP error surfaces the API message.
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 });
  res = await transcribeAudio(
    { dataBase64: Buffer.from("fake-wav").toString("base64") },
    { cfg: { sttBackend: "openai", sttProviderId: "__manual__", sttBaseUrl: "https://x/v1", sttApiKey: "bad" }, providers, fetchImpl: globalThis.fetch },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /HTTP 401/);
  assert.match(res.error, /Invalid API key/);
  ok("API error surfaced (status + message)");

  // Unconfigured → no fetch at all.
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}");
  };
  res = await transcribeAudio({ dataBase64: "QUJD" }, { cfg: undefined, providers, fetchImpl: globalThis.fetch });
  assert.equal(res.ok, false);
  assert.match(res.error, /not-configured/);
  assert.equal(called, false);
  ok("unconfigured backend short-circuits without network");

  // Empty payload rejected.
  res = await transcribeAudio(
    { dataBase64: "   " },
    { cfg: { sttBackend: "openai", sttProviderId: "__manual__", sttBaseUrl: "https://x/v1", sttApiKey: "k" }, providers, fetchImpl: globalThis.fetch },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /empty-audio/);
  ok("empty payload rejected");

  // testStt sends a valid silent WAV and reports success.
  let sawWav = null;
  globalThis.fetch = async (url, init) => {
    if (init.body instanceof FormData) {
      const f = init.body.get("file");
      sawWav = Buffer.from(await f.arrayBuffer());
    }
    return new Response(JSON.stringify({ text: "" }), { status: 200 });
  };
  res = await testStt({
    cfg: { sttBackend: "openai", sttProviderId: "__manual__", sttBaseUrl: "https://x/v1", sttApiKey: "k" },
    providers,
    fetchImpl: globalThis.fetch,
  });
  assert.equal(res.ok, true);
  assert.equal(sawWav.toString("ascii", 0, 4), "RIFF");
  ok("testStt probe (silent WAV accepted)");

  globalThis.fetch = realFetch;
}

/* ---------------- cleanForSpeech ---------------- */
{
  const zh = cleanForSpeech(
    [
      "# 标题",
      "",
      "这是**加粗**和`inline code`。",
      "```ts",
      "const x = 1;",
      "```",
      "[链接文字](https://example.com)",
      "![](https://img.example/a.png)",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
    ].join("\n"),
    true,
  );
  assert.ok(!zh.includes("#"));
  assert.ok(zh.includes("加粗") && !zh.includes("**"));
  assert.ok(zh.includes("inline code"));
  assert.ok(zh.includes("（代码块）") && !zh.includes("const x"));
  assert.ok(zh.includes("链接文字") && !zh.includes("example.com"));
  assert.ok(!zh.includes("|---|"));
  assert.ok(zh.includes(", ")); // table pipes flattened
  ok("cleanForSpeech zh (headings/code/links/tables)");

  const en = cleanForSpeech("See [docs](https://d.io) and ```py\nprint(1)\n``` for more.", false);
  assert.ok(en.includes("(code block)") && !en.includes("print"));
  assert.ok(en.includes("docs") && !en.includes("d.io"));
  ok("cleanForSpeech en (markers + code fence)");

  const unclosed = cleanForSpeech("text ```\nstill streaming…", true);
  assert.equal(unclosed, "text"); // unterminated fence dropped entirely
  ok("unterminated fence (streaming message) dropped");
}

/* ---------------- chunkText ---------------- */
{
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("   "), []);
  assert.equal(chunkText("短句。").length, 1);
  ok("chunkText trivial cases");

  const long = Array.from({ length: 30 }, (_, i) => `第${i}句话内容比较长一些。`).join("");
  const chunks = chunkText(long, 200);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= 200, `chunk too long: ${c.length}`);
    assert.ok(!c.startsWith(" ") && !c.endsWith(" "));
  }
  // No content lost (whitespace aside).
  const rejoined = chunks.join("");
  assert.equal(rejoined.replace(/\s/g, ""), long.replace(/\s/g, ""));
  ok("chunkText packs sentences under the cap without losing text");

  const unbroken = "x".repeat(500);
  const hard = chunkText(unbroken, 200);
  assert.deepEqual(hard.map((c) => c.length), [200, 200, 100]);
  ok("chunkText hard-splits unbroken runs");

  // CJK has no spaces — sentence ends must still split.
  const cjk = "一二三四五六七八九。".repeat(40);
  const cjkChunks = chunkText(cjk, 50);
  assert.ok(cjkChunks.length > 1);
  for (const c of cjkChunks) assert.ok(c.length <= 50);
  ok("chunkText splits CJK at sentence ends");
}

/* ---------------- error text mapping ---------------- */
{
  assert.match(sttTranscribeErrorText("voice.stt.timeout", true), /超时/);
  assert.match(sttTranscribeErrorText("voice.stt.provider-missing:gpt", true), /gpt/);
  assert.match(sttTranscribeErrorText("HTTP 401 Invalid API key", false), /Invalid API key/);
  assert.match(sttRecordErrorText("mic-denied", true), /麦克风/);
  ok("error text mapping (zh/en, provider-missing, raw API detail)");
}

console.log(`\nvoice: ${passed} groups passed`);
