// 准备手机 App 的发布产物：版本化 APK + 中继 /download/ 用的清单。
//
// 用法：node scripts/publish-android.mjs [apk 路径]
//   默认取 android/app/build/outputs/apk/debug/app-debug.apk，版本号从
//   android/app/build.gradle.kts 的 versionName 读。
//
// 产物落在 android/publish/（已 gitignore）：
//   mpi-android-<version>.apk / .sha256 / mpi-android.json
// 上传（中继静态目录，桌面端「手机 App」卡片会读这份清单）：
//   /var/www/mpi-mobile/download/{mpi-android-<version>.apk,mpi-android.json}
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const arg = process.argv[2];
const apkPath = resolve(root, arg && !arg.startsWith("--") ? arg : "android/app/build/outputs/apk/debug/app-debug.apk");

const gradle = readFileSync(resolve(root, "android", "app", "build.gradle.kts"), "utf8");
const version = /versionName\s*=\s*"([^"]+)"/.exec(gradle)?.[1] ?? "0.0.0";

const bytes = readFileSync(apkPath);
const sha256 = createHash("sha256").update(bytes).digest("hex").toUpperCase();
const file = `mpi-android-${version}.apk`;

const outDir = resolve(root, "android", "publish");
mkdirSync(outDir, { recursive: true });
copyFileSync(apkPath, join(outDir, file));
writeFileSync(join(outDir, `${file}.sha256`), `${sha256}  ${file}\n`);
const manifest = { version, file, size: bytes.length, sha256, publishedAt: new Date().toISOString() };
writeFileSync(join(outDir, "mpi-android.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`源文件 : ${apkPath} (${(bytes.length / 1024 / 1024).toFixed(2)} MB)`);
console.log(`版本   : ${version}`);
console.log(`SHA256 : ${sha256}`);
console.log(`产物   : ${outDir}`);
console.log("");
console.log("上传到中继（/var/www/mpi-mobile/download/）后，桌面端「手机 App」卡片即可显示版本与下载二维码。");
