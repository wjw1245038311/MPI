import assert from "node:assert/strict";
import { register } from "node:module";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { buildQuoteEnvelope, QUOTE_MAX_CHARS } = await import("../src/main/quote-envelope.ts");
const { parseUserMessage } = await import("../src/renderer/src/store.ts");

// 1. Full envelope: location attributes + guidance note + body.
{
  const env = buildQuoteEnvelope({
    text: "把权限改成 sandbox",
    entryId: "01J9ZKQ8VW3N5M2R4T6X8C0B7D",
    role: "assistant",
    sessionFile: "/home/u/.pi/agent/sessions/proj/a.jsonl",
  });
  assert.ok(env.startsWith('<quote message="01J9ZKQ8VW3N5M2R4T6X8C0B7D" role="assistant" transcript="/home/u/.pi/agent/sessions/proj/a.jsonl" note="'), env);
  assert.ok(env.endsWith("\n把权限改成 sandbox\n</quote>"), env);

  // Round-trip: the renderer strips the block and surfaces it as a quote chip.
  const parsed = parseUserMessage("帮我看看这里\n\n" + env);
  assert.equal(parsed.text, "帮我看看这里");
  assert.equal(parsed.attachments.length, 1);
  assert.deepEqual(
    { kind: parsed.attachments[0].kind, note: parsed.attachments[0].note, path: parsed.attachments[0].path },
    { kind: "quote", note: "把权限改成 sandbox", path: "/home/u/.pi/agent/sessions/proj/a.jsonl" },
  );
}

// 2. Overlong quotes are truncated; the transcript still holds the rest.
{
  const long = "x".repeat(QUOTE_MAX_CHARS + 500);
  const env = buildQuoteEnvelope({ text: long });
  assert.ok(!env.includes("x".repeat(QUOTE_MAX_CHARS + 1)));
  const parsed = parseUserMessage(env);
  assert.equal(parsed.attachments[0].note.length, QUOTE_MAX_CHARS);
}

// 3. Attribute values are escaped (paths may contain quotes).
{
  const env = buildQuoteEnvelope({ text: "t", sessionFile: 'C:/we"ird/a.jsonl' });
  assert.ok(env.includes('transcript="C:/we&quot;ird/a.jsonl"'), env);
}

// 4. Missing optional fields → attributes omitted, note stays informative.
{
  const env = buildQuoteEnvelope({ text: "only text" });
  assert.ok(!env.includes("message="), env);
  assert.ok(!env.includes("role="), env);
  assert.ok(!env.includes("transcript="), env);
  assert.match(env, /^<quote note="quoted from this conversation">/);
}

// 5. Quotes mix with file envelopes in one prompt; both become chips.
{
  const quote = buildQuoteEnvelope({ text: "引用片段", entryId: "01ABC" });
  const prompt = `<file name="a.txt" path="/tmp/a.txt">\nhello\n</file>\n\n${quote}`;
  const parsed = parseUserMessage("问题文本\n\n" + prompt);
  assert.equal(parsed.text, "问题文本");
  assert.equal(parsed.attachments.length, 2);
  assert.deepEqual(
    parsed.attachments.map((a) => [a.name, a.kind]),
    [["a.txt", undefined], ["引用", "quote"]],
  );
}

// 6. User-authored <file> markup without the name attribute is left as text —
//    same trust rule must hold for empty quote blocks (no infinite loop).
{
  const parsed = parseUserMessage("前文<quote note=\"x\"></quote>后文");
  assert.equal(parsed.text, "前文<quote note=\"x\"></quote>后文");
  assert.equal(parsed.attachments.length, 0);
}

console.log("quote envelope: all assertions passed");
