import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

// 源文件用打包器风格的无扩展名 import，这里给 node 补上解析。
register(new URL("./ts-ext-loader.mjs", import.meta.url));
const { collectAttachmentNames, exportFileName, projectDirNameFor, exportSessionZip, exportSessionBundle } = await import(
  "../src/main/session-export.ts"
);
const { importSessionZip } = await import("../src/main/backup.ts");

// ---------- 引用名收集：只认 attach="media" / "video" 的信封 ----------
// 注意契约：入参是 **JSONL 原文**（信封在 JSON 字符串里，属性引号被转义），
// 所以这里必须先 JSON.stringify 再交给函数。
const refText = [
  '<file name="a.mp4" path="C:/x/a.mp4" attach="media" kind="video" />',
  '<file name="b.pdf" path="C:/x/b.pdf" attach="media" kind="file" />',
  // 重复的引用名只收一次
  '<file name="a.mp4" path="C:/x/a.mp4" attach="media" kind="video" />',
  // 没有 attach 标记的是「给模型读的输入文件」，不是附件
  '<file path="C:/x/src.ts" name="src.ts" />',
  // 旧式 attach="video"
  '<file name="c.webm" attach="video" path="C:/x/c.webm" />',
].join(" ");
const refsJsonl = JSON.stringify({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text: refText }] },
});
assert.deepEqual(collectAttachmentNames(refsJsonl), ["a.mp4", "b.pdf", "c.webm"]);
// content 为纯字符串时也要能扫到
const stringContentJsonl = JSON.stringify({
  type: "message",
  message: { role: "user", content: '<file name="d.png" attach="media" path="/x/d.png" />' },
});
assert.deepEqual(collectAttachmentNames(stringContentJsonl), ["d.png"]);
assert.deepEqual(collectAttachmentNames(""), []);
assert.deepEqual(collectAttachmentNames("not json\n{bad"), []);

// ---------- 文件名清洗 ----------
assert.equal(exportFileName('a/b\\c:d*e?f"g<h>i|j'), "a b c d e f g h i j");
assert.equal(exportFileName("  \n\t  "), "session");
assert.equal(exportFileName("字".repeat(120)).length, 80);
assert.equal(projectDirNameFor("C:/sessions/--E--ws-Proj--/s.jsonl"), "--E--ws-Proj--");

// ---------- 导出 → 导入 往返 ----------
const root = mkdtempSync(join(tmpdir(), "mpi-session-export-"));
try {
  const projDir = join(root, "sessions", "--E--ws-Proj--");
  mkdirSync(projDir, { recursive: true });
  const sessionFile = join(projDir, "2026-10-29T08-00-00-000Z_abc.jsonl");
  const sessionBody =
    '{"type":"session","cwd":"E:\\\\ws\\\\Proj"}\n' +
    '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"看这个视频"},{"type":"image","data":"AAA","mimeType":"image/png"}]}}\n';
  writeFileSync(sessionFile, sessionBody);

  const attachFile = join(root, "a.mp4");
  const attachBytes = Buffer.from("fake-video-bytes");
  writeFileSync(attachFile, attachBytes);
  // 会话里引用 a.mp4，另有一个引用 c.webm 在本机不存在 → 应被跳过而不是让整包失败
  writeFileSync(
    sessionFile,
    sessionBody +
      '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"<file name=\\"a.mp4\\" path=\\"/x/a.mp4\\" attach=\\"media\\" kind=\\"video\\" /> <file name=\\"c.webm\\" path=\\"/x/c.webm\\" attach=\\"video\\" />"}]}}\n',
  );

  const zipPath = join(root, "pack.zip");
  const result = await exportSessionZip(zipPath, {
    file: sessionFile,
    title: "测试会话",
    cwd: "E:\\ws\\Proj",
    appVersion: "0.0.0-test",
    attachments: {
      pathFor: (name) => (name === "a.mp4" ? attachFile : null),
      metaFor: (name) => (name === "a.mp4" ? { key: "k".repeat(64), mime: "video/mp4", label: "演示视频.mp4" } : null),
    },
  });
  assert.equal(result.ok, true, "export should succeed");
  assert.equal(result.attachments, 1, "只打包存在的附件");
  assert.equal(result.skipped, 1, "缺失的附件记一次 skipped");

  // 包结构：<项目目录>/<会话>.jsonl + attachments/<引用名> + manifest.json
  const JSZip = (await import("jszip")).default;
  const zip = await new JSZip().loadAsync(readFileSync(zipPath));
  const names = Object.keys(zip.files).sort();
  assert.ok(names.includes("--E--ws-Proj--/2026-10-29T08-00-00-000Z_abc.jsonl"), "会话文件保持项目目录结构");
  assert.ok(names.includes("attachments/a.mp4"), "附件按引用名落地");
  assert.ok(names.includes("manifest.json"));
  assert.equal((await zip.file("attachments/a.mp4").async("nodebuffer")).toString(), attachBytes.toString());

  const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
  assert.equal(manifest.kind, "session-export");
  assert.equal(manifest.title, "测试会话");
  assert.equal(manifest.attachments.length, 1);
  assert.equal(manifest.attachments[0].mime, "video/mp4");
  assert.equal(manifest.attachments[0].label, "演示视频.mp4");

  // ---- 导入：jsonl 落到 sessions 根下同结构；附件交给钩子 ----
  const importRoot = join(root, "imported");
  const landed = [];
  const imported = await importSessionZip(zipPath, "skip", importRoot, {
    storeAttachment: ({ name, bytes, label, mime }) => {
      landed.push({ name, size: bytes.length, label, mime });
      return true;
    },
  });
  assert.equal(imported.imported, 1);
  assert.equal(imported.attachments, 1, "附件计数回传给设置页");
  assert.deepEqual(landed, [{ name: "a.mp4", size: attachBytes.length, label: "演示视频.mp4", mime: "video/mp4" }]);
  const back = readFileSync(join(importRoot, "--E--ws-Proj--", "2026-10-29T08-00-00-000Z_abc.jsonl"), "utf8");
  assert.equal(back, readFileSync(sessionFile, "utf8"), "jsonl 逐字节原样（图片 base64 自带，不改写）");

  // 旧式纯备份包（无 attachments/）仍然可导入，附件计数为 0
  const plain = new JSZip();
  plain.file("--E--ws-Proj--/old.jsonl", '{"type":"session"}\n');
  const plainPath = join(root, "plain.zip");
  writeFileSync(plainPath, await plain.generateAsync({ type: "nodebuffer" }));
  const plainResult = await importSessionZip(plainPath, "skip", importRoot, { storeAttachment: () => true });
  assert.equal(plainResult.imported, 1);
  assert.equal(plainResult.attachments, 0);
  // ---- 批量导出：两个会话合成一个包，共享附件只打一次，导入端一次全收 ----
  const proj2 = join(root, "sessions", "--E--ws-Other--");
  mkdirSync(proj2, { recursive: true });
  const session2 = join(proj2, "2026-10-29T09-00-00-000Z_def.jsonl");
  writeFileSync(session2, readFileSync(sessionFile));
  const batchZip = join(root, "batch.zip");
  const batch = await exportSessionBundle(batchZip, {
    sessions: [
      { file: sessionFile, title: "会话 A", cwd: "E:\ws\Proj" },
      { file: session2, title: "会话 B", cwd: "E:\ws\Other" },
    ],
    appVersion: "0.0.0-test",
    attachments: {
      pathFor: (name) => (name === "a.mp4" ? attachFile : null),
      metaFor: () => ({ mime: "video/mp4", label: "演示视频.mp4" }),
    },
  });
  assert.equal(batch.ok, true, "批量导出应成功");
  assert.equal(batch.sessions, 2);
  assert.equal(batch.attachments, 1, "两个会话引用同一附件时只打包一次");

  const bz = await new JSZip().loadAsync(readFileSync(batchZip));
  const bnames = Object.keys(bz.files).sort();
  assert.ok(bnames.includes("--E--ws-Proj--/2026-10-29T08-00-00-000Z_abc.jsonl"));
  assert.ok(bnames.includes("--E--ws-Other--/2026-10-29T09-00-00-000Z_def.jsonl"), "不同项目的会话落在各自目录");
  // 注意：JSZip 的 files 里还有目录条目（`attachments/` 结尾带斜杠），只数真正的文件。
  assert.equal(bnames.filter((n) => n.startsWith("attachments/") && !n.endsWith("/")).length, 1);
  const bman = JSON.parse(await bz.file("manifest.json").async("string"));
  assert.equal(bman.kind, "session-export");
  assert.equal(bman.sessions.length, 2, "manifest 里列出全部会话");

  const ImportedBatch = await importSessionZip(batchZip, "skip", join(root, "imported2"), {
    storeAttachment: () => true,
  });
  assert.equal(ImportedBatch.imported, 2, "导入端一次收下两个会话");
  assert.equal(ImportedBatch.attachments, 1);

} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("session-export: all assertions passed");
