import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useStore } from "../store";

/**
 * Pi TUI terminal view — replaces the rendered transcript + composer when a
 * thread is in TUI mode. Spawns an interactive pi (same session file, same
 * working folder) in a main-process PTY and pipes its bytes through xterm.js.
 *
 * Lifecycle: this component only owns the PTY kill on unmount; switching back
 * to GUI mode (store.exitTui / tuiDirty reopen) is handled by the store so it
 * also works when the thread loses focus mid-TUI.
 */

const MONO_STACK = '"Cascadia Code", "JetBrains Mono", "SF Mono", Consolas, "Liberation Mono", monospace';

function themeFor(dark: boolean): { background: string; foreground: string } {
  return dark ? { background: "#111619", foreground: "#e8eef0" } : { background: "#ffffff", foreground: "#1d1e1b" };
}

export function TuiView({ threadId, cwd, sessionFile }: { threadId: string; cwd: string; sessionFile?: string | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [status, setStatus] = useState<"starting" | "ready" | "error">("starting");
  const [errMsg, setErrMsg] = useState("");
  const language = useStore((s) => s.config?.language || "en");

  // PTY + xterm lifecycle (recreated per thread / session file).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: MONO_STACK,
      theme: themeFor(document.documentElement.dataset.theme === "dark"),
      scrollback: 5000,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      /* container may be mid-layout on first frame */
    }

    setStatus("starting");
    setErrMsg("");

    const unsubs: (() => void)[] = [];
    unsubs.push(
      window.pi.tui.onData((p) => {
        if (p.threadId === threadId && !disposed) term.write(p.data);
      }),
    );
    unsubs.push(
      window.pi.tui.onExit((p) => {
        // pi exited on its own (/exit, Ctrl-D): fall back to GUI mode. The store
        // reopen reloads whatever the TUI wrote into the session file.
        if (p.threadId !== threadId || disposed) return;
        const st = useStore.getState();
        st.pushToast("info", language === "zh" ? "Pi 终端已退出，已切回 GUI 模式" : "Pi terminal exited — back to GUI mode");
        void st.exitTui(threadId);
      }),
    );

    const dataSub = term.onData((data) => {
      window.pi.tui.write(threadId, data);
    });

    // Keep the PTY geometry in sync with the visible size.
    let resizeTimer: number | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer !== null) return;
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        try {
          fit.fit();
          window.pi.tui.resize(threadId, term.cols, term.rows);
        } catch {
          /* ignore */
        }
      }, 60);
    });
    ro.observe(host);

    (async () => {
      const res: any = await window.pi.tui.start({ threadId, cwd, sessionFile: sessionFile || null });
      if (disposed) {
        // Unmounted while starting — don't leak the PTY. The gen token makes
        // this conditional: it only kills the PTY THIS start created, never a
        // newer terminal that already took over the thread.
        if (res?.ok && res.gen !== undefined) void window.pi.tui.stop(threadId, res.gen);
        return;
      }
      if (!res?.ok) {
        setErrMsg(res?.error || "unknown error");
        setStatus("error");
        return;
      }
      try {
        fit.fit();
        window.pi.tui.resize(threadId, term.cols, term.rows);
      } catch {
        /* ignore */
      }
      setStatus("ready");
      term.focus();
    })();

    return () => {
      disposed = true;
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      ro.disconnect();
      dataSub.dispose();
      unsubs.forEach((u) => u());
      termRef.current = null;
      // Kill the PTY. History reload for the RPC bridge is the store's job
      // (tuiDirty), so it also covers "switched away mid-TUI".
      void window.pi.tui.stop(threadId).catch(() => undefined);
      term.dispose();
    };
  }, [threadId, cwd, sessionFile]);

  // Follow theme switches (incl. "system") without restarting the terminal —
  // same resolution as App.tsx.
  const themePref = useStore((s) => s.config?.theme || "light");
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const cb = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    media.addEventListener("change", cb);
    return () => media.removeEventListener("change", cb);
  }, []);
  const dark = themePref === "dark" || (themePref === "system" && systemDark);
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = themeFor(dark);
  }, [dark]);

  return (
    <div className="tui-view">
      <div className="tui-host" ref={hostRef} />
      {status !== "ready" && (
        <div className="tui-overlay">
          {status === "starting" ? (
            <>
              <span className="spinner" />
              <p>{language === "zh" ? "正在启动 Pi 终端…" : "Starting Pi terminal…"}</p>
            </>
          ) : (
            <>
              <p className="tui-overlay-err">{errMsg || (language === "zh" ? "Pi 终端启动失败" : "Failed to start the Pi terminal")}</p>
              <button
                type="button"
                onClick={() => {
                  const st = useStore.getState();
                  void st.exitTui(threadId);
                }}
              >
                {language === "zh" ? "返回 GUI 模式" : "Back to GUI mode"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
