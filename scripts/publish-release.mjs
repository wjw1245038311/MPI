#!/usr/bin/env node
/**
 * publish-release.mjs —— 一键发版：打 tag → push → GitHub Release（含附件上传）
 *
 * 用法:
 *   node scripts/publish-release.mjs <version> [--wait-ci [分钟]] [--seafile <dir>] [--no-push] [--force-upload] [--no-relay]
 *   npm run release -- 0.6.2
 *
 * 示例:
 *   node scripts/publish-release.mjs 0.6.2
 *   node scripts/publish-release.mjs 0.6.2 --seafile "E:/Seafile/wei_jw2/我的资料库/Agent"
 *   node scripts/publish-release.mjs 0.6.7 --wait-ci        # 不本地上传，等 GitHub Actions 传完（dev-release 默认）
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
 *   4. 创建或更新 GitHub Release（已存在则更新描述）
 *   5. 附件（两种模式，二选一）：
 *      - 默认：上传 release/ 产物 MPI-Setup-<v>.exe / latest.yml / .blockmap
 *        （单请求流式直传 uploads.github.com，对齐 gh CLI；失败整文件重试）。
 *        ⚠ CI（build-installers.yml）在 tag push 后也会向同一 Release 发布 win+mac 产物，
 *          所以默认「已存在即跳过、只补缺失」；--force-upload 才用本地产物覆盖。
 *      - --wait-ci [分钟]（默认 20）：不本地上传——每 15s 轮询直到 CI 的三个附件就位再校验，
 *        超时则报错并提示去掉该参数走本地上传兜底。dev-release.mjs 用此模式：家庭上行慢
 *        （~1Mbps），CI 在 GitHub 自家网络上传，大文件不必从家里出网。等待期间往 JSONL
 *        桥写心跳行，dev 应用的长任务监控会显示「正在等待 GitHub Actions 构建上传…」。
 *   6. 校验期望附件都在 Release 上（大小差异属正常——CI 与本地构建的 runtime 版本可能不同）；
 *      --seafile 时复制 exe + sha256 sidecar
 *   7. 把 latest.yml + exe + .blockmap 镜像到中继静态目录（桌面端自更新的**主源**，
 *      `scripts/dev-release.mjs` / `src/main/app-updater.ts` 都依赖这个约定）。
 *      本地 release/ 没有产物时（--wait-ci）就从刚发布的 Release 下载再推。
 *      **这一步失败默认中止发版**：ECS 上的 latest.yml 落后会让客户端永远看不到新版本。
 *      --no-relay 显式跳过（客户端会直接回退 GitHub）。
 */
import { execSync } from 'node:child_process';
import fs, { createReadStream } from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 进度桥文件（JSONL）----------
// dev 发版流水线是应用外的 CLI 进程，main 没有 IPC 可挂；这里每行 append 一个
// JSON 对象到临时文件，src/main/dev-release-progress.ts 轮询后喂给 transfer-monitor，
// LongTaskMonitor 即可显示真实上传字节/速度。协议：
//   { run, op:"begin", id, label, totalBytes } / { …,"op":"update", doneBytes, speedBps }
//   { …,"op":"end" } / { …,"op":"done" }（脚本结束）
const RUN_ID = Date.now();
const PROGRESS_FILE = process.env.MPI_RELEASE_PROGRESS_FILE || path.join(os.tmpdir(), 'mpi-dev-release-progress.jsonl');

function progressLine(obj) {
  try { fs.appendFileSync(PROGRESS_FILE, JSON.stringify({ run: RUN_ID, ...obj }) + '\n', 'utf8'); } catch { /* 进度写失败不能影响上传 */ }
}

// 正常/异常退出都收尾：done 行 + 删文件（被 kill -9 时残留由读端按 runId/截断/心跳处理）。
process.on('exit', () => {
  try { progressLine({ op: 'done' }); fs.unlinkSync(PROGRESS_FILE); } catch { /* ignore */ }
});

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
let version = null;
let seafileDir = null;
let noPush = false;
let forceUpload = false;
let noRelay = false;
/** >0 → --wait-ci mode (minutes); don't upload locally, wait for GitHub Actions assets. */
let waitCiMinutes = 0;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--seafile') seafileDir = argv[++i];
  else if (a === '--no-push') noPush = true;
  else if (a === '--force-upload') forceUpload = true;
  else if (a === '--no-relay') noRelay = true;
  else if (a === '--wait-ci') {
    const next = argv[i + 1] || '';
    waitCiMinutes = /^\d+$/.test(next) ? Number(argv[++i]) : 20;
  }
  else if (!version) version = a;
}
if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error('用法: node scripts/publish-release.mjs <x.y.z> [--seafile <dir>] [--no-push] [--force-upload] [--no-relay]');
  process.exit(1);
}
const tag = `v${version}`;

// ---------- 中继（桌面端自更新的主源）----------
// 与 scripts/dev-publish-android.mjs 同一台机器/同一套约定：手机 APK 放 download/，
// 桌面安装包镜像放 download/app/（electron-updater generic provider 读该目录下的 latest.yml）。
const RELAY_HOST = process.env.MPI_RELAY_HOST || 'root@100.67.5.31';
const RELAY_APP_DIR = process.env.MPI_RELAY_APP_DIR || '/var/www/mpi-mobile/download/app';

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
    const total = fs.statSync(filePath).size;
    const name = path.basename(filePath);
    let sent = 0;
    let lastTickAt = Date.now();
    let lastTickBytes = 0;
    let ended = false;
    const finishProgress = () => {
      if (ended) return;
      ended = true;
      progressLine({ op: 'end', id: name });
    };
    progressLine({ op: 'begin', id: name, label: `正在上传 ${name}`, totalBytes: total });
    const req = https.request({
      method: 'PUT',
      hostname: u.hostname,
      path: `${u.pathname}${u.search}`,
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(total),
      },
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; if (body.length > 4000) body = body.slice(-2000); });
      res.on('end', () => {
        finishProgress();
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve();
        let detail = '';
        try { detail = JSON.parse(body)?.errors?.[0]?.code || ''; } catch { /* ignore */ }
        reject(new Error(`附件 PUT → HTTP ${res.statusCode}${detail ? ` (${detail})` : ''}`));
      });
    });
    req.on('error', (e) => { finishProgress(); reject(e); });
    const rs = createReadStream(filePath);
    // 大文件上行慢（v0.6.5 实测 ~2MB/s，149MB 要十几分钟）：每 5s 打一行进度到日志/对话 + JSONL 桥。
    if (total > 1_000_000) {
      rs.on('data', (chunk) => {
        sent += chunk.length;
        const now = Date.now();
        if (now - lastTickAt < 5000) return;
        const dt = Math.max((now - lastTickAt) / 1000, 0.001);
        const speed = (sent - lastTickBytes) / dt;
        lastTickAt = now;
        lastTickBytes = sent;
        console.log(`   … ${name} ${((sent / total) * 100).toFixed(0)}%（${(sent / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB，${(speed / 1048576).toFixed(2)} MB/s）`);
        progressLine({ op: 'update', id: name, doneBytes: sent, speedBps: Math.round(speed) });
      });
    }
    rs.on('error', (e) => { finishProgress(); reject(e); });
    rs.pipe(req);
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

/**
 * --wait-ci mode: poll until all expected assets are on the Release (uploaded by GitHub
 * Actions from its own network). Writes a heartbeat line to the JSONL bridge every tick so
 * the dev app's long-task monitor keeps a live "waiting for CI" entry (the tailer drops
 * entries after 30s of silence). Returns the final release object.
 */
async function waitForCiAssets(releaseId, expectedNames, minutes) {
  const deadline = Date.now() + minutes * 60_000;
  progressLine({ op: 'begin', id: 'ci-wait', label: '正在等待 GitHub Actions 构建上传…' });
  console.log(`⏳ 等待 GitHub Actions 附件（超时 ${minutes} 分钟，每 15s 检查一次）…`);
  try {
    for (;;) {
      const r = await api('GET', `/repos/${OWNER}/${REPO}/releases/${releaseId}`);
      const have = new Set((r.assets || []).map((a) => a.name));
      const missing = expectedNames.filter((n) => !have.has(n));
      if (!missing.length) {
        console.log('✓ GitHub Actions 附件已全部就位');
        return r;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `等待 CI 附件超时（${minutes} 分钟），仍缺：${missing.join(', ')}。` +
          `可检查 GitHub Actions 运行状态，或修复后重跑本地上传路径：node scripts/publish-release.mjs ${version}`,
        );
      }
      progressLine({ op: 'update', id: 'ci-wait' }); // heartbeat — keep the monitor entry alive
      console.log(`   … 还差 ${missing.length} 个附件（${missing.join(', ')}）`);
      await sleep(15_000);
    }
  } finally {
    progressLine({ op: 'end', id: 'ci-wait' });
  }
}

// ---------- 中继镜像（桌面端自更新的主源）----------
/** 从刚发布的 Release 拉一个附件到本地（公开仓库，browser_download_url 无需 token）。 */
function downloadReleaseAsset(rel, name, dest) {
  const asset = (rel.assets || []).find((a) => a.name === name);
  if (!asset) throw new Error(`Release 上没有 ${name}`);
  const total = asset.size || 0;
  return new Promise((resolve, reject) => {
    const follow = (url, redirects = 0) => {
      if (redirects > 5) return reject(new Error(`下载 ${name} 重定向过多`));
      const u = new URL(url);
      const req = https.get({ hostname: u.hostname, path: `${u.pathname}${u.search}`, headers: authHeaders() }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return follow(new URL(res.headers.location, url).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`下载 ${name} → HTTP ${res.statusCode}`)); }
        const out = fs.createWriteStream(dest);
        let done = 0;
        let lastPct = -1;
        res.on('data', (c) => {
          done += c.length;
          if (!total) return;
          const pct = Math.floor((done / total) * 10) * 10;
          if (pct !== lastPct) { lastPct = pct; console.log(`     … ${name} ${pct}%（${(done / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB）`); }
        });
        out.on('error', reject);
        out.on('finish', () => out.close(() => resolve()));
        res.pipe(out);
      });
      req.on('error', reject);
    };
    follow(asset.browser_download_url);
  });
}

/**
 * 把 latest.yml + exe + .blockmap 推上中继静态目录。
 *
 * 客户端（src/main/app-updater.ts）先问 `<中继 http 源>/download/app/latest.yml`，不可达才回
 * GitHub；所以这份 latest.yml 落后 == 客户端永远看不到新版本。失败一律中止发版，
 * 不用“警告一下继续”的写法。
 */
async function mirrorToRelay(rel) {
  console.log(`\n中继镜像 → ${RELAY_HOST}:${RELAY_APP_DIR}`);
  let staging = null;
  try {
    const files = [];
    for (const name of [`MPI-Setup-${version}.exe`, 'latest.yml', `MPI-Setup-${version}.exe.blockmap`]) {
      const local = path.join(REPO_ROOT, 'release', name);
      if (fs.existsSync(local)) { files.push(local); continue; }
      staging = staging || fs.mkdtempSync(path.join(os.tmpdir(), 'mpi-relay-mirror-'));
      const dest = path.join(staging, name);
      console.log(`   · 本地没有 ${name}，从 Release 下载…`);
      await downloadReleaseAsset(rel, name, dest);
      files.push(dest);
    }
    const quoted = files.map((f) => `"${f}"`).join(' ');
    execSync(`ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new ${RELAY_HOST} "mkdir -p ${RELAY_APP_DIR}"`, { stdio: 'inherit' });
    console.log(`⬆ ${files.length} 个文件 → ${RELAY_HOST}（大文件可能需要几分钟）`);
    execSync(`scp -o BatchMode=yes -o StrictHostKeyChecking=accept-new ${quoted} ${RELAY_HOST}:${RELAY_APP_DIR}/`, { stdio: 'inherit' });
    console.log('✓ 中继镜像完成（客户端将优先从它检查/下载更新）');
  } catch (e) {
    console.error(`✗ 中继镜像失败：${e.message}`);
    console.error('  GitHub Release 已发布，但 ECS 上的 latest.yml 落后会让客户端检查不到新版本。');
    console.error('  修好 SSH/目录后重跑本脚本（幂等），或加 --no-relay 显式跳过（客户端将回退 GitHub）。');
    process.exit(1);
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
  }
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

  // 新运行开始：截断旧文件，读端据此识别新一轮 run。
  try { fs.writeFileSync(PROGRESS_FILE, '', 'utf8'); } catch { /* ignore */ }

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

  // Release 上期望的附件名（CI 与本地产物同名）
  const expectedNames = [
    `MPI-Setup-${version}.exe`,
    'latest.yml',
    `MPI-Setup-${version}.exe.blockmap`,
  ];

  let final;
  if (waitCiMinutes > 0) {
    // --wait-ci：不本地上传——GitHub Actions 在 tag push 后从自家网络传，家庭上行慢
    // （~1Mbps），大文件不必出网。轮询直到全部就位。
    final = await waitForCiAssets(rel.id, expectedNames, waitCiMinutes);
  } else {
    // 5) 上传附件（CI build-installers.yml 也会在 tag push 后发布到同一 Release：
    //    默认已存在即跳过、只补缺失；--force-upload 才用本地产物覆盖同名附件）
    const candidates = expectedNames
      .map((f) => path.join(REPO_ROOT, 'release', f))
      .filter(fs.existsSync);
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
  }

  // 6) 校验（只查期望附件都在 Release 上；大小差异属正常——CI 与本地构建的 runtime 版本可能不同）
  if (!final) final = await api('GET', `/repos/${OWNER}/${REPO}/releases/${rel.id}`);
  console.log('\nRelease 附件校验:');
  let okAll = true;
  for (const name of expectedNames) {
    const remote = final.assets.find((a) => a.name === name);
    if (!remote) { okAll = false; console.log(`  ✗ ${name} 缺失`); continue; }
    const localFile = path.join(REPO_ROOT, 'release', name);
    let note = '';
    if (fs.existsSync(localFile)) {
      const localSize = fs.statSync(localFile).size;
      if (remote.size !== localSize) note = `（与本地 ${(localSize / 1048576).toFixed(1)} MB 不同，CI 产物）`;
    }
    console.log(`  ✓ ${name} (${(remote.size / 1048576).toFixed(1)} MB)${note}`);
  }
  if (!okAll) { console.error('✗ Release 缺少期望附件，请重新运行本脚本或检查 CI'); process.exit(1); }

  // 7) 中继镜像（桌面端自更新的主源）。默认必须成功（见 mirrorToRelay 注释）。
  if (noRelay) {
    console.log('\n（--no-relay：跳过中继镜像，客户端会回退 GitHub）');
  } else {
    await mirrorToRelay(final);
  }

  // seafile 分发副本（用本地产物；--wait-ci 且未本地构建时跳过并提示）
  if (seafileDir) {
    const exe = path.join(REPO_ROOT, 'release', `MPI-Setup-${version}.exe`);
    if (!fs.existsSync(exe)) {
      console.log(`⚠ 本地 ${path.basename(exe)} 不存在（--wait-ci 模式且未本地构建），跳过 Seafile 复制；可从 Release 手动下载放置`);
    } else {
      fs.mkdirSync(seafileDir, { recursive: true });
      fs.copyFileSync(exe, path.join(seafileDir, path.basename(exe)));
      if (fs.existsSync(shaFile)) fs.copyFileSync(shaFile, path.join(seafileDir, path.basename(shaFile)));
      console.log(`✓ 已复制到 Seafile 目录: ${seafileDir}`);
    }
  }

  console.log(`\n🎉 https://github.com/${OWNER}/${REPO}/releases/tag/${tag}`);
})().catch((e) => {
  console.error(`✗ 发版失败: ${e.message}`);
  process.exit(1);
});
