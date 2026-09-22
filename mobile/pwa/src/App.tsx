/**
 * MPI Mobile PWA — pairing (S2) + home view (S4).
 *
 * Pairing: paste mpi://pair link → relay WSS → pair.request → challenge → signed
 * hello → desktop approves → deviceToken stored. Home: host card (online/last seen)
 * → projects → threads with state badges; data flows through HostSession over the
 * E2E-encrypted channel, polling while any thread is running.
 */
import { useEffect, useRef, useState } from "react";
import type { RemoteThreadSnapshot, RemoteThreadState } from "../../shared/protocol";
import ThreadView from "./ThreadView";
import { Check, ChevronRight, Close, Phone, Plus, Refresh } from "./components/icons";
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
import { currentBundleName, isUpdateAvailable } from "./lib/update-watch";

/** ?dbg=1 in the URL turns on the on-screen diagnostics overlay (real-device debugging). */
const DBG_ENABLED = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("dbg");

// 壳（0.2.7+）回前台时靠这个值判断页面是否已过期 → 与中继的 index.html 对比，
// 不同就自动 reload。契约见 docs/ANDROID-SHELL.md #11。
if (typeof window !== "undefined") {
  (window as unknown as { __mpi_build?: string }).__mpi_build = currentBundleName() ?? "";
}

/**
 * 「有新版本 · 点击刷新」浮条。
 *
 * 手机壳里的 WebView 会一直活着（返回只是退到后台、从多任务重开也不重载），
 * 所以新部署的 bundle 可能长时间不被加载。这里定期（及回到前台时）对比服务端
 * index.html 引用的 bundle 名与当前运行的名，不同就提示用户手动刷新。
 */
function UpdatePill() {
  const [stale, setStale] = useState(false);
  const [bundle, setBundle] = useState<string | null>(null);
  useEffect(() => {
    setBundle(currentBundleName());
    let alive = true;
    const check = async () => {
      if (await isUpdateAvailable()) if (alive) setStale(true);
    };
    // 启动稍后查一次（不抢首屏与配对的带宽），之后每 5 分钟一次。
    const first = window.setTimeout(() => void check(), 8_000);
    const timer = window.setInterval(() => void check(), 5 * 60_000);
    // 回到前台立即查——正是「切后台放了很久再回来」的场景。
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearTimeout(first);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  if (!stale) return null;
  return (
    <button
      type="button"
      className="update-pill"
      title={bundle ? `当前 ${bundle}` : undefined}
      onClick={() => window.location.reload()}
    >
      有新版本 · 点击刷新
    </button>
  );
}
// 临时诊断标记：确认手机端加载的是哪一版构建（扫码排查用，稳定后移除）。
const BUILD_TAG = "260922c";

/** 安卓壳注入的桥（浏览器里不存在）——用来显示「扫码配对」并提供壳版本号。 */
type ShellBridge = { scanPairQr: () => void; shellVersion?: () => string };
function shellBridge(): ShellBridge | null {
  const bridge = (window as unknown as { MpiShell?: ShellBridge }).MpiShell;
  return bridge && typeof bridge.scanPairQr === "function" ? bridge : null;
}

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

/** hostId 是 30+ 位不透明串，列表里只显示前 6 位。 */
function shortId(hostId: string): string {
  return hostId.slice(0, 6);
}

/** 中继地址只显示主机部分，列表里够用。 */
function relayHostOf(relayUrl: string): string {
  try {
    return new URL(relayUrl).host;
  } catch {
    return relayUrl;
  }
}

/** 设备显示名：本地重命名 > 配对载荷里的桌面机器名 > 短 ID 兜底。 */
function deviceLabel(item: PairingRecord): string {
  return item.displayName?.trim() || item.hostName || `主机 ${shortId(item.hostId)}`;
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
  const [stage, setStage] = useState<string>("idle");
  const [error, setError] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  /** 已绑定的主机（多设备）。当前主机由 hostId 标记，列表项按最近使用排序。 */
  const [pairings, setPairings] = useState<PairingRecord[]>([]);
  const currentPairing = pairings.find((item) => item.hostId === hostId) ?? null;
  /** 飞书式层级：一级抽屉（项目/会话）、二级抽屉（设备）。 */
  const [drawer, setDrawer] = useState<"none" | "projects" | "devices">("none");
  const drawerRef = useRef(drawer);
  drawerRef.current = drawer;
  const [connState, setConnState] = useState("idle");
  const [connErr, setConnErr] = useState<string | null>(null);
  /** Both client-creation sites share this: track state + last error (REPLACED etc.). */
  const onClientState = (s: string, err: string | null) => {
    setConnState(s);
    // 错误要“粘”住：重连重试会把 state 置回 connecting 且 err=null，如果跟着清，
    // 身份不被认可（4001/AUTH_FAILED）这类永不恢复的错误就会一闪而过。只有真连上才清。
    if (err) setConnErr(err);
    else if (s === "open") setConnErr(null);
  };
  const [view, setView] = useState<"pairing" | "home">("pairing");
  const [snap, setSnap] = useState<SessionSnapshot | null>(null);
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  // P1：新建会话——thread.create 需要 projectId；多项目时先在抽屉里内联选项目。
  const [creatingThread, setCreatingThread] = useState(false);
  const [pickingProject, setPickingProject] = useState(false);

  // S5: open thread (conversation view).
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const openThreadIdRef = useRef<string | null>(null);
  openThreadIdRef.current = openThreadId;
  const [threadSession, setThreadSession] = useState<ThreadSession | null>(null);
  const threadSessionRef = useRef<ThreadSession | null>(null);
  threadSessionRef.current = threadSession;
  const [threadView, setThreadView] = useState<ThreadViewState | null>(null);
  /** 返回键握手用：closeThread 在后面定义，用 ref 打破引用顺序。 */
  const closeThreadRef = useRef<(() => void) | null>(null);

  // S6: send control for the open thread. The pending approval (pendingUi) lives
  // in ThreadSession's view so its dedup logic is node-testable without React.
  const [threadActions, setThreadActions] = useState<ThreadActions | null>(null);
  const threadActionsRef = useRef<ThreadActions | null>(null);
  threadActionsRef.current = threadActions;
  const [uiBusy, setUiBusy] = useState(false);
  const [uiError, setUiError] = useState<string | null>(null);

  // P5-3：壳内推送提示（WebView 没有 PushManager）——按 hostId 记住，关过就不再弹。
  const [pushHintDismissed, setPushHintDismissed] = useState(false);
  useEffect(() => {
    if (!hostId) return;
    try {
      setPushHintDismissed(localStorage.getItem(`mpi-push-hint:${hostId}`) === "1");
    } catch { /* storage unavailable */ }
  }, [hostId]);

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
          if (record.deviceToken && record.deviceId) client.hello(record.deviceId, record.deviceToken, record.hostId);
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
        if (cancelled) return;
        setPairings(pairings);
        // 多设备：优先重连最近用过的那台（旧记录没有 lastSeenAt 时回退到 pairedAt）。
        const target = [...pairings]
          .filter((p) => p.deviceToken)
          .sort((a, b) => (b.lastSeenAt ?? b.pairedAt) - (a.lastSeenAt ?? a.pairedAt))[0];
        if (!target) return;
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
    // 记下“最近用过的设备”，下次自动重连优先它（多设备时不再永远连第一台）。
    const touched: PairingRecord = { ...record, lastSeenAt: Date.now() };
    void storeRef.current.savePairing(touched);
    setPairings((prev) => (prev.some((item) => item.hostId === touched.hostId) ? prev.map((item) => (item.hostId === touched.hostId ? touched : item)) : [...prev, touched]));
    if (!record.deviceToken) return;
    client.setHelloCreds(identity.deviceId, record.deviceToken, record.hostId);
    attachAutoReauth(client, record.hostId, identity, name, (result) => {
      if (result.deviceToken) client.setHelloCreds(identity.deviceId, result.deviceToken, record.hostId);
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
  // 必须监听 hashchange：壳内扫码时 WebView 已在本页，loadUrl 只改 hash → same-document
  // 导航不重载页面、React 不重挂载——没有监听器就静默无反应（真机 bug）。
  useEffect(() => {
    const attempt = () => {
      const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("pair");
      const raw = fromHash ?? new URLSearchParams(window.location.search).get("pair");
      if (!raw) return;
      let decoded = raw;
      try {
        decoded = decodeURIComponent(raw);
      } catch { /* 已经是解码态 */ }
      const source = decoded.startsWith("mpi://") ? decoded : `mpi://pair?payload=${decoded}`;
      // 参数用完即抹掉，避免刷新后重复配对；也避免把票据留在地址栏/历史里。
      // replaceState 不触发 hashchange（无循环）；再次扫码写入新 #pair= → 重新触发。
      window.history.replaceState(null, "", window.location.pathname);
      setLink(source);
      void startPairingRef.current(source);
    };
    attempt();
    window.addEventListener("hashchange", attempt);
    return () => window.removeEventListener("hashchange", attempt);
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
        hostName: payload.hostName,
        lastSeenAt: Date.now(),
      };
      await storeRef.current.savePairing(record);
      setPairings(await storeRef.current.listPairings());
      if (result.deviceToken) client.setHelloCreds(identity.deviceId, result.deviceToken, payload.hostId);
      attachAutoReauth(client, payload.hostId, identity, device.name, (r) => {
        if (r.deviceToken) client.setHelloCreds(identity.deviceId, r.deviceToken, payload.hostId);
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
  closeThreadRef.current = closeThread;

  /**
   * 飞书式：进首页即进对话——自动打开最近更新的那个会话（每台主机只自动开一次，
   * 用户主动关掉后不再弹回来）。
   */
  const autoOpenedHost = useRef<string | null>(null);
  useEffect(() => {
    if (view !== "home" || !hostId || !snap || openThreadId) return;
    if (autoOpenedHost.current === hostId) return;
    const threads = snap.projects.flatMap((project) => snap.threadsByProject[project.id] ?? []);
    if (!threads.length) return;
    autoOpenedHost.current = hostId;
    const latest = [...threads].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    void openThread(latest.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, hostId, snap, openThreadId]);

  /** P1：新建会话。thread.create 需要 projectId；host 返回新会话的 snapshot，
   *  直接进这个对话（ThreadSession 自己拉数据，不依赖首页缓存）。 */
  const createThreadIn = async (projectId: string) => {
    const client = clientRef.current;
    if (!client || creatingThread) return;
    setCreatingThread(true);
    setError(null);
    try {
      // 一次性请求：与 setupWebPush 同模式——建 Requester、用完即 detach。
      const requester = new Requester(client);
      let snapshot: RemoteThreadSnapshot | null = null;
      try {
        const payload = await requester.request<{ snapshot?: RemoteThreadSnapshot }>("thread.create", { projectId }, "create session");
        snapshot = payload?.snapshot ?? null;
      } finally {
        requester.detach();
      }
      if (!snapshot?.id) throw new Error("主机未返回会话 ID");
      // 马上要主动打开这个对话——标记已自动开过，用户关掉后不会被「自动开最新」弹回来。
      autoOpenedHost.current = hostId;
      setPickingProject(false);
      closeAllDrawers();
      void sessionRef.current?.refresh(); // 抽屉列表补上新会话（若正有刷新在跑，下次打开抽屉会再刷）
      void openThread(snapshot.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingThread(false);
    }
  };

  const onNewThreadClick = () => {
    const projects = snap?.projects ?? [];
    if (!projects.length || creatingThread) return;
    if (projects.length === 1) void createThreadIn(projects[0].id);
    else setPickingProject((v) => !v); // 多项目：切换内联项目选择
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

  /** 多设备切换：关掉当前会话与连接，再按选中的 pairing 重连（复用 startSession）。 */
  const switchHost = (record: PairingRecord) => {
    if (record.hostId === hostId) return;
    closeThread();
    setError(null);
    void (async () => {
      const device = await storeRef.current.getDevice();
      if (device) startSession(record, device.seedB64url, device.name);
    })();
  };

  /** 移除一台已绑定设备；删的是当前主机就回配对页。 */
  const removeHost = async (target: string) => {
    await storeRef.current.deletePairing(target);
    setPairings(await storeRef.current.listPairings());
    if (target === hostId) disconnect();
  };

  /** 设备重命名（本地别名）：正在编辑的 hostId + 草稿；提交时空串 = 清除别名用回机器名。 */
  const [renamingHostId, setRenamingHostId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const startRename = (item: PairingRecord) => {
    setRenamingHostId(item.hostId);
    setRenameDraft(item.displayName ?? item.hostName ?? "");
  };

  /** 提交前从存储读最新记录再改——避免用行渲染时的旧快照覆盖掉期间更新的字段（如 lastSeenAt）。 */
  const commitRename = async (targetHostId: string) => {
    const next = renameDraft.trim().slice(0, 40);
    setRenamingHostId(null);
    try {
      const current = await storeRef.current.getPairing(targetHostId);
      if (!current) return; // 期间已被移除
      const updated: PairingRecord = { ...current };
      if (next) updated.displayName = next;
      else delete updated.displayName;
      await storeRef.current.savePairing(updated);
      setPairings(await storeRef.current.listPairings());
    } catch { /* 存储不可用时放弃本次重命名 */ }
  };

  /**
   * 抽屉开合与安卓返回键——单条目制（修「添加设备回不了配对页」）：
   * 任意时刻最多存在一条抽屉历史条目。从关闭态打开 = push；已开的层级之间切换
   * 只 replaceState 换 hash；关闭（返回键/遮罩/程序化）一律单步 back()，popstate
   * 统一收口 none。
   * 原因：go(-2) 这类多步历史跳转在安卓 WebView 里不可靠——点「添加设备」实测要么
   * 整页重载（自动重连立刻弹回最近设备的主页）、要么弹穿栈后台化；单步 back/goBack
   * 则被系统返回键反复验证。代价：设备抽屉里按一次返回键两级一起关（原逐级两次）。
   */
  const openDrawer = (level: "projects" | "devices") => {
    if (drawer === level) return; // 连点头像不得重复压历史条目，否则之后出现「按返回没反应」的死按键
    setDrawer(level);
    // 打开项目抽屉顺手刷一次——桌面新建的会话、手机刚建的会话都不会漏在列表里。
    if (level === "projects") void sessionRef.current?.refresh();
    // 带真实 hash：WebView 的 canGoBack() 只认真正产生历史项的导航，不带 URL 的
    // pushState 在安卓壳里返回键看不到（实测）。
    // 从关闭态打开 = 新条目；已开的层级之间 = 同一条目换 hash（replaceState 不加条目、不触发 popstate）。
    if (drawer === "none") window.history.pushState({ drawer: level }, "", `#${level}`);
    else window.history.replaceState({ drawer: level }, "", `#${level}`);
  };

  /** 关掉所有抽屉：单步 back()（go(-2) 多步跳转在安卓 WebView 不可靠，见 openDrawer 注释），popstate 收口 none。 */
  const closeAllDrawers = () => {
    if (drawer === "none") return;
    window.history.back();
  };

  const closeDrawer = () => {
    if (drawer === "none") return;
    window.history.back(); // 统一在 popstate 里收口，避免两条路径状态不一致
  };

  useEffect(() => {
    // 单条目制：弹掉那一条抽屉历史 = 回主页，不再逐级收口。
    const onPopState = () => setDrawer("none");
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  /**
   * 安卓壳的返回键握手：壳先问 `window.__mpiBack()`。WebView 的 canGoBack() 不把
   * pushState 历史算进去（实测按返回键会直接把 App 后台化、抽屉关不掉），所以逐级
   * 返回由页面自己声明「这一下我处理了没有」。
   */
  useEffect(() => {
    const hooks = window as unknown as { __mpiBack?: () => string };
    hooks.__mpiBack = () => {
      if (drawerRef.current !== "none") {
        window.history.back();
        return "handled";
      }
      // 会话打开时，系统返回键 = 退出会话回列表（没有箭头按钮后这是主要返回路径）。
      if (openThreadIdRef.current) {
        closeThreadRef.current?.();
        return "handled";
      }
      return "pass";
    };
    return () => {
      delete hooks.__mpiBack;
    };
  }, []);

  /** 头部标题：优先当前会话名，其次主机名（放最后推导——依赖上面的多个 state）。 */
  // 会话视图：标题只留会话名（状态/权限已在工具栏 chip 里，重复显示纯属噪声）。
  const headerTitle =
    threadView?.summary?.title ||
    (currentPairing ? deviceLabel(currentPairing) : hostId ? `主机 ${shortId(hostId)}` : "MPI Mobile");
  const headerSubtitle = threadView?.summary
    ? // 副标题用项目名（Qoder 的「环境」位）；状态/权限已在 chip 里，不重复。
      (snap?.projects.find((p) => p.id === threadView.summary?.projectId)?.name ?? "")
    : hostId
      ? connState === "open"
        ? "在线"
        : "连接中…"
      : "";

  /**
   * 设备身份不再被这台主机认可（桌面端撤销过、或手机端身份被重置）时，relay 会用
   * 4001/AUTH_FAILED 关掉连接。此时无限重试毫无意义——得明确告诉用户重新配对。
   */
  const needsRepair = !!connErr && /AUTH_FAILED|4001/i.test(connErr);

  return (
    /* thread-open：会话视图必须是**确定高度**（100dvh）且不整体滚动，
       否则长对话会把输入框顶到屏幕外（"标题和输入框不能共存"）。
       列表页仍用 min-height + 整页滚动。 */
    <div className={`app${view === "home" && openThreadId ? " thread-open" : ""}`}>
      <UpdatePill />
      <header className="app-header">
        <button
          type="button"
          className="avatar-btn"
          // 头像恒为头像（不开箭头）：返回靠系统返回键 + 抽屉切换会话。
          onClick={() => openDrawer("projects")}
          aria-label="项目与会话"
        >
          <span className="app-logo" aria-hidden="true">M</span>
        </button>
        <div className="header-main">
          <h1>{headerTitle}</h1>
          {headerSubtitle && <div className="hint">{headerSubtitle}</div>}
        </div>
        {/* 占位：右侧被壳的 ⋮ 占用，补上等宽元素标题才能真居中 */}
        <span className="header-spacer" aria-hidden="true" />
      </header>
      {view === "home" && hostId && shellBridge() && !pushHintDismissed && (
        <div className="push-hint">
          <span>壳里收不到锁屏推送——在浏览器打开同一地址并配对，就能收到「MPI 需要批准」通知。</span>
          <button
            type="button"
            onClick={() => {
              try { localStorage.setItem(`mpi-push-hint:${hostId}`, "1"); } catch { /* ignore */ }
              setPushHintDismissed(true);
            }}
          >
            知道了
          </button>
        </div>
      )}
      <main className="app-main">
        {view === "home" && hostId && openThreadId && threadView ? (
          <ThreadView
            view={threadView}
            actions={threadActions}
            uiBusy={uiBusy}
            uiError={uiError}
            onRespondUi={(id, response) => void respondUi(id, response)}
            onBack={closeThread}
            // 乐观回显：点发送立刻上屏（不等主机往返，真机反馈过 5-6s 延迟）
            onEcho={(input) => threadSessionRef.current?.echoUser(input) ?? ""}
            onEchoDrop={(id) => threadSessionRef.current?.dropEcho(id)}
          />
        ) : view === "home" && hostId ? (
          <div className="chat-empty">
            <p className="hint">
              {snap && snap.projects.length === 0
                ? "这台桌面还没有项目——先在桌面端建一个项目。"
                : connState !== "open"
                  ? "正在连接桌面端…"
                  : ""}
            </p>
            {error && <p className="hint error-text">{error}</p>}
            {connState === "closed" && connErr === "REPLACED" && (
              <p className="hint error-text">此设备已在另一个窗口/标签页连接——请关闭另一个，然后刷新本页。</p>
            )}
            {snap?.error && <p className="hint error-text">数据刷新失败：{snap.error}</p>}
            {needsRepair && (
              <div className="card">
                <p className="hint" style={{ marginTop: 0 }}>
                  这台桌面不认识本设备了（可能已在该桌面端「撤销设备」，或手机端身份被重置）。需要重新配一次对。
                </p>
                <button className="btn primary btn-with-icon" onClick={disconnect}>
                  <Refresh size={15} /> 重新配对
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="card">
            <p style={{ margin: "0 0 10px" }}>
              {shellBridge() ? "扫码或粘贴桌面端生成的配对链接开始配对。" : "粘贴桌面端生成的配对链接（mpi://pair?…）开始配对。"}
            </p>
            {shellBridge() && (
              <button
                className="btn primary"
                style={{ marginBottom: 10 }}
                onClick={() => shellBridge()?.scanPairQr()}
                disabled={stage === "connecting" || stage === "waiting-challenge" || stage === "waiting-approval"}
              >
                扫码配对
              </button>
            )}
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
            {/* 临时诊断：确认手机加载的是哪一版构建（扫码排查用，稳定后移除） */}
            <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>build {BUILD_TAG}</p>
          </div>
        )}
      </main>
      {/* 飞书式层级：主页是对话 → 头像开一级抽屉（项目/会话）→ 再往左二级抽屉（设备） */}
      {drawer !== "none" && <div className="drawer-backdrop" onClick={closeDrawer} />}

      <aside className={`drawer${drawer !== "none" ? " open" : ""}`} aria-hidden={drawer === "none"}>
        <button type="button" className="drawer-head" onClick={() => openDrawer("devices")}>
          <span className="app-logo small" aria-hidden="true">M</span>
          <span className="drawer-head-main">
            <span className="drawer-head-title">
              {currentPairing ? deviceLabel(currentPairing) : hostId ? `主机 ${shortId(hostId)}` : "未连接"}
            </span>
            <span className="hint hint-with-icon">{pairings.length} 台设备 · 点此切换 <ChevronRight size={13} /></span>
          </span>
        </button>

        {view === "home" && hostId ? (
          <>
            {error && <p className="hint error-text">{error}</p>}
            {connState === "closed" && connErr === "REPLACED" && (
              <p className="hint error-text">此设备已在另一个窗口/标签页连接——请关闭另一个，然后刷新本页。</p>
            )}
            {snap?.error && <p className="hint error-text">数据刷新失败：{snap.error}</p>}

            <button type="button" className="new-thread-btn" onClick={onNewThreadClick} disabled={!snap || creatingThread || snap.projects.length === 0}>
              <Plus size={15} /> {creatingThread ? "创建中…" : "新建会话"}
            </button>
            {pickingProject && !creatingThread && snap && snap.projects.length > 1 && (
              <div className="project-picker">
                {snap.projects.map((project) => (
                  <button key={project.id} type="button" className="project-picker-row" onClick={() => void createThreadIn(project.id)}>
                    {project.name}
                  </button>
                ))}
              </div>
            )}

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
                        <button
                          type="button"
                          key={thread.id}
                          className="thread-row"
                          onClick={() => {
                            void openThread(thread.id);
                            closeAllDrawers();
                          }}
                        >
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
              !snap?.error && <p className="hint">{connState === "open" ? (snap ? "这台桌面还没有项目——先在桌面端建一个。" : "加载项目列表…") : "等待连接…"}</p>
            )}
          </>
        ) : (
          <p className="hint">还没有绑定设备——先扫码或粘贴配对链接。</p>
        )}
      </aside>

      <aside className={`drawer drawer-secondary${drawer === "devices" ? " open" : ""}`} aria-hidden={drawer !== "devices"}>
        <div className="drawer-head plain">
          <span className="drawer-head-title">设备</span>
          <span className="hint">{pairings.length} 台</span>
        </div>
        {pairings.length > 0 ? (
          <div className="device-list">
            {pairings.map((item) => (
              <div key={`${item.hostId}-${item.pairedAt}`} className={`device-row${item.hostId === hostId ? " current" : ""}`}>
                <span className="row-icon" aria-hidden="true"><Phone size={15} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {renamingHostId === item.hostId ? (
                    <div className="device-rename">
                      <input
                        type="text"
                        value={renameDraft}
                        autoFocus
                        maxLength={40}
                        spellCheck={false}
                        placeholder="留空 = 用回机器名"
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitRename(item.hostId);
                          else if (e.key === "Escape") setRenamingHostId(null);
                        }}
                      />
                      <button type="button" className="link-btn" aria-label="确认重命名" onClick={() => void commitRename(item.hostId)}>
                        <Check size={15} />
                      </button>
                      <button type="button" className="link-btn" aria-label="取消重命名" onClick={() => setRenamingHostId(null)}>
                        <Close size={15} />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="device-name device-name-editable"
                      title="点击重命名"
                      onClick={() => startRename(item)}
                    >
                      {deviceLabel(item)}
                    </button>
                  )}
                  <div className="hint">
                    {relayHostOf(item.relayUrl)}
                    {item.lastSeenAt ? ` · 最近 ${relTime(item.lastSeenAt)}` : " · 未连接过"}
                  </div>
                </div>
                {item.hostId === hostId ? (
                  <span className="badge">当前</span>
                ) : (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      switchHost(item);
                      closeAllDrawers();
                    }}
                  >
                    切换
                  </button>
                )}
                <button type="button" className="link-btn" onClick={() => void removeHost(item.hostId)}>
                  移除
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="hint">还没有绑定设备。</p>
        )}
        <button
          type="button"
          className="btn primary"
          style={{ marginTop: 12 }}
          onClick={() => {
            // 先进配对页（同步状态），再关抽屉——即使历史导航出意外，人也已在配对页。
            disconnect();
            closeAllDrawers();
          }}
        >
          <Plus size={15} /> 添加设备（回到配对页）
        </button>
      </aside>

      {DBG_ENABLED && <DbgOverlay client={clientRef.current} threadView={threadView} />}
    </div>
  );
}
