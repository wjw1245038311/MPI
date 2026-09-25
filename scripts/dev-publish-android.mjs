#!/usr/bin/env node
/**
 * dev-publish-android.mjs —— 开发期「一键把新构建推到手机可更新的地方」。
 *
 * 为什么需要：正式渠道是 GitHub Release + 中继（aliyun-ecs）。开发期反复装包时，
 * GitHub 慢/被墙，中继（Tailscale 经 DERP）实测约 1.85MB/s → 28MB 要 15 秒。
 * 而**手机从 Seafile 分享链下载实测 6MB/s**（走那条 443 隧道）→ 28MB 约 5 秒。
 *
 * 做法：把 APK 放进本机 SeaDrive 同步的分发目录（分享链服务的就是它），
 * 清单里用 **`url` 字段**写绝对地址——APP 侧 `Updater.kt` 的
 *   val urlField = obj["url"]; url = resolveAsset(base, urlField, file)
 * 对 http(s) 开头原样使用，所以**不需要改 APP、不需要发版**。
 *
 * 用法（分享链接是凭证，从 env / 参数传，不硬编码）：
 *   MPI_SEAFILE_SHARE="http://workstation.tail38d5a.ts.net/d/<token>" \
 *     node scripts/dev-publish-android.mjs
 *
 *   --no-bump    不动 gradle 版本号
 *   --no-build   复用现有 app-debug.apk（快；**与版本自增互斥**）
 *   --no-push    只生成产物，不推到中继
 *   --dry-run    只打印将要写的内容，不落盘、不推送
 *
 * 注意：
 *   · APP 先看 GitHub 清单、版本不更新时才落到中继那份。开发期你装的一定比 GitHub 上的
 *     新，所以永远走中继 ✓（这也是不用改 APP 的原因）。
 *   · 分享链是 **http**（明文）→ 只有 debug 构建能下（`src/debug/AndroidManifest.xml`
 *     放行了明文）。换 release 构建时这条快路要改成 HTTPS。
 *   · 版本号自增会弄脏 `mobile/app/app/build.gradle.kts`（开发期用；之后自行 revert 或提交）。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const GRADLE = join(ROOT, "mobile/app/app/build.gradle.kts");
const DEBUG_APK = join(ROOT, "mobile/app/app/build/outputs/apk/debug/app-debug.apk");
const PUBLISH_DIR = join(ROOT, "mobile/app/publish");
/** 本机 SeaDrive 同步的分发目录——分享链服务的就是这个目录。 */
const SHARE_DIR = process.env.MPI_DEV_SHARE_DIR || "E:/Seafile/wei_jw2/我的资料库/Agent";
const RELAY_HOST = process.env.MPI_RELAY_HOST || "root@100.67.5.31";
const RELAY_DOWNLOAD = "/var/www/mpi-mobile/download";

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const noBump = has("--no-bump");
const noBuild = has("--no-build");
const noPush = has("--no-push");
const dryRun = has("--dry-run");
const shareBase = (valueOf("--share") || process.env.MPI_SEAFILE_SHARE || "").replace(/\/+$/, "");

const log = (m) => console.log(m);
const sha256Upper = (file) => createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase();

function currentVersion() {
  return /versionName\s*=\s*"([^"]+)"/.exec(readFileSync(GRADLE, "utf8"))?.[1] ?? null;
}

function bumpVersion() {
  const text = readFileSync(GRADLE, "utf8");
  const code = Number(/versionCode\s*=\s*(\d+)/.exec(text)?.[1] ?? 0);
  const name = currentVersion() ?? "0.0.0";
  const parts = name.split(".").map(Number);
  parts[parts.length - 1] += 1;
  const next = parts.join(".");
  if (!dryRun) {
    writeFileSync(
      GRADLE,
      text.replace(/versionCode\s*=\s*\d+/, `versionCode = ${code + 1}`).replace(/versionName\s*=\s*"[^"]+"/, `versionName = "${next}"`),
    );
  }
  log(`   版本号  ${name} → ${next}（versionCode ${code} → ${code + 1}）${dryRun ? "（dry-run 不落盘）" : ""}`);
  return next;
}

function main() {
  if (!shareBase) {
    log("缺少 Seafile 分享链接。用法：");
    log('  MPI_SEAFILE_SHARE="http://workstation.tail38d5a.ts.net/d/<token>" node scripts/dev-publish-android.mjs');
    process.exit(64);
  }
  log("dev-publish-android：开发期一键发布（APK 走 Seafile 分享链）\n");
  log(`   分享基数：${shareBase}`);
  log(`   分发目录：${SHARE_DIR}\n`);

  log("  [1/5] 版本号");
  // ⚠️ 自增版本号却跳过构建 = 清单写 0.5.37、而 APK 内部的 versionName 还是 0.5.36
  // （清单里带的是文件外部的版本号，构建 APK 时才会写进 BuildConfig）→ 装上后会**反复
  // 提示更新**（死循环）。所以这个组合直接拒掉，而不是出一个看似成功的错产品。
  if (!noBump && noBuild) {
    throw new Error("--no-bump 与 --no-build 不能同时用：自增版本号必须重新构建 APK，否则清单版本与包内版本不一致（会无限提示更新）");
  }
  const version = noBump ? currentVersion() : bumpVersion();
  if (!version) throw new Error("读不到 versionName");

  if (!noBuild && !dryRun) {
    log("  [2/5] 构建 APK（gradlew assembleDebug）…");
    // 注意：`gradlew` 是 POSIX shell 脚本，Windows 上必须经 bash 执行
    // （直接 spawnSync 会因没有可执行映像而失败）。这也与项目约定一致：
    // 唯一 shell 是 Git Bash，文档里的命令就是 `./gradlew assembleDebug`。
    const built = spawnSync(process.env.MPI_BASH || "bash", ["gradlew", "assembleDebug"], {
      cwd: join(ROOT, "mobile/app"),
      stdio: "inherit",
      env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME || "E:/MyWorkspace/Software/jdk21" },
    });
    if (built.status !== 0) throw new Error(`gradlew assembleDebug 失败（退出码 ${built.status}）`);
  } else {
    log("  [2/5] 跳过构建");
  }
  if (!existsSync(DEBUG_APK)) throw new Error(`找不到 APK：${DEBUG_APK}`);
  const { size } = statSync(DEBUG_APK);

  log("  [3/5] 分发 APK");
  const apkName = `MPI-Android-Native-${version}.apk`;
  const sha = sha256Upper(DEBUG_APK);
  if (!dryRun) {
    mkdirSync(PUBLISH_DIR, { recursive: true });
    mkdirSync(SHARE_DIR, { recursive: true });
    copyFileSync(DEBUG_APK, join(PUBLISH_DIR, apkName));
    copyFileSync(DEBUG_APK, join(SHARE_DIR, apkName));
    writeFileSync(join(SHARE_DIR, `${apkName}.sha256`), `${sha}  ${apkName}\n`);
  }
  log(`   ${apkName}  ${(size / 1048576).toFixed(1)} MB`);
  log(`   sha256 ${sha}`);

  log("  [4/5] 写清单（url 字段 = 绝对地址）");
  const manifest = {
    version,
    file: apkName, // 相对名（中继兜底用；本轮会被 url 覆盖）
    url: `${shareBase}/files/?p=/${encodeURIComponent(apkName)}&dl=1`,
    size,
    sha256: sha,
    publishedAt: new Date().toISOString().slice(0, 10),
    github: "",
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  if (!dryRun) {
    writeFileSync(join(PUBLISH_DIR, "mpi-android-native.json"), manifestJson);
    writeFileSync(join(SHARE_DIR, "mpi-android-native.json"), manifestJson);
  }
  log(manifestJson.split("\n").filter(Boolean).map((line) => `   ${line}`).join("\n"));

  log("  [5/5] 推清单到中继（APP 从 GitHub 清单落到中继那份时才会看到）");
  const remote = `${RELAY_HOST}:${RELAY_DOWNLOAD}`;
  if (noPush || dryRun) {
    log("   已跳过（--no-push / --dry-run）。手动命令：");
    log(`     scp "${join(SHARE_DIR, "mpi-android-native.json")}" ${remote}/mpi-native.tmp`);
    log(`     ssh ${RELAY_HOST} 'mv ${RELAY_DOWNLOAD}/mpi-native.tmp ${RELAY_DOWNLOAD}/mpi-android-native.json'`);
  } else {
    const scp = spawnSync("scp", ["-o", "BatchMode=yes", join(SHARE_DIR, "mpi-android-native.json"), `${remote}/mpi-native.tmp`], { stdio: "inherit" });
    const mv = scp.status === 0
      ? spawnSync("ssh", ["-o", "BatchMode=yes", RELAY_HOST, `mv ${RELAY_DOWNLOAD}/mpi-native.tmp ${RELAY_DOWNLOAD}/mpi-android-native.json`], { stdio: "inherit" })
      : { status: 1 };
    log(mv.status === 0 ? "   ✓ 清单已就位（手机点「检测更新」即可）" : "   ✗ 推送失败，见上面输出");
  }

  log("\n手机侧预期：检测到 v" + version + `，从 Seafile 下 ${(size / 1048576).toFixed(1)}MB（实测 6MB/s ≈ ${Math.round(size / 6291456)} 秒）`);
  if (!noBump) log("提醒：gradle 版本号已自增（开发期改动，之后自行 revert 或提交）。");
}

main();
