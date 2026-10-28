import { spawn, type IPty } from "node-pty";
import type { IpcMain } from "electron";
import { resolvePiRuntime } from "./pi-bridge";
import { getConfig } from "./config";
import { getAgentDir } from "./session-store";
import { getShellState } from "./shell-bootstrap";
import { join } from "node:path";
import { getAdditionalSkillPaths } from "./plugins";

/**
 * Pi TUI terminal sessions.
 *
 * MPI's normal mode drives pi over `--mode rpc` (JSONL on stdio) and renders
 * the transcript itself. The TUI toggle instead spawns an interactive pi in a
 * real PTY (node-pty / ConPTY on Windows) and pipes its bytes to an xterm.js
 * instance in the renderer — the whole dialog becomes the stock pi terminal.
 *
 * Both modes share the same session JSONL: the TUI is started with
 * `--session <file>` so it continues the exact conversation, and when the user
 * switches back to GUI mode the RPC bridge is reopened from that file (see
 * store.toggleTui / TuiView cleanup).
 *
 * Race safety: tui:start is async (runtime resolution + spawn) while
 * tui:stop/tui:start can arrive in any order — React StrictMode double-mounts
 * effects in dev, and users can toggle in/out faster than a PTY boots. A
 * per-thread generation token invalidates superseded starts: when an old
 * start finally spawns its process it kills it immediately instead of leaking
 * it (or worse, having its late "stop" kill the NEW terminal). tui:exit is
 * only emitted for pi processes that exit on their own (/exit, Ctrl-D), never
 * for ones we killed — otherwise a superseded start's death would yank the
 * user back to GUI mode.
 */

interface TuiSession {
  pty: IPty;
  cwd: string;
  sessionFile?: string;
  /** Generation that owns this PTY — conditional stops must match it. */
  gen: number;
}

const sessions = new Map<string, TuiSession>(); // threadId -> live PTY
/** threadId -> latest generation (bumped by every start AND stop). */
const generations = new Map<string, number>();

function nextGeneration(threadId: string): number {
  const gen = (generations.get(threadId) ?? 0) + 1;
  generations.set(threadId, gen);
  return gen;
}

function killTui(threadId: string): void {
  const s = sessions.get(threadId);
  if (!s) return;
  sessions.delete(threadId);
  try {
    s.pty.kill();
  } catch {
    /* already gone */
  }
}

export function stopAllTuis(): void {
  for (const id of [...sessions.keys()]) killTui(id);
}

/** Live PTY generations per thread — diagnostics/tests only. */
export function tuiDebugSessions(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, s] of sessions) out[id] = s.gen;
  return out;
}

export function registerTuiIpc(
  ipcMain: IpcMain,
  sendToRenderer: (channel: string, payload: unknown) => void,
): void {
  ipcMain.handle(
    "tui:start",
    async (
      _e,
      args: { threadId: string; cwd: string; sessionFile?: string | null; kind?: "pi" | "shell" },
    ) => {
      const { threadId, cwd } = args;
      const kind = args.kind === "shell" ? "shell" : "pi";
      // Re-entering TUI mode restarts the terminal fresh; conversation state
      // lives in the session file, so nothing is lost.
      killTui(threadId);
      const gen = nextGeneration(threadId);
      try {
        // kind="shell"：右侧槽的集成终端 —— 跑用户自己的 Git Bash，用于手敲命令、输密码等
        // 需要真交互的场合（pi 的 TUI 入口已从 UI 移除，但这条 PTY 管道两边共用）。
        let shellCmd: string;
        let shellArgs: string[];
        if (kind === "shell") {
          const shell = getShellState(join(getAgentDir(), "settings.json")).shell;
          shellCmd = shell.path;
          shellArgs = ["-i", "-l"];
        } else {
          const rt = await resolvePiRuntime(getConfig().piCliPath);
          shellCmd = rt.node;
          shellArgs = [rt.cli];
          if (args.sessionFile) shellArgs.push("--session", args.sessionFile);
          // Same skill inventory as RPC mode so both modes see the same skills.
          for (const skill of getAdditionalSkillPaths(cwd)) shellArgs.push("--skill", skill);
        }

        console.log(`[tui] spawn kind=${kind} cmd=${shellCmd} args=${shellArgs.join(" ")} cwd=${cwd}`);
        const pty = spawn(shellCmd, shellArgs, {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd,
          env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
        });

        // A stop (or a newer start) may have landed while we were awaiting —
        // this spawn is already stale. Kill it; the renderer's matching call
        // has unmounted or been superseded and ignores the result either way.
        if (generations.get(threadId) !== gen) {
          try {
            pty.kill();
          } catch {
            /* ignore */
          }
          return { ok: false, error: "superseded" };
        }

        const sess: TuiSession = { pty, cwd, sessionFile: args.sessionFile || undefined, gen };
        pty.onData((data) => {
          // Only forward bytes from the CURRENT session — a stale process's
          // dying output must not bleed into the replacement terminal.
          if (sessions.get(threadId) === sess) sendToRenderer("tui:data", { threadId, data });
        });
        pty.onExit(({ exitCode }) => {
          // Only pi-initiated exits notify the renderer; kills we perform are
          // expected and must not trigger the "back to GUI" fallback.
          if (sessions.get(threadId) === sess) {
            sessions.delete(threadId);
            sendToRenderer("tui:exit", { threadId, code: exitCode });
          }
        });

        sessions.set(threadId, sess);
        console.log(`[tui] spawned kind=${kind} key=${threadId} pid=${pty.pid}`);
        // 首包诊断：shell 起来后应立刻吐提示符；没有就是 PTY/参数问题。
        let firstDataLogged = false;
        pty.onData(() => {
          if (firstDataLogged) return;
          firstDataLogged = true;
          console.log(`[tui] first data kind=${kind} key=${threadId}`);
        });
        // The renderer keeps `gen` so a late "orphan cleanup" stop from an
        // already-unmounted effect can only kill the PTY it actually started.
        return { ok: true, gen };
      } catch (e: any) {
        console.error(`[tui] spawn failed kind=${kind} key=${threadId}:`, e?.message || String(e));
        return { ok: false, error: e?.message || String(e) };
      }
    },
  );

  ipcMain.handle("tui:write", (_e, args: { threadId: string; data: string }) => {
    const sess = sessions.get(args.threadId);
    if (!sess) {
      // 键盘输入打到不存在的 PTY 上：说明 start 没成功或 key 不一致，值得一条日志。
      console.log(`[tui] write dropped (no session) key=${args.threadId} bytes=${args.data?.length ?? 0}`);
      return;
    }
    sess.pty.write(args.data);
  });

  ipcMain.handle("tui:resize", (_e, args: { threadId: string; cols: number; rows: number }) => {
    const s = sessions.get(args.threadId);
    if (!s) return;
    try {
      s.pty.resize(Math.max(2, Math.floor(args.cols)), Math.max(1, Math.floor(args.rows)));
    } catch {
      /* resize races with exit are harmless */
    }
  });

  ipcMain.handle(
    "tui:stop",
    (_e, args: { threadId: string; gen?: number }) => {
      if (args.gen !== undefined) {
        // Conditional stop: only kill the PTY owned by this generation. A
        // stale effect's cleanup must not kill a NEWER terminal that took
        // over the same thread (StrictMode double-mount, fast toggling).
        const s = sessions.get(args.threadId);
        if (!s || s.gen !== args.gen) return { ok: true };
        nextGeneration(args.threadId);
        killTui(args.threadId);
        return { ok: true };
      }
      // Unconditional stop (unmount / app quit): invalidate any in-flight
      // start for this thread before killing the live PTY, so a slow spawn
      // that finishes later sees itself as superseded.
      nextGeneration(args.threadId);
      killTui(args.threadId);
      return { ok: true };
    },
  );
}
