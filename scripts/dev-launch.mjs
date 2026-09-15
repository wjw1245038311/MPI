#!/usr/bin/env node
/**
 * 真正脱离调用方地拉起 `electron-vite dev`。
 *
 * 为什么需要单独一个文件：在 bash 里 `nohup npm run dev &` 拉起的进程仍然是调用
 * shell 的子进程/同组进程——调用方（例如远程 agent 的工具调用）被中断时，整个进程
 * 树会被一起干掉，于是"重启脚本杀掉了旧实例却没成功拉起新实例"，用户看到的现象是
 * "MPI 自己定时关掉了"。
 *
 * 这里用 detached + stdio:'ignore' + unref()：子进程自成一个进程组，父进程立刻退出
 * 也不影响它。同时**直接调用 electron-vite 的 JS 入口**（不经 npm/cmd），避免引入
 * cmd.exe 这一层。
 *
 * 用法：node scripts/dev-launch.mjs   → 打印 pid 并立即返回
 */
import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = join(REPO, "logs");
mkdirSync(LOG_DIR, { recursive: true });

const entry = join(REPO, "node_modules", "electron-vite", "bin", "electron-vite.js");
const logPath = join(LOG_DIR, "dev-run.log");
const out = openSync(logPath, "a");

const child = spawn(process.execPath, [entry, "dev"], {
  cwd: REPO,
  detached: true,
  stdio: ["ignore", out, out],
  windowsHide: true,
});

writeFileSync(join(LOG_DIR, "dev-run.pid"), String(child.pid));
child.unref();
console.log(`launched electron-vite dev pid=${child.pid} log=${logPath}`);
