/**
 * 文件类型分类——**三端同源守卫**。
 *
 * 背景（2026-11-04）：文件卡片要按类型给图标（压缩包 / 文档 / 表格 / 代码…）。
 * 分类表在三处存在，因为三个客户端是独立构建、跨语言：
 *
 *   源     src/shared/file-kind.ts              （桌面 + 主进程）
 *   副本   mobile/pwa/src/lib/file-kind.ts      （PWA）
 *   副本   mobile/app/.../data/FileKinds.kt     （安卓）
 *
 * 「一份源 + 两份副本」是本仓既有约定（同 `image-notes.ts` / choice-block），但副本
 * 最大的风险是**改一处忘另一处**：桌面把 .7z 认成压缩包、手机却认成普通文件，用户
 * 看到的是同一个文件两张脸。所以这里做两件事：
 *
 *   1. **逐条比对三份映射表**（后缀全集 + 每条的分类），谁多谁少谁改都报错；
 *   2. 钉住判定入口的优先级（后缀优先于 mime），避免两端对同一输入给不同答案。
 *
 * 只解析源码文本（正则），不依赖构建：安卓那份是 Kotlin，TS 侧无法 import。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { register } from "node:module";

register(new URL("./ts-ext-loader.mjs", import.meta.url));

const ROOT = resolve(import.meta.dirname, "..");
const shared = await import("../src/shared/file-kind.ts");
const pwa = await import("../mobile/pwa/src/lib/file-kind.ts");

// --- 1. 两份 TS 实现行为等价 -------------------------------------------------
const SAMPLE = [
  "报表.xlsx", "报告.pdf", "资料.zip", "包.tar.gz", "说明.md", "截图.png",
  "录像.mp4", "录音.mp3", "源码.ts", "未知.bin", "无后缀", "契约.docx",
  "演示.pptx", "数据.csv", "旧表.xls", "页.git", ".env", "C:\\a\\b\\c.7z",
  "/x/y/z.APK",
];
for (const name of SAMPLE) {
  assert.equal(
    pwa.fileCategory(name),
    shared.fileCategory(name),
    `PWA 与 shared 对 ${name} 的分类必须一致`,
  );
  assert.equal(pwa.extOf(name), shared.extOf(name), `extOf(${name}) 必须一致`);
}

// 后缀优先于 mime（两端同一优先级）。
assert.equal(shared.fileCategory("报表.xlsx", "image/png"), "sheet", "后缀优先：.xlsx 不该被判成图片");
assert.equal(pwa.fileCategory("报表.xlsx", "image/png"), "sheet", "PWA 同一口径");
// 无后缀时才看 mime。
assert.equal(shared.fileCategory("无后缀", "application/pdf"), "pdf");
assert.equal(pwa.fileCategory("无后缀", "application/pdf"), "pdf");
// octet-stream 不猜（交给后缀），没有后缀 → other。
assert.equal(shared.fileCategory("无后缀", "application/octet-stream"), "other");
console.log("ok 1 - 两份 TS 实现行为等价（含后缀优先于 mime）");

// --- 2. 安卓那份：解析 Kotlin 映射表，逐条比对 -------------------------------
function parseKotlinTable(file) {
  const source = readFileSync(file, "utf8");
  const start = source.indexOf("val EXT_CATEGORY");
  assert.ok(start >= 0, "FileKinds.kt 里找不到 EXT_CATEGORY（改名了？测试要跟着改）");
  const end = source.indexOf(")", start);
  assert.ok(end > start, "EXT_CATEGORY 的 mapOf( 没有闭合");
  const body = source.slice(start, end);
  const table = new Map();
  for (const m of body.matchAll(/"([^"]+)"\s+to\s+FileCategory\.(\w+)/g)) {
    table.set(`.${m[1]}`, m[2].toLowerCase());
  }
  return table;
}

const KOTLIN = resolve(ROOT, "mobile/app/app/src/main/java/com/mpi/app/data/FileKinds.kt");
const kotlin = parseKotlinTable(KOTLIN);
assert.ok(kotlin.size > 80, `Kotlin 表至少应有 80 个后缀（实际解析到 ${kotlin.size}，解析器坏了？）`);

const tsEntries = new Map(Object.entries(shared.EXT_CATEGORY));
for (const [ext, cat] of tsEntries) {
  assert.ok(kotlin.has(ext), `安卓缺少后缀 ${ext}（分类 ${cat}）——两边会显示成不同图标`);
  assert.equal(
    kotlin.get(ext),
    cat,
    `后缀 ${ext} 分类漂移：shared=${cat} / 安卓=${kotlin.get(ext)}`,
  );
}
for (const ext of kotlin.keys()) {
  assert.ok(tsEntries.has(ext), `安卓多出后缀 ${ext}（shared 里没有）——两份表要对齐`);
}
console.log(`ok 2 - 安卓 FileKinds.kt 与 shared 逐条对齐（${tsEntries.size} 个后缀）`);

// --- 3. 三端图标都覆盖了全部大类 --------------------------------------------
// 漏一个大类 → 那个类型在某一端会掉成默认图标（不明显，但就是不齐）。
const CATEGORIES = ["archive", "pdf", "doc", "sheet", "slide", "code", "text", "image", "audio", "video", "other"];

const FileTypeIconSrc = readFileSync(resolve(ROOT, "src/renderer/src/components/FileTypeIcon.tsx"), "utf8");
for (const cat of CATEGORIES) {
  assert.ok(
    new RegExp(`^\\s*${cat}:`, "m").test(FileTypeIconSrc),
    `桌面 FileTypeIcon 缺少 ${cat} 的配色/画法（FILE_CATEGORY_TO_CAT 会映射到不存在的 Cat）`,
  );
}

const PwaIconSrc = readFileSync(resolve(ROOT, "mobile/pwa/src/components/FileKindIcon.tsx"), "utf8");
for (const cat of CATEGORIES) {
  assert.ok(new RegExp(`^\\s*${cat}:`, "m").test(PwaIconSrc), `PWA FileKindIcon 缺少 ${cat} 的徽标配色`);
}

const KotlinIconSrc = readFileSync(resolve(ROOT, "mobile/app/app/src/main/java/com/mpi/app/ui/FileKindIcon.kt"), "utf8");
// text / other 在安卓里是「无徽标」分支，所以在 BADGE_COLORS 里查不到是**预期**的。
for (const cat of CATEGORIES.filter((c) => c !== "text" && c !== "other")) {
  const kotlinName = cat[0].toUpperCase() + cat.slice(1);
  assert.ok(
    KotlinIconSrc.includes(`FileCategory.${kotlinName} to`) || KotlinIconSrc.includes(`FileCategory.${kotlinName} ->`),
    `安卓 FileKindIcon 缺少 ${cat}（FileCategory.${kotlinName}）的配色或画法`,
  );
}
console.log("ok 3 - 三端图标覆盖全部 11 个大类");

// --- 4. Kotlin 的枚举与 TS 的大类名一一对应 --------------------------------
const kotlinEnums = [...readFileSync(KOTLIN, "utf8").matchAll(/^\s{4}(\w+),$/gm)].map((m) =>
  m[1].replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase(),
);
for (const cat of CATEGORIES) {
  assert.ok(kotlinEnums.includes(cat), `Kotlin FileCategory 枚举缺少 ${cat}（实际：${kotlinEnums.join(",")}）`);
}
console.log("ok 4 - Kotlin 枚举与 TS 大类名一一对应");

console.log("\n文件类型分类：三端同源检查全部通过");
