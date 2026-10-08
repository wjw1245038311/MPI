#!/usr/bin/env node
/**
 * relay-upload.mjs —— 把发版产物推到中继静态目录（大文件并发分片上传）。
 *
 * 为什么需要：桌面安装包 143MB，单连接 scp 从本机到 ECS 实测 ≈0.68MB/s（3.5 分钟）；
 * 而出口是「单连接限速、多连接可叠加」（12 条 ≈7.8MB/s）。所以大文件切成 N 段并发上传，
 * ECS 侧 `cat` 合并 → `sha256sum` 校验 → `mv` 到位。
 *
 * 用法（通常由 scripts/publish-release.mjs 调用）：
 *   node scripts/relay-upload.mjs [--host <ssh目标>] [--port <ssh端口>] [--dir <远端目录>] [--parts N] [--dry-run] <file...>
 *
 * 路径：远端目录请走 env `MPI_RELAY_APP_DIR`（或确认已导 `MSYS_NO_PATHCONV=1`）——
 *   Git Bash 会把 argv 里的 POSIX 路径改写成 Windows 路径（`/var/www/x` → `C:/Program Files/Git/var/www/x`），
 *   传到远端就变成了个叫 `C:` 的怪目录。本工具会直接报错拦下来。
 *
 * 走哪条路很关键（实测 60MB）：
 *   · **公网 443 多路并发 ≈ 7.0 MB/s**（12 条独立 TCP，企业出口单连接限速可叠加）
 *   · tailnet（100.x，DERP 隧道）无论多少路都 ~0.8 MB/s——整个 tailnet 就一条隧道，并发无意义
 *   所以默认走 `MPI_RELAY_UPLOAD_HOST`（ECS 公网）+ `MPI_RELAY_UPLOAD_PORT=443`；
 *   publish-release 会在快路失败时回退 tailnet 慢路。
 *
 * 约定 / 安全：
 *   · **`latest.yml` 一律最后落盘**：客户端读它来决定下载哪个版本；先落会让别人看到指向
 *     尚未传完的 exe 的清单（虽然 electron-updater 还会校验 sha512，但没必要冒这个险）。
 *   · 每个文件先传到 `<name>.uploading.partNN`，全部到齐后 `cat` 成 `<name>.uploading`，
 *     校验 sha256 通过才 `mv` 覆盖正式文件名 —— 中途失败时线上仍是旧文件，不会出现半个包。
 *   · 小文件（<4MB）走 scp；`--parts 1` 可强制全走 scp（排查用）。
 *   · 校验失败/任一分片失败 → 非零退出（发版脚本据此中止）。
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { DEFAULT_PARTS, PARALLEL_THRESHOLD_BYTES, partName, planParts } from "./relay-upload-parts.mjs";

const SSH_OPTS_BASE = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15"];
/** 每个分片的重试次数（12 路并发时实测偶有单条被 sshd/MaxStartups 瞬时掐断）。 */
const PART_ATTEMPTS = 3;

function sshOptions(port) {
  return port ? [...SSH_OPTS_BASE, "-p", String(port)] : [...SSH_OPTS_BASE];
}

function parseArgs(argv) {
  const out = {
    host: process.env.MPI_RELAY_UPLOAD_HOST || process.env.MPI_RELAY_HOST || "root@100.67.5.31",
    port: process.env.MPI_RELAY_UPLOAD_PORT || "",
    dir: process.env.MPI_RELAY_APP_DIR || "/var/www/mpi-mobile/download/app",
    parts: Number(process.env.MPI_RELAY_UPLOAD_PARTS || DEFAULT_PARTS),
    dryRun: false,
    files: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--host") out.host = argv[++i];
    else if (a === "--port") out.port = argv[++i];
    else if (a === "--dir") out.dir = argv[++i];
    else if (a === "--parts") out.parts = Number(argv[++i]);
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else out.files.push(a);
  }
  return out;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function ssh(host, command, port, stdio = "inherit") {
  return spawnSync("ssh", [...sshOptions(port), host, command], { stdio, encoding: "utf8" });
}

function remoteSha256(host, remotePath, port) {
  const r = ssh(host, `sha256sum ${shellQuote(remotePath)}`, port, ["ignore", "pipe", "ignore"]);
  if (r.status !== 0) return null;
  const m = /^([0-9a-f]{64})/im.exec(String(r.stdout || ""));
  return m ? m[1].toLowerCase() : null;
}

/** 本地 sha256（流式，143MB 不会进内存）。 */
function localSha256(file) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const rs = createReadStream(file);
    rs.on("data", (chunk) => hash.update(chunk));
    rs.on("error", reject);
    rs.on("end", () => resolvePromise(hash.digest("hex").toLowerCase()));
  });
}

/** 一个分片：ssh 到远端 `cat > <part>`，本地对应区间的读流接进它 stdin。 */
function uploadPart(host, port, file, part, remotePart) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("ssh", [...sshOptions(port), host, `cat > ${shellQuote(remotePart)}`], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    createReadStream(file, { start: part.start, end: part.end }).pipe(child.stdin);
    child.stdin.on("error", () => { /* ssh 提前退出时忽略 EPIPE，由 close 分支判定 */ });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolvePromise();
      reject(new Error(`分片 ${remotePart} 失败（exit ${code}）${stderr.trim() ? `：${stderr.trim().slice(0, 200)}` : ""}`));
    });
  });
}

/** 并发上传时偶有单条被掐断（sshd MaxStartups / 网络抖动），逐片重试。 */
async function uploadPartWithRetry(host, port, file, part, remotePart) {
  let lastError = null;
  for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt += 1) {
    try {
      await uploadPart(host, port, file, part, remotePart);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < PART_ATTEMPTS) {
        console.log(`   · 重试分片 ${part.index}（第 ${attempt} 次失败：${String(error.message).slice(0, 80)}）`);
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }
  throw lastError;
}

async function uploadParallel(host, port, dir, file, fileSize, parts) {
  const name = basename(file);
  const plan = planParts(fileSize, parts);
  const remoteBase = `${dir}/${name}.uploading`;
  const remoteParts = plan.map((p) => partName(remoteBase, p.index));
  console.log(`⬆ ${name}（${(fileSize / 1048576).toFixed(1)} MB）分 ${plan.length} 路并发 → ${host}${port ? `:${port}` : ""}…`);
  const startedAt = Date.now();
  await Promise.all(plan.map((p, i) => uploadPartWithRetry(host, port, file, p, remoteParts[i])));
  const seconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
  console.log(`   ✓ 分片上传完成 ${(fileSize / 1048576 / seconds).toFixed(1)} MB/s（${seconds.toFixed(1)}s）`);

  // 合并 → 校验 → 原子替换；任一步失败都不动正式文件
  const merged = ssh(host, `cat ${remoteParts.map(shellQuote).join(" ")} > ${shellQuote(remoteBase)} && rm -f ${remoteParts.map(shellQuote).join(" ")}`, port);
  if (merged.status !== 0) throw new Error(`${name} 远端合并失败（exit ${merged.status}）`);

  const [remote, local] = [remoteSha256(host, remoteBase, port), await localSha256(file)];
  if (!remote) throw new Error(`${name} 远端校验取不到 sha256`);
  if (remote !== local) throw new Error(`${name} 分片上传后 sha256 不一致（远端 ${remote.slice(0, 12)}… ≠ 本地 ${local.slice(0, 12)}…）`);

  const installed = ssh(host, `mv -f ${shellQuote(remoteBase)} ${shellQuote(`${dir}/${name}`)}`, port);
  if (installed.status !== 0) throw new Error(`${name} 远端替换失败（exit ${installed.status}）`);
  console.log(`   ✓ ${name} sha256 ${local.slice(0, 12)}… 校验通过并已就位`);
}

function uploadPlain(host, port, dir, file) {
  const name = basename(file);
  const r = spawnSync("scp", [...(port ? ["-P", String(port)] : []), ...SSH_OPTS_BASE, file, `${host}:${dir}/`], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${name} scp 失败（exit ${r.status}）`);
  console.log(`   ✓ ${name} 已上传`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.files.length) {
    console.log("用法: node scripts/relay-upload.mjs [--host <ssh目标>] [--port <ssh端口>] [--dir <远端目录>] [--parts N] [--dry-run] <file...>");
    console.log(`  默认 host=${opts.host} port=${opts.port || "(默认22)"} dir=${opts.dir} parts=${opts.parts}（<${PARALLEL_THRESHOLD_BYTES / 1048576}MB 走 scp）`);
    process.exit(opts.help ? 0 : 1);
  }
  // 远端是 Linux：目录写成 Windows 盘符一定是被 MSYS 改写过的（或写错了）
  if (/^[A-Za-z]:[\\/]/.test(opts.dir)) {
    throw new Error(`远端目录看起来是 Windows 路径：${opts.dir}\n  Git Bash 会把 argv 里的 POSIX 路径改写成 Windows 路径；远端目录请用 env MPI_RELAY_APP_DIR（命令行传则先 export MSYS_NO_PATHCONV=1）`);
  }

  // latest.yml 必须最后落地：客户端读它决定下载哪个版本
  const files = opts.files.map((f) => resolve(f));
  files.sort((a, b) => (basename(a) === "latest.yml" ? 1 : 0) - (basename(b) === "latest.yml" ? 1 : 0));

  for (const f of files) {
    const size = statSync(f).size;
    const plan = planParts(size, opts.parts);
    console.log(`· ${basename(f)}  ${(size / 1048576).toFixed(2)} MB  ${plan.length > 1 ? `${plan.length} 分片` : "scp"}`);
  }
  if (opts.dryRun) {
    console.log("（--dry-run：未上传）");
    return;
  }

  const mkdir = ssh(opts.host, `mkdir -p ${shellQuote(opts.dir)}`, opts.port);
  if (mkdir.status !== 0) throw new Error(`远端目录创建失败：${opts.dir}`);

  for (const file of files) {
    const size = statSync(file).size;
    if (planParts(size, opts.parts).length > 1) await uploadParallel(opts.host, opts.port, opts.dir, file, size, opts.parts);
    else uploadPlain(opts.host, opts.port, opts.dir, file);
  }
  console.log(`✓ 中继镜像完成（${files.length} 个文件 → ${opts.host}${opts.port ? `:${opts.port}` : ""}:${opts.dir}）`);
}

main().catch((e) => {
  console.error(`✗ 中继上传失败：${e?.message || e}`);
  process.exit(1);
});
