/** Line-level diff for the unified edit-tool view (git-style rows). */

export type DiffRow =
  | { kind: "context"; oldNo: number; newNo: number; text: string }
  | { kind: "removed"; oldNo: number; text: string }
  | { kind: "added"; newNo: number; text: string };

/** DP table cell cap. Edit snippets are small; beyond this the LCS table is
 * not worth allocating and callers fall back to plain before/after blocks. */
const MAX_CELLS = 2_000_000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // A trailing newline terminates the last line rather than starting an empty one.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Compute git-style unified rows between two texts, or null when the inputs
 * are too large for the LCS table. Deletions are listed before insertions
 * within each changed run, matching `git diff` reading order. */
export function diffLines(oldText: string, newText: string): DiffRow[] | null {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length * b.length > MAX_CELLS) return null;

  // dp[i][j] = LCS length of a[i:] and b[j:].
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }

  // Backtrack into an edit script.
  type Op = { kind: "eq" | "del"; text: string } | { kind: "ins"; text: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "eq", text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      ops.push({ kind: "del", text: a[i] });
      i++;
    } else {
      ops.push({ kind: "ins", text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", text: a[i++] });
  while (j < m) ops.push({ kind: "ins", text: b[j++] });

  // Number the rows; reorder each changed run so deletions precede insertions.
  const rows: DiffRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  let k = 0;
  while (k < ops.length) {
    if (ops[k].kind === "eq") {
      rows.push({ kind: "context", oldNo, newNo, text: ops[k].text });
      oldNo++;
      newNo++;
      k++;
      continue;
    }
    let end = k;
    while (end < ops.length && ops[end].kind !== "eq") end++;
    for (let x = k; x < end; x++) {
      if (ops[x].kind === "del") rows.push({ kind: "removed", oldNo: oldNo++, text: ops[x].text });
    }
    for (let x = k; x < end; x++) {
      if (ops[x].kind === "ins") rows.push({ kind: "added", newNo: newNo++, text: ops[x].text });
    }
    k = end;
  }
  return rows;
}
