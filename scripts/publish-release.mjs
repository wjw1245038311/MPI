#!/usr/bin/env node
/**
 * publish-release.mjs —— 一键发版：打 tag → push → GitHub Release（含附件上传）
 *
 * 用法:
 *   node scripts/publish-release.mjs <version> [--seafile <dir>] [--no-push] [--force-upload]
 *   npm run release -- 0.6.2
 *
 * 示例:
 *   node scripts/publish-release.mjs 0.6.2
 *   node scripts/publish-release.mjs 0.6.2 --seafile "E:/Seafile/wei_jw2/我的资料库/Agent"
 *
 * Token（二选一）:
 *   - 环境变量 GITHUB_TOKEN
 *   - 仓库根目录 .gh-token 文件（已 gitignore），内容一行 token
 *   （github.com/settings/tokens/new → classic → 勾 repo 权限）
 *
 * 流程:
 *   1. 本地打 tag v<version>（必须指向当前 HEAD；已存在且一致则跳过，可重复执行）
 *   2. push 当前分支 + tag 到 github remote
 *   3. Release 正文 = changelog.md 的 ## v<version> 小节 + exe SHA256
 *   4. 创建或更新 GitHub Release（已存在则更新描述；同名附件直接替换）
 *   5. 上传 release/ 产物：MPI-Setup-<v>.exe / latest.yml / .blockmap
 *      （单请求流式直传 uploads.github.com，对齐 gh CLI；失败整文件重试）
 *      ⚠ CI（build-installers.yml）在 tag push 后也会向同一 Release 发布 win+mac 产物，
 *        所以默认「已存在即跳过、只补缺失」；--force-upload 才用本地产物覆盖。
 *   6. 校验期望附件都在 Release 上（大小差异属正常——CI 与本地构建的 runtime 版本可能不同）；
 *      --seafile 时复制 exe + sha256 sidecar
 */
import { execSync } from 'node:child_process';
import fs, { createReadStream } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
let version = null;
let seafileDir = null;
let noPush = false;
let forceUpload = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--seafile') seafileDir = argv[++i];
  else if (a === '--no-push') noPush = true;
  else if (a === '--force-upload') forceUpload = true;
  else if (!version) version = a;
}
if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error('用法: node scripts/publish-release.mjs <x.y.z> [--seafile <dir>] [--no-push] [--force-upload]');
  process.exit(1);
}
const tag = `v${version}`;

// ---------- token / 仓库信息 ----------
function getToken() {
  const t = (process.env.GITHUB_TOKEN || '').trim();
  if (t) return t;
  const f = path.join(REPO_ROOT, '.gh-token');
  if (fs.existsSync(f)) {
    const s = fs.readFileSync(f, 'utf8').trim();
    if (s) return s;
  }
  console.error('缺少 token：设置环境变量 GITHUB_TOKEN，或把 token 写入仓库根目录 .gh-token（已 gitignore）');
  process.exit(1);
}
const TOKEN = getToken();

function git(args) {
  return execSync(`git ${args}`, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}
const remoteUrl = git('remote get-url github');
const m = remoteUrl.match(/[:/]([^:/]+)\/([^/]+?)(?:\.git)?$/);
if (!m) { console.error(`无法从 github remote 解析 owner/repo: ${remoteUrl}`); process.exit(1); }
const [, OWNER, REPO] = m;

// ---------- GitHub API（带重试）----------
function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

async function api(method, urlPath, body) {
  const url = `https://api.github.com${urlPath}`;
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: authHeaders(body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 204) return null;
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* ignore */ }
      if (!res.ok) {
        const err = new Error(`API ${method} ${urlPath} → HTTP ${res.status}: ${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      return data;
    } catch (e) {
      lastErr = e;
      // 4xx（除 429）不重试；网络错误 / 5xx / 429 退避重试
      const retryable = !e.status || e.status === 429 || e.status >= 500;
      if (!retryable) throw e;
      if (attempt < 4) { console.error(`   ⚠ ${method} ${urlPath} 失败（${String(e.message).slice(0, 80)}），${attempt * 2}s 后重试…`); await sleep(attempt * 2000); }
    }
  }
  throw lastErr;
}

// ---------- 附件上传 ----------
// 用 https.request 流式上传而不是 fetch：GitHub 收完整个 body 才回响应头，
// 大文件在慢速上行链路上会超过 undici 默认 headersTimeout(300s) 报 UND_ERR_HEADERS_TIMEOUT；
// 原生 http(s) 无此限制，且直接从磁盘流式读、不占内存。
function putAsset(url, filePath) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    // 必须显式 Content-Length：pipe() 默认走 chunked 编码，GitHub uploads 端点不接受（HTTP 400）。
    const req = https.request({
      method: 'PUT',
      hostname: u.hostname,
      path: `${u.pathname}${u.search}`,
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(fs.statSync(filePath).size),
      },
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; if (body.length > 4000) body = body.slice(-2000); });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve();
        let detail = '';
        try { detail = JSON.parse(body)?.errors?.[0]?.code || ''; } catch { /* ignore */ }
        reject(new Error(`附件 PUT → HTTP ${res.statusCode}${detail ? ` (${detail})` : ''}`));
      });
    });
    req.on('error', reject);
    createReadStream(filePath).pipe(req);
  });
}

// GitHub 的 uploads.github.com PUT 遇到同名已存在附件会报 422 already_exists，
// 不会自动替换（gh CLI --clobber 也是先 DELETE 再上传）。
async function deleteAssetByName(releaseId, name) {
  const rel = await api('GET', `/repos/${OWNER}/${REPO}/releases/${releaseId}`);
  const asset = (rel.assets || []).find((a) => a.name === name);
  if (!asset) return false;
  await api('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${asset.id}`);
  console.log(`   🗑 已删除旧附件 ${name}（id ${asset.id}），重新上传`);
  return true;
}

async function uploadAsset(releaseId, file) {
  const name = path.basename(file);
  const size = fs.statSync(file).size;
  const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
  console.log(`⬆ ${name} (${mb(size)})`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // 单请求流式直传（GitHub 现支持任意大小整文件上传，与 gh CLI 一致；
      // 旧 >100MB 分片 API POST api.github.com/.../releases/{id}/assets 已废弃返回 404）。
      const url = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}&content_type=application%2Foctet-stream`;
      await putAsset(url, file);
      console.log(`   ✓ ${name} 上传完成`);
      return;
    } catch (e) {
      const msg = String(e.message);
      if (msg.includes('already_exists')) {
        try { if (await deleteAssetByName(releaseId, name)) continue; } catch { /* fallthrough to retry */ }
      }
      const cause = e.cause ? ` [${e.cause.code || e.cause.message}]` : '';
      console.error(`   ⚠ ${name} 上传失败（第 ${attempt}/3 次）: ${msg.slice(0, 120)}${cause}`);
      if (attempt < 3) await sleep(attempt * 5000);
    }
  }
  console.error(`✗ ${name} 上传失败，可重新运行本脚本续传`);
  process.exit(1);
}

// ---------- changelog 正文提取 ----------
function changelogBody(v) {
  const md = fs.readFileSync(path.join(REPO_ROOT, 'changelog.md'), 'utf8');
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## v${v}`));
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { end = i; break; }
  }
  return lines.slice(start, end).join('\n').trim();
}

// ---------- 主流程 ----------
(async () => {
  console.log(`== MPI v${version} 发版（${OWNER}/${REPO}）==`);

  const dirty = git('status --porcelain');
  if (dirty) console.warn(`⚠ 工作区有未提交改动：\n${dirty}\n  tag 指向当前 HEAD，未提交内容不会进 release。`);

  // 1) tag
  const branch = git('rev-parse --abbrev-ref HEAD');
  const head = git('rev-parse HEAD');
  let existingTag = null;
  try { existingTag = git(`rev-parse -q --verify refs/tags/${tag}`); } catch { /* not exists */ }
  if (existingTag) {
    if (existingTag !== head) {
      console.error(`✗ tag ${tag} 已存在但不指向当前 HEAD（tag→${git(`rev-parse --short ${existingTag}`)}，HEAD=${git('rev-parse --short HEAD')}）；如需移动请手动 git tag -f`);
      process.exit(1);
    }
    console.log(`✓ tag ${tag} 已存在且指向当前提交，跳过创建`);
  } else {
    git(`tag ${tag}`);
    console.log(`✓ 创建 tag ${tag} → ${git('rev-parse --short HEAD')}`);
  }

  // 2) push
  if (!noPush) {
    git(`push github refs/heads/${branch}:refs/heads/${branch}`);
    git(`push github refs/tags/${tag}`);
    console.log(`✓ 已推送 ${branch} + ${tag}`);
  } else {
    console.log('（--no-push：跳过 push）');
  }

  // 3) Release 正文
  let body = changelogBody(version);
  if (!body) console.warn('⚠ changelog.md 里没找到 ## v' + version + ' 小节，Release 描述将为空');
  const shaFile = path.join(REPO_ROOT, 'release', `MPI-Setup-${version}.exe.sha256`);
  if (fs.existsSync(shaFile)) {
    body += `\n\nSHA256: \`${fs.readFileSync(shaFile, 'utf8').trim().split(/\s+/)[0]}\``;
  }

  // 4) 创建 / 更新 Release
  let rel = null;
  try { rel = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${tag}`); } catch { /* 404 */ }
  if (rel) {
    await api('PATCH', `/repos/${OWNER}/${REPO}/releases/${rel.id}`, { name: `MPI v${version}`, body });
    console.log(`✓ 更新已有 Release #${rel.id}（标题/描述）`);
  } else {
    rel = await api('POST', `/repos/${OWNER}/${REPO}/releases`, {
      tag_name: tag, target_commitish: branch, name: `MPI v${version}`, body,
    });
    console.log(`✓ 创建 Release #${rel.id}`);
  }

  // 5) 上传附件（CI build-installers.yml 也会在 tag push 后发布到同一 Release：
  //    默认已存在即跳过、只补缺失；--force-upload 才用本地产物覆盖同名附件）
  const candidates = [
    `MPI-Setup-${version}.exe`,
    'latest.yml',
    `MPI-Setup-${version}.exe.blockmap`,
  ].map((f) => path.join(REPO_ROOT, 'release', f)).filter(fs.existsSync);
  if (!candidates.length) { console.error('✗ release/ 下没有产物，先跑 npm run dist'); process.exit(1); }

  const existingAssets = new Map(rel.assets.map((a) => [a.name, a.size]));
  for (const f of candidates) {
    const name = path.basename(f);
    const size = fs.statSync(f).size;
    const remoteSize = existingAssets.get(name);
    if (remoteSize !== undefined && !forceUpload) {
      console.log(remoteSize === size
        ? `= ${name} 已存在且大小一致，跳过`
        : `= ${name} Release 上已有（${(remoteSize / 1048576).toFixed(1)} MB，与本地 ${(size / 1048576).toFixed(1)} MB 不同——CI 产物），跳过；--force-upload 可用本地产物覆盖`);
      continue;
    }
    await uploadAsset(rel.id, f);
  }

  // 6) 校验（只查期望附件都在 Release 上；大小差异属正常——CI 与本地构建的 runtime 版本可能不同）
  const final = await api('GET', `/repos/${OWNER}/${REPO}/releases/${rel.id}`);
  console.log('\nRelease 附件校验:');
  let okAll = true;
  for (const f of candidates) {
    const name = path.basename(f);
    const remote = final.assets.find((a) => a.name === name);
    if (!remote) { okAll = false; console.log(`  ✗ ${name} 缺失`); continue; }
    const localSize = fs.statSync(f).size;
    const note = remote.size === localSize ? '' : `（与本地 ${(localSize / 1048576).toFixed(1)} MB 不同，CI 产物）`;
    console.log(`  ✓ ${name} (${(remote.size / 1048576).toFixed(1)} MB)${note}`);
  }
  if (!okAll) { console.error('✗ Release 缺少期望附件，请重新运行本脚本或检查 CI'); process.exit(1); }

  // seafile 分发副本
  if (seafileDir) {
    const exe = path.join(REPO_ROOT, 'release', `MPI-Setup-${version}.exe`);
    fs.mkdirSync(seafileDir, { recursive: true });
    fs.copyFileSync(exe, path.join(seafileDir, path.basename(exe)));
    if (fs.existsSync(shaFile)) fs.copyFileSync(shaFile, path.join(seafileDir, path.basename(shaFile)));
    console.log(`✓ 已复制到 Seafile 目录: ${seafileDir}`);
  }

  console.log(`\n🎉 https://github.com/${OWNER}/${REPO}/releases/tag/${tag}`);
})().catch((e) => {
  console.error(`✗ 发版失败: ${e.message}`);
  process.exit(1);
});
