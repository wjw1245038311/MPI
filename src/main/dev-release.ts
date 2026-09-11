/**
 * dev-release.ts —— 开发模式一键发版（方案 A：应用内流水线）
 *
 * 把「bump patch → changelog Unreleased 改名 → commit → push origin →
 * npm run dist → publish-release.mjs」串成一条可观察的流水线，供设置页
 * 「关于 MPI」里的 dev 面板调用。仅 !app.isPackaged（dev）可用；打包版
 * 里该面板不渲染、IPC 也会拒绝。
 *
 * 安全边界：
 *   - 预检要求工作区干净（有未提交改动直接中止并列出文件），绝不自动
 *     commit/stash 别人的 WIP——发版只包含已提交内容 + 本次 bump 提交；
 *   - GitHub token 只在 main 进程读取（env GITHUB_TOKEN 或仓库根 .gh-token，
 *     后者已 gitignore），任何情况下不传给 renderer；
 *   - 构建/发布子进程可整体取消（Windows taskkill /T 杀进程树）。
 */
import { execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { app } from "electron";

type LogFn = (line: string) => void;

export interface DevReleaseStatus {
  isDev: boolean;
  running: boolean;
  currentVersion: string | null;
  nextVersion: string | null;
  /** git status --porcelain 的路径列表（空 = 干净） */
  dirtyFiles: string[];
  hasToken: boolean;
}

export interface DevReleaseResult {
  ok: boolean;
  version?: string;
  error?: string;
  cancelled?: boolean;
}

/** Seafile 分发副本目录（与 publish-release.mjs 文档示例一致）；不存在则自动跳过。 */
const SEAFILE_DIR = "E:/Seafile/wei_jw2/我的资料库/Agent";

let running = false;
let cancelRequested = false;
let activeLog: LogFn | null = null;
let activeChild: { pid?: number } | null = null;

/** Ring buffer of recent pipeline lines so a standalone log window opened
 * mid-run (or after the run finished) can replay the full history. */
const LOG_BUFFER_MAX = 5000;
let logBuffer: string[] = [];

function bufferLine(line: string): void {
  logBuffer.push(line);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX);
}

/** Snapshot of the buffered pipeline lines (oldest first). */
export function getDevReleaseLogBuffer(): string[] {
  return [...logBuffer];
}

function repoRoot(): string {
  // dev 下 main bundle 位于 <repo>/out/main/ → ../.. 即仓库根（同 autoLaunchArgs 的推导）。
  const root = resolve(__dirname, "../..");
  if (!existsSync(join(root, "package.json")) || !existsSync(join(root, "scripts", "publish-release.mjs"))) {
    throw new Error(`无法定位仓库根目录：${root}（缺少 package.json / scripts/publish-release.mjs）`);
  }
  return root;
}

function git(args: string): string {
  try {
    return execSync(`git ${args}`, { cwd: repoRoot(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    const msg = e instanceof Error ? String(e.message).split("\n").slice(0, 4).join(" ") : String(e);
    throw new Error(`git ${args} 失败：${msg}`);
  }
}

function hasToken(): boolean {
  if ((process.env.GITHUB_TOKEN || "").trim()) return true;
  try {
    const f = join(repoRoot(), ".gh-token");
    return existsSync(f) && readFileSync(f, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

function bumpPatch(version: string): string | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) return null;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/** changelog.md：把 `## Unreleased` 改名为 `## v<version>（YYYY-MM-DD）`；
 *  没有该小节时在第一个版本标题前插入空小节。返回 { text, summary, hasEntries }，
 *  summary = 小节内前 3 条「**标题**」用 + 连接（供 commit message）。 */
function renameUnreleased(md: string, version: string): { text: string; summary: string; hasEntries: boolean } {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const heading = `## v${version}（${date}）`;
  const lines = md.split("\n");

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Unreleased\s*$/.test(lines[i])) { start = i; break; }
  }
  if (start < 0) {
    // 没有 Unreleased：在第一个版本标题前插入空小节（Release 描述将为空，调用方会警告）。
    const firstVer = lines.findIndex((l) => /^##\s+v\d/.test(l));
    const at = firstVer >= 0 ? firstVer : lines.length;
    lines.splice(at, 0, heading, "");
    start = at;
  } else {
    lines[start] = heading;
  }

  // 小节范围：start+1 → 下一个 `## ` 标题（或文件尾）——只在本节内找条目/标题，
  // 绝不能越过边界误匹配旧版本的内容。
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  const titles: string[] = [];
  let hasEntries = false;
  for (let i = start + 1; i < end; i++) {
    if (/^\s*\d+\.\s+/.test(lines[i])) hasEntries = true;
    if (titles.length < 3) {
      const m = /^\s*\d+\.\s+\*\*(.+?)\*\*/.exec(lines[i]);
      if (m) titles.push(m[1].trim());
    }
  }
  let summary = titles.join("+");
  if (summary.length > 60) summary = summary.slice(0, 57) + "…";

  return { text: lines.join("\n"), summary, hasEntries };
}

/** 流式跑一条命令，逐行回调；返回退出码。cancelRequested 时由 cancelDevRelease() 杀进程树。 */
function runStream(cmd: string, args: string[], onLine: LogFn): Promise<{ code: number | null }> {
  return new Promise((resolvePromise) => {
    const p = spawn(cmd, args, {
      cwd: repoRoot(),
      windowsHide: true,
      env: process.env,
      detached: process.platform !== "win32", // POSIX 下按进程组杀；Windows 用 taskkill /T
    });
    activeChild = p;
    let buf = "";
    const feed = (chunk: string) => {
      buf += chunk.replace(/\r\n/g, "\n");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    };
    p.stdout?.on("data", (d: Buffer) => feed(d.toString("utf8")));
    p.stderr?.on("data", (d: Buffer) => feed(d.toString("utf8")));
    p.on("error", (err) => {
      onLine(`✗ 无法启动进程：${err.message}`);
      activeChild = null;
      resolvePromise({ code: null });
    });
    p.on("close", (code) => {
      if (buf.trim()) onLine(buf.replace(/\n+$/, ""));
      buf = "";
      activeChild = null;
      resolvePromise({ code });
    });
  });
}

function killActiveTree(): void {
  const pid = activeChild?.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
    else process.kill(-pid, "SIGTERM");
  } catch {
    /* 进程可能已退出 */
  }
}

class CancelledError extends Error {}

function assertNotCancelled(): void {
  if (cancelRequested) throw new CancelledError("cancelled");
}

export function getDevReleaseStatus(): DevReleaseStatus {
  const isDev = !app.isPackaged;
  let currentVersion: string | null = null;
  let nextVersion: string | null = null;
  let dirtyFiles: string[] = [];
  try {
    if (isDev) {
      currentVersion = JSON.parse(readFileSync(join(repoRoot(), "package.json"), "utf8")).version ?? null;
      nextVersion = currentVersion ? bumpPatch(currentVersion) : null;
      const porcelain = git("status --porcelain");
      dirtyFiles = porcelain ? porcelain.split("\n").map((l) => l.slice(3).trim()).filter(Boolean) : [];
    }
  } catch {
    /* dev-release 面板只读展示，失败保持空值 */
  }
  return { isDev, running, currentVersion, nextVersion, dirtyFiles, hasToken: isDev ? hasToken() : false };
}

export function cancelDevRelease(): { ok: boolean; error?: string } {
  if (!running) return { ok: false, error: "当前没有进行中的发版" };
  cancelRequested = true;
  activeLog?.("⏹ 正在取消（终止当前进程树）…");
  killActiveTree();
  return { ok: true };
}

export async function startDevRelease(onLog: LogFn): Promise<DevReleaseResult> {
  if (running) return { ok: false, error: "已有发版流程在进行中" };
  if (app.isPackaged) return { ok: false, error: "仅开发模式可用（打包版请走 CI / npm run release）" };

  running = true;
  cancelRequested = false;
  // Buffer every line (including the cancel notice, which goes through
  // activeLog) so the standalone log window can replay history.
  const log = (line: string) => {
    bufferLine(line);
    onLog(line);
  };
  activeLog = log;
  let prevHead = "";
  try {
    log("== MPI dev 一键发版 ==");

    // ---- [1/5] 预检 -------------------------------------------------------
    log("[1/5] 预检");
    const porcelain = git("status --porcelain");
    if (porcelain) {
      const files = porcelain.split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
      for (const f of files) log(`   · ${f}`);
      throw new Error(`工作区有未提交改动（${files.length} 个文件），请先 commit 或 stash 后再发版`);
    }
    log("   ✓ 工作区干净");
    if (!hasToken()) {
      throw new Error("缺少 GitHub token：设置环境变量 GITHUB_TOKEN，或在仓库根目录写入 .gh-token（已 gitignore）");
    }
    log("   ✓ GitHub token 就绪");
    const remoteUrl = git("remote get-url github");
    if (!/[:/]([^:/]+)\/([^/]+?)(?:\.git)?$/.test(remoteUrl)) throw new Error(`github remote 无法解析：${remoteUrl}`);
    log(`   ✓ github remote: ${remoteUrl}`);
    const pkg = JSON.parse(readFileSync(join(repoRoot(), "package.json"), "utf8"));
    const currentVersion: string = pkg.version;
    const nextVersion = bumpPatch(currentVersion);
    if (!nextVersion) throw new Error(`package.json 版本号不是 x.y.z：${currentVersion}`);
    log(`   ✓ 版本 ${currentVersion} → ${nextVersion}（patch +1）`);

    // ---- [2/5] bump + changelog -------------------------------------------
    assertNotCancelled();
    log("[2/5] 更新 package.json 与 changelog.md");
    pkg.version = nextVersion;
    writeFileSync(join(repoRoot(), "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");
    const md = readFileSync(join(repoRoot(), "changelog.md"), "utf8");
    const { text: newMd, summary, hasEntries } = renameUnreleased(md, nextVersion);
    if (newMd === md) throw new Error("changelog.md 未找到 ## Unreleased 小节，且无法定位插入位置");
    writeFileSync(join(repoRoot(), "changelog.md"), newMd, "utf8");
    if (!hasEntries) log("   ⚠ changelog 无 Unreleased 条目，本次 Release 描述将为空");
    else log(`   ✓ changelog：Unreleased → v${nextVersion}${summary ? `（摘要：${summary}）` : ""}`);

    // ---- [3/5] commit ------------------------------------------------------
    assertNotCancelled();
    log("[3/5] 提交版本");
    prevHead = git("rev-parse HEAD");
    // spawnSync + 参数数组（不走 shell）：commit message / 分支名含特殊字符也安全。
    const runGit = (args: string[]) => {
      const r = spawnSync("git", args, { cwd: repoRoot(), encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args[0]} 失败：${(r.stderr || r.error?.message || "").trim().split("\n")[0]}`);
    };
    runGit(["add", "package.json", "changelog.md"]);
    const msg = `release: v${nextVersion}${summary ? `——${summary}` : ""}`;
    runGit(["commit", "-m", msg]);
    log(`   ✓ 已提交 ${git("rev-parse --short HEAD")}：${msg}`);

    // ---- [4/5] push origin + 构建安装包 ------------------------------------
    assertNotCancelled();
    log("[4/5] 推送 origin 并构建安装包（npm run dist，约数分钟）");
    const branch = git("rev-parse --abbrev-ref HEAD");
    try {
      runGit(["push", "origin", branch]);
      log(`   ✓ 已推送 origin/${branch}`);
    } catch (e) {
      const m = e instanceof Error ? e.message.split("\n")[0] : String(e);
      log(`   ⚠ push origin 失败（不阻断，github 由发布脚本推送）：${m.slice(0, 160)}`);
    }
    const isWin = process.platform === "win32";
    const distRes = await runStream(isWin ? "cmd" : "sh", isWin ? ["/d", "/s", "/c", "npm run dist"] : ["-c", "npm run dist"], log);
    assertNotCancelled();
    if (distRes.code !== 0) {
      throw new Error(`构建失败（npm run dist 退出码 ${distRes.code}）。版本提交已保留：如需撤销可 git reset --hard ${prevHead.slice(0, 7)}`);
    }
    log("   ✓ 安装包构建完成");

    // ---- [5/5] 发布到 GitHub Release ---------------------------------------
    assertNotCancelled();
    log("[5/5] 发布到 GitHub Release（tag → push → 附件上传）");
    const args = [join(repoRoot(), "scripts", "publish-release.mjs"), nextVersion];
    if (existsSync(SEAFILE_DIR)) {
      args.push("--seafile", SEAFILE_DIR);
      log(`   · Seafile 分发副本：${SEAFILE_DIR}`);
    } else {
      log("   · 未找到 Seafile 目录，跳过分发副本");
    }
    const nodeName = process.platform === "win32" ? "node.exe" : "node";
    const pubRes = await runStream(nodeName, args, log);
    assertNotCancelled();
    if (pubRes.code !== 0) {
      throw new Error(`发布失败（publish-release.mjs 退出码 ${pubRes.code}）。可修复后手动重跑：npm run release -- ${nextVersion}`);
    }

    log(`🎉 v${nextVersion} 发版完成`);
    return { ok: true, version: nextVersion };
  } catch (e) {
    if (e instanceof CancelledError || cancelRequested) {
      const hint = prevHead ? `（版本提交已保留：如需撤销可 git reset --hard ${prevHead.slice(0, 7)}）` : "";
      log(`⏹ 已取消${hint}`);
      return { ok: false, cancelled: true, error: "用户取消" };
    }
    const message = e instanceof Error ? e.message : String(e);
    log(`✗ ${message}`);
    return { ok: false, error: message };
  } finally {
    running = false;
    cancelRequested = false;
    activeLog = null;
    activeChild = null;
  }
}
