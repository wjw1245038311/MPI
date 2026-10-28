import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useStore } from "../store";
import { SidePanel } from "./SidePanel";
import { Refresh, Terminal as TerminalIcon } from "./icons";

/**
 * 右侧槽的集成终端（代替已被移除的「Pi TUI」入口）。
 *
 * 与 TuiView 的区别：这里跑的是**用户自己的 shell**（Git Bash），不是 pi 的 TUI ——
 * 用途是手敲命令、看输出、在需要交互的地方输密码/账号（这类输不进对话框）。
 * PTY 管道与 TuiView 共用（main/tui.ts 的 kind="shell"），生命周期按 cwd 走：
 * 切会话 = 换目录 = 重开一个 shell（旧的在 unmount 时被 stop 掉）。
 *
 * 复用 SidePanel 外壳，所以宽度拖拽 / 展开 / 关闭与其它右栏面板一致。
 */
const MONO_STACK = '"Cascadia Code", "JetBrains Mono", "SF Mono", Consolas, "Liberation Mono", monospace';

function themeFor(dark: boolean): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  return dark
    ? { background: "#111619", foreground: "#e8eef0", cursor: "#7bd6a1", selectionBackground: "#2c3a42" }
    : { background: "#ffffff", foreground: "#1d1e1b", cursor: "#2e7d52", selectionBackground: "#dcebe2" };
}

export function TerminalPanel({ cwd, threadId }: { cwd: string; threadId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [status, setStatus] = useState<"starting" | "ready" | "error">("starting");
  const [errMsg, setErrMsg] = useState("");
  // 「重开」用它把 effect 重新跑一遍（清屏 + 新建 shell）
  const [epoch, setEpoch] = useState(0);
  const language = useStore((s) => s.config?.language || "en");
  const closeTerminal = useStore((s) => s.closeTerminal);
  const zh = language === "zh";

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    // PTY 键带 shell: 前缀，和 pi 的 TUI 共用同一条管道但不撞槽位。
    const ptyId = `shell:${threadId}`;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: MONO_STACK,
      theme: themeFor(document.documentElement.dataset.theme === "dark"),
      scrollback: 5000,
      // 让 xterm 自己处理 Ctrl+C/Ctrl+V 之类的常见组合
      macOptionIsMeta: false,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    /** 只在容器有真实尺寸时 fit —— 侧板首帧宽度/高度可能是 0。 */
    const safeFit = () => {
      if (host.clientWidth < 24 || host.clientHeight < 24) return false;
      try {
        fit.fit();
        return true;
      } catch {
        return false;
      }
    };
    try {
      term.open(host);
    } catch (e: any) {
      setErrMsg(e?.message || "xterm open failed");
      setStatus("error");
      term.dispose();
      return;
    }
    // 首帧延迟到 renderer 初始化之后（xterm 的 CharSizeService 要等一帧 + 字体就绪），
    // 否则 fit() 会在内部渲染服务还没建立时抛 dimensions 错误。
    const firstFitTimer = window.setTimeout(() => {
      if (disposed) return;
      const ok = safeFit();
      console.log("[term] first fit", ok, host.clientWidth, host.clientHeight);
    }, 180);

    setStatus("starting");
    setErrMsg("");

    let dataSeen = 0;
    const unsubData = window.pi.tui.onData((p) => {
      if (p.threadId !== ptyId || disposed) return;
      try {
        term.write(p.data);
        if (dataSeen < 3) console.log("[term] data bytes", p.data.length);
        dataSeen += 1;
      } catch (e: any) {
        console.error("[term] write failed:", e?.message || String(e));
      }
    });
    const unsubExit = window.pi.tui.onExit((p) => {
      if (p.threadId !== ptyId || disposed) return;
      term.write(`\r\n\x1b[2m[shell exited: ${p.code ?? 0}]\x1b[0m\r\n`);
      setStatus("error");
      setErrMsg(zh ? "shell 已退出，点「重开」新建一个" : "Shell exited — hit Reopen for a new one");
    });
    // 键盘输入写进本终端的 PTY（之前漏了这个前缀，敲键会写到一个不存在的会话上）
    let keysSeen = 0;
    const dataSub = term.onData((data) => {
      // 只记前几次按键：用来确认「键盘 → PTY」这条路通，之后不再刷日志。
      if (keysSeen < 3) console.log("[term] key input bytes", data.length);
      keysSeen += 1;
      window.pi.tui.write(ptyId, data);
    });

    let resizeTimer: number | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer !== null) return;
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        if (!safeFit()) return;
        try {
          window.pi.tui.resize(ptyId, term.cols, term.rows);
        } catch {
          /* ignore */
        }
      }, 60);
    });
    ro.observe(host);

    (async () => {
      // 用 "shell:" 前缀区分会话级的终端实例，避免和同 id 的 pi TUI 撞 PTY 槽位。
      const res: any = await window.pi.tui.start({ threadId: ptyId, cwd, kind: "shell" });
      if (disposed) {
        if (res?.ok && res.gen !== undefined) void window.pi.tui.stop(ptyId, res.gen);
        return;
      }
      console.log("[term] start result", JSON.stringify(res));
      if (!res?.ok) {
        setErrMsg(res?.error || "unknown error");
        setStatus("error");
        return;
      }
      safeFit();
      try {
        window.pi.tui.resize(ptyId, term.cols, term.rows);
      } catch {
        /* ignore */
      }
      setStatus("ready");
      term.focus();
    })();

    return () => {
      disposed = true;
      window.clearTimeout(firstFitTimer);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      ro.disconnect();
      dataSub.dispose();
      unsubData();
      unsubExit();
      termRef.current = null;
      void window.pi.tui.stop(ptyId).catch(() => undefined);
      term.dispose();
    };
    // cwd / threadId 变了 = 换了工作目录 → 重开；epoch 用于手动重开
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, threadId, epoch]);

  // 跟随主题切换
  const themePref = useStore((s) => s.config?.theme || "light");
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  const dark = themePref === "dark" || (themePref === "system" && systemDark);
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    try {
      term.options.theme = themeFor(dark) as any;
    } catch {
      /* 已 dispose 或尚未 open，忽略 */
    }
  }, [dark]);

  return (
    <SidePanel
      title={zh ? "终端" : "Terminal"}
      icon={<TerminalIcon size={15} />}
      onClose={closeTerminal}
    >
      <div className="term-panel">
        <div className="term-meta" title={cwd}>
          <span className="term-meta-cwd">{cwd || "—"}</span>
          <button
            type="button"
            className="iconbtn"
            title={zh ? "重开终端（清屏 + 新 shell）" : "Reopen (clear + new shell)"}
            onClick={() => {
              setStatus("starting");
              setErrMsg("");
              setEpoch((n) => n + 1);
            }}
          >
            <Refresh size={13} />
          </button>
        </div>
        <div className="term-host" ref={hostRef} />
        {status !== "ready" && (
          <div className="term-overlay">
            {status === "starting" ? (
              <>
                <span className="spinner" />
                <p>{zh ? "正在启动终端…" : "Starting terminal…"}</p>
              </>
            ) : (
              <>
                <p className="term-overlay-err">{errMsg || (zh ? "终端启动失败" : "Failed to start the terminal")}</p>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setStatus("starting");
                    setEpoch((n) => n + 1);
                  }}
                >
                  {zh ? "重开" : "Reopen"}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </SidePanel>
  );
}
