/**
 * L1 tests for src/main/stt-relay.ts — phone voice memo STT routing.
 * Run: node --experimental-strip-types scripts/test-stt-relay.mjs
 */
import assert from "node:assert/strict";

const { resolveSttTargets, transcribeWav, DEFAULT_LOCAL_VOICE_URL, GATEWAY_STT_URL } = await import(
  "../src/main/stt-relay.ts"
);

// A tiny valid WAV (44-byte header + 16 samples of silence @16kHz mono).
const wavHeader = Buffer.alloc(44);
wavHeader.write("RIFF", 0);
wavHeader.writeUInt32LE(36, 4);
wavHeader.write("WAVE", 8);
wavHeader.write("fmt ", 12);
wavHeader.writeUInt32LE(16, 16); // fmt chunk size
wavHeader.writeUInt16LE(1, 20);   // PCM
wavHeader.writeUInt16LE(1, 22);   // mono
wavHeader.writeUInt32LE(16000, 24);
wavHeader.write("data", 36);
wavHeader.writeUInt32LE(32, 40);
const WAV_B64 = Buffer.concat([wavHeader, Buffer.alloc(32)]).toString("base64");

let passed = 0;
function ok(name) { passed++; console.log(`  ✓ ${name}`); }

// ---------------------------------------------------------------- target resolution
{
  const t = resolveSttTargets({ voice: { sttBackend: "openai", sttBaseUrl: "http://127.0.0.1:8800/v1/", sttModel: "SenseVoiceSmall" } });
  assert.equal(t.length, 1);
  assert.equal(t[0].baseUrl, "http://127.0.0.1:8800/v1"); // trailing slash stripped
  assert.equal(t[0].model, "SenseVoiceSmall");
  ok("voice config (openai) wins as primary target");
}
{
  const t = resolveSttTargets({ sttUrl: "http://10.0.0.5:9000/v1" });
  assert.equal(t[0].baseUrl, "http://10.0.0.5:9000/v1");
  ok("sttUrl override used when no voice config");
}
{
  const t = resolveSttTargets({});
  assert.equal(t[0].baseUrl, DEFAULT_LOCAL_VOICE_URL);
  assert.equal(t[0].model, "SenseVoiceSmall");
  ok("default target is the local-voice app endpoint");
}
{
  // voice config with a non-openai backend must NOT be used (gemini has a different protocol)
  const t = resolveSttTargets({ voice: { sttBackend: "gemini", sttBaseUrl: "http://x/v1" } });
  assert.equal(t[0].baseUrl, DEFAULT_LOCAL_VOICE_URL);
  ok("non-openai voice backend ignored (falls to default)");
}

// ---------------------------------------------------------------- happy path via openai target
{
  const calls = [];
  const mockFetch = async (url, init) => {
    calls.push({ url, body: init.body });
    return new Response(JSON.stringify({ text: "你好世界" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const r = await transcribeWav(WAV_B64, { voice: { sttBackend: "openai", sttBaseUrl: "http://127.0.0.1:8800/v1" } }, mockFetch);
  assert.equal(r.text, "你好世界");
  assert.match(r.via, /^openai:/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8800/v1/audio/transcriptions");
  assert.ok(calls[0].body instanceof FormData, "multipart body expected");
  const file = calls[0].body.get("file");
  assert.ok(file && file.name === "voice.wav");
  ok("openai target: multipart POST to <base>/audio/transcriptions with voice.wav");
}

// ---------------------------------------------------------------- fallback to gateway when primary is down
{
  const calls = [];
  const mockFetch = async (url, init) => {
    calls.push(url);
    if (url.startsWith("http://127.0.0.1:8800")) throw new Error("connect ECONNREFUSED");
    assert.equal(init.headers["content-type"], "audio/wav");
    return new Response(JSON.stringify({ text: "兜底识别" }), { status: 200 });
  };
  const r = await transcribeWav(WAV_B64, {}, mockFetch); // {} → default :8800 primary
  assert.equal(r.text, "兜底识别");
  assert.match(r.via, /^gateway:/);
  assert.deepEqual(calls, [`${DEFAULT_LOCAL_VOICE_URL}/audio/transcriptions`, GATEWAY_STT_URL]);
  ok("primary down → gateway raw-WAV fallback (order verified)");
}

// ---------------------------------------------------------------- all targets fail
{
  const mockFetch = async () => { throw new Error("boom"); };
  await assert.rejects(
    () => transcribeWav(WAV_B64, {}, mockFetch),
    /all STT targets failed:.*unreachable.*\|.*unreachable/,
  );
  ok("all targets down → error aggregates every failure reason");
}

// ---------------------------------------------------------------- empty payload rejected early
{
  await assert.rejects(() => transcribeWav("", {}, async () => new Response("{}")), /empty audio/);
  ok("empty base64 payload rejected before any network call");
}

console.log(`\ntest-stt-relay: ${passed} 组断言全部通过`);
