import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { loadConfig } = await import("../src/main/config.ts");
const { deleteFeedback, flushFeedback, getFeedback, setFeedback } = await import(
  "../src/main/feedback-store.ts"
);

// ---------------------------------------------------------------------------
// Feedback store (sidecar JSON under a throwaway userData dir)
// ---------------------------------------------------------------------------
const dataDir = mkdtempSync(join(tmpdir(), "mpi-feedback-"));
try {
  loadConfig(dataDir); // points feedback-store at the throwaway dir

  assert.deepEqual(getFeedback(), {}, "starts empty");

  setFeedback("01ABC", 1);
  assert.equal(getFeedback()["01ABC"].rating, 1);

  // note undefined keeps the existing note; a string replaces it
  setFeedback("01ABC", 1, "great fix");
  assert.equal(getFeedback()["01ABC"].note, "great fix");
  setFeedback("01ABC", -1); // switch sides, keep note (dsh parity)
  const switched = getFeedback()["01ABC"];
  assert.equal(switched.rating, -1);
  assert.equal(switched.note, "great fix");

  // null clears the note; empty string also clears
  setFeedback("01ABC", -1, "");
  assert.equal(getFeedback()["01ABC"].note, undefined);

  // re-clicking the active rating retracts (delete)
  deleteFeedback("01ABC");
  assert.deepEqual(getFeedback(), {}, "retract removes the entry");

  // persistence: flush then read the raw JSON back
  setFeedback("01DEF", -1, "note");
  flushFeedback();
  const onDisk = JSON.parse(readFileSync(join(dataDir, "feedback.json"), "utf8"));
  assert.equal(onDisk["01DEF"].rating, -1);
  assert.equal(onDisk["01DEF"].note, "note");

  // note length is capped at 500 chars
  setFeedback("01GHI", 1, "x".repeat(900));
  assert.equal(getFeedback()["01GHI"].note.length, 500);

  console.log("feedback-store: all assertions passed");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
