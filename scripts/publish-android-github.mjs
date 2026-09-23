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
  const manifest = {
    version,
    file: apkAsset,
    url: `${base}/${apkAsset}`,
    size: statSync(apkLocal).size,
    sha256: sha256Upper(apkLocal),
    publishedAt: new Date().toISOString().slice(0, 10),
    github: "",
    ...(patchAsset
      ? {
          patch: {
            from: patchFrom,
            file: patchAsset,
            url: `${base}/${patchAsset}`,
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
