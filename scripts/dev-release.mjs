#!/usr/bin/env node
/**
 * dev-release.mjs —— MPI dev 一键发版流水线（独立脚本版）
 *
 * 由「发版评审会话」中的 agent 在用户明确确认后执行：
 *   node scripts/dev-release.mjs
 *
 * 流程（面板「发版评审」会话运行本脚本；src/main/dev-release.ts 为旧的应用内流水线，已不再使用）：
 *   [1/5] 预检（token / github remote / 版本号；工作区脏则自动 git stash -u）
 *   [2/5] bump patch + changelog Unreleased → vN（日期）
 *   [3/5] commit「release: vX——摘要」
 *   [4/5] push origin main+tag（触发 GitHub Actions 构建）+ 本地 npm run dist 并行（只为 Seafile 副本）
 *   [5/5] publish-release.mjs --wait-ci 等 CI 附件就位 → 校验 → Seafile 分发副本
 *         （家庭上行慢，大文件由 CI 在 GitHub 自家网络上传；超时可手动重跑不带 --wait-ci 走本地上传兜底）
 *
 * 安全边界：
 *   - 工作区不干净不再阻断：自动 stash -u（含 untracked），构建只基于已提交
 *     代码；结束后 finally 自动 pop 恢复。pop 冲突时暂存条目保留并提示手动处理。
 *   - GitHub token 从 env GITHUB_TOKEN 或仓库根 .gh-token（gitignore）读取，
 *     绝不打印到输出里。
 *   - 退出码：0 = 成功；1 = 失败/中止。
 */
import { execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(ROOT, "package.json")) || !existsSync(join(ROOT, "scripts", "publish-release.mjs"))) {
  console.error(`✗ 无法定位仓库根目录：${ROOT}（缺少 package.json / scripts/publish-release.mjs）`);
  process.exit(1);
}

/** Seafile 分发副本目录（与 publish-release.mjs 文档示例一致）；不存在则自动跳过。 */
const SEAFILE_DIR = "E:/Seafile/wei_jw2/我的资料库/Agent";

let stashedCount = 0;
let nextVersion = null;
let stashRestored = false;

function log(line) {
  process.stdout.write(`${line}\n`);
}

/** 恢复暂存的 WIP（幂等）。正常结束走 finally；进程被 Ctrl+C / kill 时走信号
 * 钩子——上次 v0.6.4 发版就是应用中途关闭导致 pop 没执行、WIP 卡在 stash 里。 */
function restoreStash() {
  if (stashRestored || stashedCount === 0 || !nextVersion) return;
  stashRestored = true;
  try {
    const headSubject = gitOut(["log", "-1", "--format=%s"]);
    if (!headSubject.startsWith(`release: v${nextVersion}`)) {
      // 发版提交尚未落地就中止——丢弃流水线自己对 package.json/changelog.md
      // 的未提交写入，pop 才能干净应用。
      execSync("git checkout -- package.json changelog.md", { cwd: ROOT, stdio: "ignore" });
    }
    gitOut(["stash", "pop"]);
    log(`   ✓ 已自动恢复暂存的未提交改动（${stashedCount} 个文件）`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`⚠ 自动恢复暂存失败：${msg.split("\n")[0].slice(0, 160)}\n   暂存条目仍保留，请手动处理（git stash list / git stash pop）`);
  }
}

process.on("SIGINT", () => {
  log("⏹ 收到 Ctrl+C，正在恢复暂存的未提交改动…");
  restoreStash();
  process.exit(130);
});
process.on("SIGTERM", () => {
  log("⏹ 收到终止信号，正在恢复暂存的未提交改动…");
  restoreStash();
  process.exit(143);
});

function git(args) {
  try {
    return execSync(`git ${args}`, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    const msg = e instanceof Error ? String(e.message).split("\n").slice(0, 4).join(" ") : String(e);
    throw new Error(`git ${args} 失败：${msg}`);
  }
}

/** spawnSync + 参数数组（不走 shell）：stash/commit message 含特殊字符也安全。 */
function gitOut(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args[0]} 失败：${(r.stderr || r.error?.message || "").trim().split("\n")[0]}`);
  return (r.stdout || "").trim();
}

function hasToken() {
  if ((process.env.GITHUB_TOKEN || "").trim()) return true;
  try {
    const f = join(ROOT, ".gh-token");
    return existsSync(f) && readFileSync(f, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

function bumpPatch(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) return null;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/** changelog.md：把 `## Unreleased` 改名为 `## v<version>（YYYY-MM-DD）`；
 *  没有该小节时在第一个版本标题前插入空小节。返回 { text, summary, hasEntries }。 */
function renameUnreleased(md, version) {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const heading = `## v${version}（${date}）`;
  const lines = md.split("\n");

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Unreleased\s*$/.test(lines[i])) { start = i; break; }
  }
  if (start < 0) {
    const firstVer = lines.findIndex((l) => /^##\s+v\d/.test(l));
    const at = firstVer >= 0 ? firstVer : lines.length;
    lines.splice(at, 0, heading, "");
    start = at;
  } else {
    lines[start] = heading;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  const titles = [];
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

/** 流式跑一条命令（输出直接透传到 stdout，便于在对话中观察）；返回退出码。 */
function runStream(cmd, args) {
  return new Promise((resolvePromise) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", (err) => {
      log(`✗ 无法启动进程：${err.message}`);
      resolvePromise(null);
    });
    p.on("close", (code) => resolvePromise(code));
  });
}

async function main() {
  log("== MPI dev 一键发版 ==");

  // ---- [1/5] 预检 ---------------------------------------------------------
  log("[1/5] 预检");
  if (!hasToken()) {
    throw new Error("缺少 GitHub token：设置环境变量 GITHUB_TOKEN，或在仓库根目录写入 .gh-token（已 gitignore）");
  }
  log("   ✓ GitHub token 就绪");
  const remoteUrl = git("remote get-url github");
  if (!/[:/]([^:/]+)\/([^/]+?)(?:\.git)?$/.test(remoteUrl)) throw new Error(`github remote 无法解析：${remoteUrl}`);
  log(`   ✓ github remote: ${remoteUrl}`);
  // 预检只取版本号；不要持有这个对象——[2/5] 必须在 stash 之后重新读取（见下）。
  const currentVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  nextVersion = bumpPatch(currentVersion);
  if (!nextVersion) throw new Error(`package.json 版本号不是 x.y.z：${currentVersion}`);
  log(`   ✓ 版本 ${currentVersion} → ${nextVersion}（patch +1）`);

  // 工作区脏不阻断：stash -u 暂存（含 untracked），构建只基于已提交代码；
  // finally 里自动恢复。放在预检最后——上面的硬性失败都不留副作用。
  const porcelain = git("status --porcelain");
  if (porcelain) {
    const files = porcelain.split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
    for (const f of files) log(`   · ${f}`);
    const stashMsg = `MPI dev-release ${new Date().toISOString()}`;
    gitOut(["stash", "push", "-u", "-m", stashMsg]);
    stashedCount = files.length;
    log(`   ✓ 已自动暂存 ${files.length} 个未提交文件（git stash -u，发版结束后自动恢复）`);
  } else {
    log("   ✓ 工作区干净");
  }

  // ---- [2/5] bump + changelog ---------------------------------------------
  log("[2/5] 更新 package.json 与 changelog.md");
  // stash 之后重新读取：预检的 parse 发生在 stash 之前，写回那个旧对象会把
  // package.json 里的未提交 WIP 漏进 release commit（v0.6.6 曾漏入一行测试脚本）。
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  pkg.version = nextVersion;
  writeFileSync(join(ROOT, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");
  const md = readFileSync(join(ROOT, "changelog.md"), "utf8");
  const { text: newMd, summary, hasEntries } = renameUnreleased(md, nextVersion);
  if (newMd === md) throw new Error("changelog.md 未找到 ## Unreleased 小节，且无法定位插入位置");
  writeFileSync(join(ROOT, "changelog.md"), newMd, "utf8");
  if (!hasEntries) log("   ⚠ changelog 无 Unreleased 条目，本次 Release 描述将为空");
  else log(`   ✓ changelog：Unreleased → v${nextVersion}${summary ? `（摘要：${summary}）` : ""}`);

  // ---- [3/5] commit --------------------------------------------------------
  log("[3/5] 提交版本");
  const prevHead = git("rev-parse HEAD");
  gitOut(["add", "package.json", "changelog.md"]);
  const msg = `release: v${nextVersion}${summary ? `——${summary}` : ""}`;
  gitOut(["commit", "-m", msg]);
  log(`   ✓ 已提交 ${git("rev-parse --short HEAD")}：${msg}`);

  // ---- [4/5] push origin + 构建安装包 --------------------------------------
  log("[4/5] 推送 origin 并触发 GitHub Actions 构建；并行构建本地安装包（仅供 Seafile 副本，不再从家里上传）");
  const branch = git("rev-parse --abbrev-ref HEAD");
  const tagName = `v${nextVersion}`;
  try {
    git(`rev-parse -q --verify refs/tags/${tagName}`);
    log(`   ✓ tag ${tagName} 已存在，跳过创建`);
  } catch {
    gitOut(["tag", tagName]);
    log(`   ✓ 创建 tag ${tagName} → ${git("rev-parse --short HEAD")}`);
  }
  try {
    gitOut(["push", "origin", branch]);
    log(`   ✓ 已推送 origin/${branch}`);
  } catch (e) {
    const m = e instanceof Error ? e.message.split("\n")[0] : String(e);
    log(`   ⚠ push origin 失败（不阻断，github 由发布脚本推送）：${m.slice(0, 160)}`);
  }
  try {
    gitOut(["push", "origin", tagName]);
    log(`   ✓ 已推送 ${tagName}（GitHub Actions 构建开始）`);
  } catch (e) {
    const m = e instanceof Error ? e.message.split("\n")[0] : String(e);
    log(`   ⚠ tag push 失败（发布脚本会重试）：${m.slice(0, 160)}`);
  }
  const isWin = process.platform === "win32";
  const distCode = await runStream(isWin ? "cmd" : "sh", isWin ? ["/d", "/s", "/c", "npm run dist"] : ["-c", "npm run dist"]);
  if (distCode !== 0) {
    throw new Error(`构建失败（npm run dist 退出码 ${distCode}）。版本提交已保留：如需撤销可 git reset --hard ${prevHead.slice(0, 7)}；tag 可用 git push origin :refs/tags/${tagName} 删除`);
  }
  log("   ✓ 本地安装包构建完成（仅供 Seafile 分发副本）");

  // ---- [5/5] 发布到 GitHub Release -----------------------------------------
  log("[5/5] 等待 GitHub Actions 上传附件，随后校验并复制 Seafile");
  const args = [join(ROOT, "scripts", "publish-release.mjs"), nextVersion, "--wait-ci"];
  if (existsSync(SEAFILE_DIR)) {
    args.push("--seafile", SEAFILE_DIR);
    log(`   · Seafile 分发副本：${SEAFILE_DIR}`);
  } else {
    log("   · 未找到 Seafile 目录，跳过分发副本");
  }
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const pubCode = await runStream(nodeName, args);
  if (pubCode !== 0) {
    throw new Error(`发布失败（publish-release.mjs 退出码 ${pubCode}）。可修复后手动重跑：npm run release -- ${nextVersion}`);
  }

  log(`🎉 v${nextVersion} 发版完成`);
}

try {
  await main();
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  log(`✗ ${message}`);
  process.exitCode = 1;
} finally {
  // 自动恢复暂存的 WIP（成功/失败都执行；信号钩子已恢复过则跳过）。
  restoreStash();
}
