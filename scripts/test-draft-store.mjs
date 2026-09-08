import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Source files use bundler-style extensionless imports; resolve them for node.
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { loadConfig } = await import("../src/main/config.ts");
const { deleteDraft, flushDrafts, getAllDrafts, setDraft } = await import("../src/main/draft-store.ts");

const dir = mkdtempSync(join(tmpdir(), "mpi-drafts-"));
loadConfig(dir); // points draft-store at a throwaway userData dir

const d = (text) => ({ text, images: [], files: [] });

// --- basic set/get ---------------------------------------------------------
setDraft("n:C:\\proj", d("hello"));
assert.deepEqual(getAllDrafts()["n:C:\\proj"], { text: "hello", images: [], files: [] });

// --- LRU refresh: updating an existing key moves it to the MRU end ---------
for (const k of ["k2", "k3", "k4", "k5"]) setDraft(k, d("x"));
setDraft("n:C:\\proj", d("hello again")); // touch the oldest entry
assert.deepEqual(
  Object.keys(getAllDrafts()),
  ["k2", "k3", "k4", "k5", "n:C:\\proj"],
  "updated key must move to the MRU end (p-a-d #19 FIFO footgun)",
);

// --- eviction keeps the most recently used, never an active one ------------
for (let i = 6; i <= 41; i++) setDraft(`k${i}`, d("x")); // push past the cap of 40
const afterEviction = getAllDrafts();
assert.equal(Object.keys(afterEviction).length, 40, "LRU cap is 40 drafts");
assert.ok(!("k2" in afterEviction), "least recently used entry (k2) evicted");
assert.ok("n:C:\\proj" in afterEviction, "recently touched draft survives eviction");

// --- delete ----------------------------------------------------------------
deleteDraft("k3");
assert.ok(!("k3" in getAllDrafts()));

// --- disk persistence (coalesced flush + atomic file) ----------------------
flushDrafts();
const onDisk = JSON.parse(readFileSync(join(dir, "drafts.json"), "utf8"));
assert.equal(onDisk["n:C:\\proj"].text, "hello again");
assert.ok(!("k3" in onDisk), "deleted draft must not be written back");
assert.deepEqual(Object.keys(onDisk).at(-1), "k41", "disk order matches LRU recency");

// --- size guard: oversized images are dropped, text survives ---------------
const bigImage = { id: "p1", dataUrl: "", base64: "A".repeat(3_000_000), mimeType: "image/png" };
setDraft("big", { text: "keep me", images: [bigImage], files: [] });
flushDrafts();
const bigOnDisk = JSON.parse(readFileSync(join(dir, "drafts.json"), "utf8"))["big"];
assert.equal(bigOnDisk.text, "keep me");
assert.deepEqual(bigOnDisk.images, [], "oversized base64 images must be stripped before persisting");

console.log("draft store tests passed");
