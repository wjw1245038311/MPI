import assert from "node:assert/strict";
import { register } from "node:module";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));

const { EDGE_VOICES, defaultEdgeVoice, findEdgeVoice, edgeRatePercent } = await import(
  "../src/renderer/src/lib/edge-voices.ts"
);

let passed = 0;
const ok = (label) => {
  passed++;
  console.log(`  ✓ ${label}`);
};

// --- Edge voice catalogue ---------------------------------------------------
{
  assert.ok(EDGE_VOICES.length >= 6, "a useful set of voices exists");
  const names = EDGE_VOICES.map((v) => v.shortName);
  assert.equal(new Set(names).size, names.length, "short names are unique");
  for (const v of EDGE_VOICES) {
    assert.match(v.shortName, /^[a-z]{2}-[A-Z]{2}-\w+Neural$/, `${v.shortName} looks like an Edge short name`);
    assert.ok(v.lang.trim() && v.zh.trim() && v.en.trim(), `${v.shortName} is bilingual + tagged`);
  }
  assert.ok(EDGE_VOICES.some((v) => v.lang === "zh-CN"), "has Mandarin voices");
  assert.ok(EDGE_VOICES.some((v) => v.lang === "en-US"), "has US English voices");
  ok("Edge voice catalogue is unique, tagged and bilingual");
}

// --- defaultEdgeVoice / findEdgeVoice --------------------------------------
{
  assert.equal(defaultEdgeVoice("zh"), "zh-CN-XiaoxiaoNeural");
  assert.equal(defaultEdgeVoice("en"), "en-US-AriaNeural");
  assert.ok(EDGE_VOICES.some((v) => v.shortName === defaultEdgeVoice("zh")), "zh default is in the catalogue");
  assert.ok(EDGE_VOICES.some((v) => v.shortName === defaultEdgeVoice("en")), "en default is in the catalogue");

  assert.equal(findEdgeVoice("zh-CN-YunxiNeural")?.lang, "zh-CN");
  assert.equal(findEdgeVoice("en-GB-RyanNeural")?.lang, "en-GB");
  assert.equal(findEdgeVoice(undefined), undefined);
  assert.equal(findEdgeVoice("nope"), undefined);
  ok("default + lookup resolve against the catalogue");
}

// --- edgeRatePercent -------------------------------------------------------
{
  assert.equal(edgeRatePercent(1), "+0%");
  assert.equal(edgeRatePercent(0.5), "-50%");
  assert.equal(edgeRatePercent(2), "+100%");
  assert.equal(edgeRatePercent(1.5), "+50%");
  assert.equal(edgeRatePercent(0.75), "-25%");
  // undefined / non-finite → normal; out-of-range clamped.
  assert.equal(edgeRatePercent(undefined), "+0%");
  assert.equal(edgeRatePercent(Number.NaN), "+0%");
  assert.equal(edgeRatePercent(3), "+100%");
  assert.equal(edgeRatePercent(0), "-50%");
  ok("edgeRatePercent maps + clamps the UI rate");
}

console.log(`\nedge-voices: ${passed} groups passed`);
