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
import DbgOverlay from "./DbgOverlay";
import { IdbKeyStore } from "./lib/keystore-idb";
import type { KeyStore, PairingRecord } from "./lib/keystore";
import { createDeviceIdentity, randomSeedB64url } from "./lib/device-identity";
import { attachAutoReauth, parsePairingLink, runPairing, type PairingStage } from "./lib/pairing";
import { RelayClient } from "./lib/relay-client";
import { HostSession, type SessionSnapshot } from "./lib/session";
import { Requester } from "./lib/requester";
import { ThreadActions } from "./lib/thread-actions";
import { ThreadSession, type ThreadView as ThreadViewState } from "./lib/thread-session";
import { ensureBrowserPush } from "./lib/webpush";

/** ?dbg=1 in the URL turns on the on-screen diagnostics overlay (real-device debugging). */
const DBG_ENABLED = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("dbg");

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
  /** 扫码自动配对：startPairing 定义在后面，用 ref 让挂载时的 effect 能调到它。 */
  const startPairingRef = useRef<(source?: string) => Promise<void>>(async () => {});
  const autoPairHandled = useRef(false);
  const [stage, setStage] = useState<string>("idle");
  const [error, setError] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [connState, setConnState] = useState("idle");
  const [connErr, setConnErr] = useState<string | null>(null);
  /** Both client-creation sites share this: track state + last error (REPLACED etc.). */
  const onClientState = (s: string, err: string | null) => {
    setConnState(s);
    setConnErr(err);
  };
  const [view, setView] = useState<"pairing" | "home">("pairing");
  const [snap, setSnap] = useState<SessionSnapshot | null>(null);
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);

  // S5: open thread (conversation view).
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const openThreadIdRef = useRef<string | null>(null);
  openThreadIdRef.current = openThreadId;
  const [threadSession, setThreadSession] = useState<ThreadSession | null>(null);
  const threadSessionRef = useRef<ThreadSession | null>(null);
  threadSessionRef.current = threadSession;
  const [threadView, setThreadView] = useState<ThreadViewState | null>(null);

  // S6: send control for the open thread. The pending approval (pendingUi) lives
  // in ThreadSession's view so its dedup logic is node-testable without React.
  const [threadActions, setThreadActions] = useState<ThreadActions | null>(null);
  const threadActionsRef = useRef<ThreadActions | null>(null);
  threadActionsRef.current = threadActions;
  const [uiBusy, setUiBusy] = useState(false);
  const [uiError, setUiError] = useState<string | null>(null);

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

  /** S7 WebPush：订阅 + 经加密通道上报 host（best-effort，失败不影响主流程）。 */
  const setupWebPush = (client: RelayClient, relayWsUrl: string) => {
    void (async () => {
      // startSession calls this before the socket is up — wait for the first open.
      if (client.getState() !== "open") {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { detach(); resolve(); }, 10_000);
          const detach = client.onState((s) => {
            if (s === "open") {
              clearTimeout(timer);
              detach();
              resolve();
            }
          });
        });
      }
      const reporter = new Requester(client);
      try {
        await ensureBrowserPush(relayWsUrl, async (subscription) => {
          await reporter.request("push.subscribe", { subscription }, "push.subscribe");
        });
      } catch { /* best-effort */ } finally {
        reporter.detach();
      }
    })();
  };

  /** Create (or reuse) the data session for an established client and enter home. */
  const enterHome = (client: RelayClient, record: PairingRecord) => {
    // S8.7 diagnostic: trace every enterHome call + HostSession creation.
    try {
      const hooks = (globalThis as unknown as { __mpi_dbg?: { dbg?: (e: Record<string, unknown>) => void } }).__mpi_dbg;
      hooks?.dbg?.({ kind: "removed", label: `app@${client.getClientId()}`, requestId: "*", reason: `enterHome ref=${sessionRef.current ? "set" : "null"} stack=${new Error("eh").stack?.split("\n").slice(2, 4).join(" <- ") ?? "?"}` });
    } catch { /* diagnostics must never break the app */ }
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
    const client = new RelayClient({ url: record.relayUrl, onStateChange: onClientState });
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
    setupWebPush(client, record.relayUrl);
  };

  // 扫码即配对：桌面二维码现在是 https 链接 https://<relay>/#pair=<payload>（mpi://
  // 多数扫码器只当文本显示），扫码打开本页即自动开始，省掉手动粘贴。
  useEffect(() => {
    if (autoPairHandled.current) return;
    const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("pair");
    const raw = fromHash ?? new URLSearchParams(window.location.search).get("pair");
    if (!raw) return;
    autoPairHandled.current = true;
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch { /* 已经是解码态 */ }
    const source = decoded.startsWith("mpi://") ? decoded : `mpi://pair?payload=${decoded}`;
    setLink(source);
    void startPairingRef.current(source);
    // 参数用完即抹掉，避免刷新后重复配对；也避免把票据留在地址栏/历史里。
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const startPairing = async (source?: string) => {
    let payload;
    try {
      payload = parsePairingLink(source ?? link);
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
    const client = new RelayClient({ url: payload.relayUrl, onStateChange: onClientState });
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
      setupWebPush(client, payload.relayUrl!);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("error");
    }
  };
  startPairingRef.current = startPairing;

  // S7 deep link: a WebPush notification click lands on /thread/<id> — open it.
  const deepLinkHandled = useRef(false);
  useEffect(() => {
    if (deepLinkHandled.current || view !== "home" || !session) return;
    const m = /^\/thread\/([^/]+)$/.exec(window.location.pathname);
    if (!m) return;
    deepLinkHandled.current = true;
    void openThread(m[1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, session]);

  // S8: a notification click on an already-open app asks us to open the thread
  // in place (sw.js posts the deep link). SPA navigation keeps the live E2E
  // session — no cold-load handshake race. Cold loads (no window open) land on
  // /thread/<id> and go through the deep-link effect below instead.
  const openThreadRef = useRef<(threadId: string) => Promise<void>>(async () => {});
  useEffect(() => {
    const sw = navigator.serviceWorker;
    if (!sw) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | null;
      if (data?.type !== "mpi:deeplink" || typeof data.url !== "string") return;
      const m = /^\/thread\/([^/?#]+)/.exec(data.url);
      if (m && openThreadIdRef.current !== m[1]) void openThreadRef.current(m[1]);
    };
    sw.addEventListener("message", onMessage);
    return () => sw.removeEventListener("message", onMessage);
  }, []);

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
      // S6: send control becomes available once the snapshot is in.
      setUiError(null);
      setThreadActions(new ThreadActions(client, threadId));
    } catch (e) {
      // open() failed — go back to the list and surface the error there.
      const ts = threadSessionRef.current as ThreadSession | null; // re-read: TS narrowing is stale across awaits
      ts?.detach();
      setThreadSession(null);
      setOpenThreadId(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  openThreadRef.current = openThread;

  const closeThread = () => {
    threadActionsRef.current?.detach();
    threadSessionRef.current?.detach();
    setThreadActions(null);
    setUiError(null);
    setThreadSession(null);
    setThreadView(null);
    setOpenThreadId(null);
  };

  const respondUi = async (requestId: string, response: Record<string, unknown>) => {
    const actions = threadActionsRef.current;
    if (!actions || uiBusy) return;
    setUiBusy(true);
    setUiError(null);
    try {
      await actions.respondUi(requestId, response);
      // Dedup + card dismissal live in the session (node-testable).
      threadSessionRef.current?.markUiResponded(requestId);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setUiError(message.startsWith("THREAD_BUSY") ? "该会话正被其他设备操作，无法提交审批。" : `提交失败：${message}`);
    } finally {
      setUiBusy(false);
    }
  };

  const disconnect = () => {
    threadActionsRef.current?.detach();
    threadSessionRef.current?.detach();
    setThreadActions(null);
    setUiError(null);
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
          <ThreadView
            view={threadView}
            actions={threadActions}
            uiBusy={uiBusy}
            uiError={uiError}
            onRespondUi={(id, response) => void respondUi(id, response)}
            onBack={closeThread}
          />
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
            {connState === "closed" && connErr === "REPLACED" && (
              <p className="hint error-text">此设备已在另一个窗口/标签页连接——请关闭另一个，然后刷新本页。</p>
            )}
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
      {DBG_ENABLED && <DbgOverlay client={clientRef.current} threadView={threadView} />}
    </div>
  );
}
