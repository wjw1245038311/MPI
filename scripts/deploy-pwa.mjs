#!/usr/bin/env node
/**
 * 把 PWA 构建产物同步到**公网中继**（ECS）的静态目录。
 *
 * 为什么需要单独一个脚本：网页版（PWA）要能在**外网随时打开**，页面入口就必须挂在公网上
 * （局域网 TLS / tailnet 入口都只在特定网络里可达）。所以 ECS 继续托管一份 PWA —— 但它会
 * **随手动构建而过时**（实测 2026-10-16：ECS 上那份还是 10-09 的构建）。这个脚本就是那条
 * 「构建完顺手同步一次」的路：
 *
 *   node scripts/deploy-pwa.mjs                 # 上传 mobile/pwa/dist
 *   node scripts/deploy-pwa.mjs --host root@1.2.3.4 --dir /var/www/mpi-mobile
 *   node scripts/deploy-pwa.mjs --no-build      # 不重新构建，只上传现有 dist
 *
 * 行为：
 *   1. 默认先 `npm run build`（在 mobile/pwa 下）——避免把旧产物传上去；
 *   2. 上传 index.html / manifest / sw.js / 图标 / assets/；
 *   3. 传完在远端**只保留本版 index.html 引用到的 assets**（旧 bundle 会一直堆着）；
 *   4. 最后 ssh 验证一次远端 index.html 引用的 JS 与本地一致（不一致就报错退出）。
 *
 * 注意：`download/`（APK、手机清单、桌面安装包镜像）与 `mpi-selfsigned-ca.crt` **不动**。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PWA_DIR = join(ROOT, "mobile", "pwa");
const DIST = join(PWA_DIR, "dist");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const HOST = value("--host", process.env.MPI_RELAY_HOST || "root@100.67.5.31");
const DIR = value("--dir", process.env.MPI_RELAY_PWA_DIR || "/var/www/mpi-mobile");
const SSH_OPTS = ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes"];

const log = (line) => console.log(`[deploy-pwa] ${line}`);

/** 本版 index.html 引用的资源文件名（用于远端清理旧 bundle）。 */
function referencedAssets(html) {
  const names = new Set();
  for (const match of html.matchAll(/(?:src|href)="\/?assets\/([^"]+)"/g)) names.add(match[1]);
  return [...names];
}

function main() {
  if (!flag("--no-build")) {
    log("构建 PWA（npm run build）…");
    execFileSync("npm", ["run", "build"], { cwd: PWA_DIR, stdio: "inherit", shell: process.platform === "win32" });
  }
  const indexPath = join(DIST, "index.html");
  if (!existsSync(indexPath)) throw new Error(`找不到构建产物：${indexPath}（先跑 npm run build 或去掉 --no-build）`);
  const html = readFileSync(indexPath, "utf8");
  const assets = referencedAssets(html);
  if (!assets.length) throw new Error("index.html 里没有 assets/ 引用，产物看起来不完整");
  log(`产物：${assets.join(", ")}`);

  // 逐项 scp（不用 -r，避免把旧 bundle 一起带上去覆盖掉不该覆盖的东西）
  const files = ["index.html", "manifest.webmanifest", "sw.js", "icon.svg", "icon-maskable.svg"];
  const existing = files.filter((name) => existsSync(join(DIST, name)));
  execFileSync("scp", [...SSH_OPTS, ...existing.map((name) => join(DIST, name)), `${HOST}:${DIR}/`], { stdio: "inherit" });
  execFileSync("scp", [...SSH_OPTS, "-r", join(DIST, "assets"), `${HOST}:${DIR}/`], { stdio: "inherit" });

  // 远端清理：只留本版引用到的 assets（旧的按内容哈希命名，会无限堆积）
  const keep = assets.join(" ");
  const clean = [
    `cd ${DIR} || exit 1`,
    `for f in assets/*; do case " ${keep} " in *" $(basename "$f") "*) ;; *) rm -f "$f" ;; esac; done`,
    `grep -o 'assets/index-[A-Za-z0-9_-]*\\.js' index.html | head -1`,
  ].join(" && ");
  const remoteJs = execFileSync("ssh", [...SSH_OPTS, HOST, clean], { encoding: "utf8" }).trim();
  const localJs = assets.find((name) => /\.js$/.test(name)) || "";
  if (!remoteJs || !remoteJs.endsWith(localJs)) {
    throw new Error(`远端 index.html 引用的 JS 与本地不一致：远端 ${remoteJs || "(空)"} / 本地 ${localJs}`);
  }
  log(`✓ 已同步到 ${HOST}:${DIR}（远端引用 ${remoteJs}）`);
  log(`网页版入口：https://<中继域名或IP>:9443/（自签证书，设备需装一次根证书）`);
}

try {
  main();
} catch (error) {
  console.error(`[deploy-pwa] ✗ ${error?.message || error}`);
  process.exit(1);
}
