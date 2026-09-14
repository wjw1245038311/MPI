/**
 * S6.1 验收：§4.5 审批 diff 扩展（主机端）。
 *   - parseApprovalHeading：en/zh 标题解析、非审批请求 → null
 *   - buildApprovalDiff：write/edit 新旧内容 unified diff、+N -M 统计一致、
 *     新文件全增、通配符/裸路径/非 write 工具 → undefined、>50KB 截断带省略标记
 *   - sanitizeRemoteUiRequest：白名单含 diff、剥离未知字段
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { buildApprovalDiff, parseApprovalHeading, sanitizeRemoteUiRequest } from "../src/main/remote/approval-diff.ts";

const heading = (tool, reason, detail) => `Permission required: ${tool}\n${reason}\n\n${detail}`;

// ---- parseApprovalHeading -------------------------------------------------
{
  const en = parseApprovalHeading(heading("write", "Strict mode: every file write or edit requires confirmation.", '{"path":"a.ts"}'));
  assert.equal(en?.tool, "write");
  assert.equal(en?.detail, '{"path":"a.ts"}');

  const zh = parseApprovalHeading(`权限确认：edit\n严格模式：所有文件写入/编辑需确认。\n\n{"path":"b.ts"}`);
  assert.equal(zh?.tool, "edit");
  assert.equal(zh?.detail, '{"path":"b.ts"}');

  // detail 本身含 \n（pretty JSON）→ 取第一个 \n\n 之后的全部
  const multi = parseApprovalHeading(heading("write", "r", '{\n  "path": "c.ts"\n}'));
  assert.equal(multi?.detail, '{\n  "path": "c.ts"\n}');

  // 无 detail（只有 reason）→ detail ""
  const noDetail = parseApprovalHeading("Permission required: Shell\nsome reason");
  assert.equal(noDetail?.tool, "Shell");
  assert.equal(noDetail?.detail, "");

  // 非审批请求 → null
  assert.equal(parseApprovalHeading("随便一个标题"), null);
  assert.equal(parseApprovalHeading(""), null);
}

// ---- buildApprovalDiff ----------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "mpi-approval-diff-"));
try {
  // write：修改已有文件
  const relA = path.join("src", "a.ts");
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, relA), ["line1", "line2", "line3", "line4"].join("\n"), "utf8");
  const newContentA = ["line1", "CHANGED", "line3", "line4", "line5"].join("\n");
  const diffA = await buildApprovalDiff(dir, heading("write", "r", JSON.stringify({ path: relA, content: newContentA })));
  assert.ok(diffA, "write diff should exist");
  assert.equal(diffA.path, relA);
  assert.equal(diffA.added, 2); // CHANGED + line5
  assert.equal(diffA.removed, 1); // line2
  assert.match(diffA.hunks, /@@ -\d+,\d+ \+\d+,\d+ @@/);
  assert.match(diffA.hunks, /\+CHANGED/);
  assert.match(diffA.hunks, /-line2/);
  assert.match(diffA.hunks, / line1/); // 上下文

  // edit：edits[] 应用到旧内容
  const relB = "b.txt";
  writeFileSync(path.join(dir, relB), "alpha\nbeta\ngamma\n", "utf8");
  const diffB = await buildApprovalDiff(
    dir,
    heading("edit", "r", JSON.stringify({ path: relB, edits: [{ oldText: "beta", newText: "BETA" }] })),
  );
  assert.ok(diffB);
  assert.equal(diffB.added, 1);
  assert.equal(diffB.removed, 1);
  assert.match(diffB.hunks, /\+BETA/);
  assert.match(diffB.hunks, /-beta/);

  // edit：oldText 未命中 → undefined（无法安全应用）
  const diffMiss = await buildApprovalDiff(
    dir,
    heading("edit", "r", JSON.stringify({ path: relB, edits: [{ oldText: "not-there", newText: "x" }] })),
  );
  assert.equal(diffMiss, undefined);

  // 新文件：全增（父目录不存在也 OK——old=""）
  const diffNew = await buildApprovalDiff(dir, heading("write", "r", JSON.stringify({ path: "new/file.md", content: "# hi\n" })));
  assert.ok(diffNew);
  // "# hi\n" → ["# hi", ""]；旧文件不存在 old="" → [""]，尾部空行 LCS 匹配
  assert.equal(diffNew.added, 1);
  assert.equal(diffNew.removed, 0);

  // 非 write/edit 工具 → undefined
  const diffShell = await buildApprovalDiff(dir, heading("Shell", "r", JSON.stringify({ command: "rm -rf /" })));
  assert.equal(diffShell, undefined);

  // 通配符路径 → undefined
  const diffWild = await buildApprovalDiff(dir, heading("write", "r", JSON.stringify({ path: "src/*.ts", content: "x" })));
  assert.equal(diffWild, undefined);

  // detail 是裸路径（敏感文件场景）→ JSON.parse 失败 → undefined
  const diffBare = await buildApprovalDiff(dir, heading("write", "r", ".env"));
  assert.equal(diffBare, undefined);

  // edit 无 edits 字段 → undefined
  const diffNoEdits = await buildApprovalDiff(dir, heading("edit", "r", JSON.stringify({ path: relB })));
  assert.equal(diffNoEdits, undefined);

  // >50KB 截断：1→1900 行，每行 ~36 字节 → hunks ≈ 68KB
  const bigLines = Array.from({ length: 1900 }, (_, i) => `line-${i}: some padding text here`);
  const diffBig = await buildApprovalDiff(dir, heading("write", "r", JSON.stringify({ path: "big.txt", content: bigLines.join("\n") })));
  assert.ok(diffBig, "big diff should exist");
  const markerBytes = Buffer.byteLength("…（diff 超限截断，完整内容见桌面端）", "utf8");
  assert.ok(Buffer.byteLength(diffBig.hunks, "utf8") <= 50 * 1024 + markerBytes, `truncated to ≤50KB (got ${Buffer.byteLength(diffBig.hunks)})`);
  assert.match(diffBig.hunks, /…（diff 超限截断/);

  // 无变化 → undefined（不附 diff）
  const same = await buildApprovalDiff(dir, heading("write", "r", JSON.stringify({ path: relB, content: readFileSync(path.join(dir, relB), "utf8") })));
  assert.equal(same, undefined);

  // 尺寸守卫：>2000 行 → undefined（不跑大 DP）
  const huge = Array.from({ length: 2500 }, (_, i) => `h${i}`);
  const diffHuge = await buildApprovalDiff(dir, heading("write", "r", JSON.stringify({ path: "huge.txt", content: huge.join("\n") })));
  assert.equal(diffHuge, undefined);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ---- sanitizeRemoteUiRequest ----------------------------------------------
{
  const req = {
    id: "abc",
    method: "select",
    title: "Permission required: write\nr\n\ndetail",
    options: ["仅允许本次", "拒绝"],
    diff: { path: "a.ts", added: 1, removed: 0, hunks: "+x" },
    evil: "should-be-stripped",
  };
  const safe = sanitizeRemoteUiRequest(req);
  assert.deepEqual(Object.keys(safe).sort(), ["diff", "id", "method", "options", "title"].sort());
  assert.deepEqual(safe.diff, req.diff);
  assert.equal("evil" in safe, false);
}

console.log("approval-diff: all assertions passed");
process.exit(0);
