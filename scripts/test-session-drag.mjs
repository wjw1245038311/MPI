import assert from "node:assert/strict";
import { register } from "node:module";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { MPI_SESSION_MIME, parseSessionDragPayload } = await import(
  "../src/renderer/src/lib/file-drag.ts"
);

assert.equal(MPI_SESSION_MIME, "application/x-mpi-session");

// valid payload round-trips (as the sidebar sets it) — forward slashes keep
// this test portable; the parser does not care about separators.
const raw = JSON.stringify({ file: "C:/Users/x/.pi/agent/sessions/a.jsonl", title: "重构 Composer" });
assert.deepEqual(parseSessionDragPayload(raw), {
  file: "C:/Users/x/.pi/agent/sessions/a.jsonl",
  title: "重构 Composer",
});

// empty title is tolerated (composer falls back to the basename)
assert.equal(parseSessionDragPayload(JSON.stringify({ file: "/s/a.jsonl" }))?.title, "");

// malformed / absent payloads are rejected, never thrown
for (const bad of ["", "not json", '{"file":123}', '{"file":""}', '{"file":"  "}']) {
  assert.equal(parseSessionDragPayload(bad), null, `rejected: ${bad}`);
}

console.log("session-drag payload: all assertions passed");
