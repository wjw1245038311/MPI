// 准备手机 App 的发布产物：版本化 APK + 清单；可选上传到 GitHub Release 作备选源。
//
// 用法：
//   node scripts/publish-android.mjs                 # 只出本地产物（android/publish/）
//   node scripts/publish-android.mjs --github        # 额外上传到 GitHub Release 并写入 github 字段
//   node scripts/publish-android.mjs <apk路径> --github
//
// 版本号从 android/app/build.gradle.kts 的 versionName 读。
//
// 两个下载源（桌面端「手机 App」卡片会同时给出）：
//   主  中继静态托管 /var/www/mpi-mobile/download/{mpi-android-<v>.apk,mpi-android.json}
//        —— 手机在 Tailscale 内最快；但中继不一定一直开着
//   备  GitHub Release（tag=android-v<version>）
//        —— 仓库是公开的，手机能访问 GitHub 即可；GitHub 偶尔连不上时用中继
//
// GitHub 上传需要 token：环境变量 GITHUB_TOKEN，或仓库根 .gh-token（已 gitignore）。
// ⚠ 本机直连 api.github.com 被墙时，带代理运行：
//   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:10808 node scripts/publish-android.mjs --github
import { createHash } from "node:crypto";
import { existsSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const wantGithub = argv.includes("--github");
const apkArg = argv.find((a) => !a.startsWith("--"));
const apkPath = resolve(root, apkArg ?? "android/app/build/outputs/apk/debug/app-debug.apk");

const gradle = readFileSync(resolve(root, "android", "app", "build.gradle.kts"), "utf8");
const version = /versionName\s*=\s*"([^"]+)"/.exec(gradle)?.[1] ?? "0.0.0";

const bytes = readFileSync(apkPath);
const sha256 = createHash("sha256").update(bytes).digest("hex").toUpperCase();
const file = `mpi-android-${version}.apk`;

const outDir = resolve(root, "android", "publish");
mkdirSync(outDir, { recursive: true });
copyFileSync(apkPath, join(outDir, file));
writeFileSync(join(outDir, `${file}.sha256`), `${sha256}  ${file}\n`);

let githubUrl = "";
if (wantGithub) {
  const token = (process.env.GITHUB_TOKEN || (existsSync(join(root, ".gh-token")) ? readFileSync(join(root, ".gh-token"), "utf8") : "")).trim();
  if (!token) {
    console.error("缺少 token：设置 GITHUB_TOKEN，或把 token 写入仓库根 .gh-token");
    process.exit(1);
  }
  const remote = execSync("git remote get-url github", { cwd: root, encoding: "utf8" }).trim();
  const parsed = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
  if (!parsed) {
    console.error(`无法从 github remote 解析 owner/repo：${remote}`);
    process.exit(1);
  }
  const [, owner, repo] = parsed;
  const tag = `android-v${version}`;

  const gh = async (method, path, body) => {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "mpi-publish-android",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };

  let release = null;
  try {
    release = await gh("GET", `/repos/${owner}/${repo}/releases/tags/${tag}`);
  } catch {
    release = await gh("POST", `/repos/${owner}/${repo}/releases`, {
      tag_name: tag,
      name: `MPI 安卓壳 ${version}`,
      // ⚠ 必须标成 pre-release：桌面端自更新走 electron-updater，它在 allowPrerelease=false
      // 时会先取 GitHub 的 /releases/latest 定标签，再去该标签下找 latest.yml。若安卓
      // 发布成了“最新稳定版”，更新检查会去找 android-v*/latest.yml 而 404 报错。
      // 标为预发布后 /releases/latest 仍指向 v<桌面版本>，而按 tag 的直链下载不受影响。
      prerelease: true,
      body: `手机端 APK（自用）。\n\nSHA256: \`${sha256}\`\n\n中继不可用时用它作备选下载源；标为预发布以免劫持桌面端的“最新版本”。`,
    });
  }

  // 同名附件必须先删再传：uploads.github.com 遇已存在会 422，不会自动覆盖。
  // 已存在的 release 也强制回到预发布状态（防止早先误发成正式版而劫持 /releases/latest）。
  if (release && !release.prerelease) {
    release = await gh("PATCH", `/repos/${owner}/${repo}/releases/${release.id}`, { prerelease: true });
  }

  const assets = (await gh("GET", `/repos/${owner}/${repo}/releases/${release.id}`)).assets ?? [];
  for (const name of [file, `${file}.sha256`]) {
    const existing = assets.find((a) => a.name === name);
    if (existing) await gh("DELETE", `/repos/${owner}/${repo}/releases/assets/${existing.id}`);
  }

  const uploadUrl = String(release.upload_url).replace(/\{.*$/, "");
  for (const [name, buf] of [
    [file, bytes],
    [`${file}.sha256`, Buffer.from(`${sha256}  ${file}\n`, "utf8")],
  ]) {
    const res = await fetch(`${uploadUrl}?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "mpi-publish-android",
        "content-type": "application/octet-stream",
      },
      body: buf,
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) throw new Error(`上传 ${name} 失败：${res.status} ${(await res.text()).slice(0, 200)}`);
    console.log(`GitHub: ${name} 已上传`);
  }
  githubUrl = `https://github.com/${owner}/${repo}/releases/download/${tag}/${file}`;
}

const manifest = { version, file, size: bytes.length, sha256, publishedAt: new Date().toISOString(), ...(githubUrl ? { github: githubUrl } : {}) };
writeFileSync(join(outDir, "mpi-android.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`源文件 : ${apkPath} (${(bytes.length / 1024 / 1024).toFixed(2)} MB)`);
console.log(`版本   : ${version}`);
console.log(`SHA256 : ${sha256}`);
if (githubUrl) console.log(`GitHub : ${githubUrl}`);
console.log(`产物   : ${outDir}`);
console.log("");
console.log("上传到中继（/var/www/mpi-mobile/download/）后，桌面端「手机 App」卡片即可显示两个下载源。");
