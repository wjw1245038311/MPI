import { useEffect, useRef, useState } from "react";
import type { RelayClient } from "./lib/relay-client";
import type { ThreadView as ThreadViewState } from "./lib/thread-session";

interface FrameRec { text: string; warn?: boolean; at: string }

/** 壳侧取证快照（MpiShell.scanDiagnostics，0.2.3+）：黑屏/扫码无反应时定位用。
 * events 行格式 = "<epochMillis> <事件文本>"。 */
interface ShellDiag {
  shellVersion: string;
  baseUrl: string;
  events: string[];
}

const fmtShellLine = (line: string): string => {
  const m = line.match(/^(\d{13}) (.*)$/);
  return m ? `${new Date(Number(m[1])).toISOString().slice(11, 23)} ${m[2]}` : line;
};

/** On-screen diagnostics for real-device debugging — enabled with ?dbg=1 in the URL.
 * Renders even before a relay client exists (that is exactly when it is needed). */
export default function DbgOverlay({ client, threadView }: { client: RelayClient | null; threadView: ThreadViewState | null }) {
  const [frames, setFrames] = useState<FrameRec[]>([]);
  const logRef = useRef<{ list: FrameRec[] }>({ list: [] });

  // Shell-side event log (load/scan/update) — pulled every 2s while the overlay is up.
  const [shellDiag, setShellDiag] = useState<ShellDiag | null>(null);
  useEffect(() => {
    const bridge = (window as unknown as { MpiShell?: { scanDiagnostics?: () => string } }).MpiShell;
    if (!bridge?.scanDiagnostics) return;
    let alive = true;
    const pull = () => {
      try {
        setShellDiag(JSON.parse(bridge.scanDiagnostics!()));
      } catch { /* 壳返回异常时保持上次值 */ }
    };
    pull();
    const t = setInterval(() => {
      if (alive) pull();
    }, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Shared frame log (Requester correlation hooks + inbound frames push here).
  useEffect(() => {
    const push = (text: string, warn?: boolean) => {
      const log = logRef.current;
      log.list.push({ text, warn, at: new Date().toISOString().slice(11, 23) });
      if (log.list.length > 14) log.list.shift();
      setFrames([...log.list]);
    };
    const g = globalThis as { __mpi_dbg?: Record<string, unknown> };
    g.__mpi_dbg = {
      dbg: (e: { kind: string; label: string; type?: string; requestId?: string; reason?: string; pending?: number }) => {
        if (e.kind === "sent") push(`OUT ${e.label} ${e.type} rid=${e.requestId}`);
        else if (e.kind === "removed") push(`DEL ${e.label} rid=${e.requestId ?? "?"} (${e.reason})`, true);
        else push(`UNMATCHED ${e.label} ${e.type} rid=${e.requestId} pending=${e.pending}`, true);
      },
    };
    return () => { delete g.__mpi_dbg; };
  }, []);

  // Inbound frames (post-decrypt): type + size.
  useEffect(() => {
    if (!client) return;
    const off = client.onFrame((f) => {
      const log = logRef.current;
      log.list.push({
        text: `IN ${typeof f.type === "string" ? f.type : "<enc>"} ${JSON.stringify(f).length}B rid=${typeof f.requestId === "string" ? String(f.requestId) : "-"}`,
        at: new Date().toISOString().slice(11, 23),
      });
      if (log.list.length > 14) log.list.shift();
      setFrames([...log.list]);
    });
    return off;
  }, [client]);

  // Re-render periodically to pick up state/lastError changes.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="dbg-overlay">
      <b>DBG</b>{" "}
      {client
        ? <>cid={client.getClientId()} state={client.getState()} err={client.getLastError() ?? "-"}</>
        : <span style={{ color: "#ff9f43" }}>client 未就绪（页面已渲染、中继连接未建立）</span>}
      {threadView ? <> | thread ready={String(threadView.ready)} msgs={threadView.messages.length} banner={threadView.errorBanner ?? "-"}</> : null}
      {shellDiag && (
        <>
          <div style={{ marginTop: 4 }}>
            <b>SHELL</b> v{shellDiag.shellVersion} base={shellDiag.baseUrl}
          </div>
          {(shellDiag.events || []).slice(-8).map((line, i) => (
            <div key={`sh-${i}`} style={{ color: "#7ec8ff" }}>{fmtShellLine(line)}</div>
          ))}
        </>
      )}
      {frames.map((f, i) => (
        <div key={`${f.at}-${i}`} style={f.warn ? { color: "#ff9f43" } : undefined}>{f.at} {f.text}</div>
      ))}
    </div>
  );
}
