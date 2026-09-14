import { useEffect, useRef, useState } from "react";
import type { RelayClient } from "./lib/relay-client";
import type { ThreadView as ThreadViewState } from "./lib/thread-session";

interface FrameRec { text: string; warn?: boolean; at: string }

/** On-screen diagnostics for real-device debugging — enabled with ?dbg=1 in the URL. */
export default function DbgOverlay({ client, threadView }: { client: RelayClient | null; threadView: ThreadViewState | null }) {
  const [frames, setFrames] = useState<FrameRec[]>([]);
  const logRef = useRef<{ list: FrameRec[] }>({ list: [] });

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

  if (!client) return null;
  return (
    <div className="dbg-overlay">
      <b>DBG</b> cid={client.getClientId()} state={client.getState()} err={client.getLastError() ?? "-"}
      {threadView ? <> | thread ready={String(threadView.ready)} msgs={threadView.messages.length} banner={threadView.errorBanner ?? "-"}</> : null}
      {frames.map((f, i) => (
        <div key={`${f.at}-${i}`} style={f.warn ? { color: "#ff9f43" } : undefined}>{f.at} {f.text}</div>
      ))}
    </div>
  );
}
