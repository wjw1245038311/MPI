import assert from "node:assert/strict";
import { register } from "node:module";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const {
  EDGE_TRUSTED_CLIENT_TOKEN,
  EDGE_MAX_TEXT_CHARS,
  edgeGecToken,
  edgeConnectionId,
  edgeWsUrl,
  escapeXml,
  voiceLang,
  edgeRateString,
  buildEdgeSsml,
  edgeTextFrame,
  parseEdgeFrame,
  synthesizeEdge,
} = await import("../src/main/edge-tts.ts");

let passed = 0;
const ok = (label) => {
  passed++;
  console.log(`  ✓ ${label}`);
};

// --- Sec-MS-GEC token: deterministic, windowed, correct shape --------------
{
  const token = edgeGecToken(1726150000000);
  assert.match(token, /^[0-9A-F]{64}$/, "64 uppercase hex chars");
  // Regression vector (guards against accidental algorithm changes).
  assert.equal(token, "C948F08BB1DDE220A828E19C9059F17F50F179AE940834527737565121668D7E");
  // Deterministic.
  assert.equal(edgeGecToken(1726150000000), token);
  // 5-minute window: two instants 1s apart in the same window share a token.
  assert.equal(edgeGecToken(1726150299000), edgeGecToken(1726150300000));
  // Different windows differ.
  assert.notEqual(edgeGecToken(1726150000000), edgeGecToken(1726150600000));
  // A custom client token changes the result.
  assert.notEqual(edgeGecToken(1726150000000), edgeGecToken(1726150000000, "other"));
  assert.equal(EDGE_TRUSTED_CLIENT_TOKEN.length, 32);
  ok("edgeGecToken is deterministic, windowed and matches the known vector");
}

// --- connection id ----------------------------------------------------------
{
  const a = edgeConnectionId();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, edgeConnectionId());
  ok("edgeConnectionId is 32 hex chars and unique");
}

// --- ws url carries the required params ------------------------------------
{
  const url = edgeWsUrl("abc123", 1726150000000);
  assert.ok(url.startsWith("wss://speech.platform.bing.com/"), "edge endpoint");
  assert.ok(url.includes("TrustedClientToken="), "trusted token param");
  assert.ok(url.includes("Sec-MS-GEC="), "gec param");
  assert.ok(url.includes("Sec-MS-GEC-Version=1-"), "gec version param");
  assert.ok(url.includes("ConnectionId=abc123"), "connection id param");
  ok("edgeWsUrl includes token, GEC and connection id");
}

// --- xml escaping / lang / rate --------------------------------------------
{
  assert.equal(escapeXml("<a> & \"b\" 'c'"), "&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos;");
  assert.equal(voiceLang("zh-CN-XiaoxiaoNeural"), "zh-CN");
  assert.equal(voiceLang("en-GB-RyanNeural"), "en-GB");
  assert.equal(voiceLang("garbage"), "en-US");

  assert.equal(edgeRateString(1), "+0%");
  assert.equal(edgeRateString(0.5), "-50%");
  assert.equal(edgeRateString(2), "+100%");
  assert.equal(edgeRateString(1.5), "+50%");
  assert.equal(edgeRateString(undefined), "+0%");
  assert.equal(edgeRateString(Number.NaN), "+0%");
  assert.equal(edgeRateString(9), "+100%");
  assert.equal(edgeRateString(0), "-50%");
  ok("escapeXml / voiceLang / edgeRateString behave and clamp");
}

// --- SSML -------------------------------------------------------------------
{
  const ssml = buildEdgeSsml("a < b & c", "zh-CN-YunxiNeural", "+25%");
  assert.ok(ssml.includes("xml:lang='zh-CN'"), "lang attribute");
  assert.ok(ssml.includes("voice name='zh-CN-YunxiNeural'"), "voice name");
  assert.ok(ssml.includes("rate='+25%'"), "rate");
  assert.ok(ssml.includes("a &lt; b &amp; c"), "text escaped");
  assert.ok(ssml.startsWith("<speak") && ssml.endsWith("</speak>"));
  ok("buildEdgeSsml escapes text and sets voice/lang/rate");
}

// --- frame helpers ----------------------------------------------------------
{
  const frame = edgeTextFrame({ "X-RequestId": "r1", Path: "ssml" }, "<speak/>");
  assert.equal(frame, "X-RequestId:r1\r\nPath:ssml\r\n\r\n<speak/>");

  // Build a binary frame: 2-byte BE header length + header + payload.
  const header = "X-RequestId:r1\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n\r\n";
  const payload = Buffer.from([1, 2, 3, 4, 5]);
  const buf = Buffer.concat([Buffer.from([(header.length >> 8) & 0xff, header.length & 0xff]), Buffer.from(header, "utf8"), payload]);
  const parsed = parseEdgeFrame(buf);
  assert.equal(parsed.path, "audio");
  assert.equal(parsed.headers["content-type"], "audio/mpeg");
  assert.deepEqual([...parsed.payload], [1, 2, 3, 4, 5]);
  ok("edgeTextFrame / parseEdgeFrame round-trip");
}

// --- synthesizeEdge: validation + injected WS (no real socket) -------------
{
  // Empty text is rejected without opening a socket.
  const empty = await synthesizeEdge({ text: "   " }, { wsImpl: () => { throw new Error("should not connect"); } });
  assert.deepEqual(empty, { ok: false, error: "voice.tts.empty-text" });

  const tooLong = await synthesizeEdge({ text: "x".repeat(EDGE_MAX_TEXT_CHARS + 1) }, { wsImpl: () => { throw new Error("should not connect"); } });
  assert.equal(tooLong.error, "voice.tts.too-long");

  // Fake WS that emits a config-style control frame + one audio frame + turn.end.
  class FakeWs {
    constructor() {
      this.handlers = {};
      this.sent = [];
      this.closed = false;
      queueMicrotask(() => this.emit("open"));
    }
    on(ev, cb) {
      (this.handlers[ev] ||= []).push(cb);
      return this;
    }
    emit(ev, ...a) {
      for (const cb of this.handlers[ev] || []) cb(...a);
    }
    send(m) {
      this.sent.push(m);
    }
    close() {
      this.closed = true;
    }
  }
  const created = [];
  const res = await synthesizeEdge(
    { text: "hello", voice: "en-US-AriaNeural", rate: 1 },
    {
      wsImpl: function FakeWsFactory() {
        const w = new FakeWs();
        created.push(w);
        // Drive the protocol after listeners are attached.
        setTimeout(() => {
          const header = "Path:audio\r\n\r\n";
          const payload = Buffer.from([9, 8, 7]);
          const frame = Buffer.concat([
            Buffer.from([(header.length >> 8) & 0xff, header.length & 0xff]),
            Buffer.from(header, "utf8"),
            payload,
          ]);
          w.emit("message", frame, true);
          w.emit("message", Buffer.from("Path:turn.end\r\n\r\n"), false);
        }, 0);
        return w;
      },
      now: () => 1726150000000,
    },
  );
  assert.equal(res.ok, true, "synthesis succeeds");
  assert.equal(res.mime, "audio/mpeg");
  assert.deepEqual([...Buffer.from(res.audioBase64, "base64")], [9, 8, 7]);
  assert.equal(created[0].sent.length, 2, "sent speech.config + ssml");
  assert.ok(created[0].sent[0].includes("speech.config"));
  assert.ok(created[0].sent[1].includes("hello"));
  ok("synthesizeEdge validates input and assembles audio from injected WS");
}

console.log(`\nedge-tts: ${passed} groups passed`);
