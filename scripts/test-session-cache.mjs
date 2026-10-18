/**
 * 会话摘要/用量缓存落盘（src/main/session-store.ts）。
 *
 * 背景（2026-10-18）：重启后首次 `app:getProjects` / `app:getTotalUsage` 会把
 * 205 个会话 / 350MB 全量重解析一遍，主线程被占满 → 首屏 IPC 排队 15s、新建会话跟着卡。
 * 现在按「文件 mtime + size」持久化到 `<userData>/session-cache.json`。
 *
 * 这个测试钉两件事：
 *   1. 首次扫描会落盘（含 schema 版本）；
 *   2. **新进程**（模拟重启）直接信缓存，不再重解析 —— 用「篡改缓存值后读回来」证明；
 *      文件真的变了（mtime/size）才重新解析。
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "mpi-session-cache-"));
const agentDir = join(work, "agent");
const configDir = join(work, "config");
mkdirSync(join(agentDir, "sessions", "proj-a"), { recursive: true });
mkdirSync(configDir, { recursive: true });

const sessionFile = join(agentDir, "sessions", "proj-a", "a.jsonl");
const today = new Date().toISOString();
writeFileSync(
  sessionFile,
  [
    JSON.stringify({ type: "session", id: "s1", cwd: "/tmp/proj-a", timestamp: today }),
    JSON.stringify({ type: "message", message: { role: "user", content: "你好" }, timestamp: today }),
    JSON.stringify({
      type: "message",
      message: { role: "assistant", usage: { totalTokens: 100, cost: { total: 0.5 } } },
      timestamp: today,
    }),
  ].join("\n") + "\n",
);

// 独立的 runner：模拟「另一个进程（重启后的 MPI）」读同一份缓存。
const runner = join(work, "runner.mjs");
writeFileSync(
  runner,
  `import { register } from "node:module";
import { pathToFileURL } from "node:url";
register(pathToFileURL(${JSON.stringify(join(REPO, "scripts", "ts-ext-loader.mjs"))}));
const { loadConfig } = await import(pathToFileURL(${JSON.stringify(join(REPO, "src", "main", "config.ts"))}));
loadConfig(${JSON.stringify(configDir)});
const { getTotalUsage, scanProjects } = await import(pathToFileURL(${JSON.stringify(join(REPO, "src", "main", "session-store.ts"))}));
const usage = await getTotalUsage();
const projects = await scanProjects();
const threads = projects.reduce((n, p) => n + p.threads.length, 0);
console.log(JSON.stringify({ tokens: usage.tokens, sessions: usage.sessions, projects: projects.length, threads }));
`,
  "utf8",
);

const runOnce = () =>
  JSON.parse(
    execFileSync(process.execPath, [runner], {
      cwd: REPO,
      env: { ...process.env, PI_AGENT_DIR: agentDir },
      encoding: "utf8",
    }).trim(),
  );

// --- 1. 首次扫描：算出真值并落盘 -----------------------------------------------
const first = runOnce();
assert.equal(first.tokens, 100, "首次扫描应解析出 100 tokens");
assert.equal(first.threads, 1, "首次扫描应看到 1 条会话");

const cacheFile = join(configDir, "session-cache.json");
const cache = JSON.parse(readFileSync(cacheFile, "utf8"));
assert.equal(cache.schema, 1, "缓存要带 schema 版本");
assert.ok(Array.isArray(cache.summary) && cache.summary.length === 1, "摘要缓存应落盘");
assert.ok(Array.isArray(cache.usage) && cache.usage.length === 1, "用量缓存应落盘");
console.log("  ✓ 首次扫描后写出 session-cache.json（schema 1，摘要 + 用量）");

// --- 2. 篡改缓存值 → 新进程应直接信缓存（证明没有重解析） ----------------------
for (const entry of cache.usage) entry[3] = 424242; // tokens
writeFileSync(cacheFile, JSON.stringify(cache), "utf8");
const cached = runOnce();
assert.equal(cached.tokens, 424242, "新进程应沿用磁盘缓存（否则说明又全量重解析了）");
assert.equal(cached.threads, 1, "摘要也能从磁盘缓存恢复");
console.log("  ✓ 重启进程直接复用磁盘缓存，不再全量重解析");

// --- 3. 文件变了（mtime/size）→ 必须重新解析 -----------------------------------
appendFileSync(
  sessionFile,
  JSON.stringify({
    type: "message",
    message: { role: "assistant", usage: { totalTokens: 7 } },
    timestamp: today,
  }) + "\n",
);
const changed = runOnce();
assert.equal(changed.tokens, 107, "文件变更后应重算：100 + 7 = 107（篡改值必须被真实值覆盖）");
console.log("  ✓ 文件 mtime/size 变化会触发重算（缓存不会被误信）");

rmSync(work, { recursive: true, force: true });
console.log("\nsession-cache 测试通过：3 项");
