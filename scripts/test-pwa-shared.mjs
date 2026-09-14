/**
 * Equivalence tests: mobile/shared/protocol.ts (PWA vendored copy) must behave
 * identically to src/main/remote/protocol.ts (desktop source). Drift fails here.
 */
import assert from "node:assert/strict";

const desktop = await import("../src/main/remote/protocol.ts");
const shared = await import("../mobile/shared/protocol.ts");

// --- constants -----------------------------------------------------------------
assert.equal(shared.REMOTE_PROTOCOL_VERSION, desktop.REMOTE_PROTOCOL_VERSION);
assert.deepEqual([...shared.REMOTE_REQUEST_TYPES], [...desktop.REMOTE_REQUEST_TYPES]);

// --- makeEnvelope (fixed sentAt so both sides are comparable) --------------------
const cases = [
  ["projects.list", "s1"],
  ["thread.prompt", "sess-abc", { text: "hello" }],
  ["ui.respond", "s2", { id: "r9" }, { requestId: "req-1", threadId: "t7", seq: 42, sentAt: 1_700_000_000_000 }],
];
for (const [type, sessionId, payload, extra] of cases) {
  const a = desktop.makeEnvelope(type, sessionId, payload, extra);
  const b = shared.makeEnvelope(type, sessionId, payload, extra);
  assert.deepEqual(b, a, `makeEnvelope(${type})`);
}

// --- parseEnvelope: valid inputs ---------------------------------------------------
const validSamples = [
  JSON.stringify({ v: 1, type: "projects.list", sessionId: "s1", sentAt: 5 }),
  JSON.stringify({ v: 1, type: "thread.event", sessionId: "s1", sentAt: 5, threadId: "t", seq: 3, payload: { kind: "x" } }),
  JSON.stringify({ v: 1, type: "ui.request", sessionId: "s1", sentAt: 5, requestId: "r", error: undefined, extraField: true }),
];
for (const raw of validSamples) {
  assert.deepEqual(shared.parseEnvelope(raw), desktop.parseEnvelope(raw), `parseEnvelope(${raw.slice(0, 40)}…)`);
}

// --- parseEnvelope: invalid inputs must raise the SAME error code -------------------
const invalidSamples = [
  "not json",
  JSON.stringify([1, 2, 3]), // not an object
  JSON.stringify({ v: 2, type: "x", sessionId: "s", sentAt: 1 }), // unsupported version
  JSON.stringify({ v: 1, type: "", sessionId: "s", sentAt: 1 }), // empty type
  JSON.stringify({ v: 1, type: "x".repeat(81), sessionId: "s", sentAt: 1 }), // type too long
  JSON.stringify({ v: 1, type: "x", sessionId: "", sentAt: 1 }), // empty session id
  JSON.stringify({ v: 1, type: "x", sessionId: "s".repeat(129), sentAt: 1 }), // session id too long
  JSON.stringify({ v: 1, type: "x", sessionId: "s", sentAt: 1.5 }), // non-integer timestamp
  JSON.stringify({ v: 1, type: "x", sessionId: "s", sentAt: 1, requestId: "r".repeat(129) }), // request id too long
  "x".repeat(2_000_001), // PAYLOAD_TOO_LARGE (checked before JSON parsing)
];
for (const raw of invalidSamples) {
  let desktopCode = null;
  try {
    desktop.parseEnvelope(raw);
  } catch (error) {
    assert.ok(error instanceof desktop.RemoteProtocolError, "desktop should throw RemoteProtocolError");
    desktopCode = error.code;
  }
  let sharedCode = null;
  try {
    shared.parseEnvelope(raw);
  } catch (error) {
    assert.ok(error instanceof shared.RemoteProtocolError, "shared should throw RemoteProtocolError");
    sharedCode = error.code;
  }
  assert.equal(sharedCode, desktopCode, `parseEnvelope error code for ${String(raw).slice(0, 40)}…`);
  assert.notEqual(desktopCode, null, `sample should be invalid: ${String(raw).slice(0, 40)}`);
}

// --- responseFor / errorFor -----------------------------------------------------------
const request = desktop.makeEnvelope("thread.prompt", "s1", { text: "hi" }, { requestId: "req-7", sentAt: 9 });
assert.deepEqual(shared.responseFor(request, { ok: true }), desktop.responseFor(request, { ok: true }));
assert.deepEqual(shared.errorFor(request, "THREAD_BUSY", "busy"), desktop.errorFor(request, "THREAD_BUSY", "busy"));

console.log("pwa-shared protocol equivalence tests passed");
