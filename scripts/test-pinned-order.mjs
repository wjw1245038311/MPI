import assert from "node:assert/strict";
import { reorderPinned } from "../src/main/pinned-order.ts";

// --- move existing entry -----------------------------------------------------
assert.deepEqual(reorderPinned(["a", "b", "c", "d"], "d", 0), ["d", "a", "b", "c"]); // to front
assert.deepEqual(reorderPinned(["a", "b", "c", "d"], "a", 2), ["b", "c", "a", "d"]); // down two
assert.deepEqual(reorderPinned(["a", "b", "c"], "b", 1), ["a", "b", "c"]); // same rank = no-op
assert.deepEqual(reorderPinned(["a", "b", "c"], "b", 99), ["a", "c", "b"]); // clamped to end

// --- insert new entry (pin at rank) -------------------------------------------
assert.deepEqual(reorderPinned(["a", "b"], "x", 0), ["x", "a", "b"]);
assert.deepEqual(reorderPinned(["a", "b"], "x", 1), ["a", "x", "b"]);
assert.deepEqual(reorderPinned(["a", "b"], "x", 99), ["a", "b", "x"]); // clamped to end
assert.deepEqual(reorderPinned([], "x", 0), ["x"]);

// --- case-insensitive identity (Windows paths) ---------------------------------
const win = reorderPinned(["C:\\Foo\\Bar"], "c:\\foo\\bar", 0);
assert.deepEqual(win, ["C:\\Foo\\Bar"]); // original casing preserved, no duplicate
assert.equal(reorderPinned(["C:\\Foo\\Bar"], "c:\\FOO\\BAR", 5).length, 1);

// --- bad target values fall back to front ---------------------------------------
assert.deepEqual(reorderPinned(["a", "b"], "x", NaN), ["x", "a", "b"]);
assert.deepEqual(reorderPinned(["a", "b"], "x", -3), ["x", "a", "b"]);

console.log("pinned-order tests passed");
