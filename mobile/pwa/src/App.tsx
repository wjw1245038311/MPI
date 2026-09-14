/**
 * MPI Mobile PWA — pairing (S2) + home view (S4).
 *
 * Pairing: paste mpi://pair link → relay WSS → pair.request → challenge → signed
 * hello → desktop approves → deviceToken stored. Home: host card (online/last seen)
 * → projects → threads with state badges; data flows through HostSession over the
 * E2E-encrypted channel, polling while any thread is running.
 */
import { useEffect, useRef, useState } from "react";
import type { RemoteThreadState } from "../../shared/protocol";
import ThreadView from "./ThreadView";
import { IdbKeyStore } from "./lib/keystore-idb";
import type { KeyStore, PairingRecord } from "./lib/keystore";
import { createDeviceIdentity, randomSeedB64url } from "./lib/device-identity";
import { attachAutoReauth, parsePairingLink, runPairing, type PairingStage } from "./lib/pairing";
import { RelayClient } from "./lib/relay-client";
import { HostSession, type SessionSnapshot } from "./lib/session";
import { ThreadSession, type ThreadView as ThreadViewState } from "./lib/thread-session";

const STAGE_LABELS: Record<string, string> = {
  idle: "未连接",
  connecting: "连接中继…",
  open: "已连接",
  closed: "已断开",
  "waiting-challenge": "等待主机挑战…",
  "waiting-approval": "等待桌面端批准…（在 Windows 的 RemotePanel 点「允许」）",
  approved: "配对成功",
  error: "出错",
};

const THREAD_STATE_LABELS: Record<RemoteThreadState, string> = {
  draft: "草稿",
  idle: "空闲",
  running: "运行中",
  error: "出错",
  disconnected: "已断开",
};

/** Compact relative time for list rows. */
function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 45_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  return `${Math.round(diff / 86_400_000)} 天前`;
}

export default function App() {
  const storeRef = useRef<KeyStore>(new IdbKeyStore());
  const clientRef = useRef<RelayClient | null>(null);
  const [session, setSession] = useState<HostSession | null>(null);
  const sessionRef = useRef<HostSession | null>(null);
  sessionRef.current = session;

  const [link, setLink] = useState("");
  const [stage, setStage] = useState<string>("idle");
  const [error, setError] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [connState, setConnState] = useState("idle");
  const [view, setView] = useState<"pairing" | "home">("pairing");
  const [snap, setSnap] = useState<SessionSnapshot | null>(null);
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);

  // S5: open thread (conversation view).
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [threadSession, setThreadSession] = useState<ThreadSession | null>(null);
  const threadSessionRef = useRef<ThreadSession | null>(null);
  threadSessionRef.current = threadSession;
  const [threadView, setThreadView] = useState<ThreadViewState | null>(null);

  // Mirror the session snapshots into React state.
  useEffect(() => {
    if (!session) return;
    setSnap(session.getSnapshot());
    return session.subscribe(setSnap);
  }, [session]);

  useEffect(() => {
    if (!threadSession) return;
    setThreadView(threadSession.getSnapshot());
    return threadSession.subscribe(setThreadView);
  }, [threadSession]);

  /** Create (or reuse) the data session for an established client and enter home. */
  const enterHome = (client: RelayClient, record: PairingRecord) => {
    // Note: use a local — setSession() only lands in sessionRef on the next render.
    let s = sessionRef.current;
    if (!s) {
      s = new HostSession(client, {
        // Request timed out while the socket is still open — the host's uplink may
        // have dropped silently; re-hello forces the relay to re-route + challenge.
        onStaleConnection: () => {
          if (record.deviceToken && record.deviceId) client.hello(record.deviceId, record.deviceToken);
        },
      });
      setSession(s);
    }
    void s.refresh();
    setView("home");
  };

  // Auto-reconnect on load when a pairing with a stored token exists.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const device = await storeRef.current.getDevice();
        if (!device) return;
        const pairings = await storeRef.current.listPairings();
        const target = pairings.find((p) => p.deviceToken);
        if (!target || cancelled) return;
        startSession(target, device.seedB64url, device.name);
      } catch { /* storage unavailable */ }
    })();
    return () => {
      cancelled = true;
      sessionRef.current?.detach();
      clientRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** (Re)connect to a stored pairing. The first socket open triggers re-auth via
   * attachAutoReauth, which also reinstalls E2E crypto; home shows immediately. */
  const startSession = (record: PairingRecord, seedB64url: string, name: string) => {
    clientRef.current?.close();
    sessionRef.current?.detach();
    setSession(null);
    const identity = createDeviceIdentity(seedB64url);
    const client = new RelayClient({ url: record.relayUrl, onStateChange: (s) => setConnState(s) });
    clientRef.current = client;
    setHostId(record.hostId);
    setError(null);
    if (!record.deviceToken) return;
    client.setHelloCreds(identity.deviceId, record.deviceToken);
    attachAutoReauth(client, record.hostId, identity, name, (result) => {
      if (result.deviceToken) client.setHelloCreds(identity.deviceId, result.deviceToken);
      void storeRef.current.savePairing({
        ...record,
        deviceToken: result.deviceToken || null,
        hostX25519PubB64u: result.hostX25519PubB64u || record.hostX25519PubB64u,
      });
      void sessionRef.current?.refresh(); // the open-triggered refresh may have raced AUTH_REQUIRED
      void threadSessionRef.current?.resync().catch(() => {}); // same race for an open conversation
    });
    client.connect();
    enterHome(client, record);
  };

  const startPairing = async () => {
    let payload;
    try {
      payload = parsePairingLink(link);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!payload.relayUrl) {
      setError("链接中没有中继地址（relayUrl）——请用桌面端生成的新版配对链接");
      return;
    }
    let device = await storeRef.current.getDevice();
    if (!device) {
      device = { seedB64url: randomSeedB64url(), name: "MPI PWA" };
      await storeRef.current.saveDevice(device);
    }
    const identity = createDeviceIdentity(device.seedB64url);

    clientRef.current?.close();
    sessionRef.current?.detach();
    setSession(null);
    const client = new RelayClient({ url: payload.relayUrl, onStateChange: (s) => setConnState(s) });
    clientRef.current = client;
    setError(null);
    try {
      const result = await runPairing(client, payload, identity, device.name, (s: PairingStage) => setStage(s));
      const record: PairingRecord = {
        hostId: payload.hostId,
        relayUrl: payload.relayUrl!,
        deviceId: identity.deviceId,
        deviceToken: result.deviceToken || null,
        hostX25519PubB64u: result.hostX25519PubB64u || undefined,
        pairedAt: Date.now(),
      };
      await storeRef.current.savePairing(record);
      if (result.deviceToken) client.setHelloCreds(identity.deviceId, result.deviceToken);
      attachAutoReauth(client, payload.hostId, identity, device.name, (r) => {
        if (r.deviceToken) client.setHelloCreds(identity.deviceId, r.deviceToken);
        void sessionRef.current?.refresh();
        void threadSessionRef.current?.resync().catch(() => {});
      });
      setHostId(payload.hostId);
      enterHome(client, record);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("error");
    }
  };

  /** Open a conversation (S5). The host's uplink must be connected; the home view
   * is hidden while a thread is open, so no double-open guard is needed. */
  const openThread = async (threadId: string) => {
    const client = clientRef.current;
    if (!client) return;
    setOpenThreadId(threadId);
    try {
      const ts = new ThreadSession(client, threadId);
      setThreadSession(ts);
      await ts.open();
    } catch (e) {
      // open() failed — go back to the list and surface the error there.
      const ts = threadSessionRef.current as ThreadSession | null; // re-read: TS narrowing is stale across awaits
      ts?.detach();
      setThreadSession(null);
      setOpenThreadId(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const closeThread = () => {
    threadSessionRef.current?.detach();
    setThreadSession(null);
    setThreadView(null);
    setOpenThreadId(null);
  };

  const disconnect = () => {
    threadSessionRef.current?.detach();
    sessionRef.current?.detach();
    clientRef.current?.close();
    setSession(null);
    setSnap(null);
    setConnState("closed");
    setHostId(null);
    setStage("idle");
    setError(null);
    setExpandedProjectId(null);
    setOpenThreadId(null);
    setThreadSession(null);
    setThreadView(null);
    setView("pairing");
  };

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-logo" aria-hidden="true">M</span>
        <h1>MPI Mobile</h1>
      </header>
      <main className="app-main">
        {view === "home" && hostId && openThreadId && threadView ? (
          <ThreadView view={threadView} onBack={closeThread} />
        ) : view === "home" && hostId ? (
          <div className="card home-card">
            {/* Host card */}
            <div className="host-row">
              <span className={`dot ${connState === "open" ? "ok" : "err"}`} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>主机 {hostId}</div>
                <div className="hint">
                  {snap?.lastFrameAt
                    ? `最后活动 ${relTime(snap.lastFrameAt)}`
                    : connState === "open"
                      ? "在线"
                      : "离线"}
                </div>
              </div>
            </div>

            {error && <p className="hint error-text">{error}</p>}
            {snap?.error && <p className="hint error-text">数据刷新失败：{snap.error}</p>}

            {/* Projects → threads */}
            {snap && snap.projects.length > 0 ? (
              snap.projects.map((project) => {
                const expanded = expandedProjectId === project.id;
                const threads = snap.threadsByProject[project.id] ?? [];
                return (
                  <div key={project.id} className="project">
                    <button type="button" className="project-row" onClick={() => setExpandedProjectId(expanded ? null : project.id)}>
                      <span style={{ fontWeight: 600 }}>{project.name}</span>
                      <span className="hint">{project.threadCount} 会话 · {relTime(project.updatedAt)}</span>
                    </button>
                    {expanded && (
                      threads.length > 0 ? threads.map((thread) => (
                        <button type="button" key={thread.id} className="thread-row" onClick={() => void openThread(thread.id)}>
                          <span className={`badge badge-${thread.state}`}>{THREAD_STATE_LABELS[thread.state]}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div className="thread-title">{thread.title}</div>
                            {thread.preview && <div className="hint thread-preview">{thread.preview}</div>}
                          </div>
                          <span className="hint">{thread.messageCount} 条 · {relTime(thread.updatedAt)}</span>
                        </button>
                      )) : (
                        <div className="hint" style={{ padding: "6px 12px" }}>暂无会话</div>
                      )
                    )}
                  </div>
                );
              })
            ) : (
              !snap?.error && <p className="hint">{connState === "open" ? "加载项目列表…" : "等待连接…"}</p>
            )}

            <button onClick={disconnect}>断开 / 切换主机</button>
          </div>
        ) : (
          <div className="card">
            <p style={{ margin: "0 0 10px" }}>粘贴桌面端生成的配对链接（mpi://pair?…）开始配对。</p>
            <textarea rows={4} value={link} onChange={(e) => setLink(e.target.value)} placeholder="mpi://pair?payload=…" spellCheck={false} />
            <div style={{ marginTop: 10 }}>
              <button onClick={() => void startPairing()} disabled={!link.trim() || stage === "connecting" || stage === "waiting-challenge" || stage === "waiting-approval"}>
                {stage === "waiting-approval" ? "等待批准…" : "连接并配对"}
              </button>
            </div>
            {(stage !== "idle" || error) && (
              <div className="status-line" aria-live="polite">
                <span className={`dot ${stage === "approved" ? "ok" : stage === "error" ? "err" : ""}`} />
                {STAGE_LABELS[stage] ?? stage}
                {error && <span style={{ color: "var(--err)" }}> · {error}</span>}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
