// 发布手机端更新产物到 GitHub，并生成 App 读取的清单。
//
// 用法：
//   GITHUB_TOKEN=ghp_xxx node scripts/publish-android-github.mjs
//   # 国内网络（走本地代理；Node 需要 NODE_USE_ENV_PROXY 才认 HTTPS_PROXY）：
//   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:10808 GITHUB_TOKEN=ghp_xxx \
//     node scripts/publish-android-github.mjs
//
// 做三件事：
//   1. 确保 tag `android-v<version>` 的 Release 存在（**prerelease**：不能抢桌面端自更新的 latest）
//   2. 上传 assets：mpi-android-native-<version>.apk（有增量包时也传 .patch）
//   3. 生成清单到 mobile/app/update/mpi-android-native.json（**需要你 commit**，
//      App 从 raw.githubusercontent.com 这个固定路径读它）
//
// 为什么清单不放 Release 的 latest：手机包是 prerelease，`latest/download/…` 读不到；
// 若改成稳定版又会抢走桌面端自更新的 latest（AGENTS.md 记过这个坑）。
//
// 增量基线版本：默认按 `mpi-android-native-<from>-to-<version>.patch` 的文件名推断，
// 也可用 `--from 0.5.17` 指定。
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, join, dirname } from "node:path";

const REPO = "wjw1245038311/MPI";
const ROOT = resolve(import.meta.dirname, "..");
const PUBLISH_DIR = join(ROOT, "mobile", "app", "publish");
const GRADLE = join(ROOT, "mobile", "app", "app", "build.gradle.kts");
const MANIFEST_PATH = join(ROOT, "mobile", "app", "update", "mpi-android-native.json");

const API = "https://api.github.com";
const UPLOAD = "https://uploads.github.com";

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!token) {
  console.error("缺少 GITHUB_TOKEN（需要 repo 权限）");
  process.exit(64);
}

const argv = process.argv.slice(2);
const fromArg = argv.includes("--from") ? argv[argv.indexOf("--from") + 1] : null;

function sha256Upper(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase();
}

function headers(extra = {}) {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "mpi-publish-android",
    ...extra,
  };
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: headers(init.headers) });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body };
}

async function ensureRelease(tag, name) {
  const existing = await api(`/repos/${REPO}/releases/tags/${tag}`);
  if (existing.ok) return existing.body;
  const created = await api(`/repos/${REPO}/releases`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tag_name: tag, name, prerelease: true, draft: false }),
  });
  if (!created.ok) throw new Error(`创建 release 失败：${created.status} ${JSON.stringify(created.body)}`);
  return created.body;
}

async function uploadAsset(releaseId, filePath, assetName) {
  const assets = await api(`/repos/${REPO}/releases/${releaseId}/assets`);
  if (assets.ok && Array.isArray(assets.body)) {
    for (const asset of assets.body) {
      if (asset.name === assetName) {
        await api(`/repos/${REPO}/releases/assets/${asset.id}`, { method: "DELETE" });
      }
    }
  }
  const bytes = readFileSync(filePath);
  const res = await fetch(
    `${UPLOAD}/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/octet-stream", "content-length": String(bytes.length) }),
      body: bytes,
    },
  );
  if (!res.ok) throw new Error(`上传 ${assetName} 失败：${res.status} ${await res.text()}`);
  return { name: assetName, size: bytes.length };
}

async function main() {
  const version = /versionName\s*=\s*"([^"]+)"/.exec(readFileSync(GRADLE, "utf8"))?.[1];
  if (!version) throw new Error("读不到 versionName");

  const apkLocal = join(PUBLISH_DIR, `MPI-Android-Native-${version}.apk`);
  if (!existsSync(apkLocal)) throw new Error(`缺少 ${apkLocal}（先 npm run assembleDebug 或 gradle assembleDebug）`);
  const apkAsset = `mpi-android-native-${version}.apk`;

  // 增量包：--from 指定，或按 publish 里的文件名推断
  let patchLocal = null;
  let patchFrom = fromArg;
  if (!patchFrom) {
    const dir = readdirSafe(PUBLISH_DIR).find((f) => f.endsWith(`-to-${version}.patch`));
    if (dir) {
      patchLocal = join(PUBLISH_DIR, dir);
      patchFrom = /-(\d[\w.]*)-to-/.exec(dir)?.[1] ?? null;
    }
  } else {
    const candidate = join(PUBLISH_DIR, `mpi-android-native-${patchFrom}-to-${version}.patch`);
    if (existsSync(candidate)) patchLocal = candidate;
  }

  const tag = `android-v${version}`;
  const base = `https://github.com/${REPO}/releases/download/${tag}`;

  console.log(`仓库   : ${REPO}`);
  console.log(`版本   : ${version}（tag ${tag}）`);
  console.log(`APK    : ${apkAsset} (${statSync(apkLocal).size} bytes)`);
  console.log(`增量包 : ${patchLocal ? `${patchFrom} → ${version} (${statSync(patchLocal).size} bytes)` : "无"}`);

  const release = await ensureRelease(tag, `MPI Android ${version}`);
  console.log(`release: ${release.html_url ?? "(已存在)"}`);

  const uploaded = [];
  uploaded.push(await uploadAsset(release.id, apkLocal, apkAsset));
  let patchAsset = null;
  if (patchLocal) {
    patchAsset = `mpi-android-native-${patchFrom}-to-${version}.patch`;
    uploaded.push(await uploadAsset(release.id, patchLocal, patchAsset));
  }
  for (const item of uploaded) console.log(`✓ ${item.name} (${item.size} bytes)`);

  // 生成清单（file 用 Release asset 的绝对 URL）
  // `file` 同时写绝对 URL：这是 App `Updater.parseManifest` 的**既定契约**
  // （它只读 `file`，再拼 base；GitHub 模式 base 为空 → 相对名会变成
  //  `/mpi-….apk` → Android 报 “no scheme”）。详见 2026-09-24 的真机报错。
  const apkUrl = `${base}/${apkAsset}`;
  const patchUrl = patchAsset ? `${base}/${patchAsset}` : null;
  const manifest = {
    version,
    file: apkUrl,
    url: apkUrl,
    size: statSync(apkLocal).size,
    sha256: sha256Upper(apkLocal),
    publishedAt: new Date().toISOString().slice(0, 10),
    github: "",
    ...(patchAsset && patchUrl
      ? {
          patch: {
            from: patchFrom,
            file: patchUrl,
            url: patchUrl,
            size: statSync(patchLocal).size,
            sha256: sha256Upper(patchLocal),
          },
        }
      : {}),
  };
  mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\n清单已写入：${MANIFEST_PATH}`);
  console.log("⚠️ 记得 commit + push 它（App 从 raw 固定路径读）：");
  console.log(`   https://raw.githubusercontent.com/${REPO}/main/mobile/app/update/mpi-android-native.json`);

  // 同步到中继的 /download/。
  // **这一步不是可选的**：客户端 Updater.check() 把**中继当权威源**（中继优先且拿到结果就
  // 短路，不再问 GitHub——否则每次「已是最新」都要等 GitHub 超时 ~10s）。所以中继那份陈旧
  // 就等于客户端漏更新。scripts/dev-publish-android.mjs 也是同样的约定。
  await pushManifestToRelay();
}

/** 把清单放到中继静态目录（scp 到临时名再 mv，避免客户端读到写一半的文件）。 */
async function pushManifestToRelay() {
  const host = process.env.MPI_RELAY_HOST || "root@100.67.5.31";
  const dir = "/var/www/mpi-mobile/download";
  const tmp = `${dir}/mpi-native.tmp`;
  console.log(`\n同步清单到中继（${host}:${dir}）…`);
  const scp = spawnSync("scp", ["-o", "BatchMode=yes", MANIFEST_PATH, `${host}:${tmp}`], { stdio: "inherit" });
  if (scp.status !== 0) {
    // 不静默：不同步等于客户端收不到这次更新
    console.error("⚠️ 清单未能同步到中继（scp 失败）。客户端以中继为权威源，**必须**补上：");
    console.error(`   scp "${MANIFEST_PATH}" ${host}:${tmp} && ssh ${host} 'mv ${tmp} ${dir}/mpi-android-native.json'`);
    return;
  }
  const mv = spawnSync("ssh", ["-o", "BatchMode=yes", host, `mv ${tmp} ${dir}/mpi-android-native.json`], { stdio: "inherit" });
  console.log(mv.status === 0 ? "   ✓ 中继清单已就位" : "   ⚠️ 中继上 mv 失败，请手动替换（见上）");
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

main().catch((error) => {
  console.error("失败：", error.message);
  process.exit(1);
});
