import assert from "node:assert/strict";
import { diffLines } from "../src/renderer/src/lib/diff.ts";

const ctx = (oldNo, newNo, text) => ({ kind: "context", oldNo, newNo, text });
const del = (oldNo, text) => ({ kind: "removed", oldNo, text });
const add = (newNo, text) => ({ kind: "added", newNo, text });

// --- simple single-line replacement ----------------------------------------
assert.deepEqual(diffLines("a\nb\nc", "a\nB\nc"), [ctx(1, 1, "a"), del(2, "b"), add(2, "B"), ctx(3, 3, "c")]);

// --- insertion --------------------------------------------------------------
assert.deepEqual(diffLines("a\nc", "a\nx\nc"), [ctx(1, 1, "a"), add(2, "x"), ctx(2, 3, "c")]);

// --- deletion -----------------------------------------------------------------
assert.deepEqual(diffLines("a\nx\nc", "a\nc"), [ctx(1, 1, "a"), del(2, "x"), ctx(3, 2, "c")]);

// --- identical text: all context ---------------------------------------------
assert.deepEqual(diffLines("a\nb", "a\nb"), [ctx(1, 1, "a"), ctx(2, 2, "b")]);

// trailing newline is not a phantom empty line
assert.deepEqual(diffLines("a\nb\n", "a\nb"), [ctx(1, 1, "a"), ctx(2, 2, "b")]);

// --- completely different: deletions before insertions ------------------------
assert.deepEqual(diffLines("x\ny", "p\nq"), [del(1, "x"), del(2, "y"), add(1, "p"), add(2, "q")]);

// --- pure insertion / pure deletion -------------------------------------------
assert.deepEqual(diffLines("", "a\nb"), [add(1, "a"), add(2, "b")]);
assert.deepEqual(diffLines("a", ""), [del(1, "a")]);

// --- CJK content ----------------------------------------------------------------
assert.deepEqual(diffLines("第一行\n第二行", "第一行\n改过的行"), [ctx(1, 1, "第一行"), del(2, "第二行"), add(2, "改过的行")]);

// --- multi-line change in the middle --------------------------------------------
{
  const old = ["l1", "l2", "old-a", "old-b", "l5", "l6"].join("\n");
  const next = ["l1", "l2", "new-a", "l5", "l6", "l7"].join("\n");
  assert.deepEqual(diffLines(old, next), [
    ctx(1, 1, "l1"),
    ctx(2, 2, "l2"),
    del(3, "old-a"),
    del(4, "old-b"),
    add(3, "new-a"),
    ctx(5, 4, "l5"),
    ctx(6, 5, "l6"),
    add(6, "l7"),
  ]);
}

// --- size guard: too large for the LCS table ------------------------------------
{
  const big = Array.from({ length: 1500 }, (_, i) => `line-${i}`).join("\n");
  assert.equal(diffLines(big, big + "\ntail"), null);
}

console.log("diff tests passed");
