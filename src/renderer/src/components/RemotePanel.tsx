import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useStore } from "../store";
import { shortDeviceId } from "../../../shared/remote-device-match";
import { Bell, Check, Cloud, Download, Plug, QrCode, Smartphone } from "./icons";

type Pairing = {
  hostId: string;
  fingerprint: string;
  hostPublicKeyPem: string;
  signalingUrl: string;
  stunUrls: string[];
  /** Cloud-relay URL (present when the relay is configured) — the PWA connects here. */
  relayUrl?: string;
  /** 机器名（多设备列表区分主机用）。 */
  hostName?: string;
  ticket: string;
  expiresAt: number;
  protocol: number;
};

type RemoteStatus = {
  signalingEnabled: boolean;
  signalingUrl: string;
  signalingState: string;
  devices: Array<{ deviceId: string; name: string; connectedAt: number; authenticated: boolean }>;
  pendingPairings: Array<{ connectionId: string; deviceId: string; name: string }>;
};

type RelayStatus = {
  state: "disabled" | "connecting" | "connected" | "error";
  relayUrl: string;
  lastError: string | null;
  /** 配对票里给**手机**的中继地址（= 面板里「手机通道地址」字段；空 = 退回 relayUrl）。 */
  mobileRelayUrl?: string;
  /** **本次配对票里实际会告诉手机的地址**（局域网模式 > 手机通道地址 > relayUrl，与主机一致）。 */
  phoneRelayUrl?: string;
  /** 备用通道（阶段 ②）：手机侧备用公网地址（如 `wss://relay.whomidas.cn/ws`；空 = 不进配对票）。 */
  phoneRelayFallbackUrl?: string;
  /** 备用上行是否启用（主机额外挂在**本机中继**上，供 ECS 挂掉时顶替）。 */
  fallbackEnabled?: boolean;
  /** 各通道上行的实时状态（key = 通道 id：lan / primary / …）。 */
  channels?: Array<{ key: string } & Omit<RelayStatus, "mobileRelayUrl" | "phoneRelayUrl">>;
  /** S5：面板编辑用的生效通道列表（`hostUrl` 为**推导后**的实际值；不回传 token，只给 `hasToken`）。 */
  relayChannels?: RelayChannelRow[];
  /** S5：选路模式（manual = 只用选中那条；auto = 全部启用）。 */
  relayMode?: "manual" | "auto";
  /** S5：手动模式下选中的通道 id。 */
  activeChannelId?: string;
  /** 是否已存过通道列表（false = 当前列表由旧字段合成，首次保存后才落盘）。 */
  relayChannelsStored?: boolean;
};

/** S5：渲染层通道行（`tokenDraft` 仅渲染层用：留空 = 保持现有 token，见 config.updateConfig）。 */
type RelayChannelRow = {
  id: string;
  label: string;
  phoneUrl: string;
  hostUrl: string;
  hostUrlConfigured: boolean;
  hasToken: boolean;
  enabled: boolean;
  kind: "local" | "lan" | "remote";
  tokenDraft: string;
};

/** 中继托管的手机 App 安装包清单（/download/mpi-android.json）；中继不可达时
 *  主进程会回退到缓存副本（stale=true）并只提供 GitHub 备选源。 */
type PhoneAppInfo =
  | {
      ok: true;
      stale: boolean;
      error: string | null;
      version: string;
      size: number;
      sha256: string;
      publishedAt: string;
      url: string;
      github: string;
    }
  | { ok: false; error: string };

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pairingUri(pairing: Pairing): string {
  return `mpi://pair?payload=${base64Url(JSON.stringify(pairing))}`;
}

/** wss://host:port/ws → https://host:port（手机能直接打开的 HTTP 源）。 */
function relayOrigin(relayUrl: string): string | null {
  try {
    const url = new URL(relayUrl);
    const scheme = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
    return `${scheme}//${url.host}`;
  } catch {
    return null;
  }
}

/** 扫码用的配对地址。用 https 链接而不是 mpi://：系统相机与绝大多数扫码器只把
 *  未知 scheme 当文本显示，而 https 链接可以直接打开——PWA 读到 #pair= 即自动
 *  开始配对，已装安卓壳则被壳的 VIEW 过滤器接管。无中继时回退到 mpi:// 链接。
 *
 * ⚠ payload 只放配对必需字段：完整对象（含 hostPublicKeyPem PEM/fingerprint/
 * signalingUrl/stunUrls）序列化后 ~650 字符 → QR version≈25（97×97 模块），
 * 手机扫码器在笔记本屏幕距离上基本识别不了（真机 bug）。精简后 ~270 字符 →
 * version 5-6，任何距离都能扫。PWA 的 parsePairingLink 对这些字段本就全部可选
 * （relay 流程的主机 E2E 公钥由 pair.accepted 下发，不从二维码取）。 */
function pairingScanUrl(pairing: Pairing, relayHttp: string | null): string {
  const minimal = {
    hostId: pairing.hostId,
    ticket: pairing.ticket,
    expiresAt: pairing.expiresAt,
    protocol: pairing.protocol,
    ...(pairing.relayUrl ? { relayUrl: pairing.relayUrl } : {}),
    ...(pairing.hostName ? { hostName: pairing.hostName } : {}),
  };
  const payload = base64Url(JSON.stringify(minimal));
  return relayHttp ? `${relayHttp}/#pair=${payload}` : pairingUri(pairing);
}

/** 手机（没有 Tailscale）大概率连不上的地址：tailnet 域名 / 100.x CGNAT / 内网段。 */
function unreachableForPhone(url: string): boolean {
  const value = (url || "").trim();
  if (!value) return false;
  return (
    /\.ts\.net\b/i.test(value) ||
    /\/\/(100\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.)/.test(value)
  );
}

function statusClass(state: string): string {
  return ["connected", "connecting", "error", "disabled"].includes(state) ? state : "disabled";
}

function statusLabel(state: string, zh: boolean): string {
  if (zh) {
    if (state === "connected") return "已连接";
    if (state === "connecting") return "连接中";
    if (state === "error") return "连接错误";
    return "未连接";
  }
  if (state === "connected") return "Connected";
  if (state === "connecting") return "Connecting";
  if (state === "error") return "Connection error";
  return "Not connected";
}

export function RemotePanel({ language }: { language: "en" | "zh" }) {
  const zh = language === "zh";
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  /** 配对二维码的内容：有中继时是打开中继网页的 https 链接，无中继时是 mpi:// 链接。 */
  const [scanUrl, setScanUrl] = useState<string | null>(null);
  const pushToast = useStore((s) => s.pushToast);
  /** 扫码后是否免去桌面端再点一次「允许」（票=凭据，默认开）。 */
  const [autoApprove, setAutoApprove] = useState(true);
  /** 同名且离线的旧绑定是否在配对时被替换（= config.remoteReplaceSameNameOffline）。 */
  const [replaceSameName, setReplaceSameName] = useState(true);
  const [phoneApp, setPhoneApp] = useState<PhoneAppInfo | null>(null);
  /** 下载码只留一个：中继（主）；GitHub 降级为一行文本备用地址。地址只放进 <img title>，不占版面。 */
  const [appQr, setAppQr] = useState<string | null>(null);
  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null);
  const [relayUrl, setRelayUrl] = useState("");
  /** 配对票里给手机的地址（公网可达）。与 relayUrl 分开：主机走 tailnet，手机走公网。 */
  const [mobileRelayUrl, setMobileRelayUrl] = useState("");
  /** 本次配对票里实际会告诉手机的地址（主进程算好，优先级与主机一致）。 */
  const [phoneRelayUrl, setPhoneRelayUrl] = useState("");
  /** 中继准入 token 已在 S5 改为**每通道**（见 channelRows 的 tokenDraft）——不再有全局字段。 */
  /** S5：中继通道列表（编辑副本）+ 选路模式 + 当前通道。 */
  const [channelRows, setChannelRows] = useState<RelayChannelRow[]>([]);
  const [relayMode, setRelayMode] = useState<"manual" | "auto">("manual");
  const [activeChannelId, setActiveChannelId] = useState("");
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  /** 本机中继静态目录（托管 PWA / 下载页；空 = 不托管）。 */
  const [localRelayStaticDir, setLocalRelayStaticDir] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async (syncRelayUrl = true) => {
    try {
      const next = (await window.pi.remote.getStatus()) as RemoteStatus;
      setStatus(next);
    } catch {
      // The panel can briefly outlive the Electron IPC bridge during reload.
    }
    try {
      const relay = (await window.pi.remote.getRelayStatus()) as RelayStatus;
      setRelayStatus(relay);
      if (syncRelayUrl) setRelayUrl(relay.relayUrl || "");
      if (syncRelayUrl) setMobileRelayUrl(relay.mobileRelayUrl || "");
      if (syncRelayUrl) setPhoneRelayUrl(relay.phoneRelayUrl || "");
      if (syncRelayUrl) setChannelRows((relay.relayChannels ?? []).map((row) => ({ ...row, tokenDraft: "" })));
      if (syncRelayUrl) setRelayMode(relay.relayMode === "auto" ? "auto" : "manual");
      if (syncRelayUrl)
        setActiveChannelId(relay.activeChannelId || relay.relayChannels?.find((row) => row.enabled && row.id !== "lan")?.id || "");
    } catch { /* same reload race */ }
  };

  useEffect(() => {
    void refresh();
    void refreshLanMode();
    void (async () => {
      // 「同名离线自动替换」开关的当前值存在 config 里（不在 remote 状态里）
      try {
        const cfg = (await window.pi.app.getConfig()) as { remoteReplaceSameNameOffline?: boolean; localRelayStaticDir?: string };
        if (typeof cfg?.remoteReplaceSameNameOffline === "boolean") setReplaceSameName(cfg.remoteReplaceSameNameOffline);
        if (typeof cfg?.localRelayStaticDir === "string") setLocalRelayStaticDir(cfg.localRelayStaticDir);
      } catch { /* IPC 未就绪 */ }
    })();
    const timer = window.setInterval(() => void refresh(false), 1500);
    const off = window.pi.remote.onPairingRequest(() => void refresh(false));
    return () => {
      window.clearInterval(timer);
      off();
    };
  }, []);

  // 手机 App 安装包信息（中继托管的静态清单）——换中继地址后重取。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const info = (await window.pi.remote.getPhoneApp()) as PhoneAppInfo;
        if (alive) setPhoneApp(info);
      } catch {
        if (alive) setPhoneApp({ ok: false, error: "IPC 不可用" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [relayUrl]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      // 只发中继源的码。中继清单不可达（stale）时不生成码——下面的 GitHub 文本地址兜底。
      const url = phoneApp?.ok && !phoneApp.stale ? phoneApp.url : "";
      const image = url
        ? await QRCode.toDataURL(url, { width: 172, margin: 1, errorCorrectionLevel: "M" }).catch(() => null)
        : null;
      if (alive) setAppQr(image);
    })();
    return () => {
      alive = false;
    };
  }, [phoneApp]);

  const createPairing = async () => {
    setBusy(true);
    try {
      const next = (await window.pi.remote.createPairing(autoApprove)) as Pairing;
      // 二维码的**网址**优先用手机通道地址（公网）：用系统相机/浏览器扫时也不该去打开打不开的
      // tailnet 页（典型症状：浏览器 timeout，而中继日志里一条 pair.request 都没有）。
      // App 内「扫码配对」只读 payload，用哪个网址都一样。
      const url = pairingScanUrl(next, relayOrigin(mobileRelayUrl) ?? relayOrigin(relayUrl));
      setPairing(next);
      setScanUrl(url);
      setQr(await QRCode.toDataURL(url, { width: 260, margin: 1, errorCorrectionLevel: "M" }));
    } finally {
      setBusy(false);
    }
  };

  const copyScanUrl = async () => {
    if (!scanUrl) return;
    try {
      await navigator.clipboard.writeText(scanUrl);
      pushToast("success", zh ? "链接已复制" : "Link copied");
    } catch {
      pushToast("error", zh ? "复制失败" : "Copy failed");
    }
  };

  /** S5：通道列表编辑（本地副本，保存时整表写回；token 留空 = 保持现有）。 */
  const updateChannel = (id: string, patch: Partial<RelayChannelRow>) => {
    setChannelRows((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };
  const addChannel = () => {
    const id = `ch${Date.now().toString(36)}`;
    setChannelRows((rows) => [
      ...rows,
      { id, label: zh ? "新通道" : "New channel", phoneUrl: "", hostUrl: "", hostUrlConfigured: false, hasToken: false, enabled: true, kind: "remote", tokenDraft: "" },
    ]);
    setEditingChannelId(id);
  };
  /**
   * 上下移动一条通道（顺序 = 手机尝试的顺序，首个优先）。
   * 局域网通道由运行时合成，不让越过它。
   */
  const moveChannel = (id: string, delta: number) => {
    setChannelRows((rows) => {
      const index = rows.findIndex((row) => row.id === id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= rows.length) return rows;
      if (rows[target].id === "lan" || rows[index].id === "lan") return rows;
      const next = [...rows];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };
  const removeChannel = (id: string) => {
    setChannelRows((rows) => rows.filter((row) => row.id !== id));
    if (activeChannelId === id) setActiveChannelId("");
  };
  const saveChannels = async () => {
    setBusy(true);
    try {
      await window.pi.app.setConfig({
        // 运行时合成的局域网通道不入配置（它由状态推导）
        relayChannels: channelRows
          .filter((row) => row.id !== "lan")
          .map((row) => ({
            id: row.id,
            label: row.label.trim() || row.id,
            phoneUrl: row.phoneUrl.trim(),
            ...(row.hostUrlConfigured && row.hostUrl.trim() ? { hostUrl: row.hostUrl.trim() } : {}),
            ...(row.tokenDraft.trim() ? { token: row.tokenDraft.trim() } : {}),
            enabled: row.enabled,
            kind: row.kind,
          })),
        relayMode,
        activeChannelId,
        localRelayStaticDir: localRelayStaticDir.trim(),
      });
      // 二维码里存的是**生成那一刻**的地址 —— 改完必须作废旧码（否则扫到的还是老地址）。
      setPairing(null);
      setQr(null);
      setScanUrl(null);
      await refresh(false);
      await refreshLanMode();
    } finally {
      setBusy(false);
    }
  };

  /** 局域网模式（P2）：开关 + 当前地址。 */
  const [lanMode, setLanMode] = useState<{
    enabled: boolean;
    url: string | null;
    attachmentBase: string | null;
    localUrl: string | null;
    port: number;
    address: string | null;
    bindHost: string;
    advertiseLan: boolean;
    lastError: string | null;
  } | null>(null);
  const refreshLanMode = async () => {
    try {
      setLanMode(await window.pi.remote.getLanMode());
    } catch {
      setLanMode(null);
    }
  };
  const toggleLanMode = async () => {
    setBusy(true);
    try {
      setLanMode(await window.pi.remote.setLanMode({ enabled: !lanMode?.advertiseLan }));
    } finally {
      setBusy(false);
    }
  };

  const toggleRelay = async () => {
    setBusy(true);
    try {
      await window.pi.app.setConfig({ remoteRelayEnabled: relayStatus?.state !== "disabled" ? false : true });
      await refresh(false);
    } finally {
      setBusy(false);
    }
  };

  const phoneNeedsAttention = !mobileRelayUrl.trim() && unreachableForPhone(relayUrl);

  return (
    <div className="set-remote-stack">
      <div className="set-card">
        <div className="set-card-head">
          <span className="set-card-icon"><Smartphone size={14} /></span>
          <div className="set-card-title">{zh ? "Android 手机远程控制" : "Android remote companion"}</div>
        </div>
        <div className="set-hint">
          {zh
             ? "手机经自建中继（或局域网直连）连到本机；中继只转发不解析，提示词、代码、会话与文件端到端加密。"
            : "Phones reach this machine through the self-hosted relay (or over the LAN); the relay only forwards, prompts, code, sessions and files stay end-to-end encrypted."}
        </div>
        <div className="set-remote-status" aria-live="polite">
          <span className="set-diag-k">{zh ? "中继连接状态" : "Relay connection"}</span>
          <span className={`set-remote-status-value ${statusClass(relayStatus?.state || "disabled")}`}>
            <span className="set-remote-status-dot" aria-hidden="true" />
            {statusLabel(relayStatus?.state || "disabled", zh)}
            {relayStatus?.lastError ? ` · ${relayStatus.lastError}` : ""}
          </span>
        </div>
      </div>

      <div className="set-card">
        <div className="set-card-head">
          <span className="set-card-icon"><Cloud size={14} /></span>
          <div className="set-card-title">{zh ? "手机版云中继（PWA）" : "Mobile cloud relay (PWA)"}</div>
        </div>
        <div className="set-hint">
          {zh
            ? "手机 PWA 经自建中继连接本机的 WSS uplink；中继只转发不解析，应用内容 E2E 加密（S3）。托盘驻留 + 常开即守护模式。"
            : "The phone PWA reaches this machine through the self-hosted relay over a persistent WSS uplink; the relay only forwards, content is E2E-encrypted (S3). Tray-resident + always-on = daemon mode."}
        </div>
        {/* ---- S5：中继通道列表（替代原来「中继地址 / 手机通道地址」两个固定字段）---- */}
        <div className="set-hint" style={{ fontWeight: 600, marginTop: 4 }}>
          {zh ? "中继通道" : "Relay channels"}
          <span style={{ fontWeight: 400, marginLeft: 6 }}>
            {zh ? "（主机挂在哪几条上；手机连的公网地址写在每条里。从上到下 = 手机尝试的顺序，首个优先）" : "(where this host registers; each row carries the phone-facing URL. Top-to-bottom = the order the phone tries them)"}
          </span>
        </div>
        {channelRows.map((row) => {
          const state = relayStatus?.channels?.find((c) => c.key === row.id)?.state;
          const dotColor =
            row.id === "lan" || state === "connected" ? "#3fb950" : state === "connecting" ? "#d29922" : state === "error" ? "#f85149" : row.enabled ? "#8b95a5" : "#4b5563";
          const dotTitle = row.id === "lan" ? (zh ? "局域网通道（运行时自动探测）" : "LAN channel (auto)") : state || (zh ? "未启用" : "disabled");
          const editing = editingChannelId === row.id;
          return (
            <div key={row.id} style={{ borderTop: "1px solid var(--border, #2a3140)", padding: "8px 0" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, flex: "0 0 auto" }} title={dotTitle} />
                <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <strong style={{ fontWeight: 600 }}>{row.label}</strong>
                    {row.id === "lan" && <em style={{ opacity: 0.7, fontSize: 12 }}>{zh ? "运行时" : "runtime"}</em>}
                    {row.id !== "lan" && !row.enabled && <em style={{ opacity: 0.7, fontSize: 12 }}>{zh ? "已关闭" : "off"}</em>}
                  </div>
                  <div style={{ fontSize: 12, wordBreak: "break-all" }}>{row.phoneUrl || (zh ? "（未填手机地址）" : "(no phone URL)")}</div>
                  <div style={{ fontSize: 12, opacity: 0.65, wordBreak: "break-all" }}>
                    {zh ? "主机上行" : "uplink"}: {row.hostUrl || "—"}
                    {row.hostUrl && !row.hostUrlConfigured ? (zh ? "（推导）" : " (derived)") : ""}
                    {row.hasToken ? (zh ? " · 带准入 token" : " · token") : ""}
                  </div>
                </div>
                {row.id !== "lan" && (
                  <div style={{ display: "flex", gap: 6, flex: "0 0 auto" }}>
                    {/* S5 补口：通道原来只能编辑/删除，没有「停用」——用户只能靠改坏地址来停一条，很难回滚 */}
                    <button
                      type="button"
                      className="set-btn"
                      onClick={() => updateChannel(row.id, { enabled: !row.enabled })}
                      title={
                        row.enabled
                          ? zh
                            ? "停用：不挂这条上行，也不写进手机拿到的通道列表（保存后生效）"
                            : "Disable: stop this uplink and drop it from the phone's channel list (save to apply)"
                          : zh
                            ? "启用（保存后生效）"
                            : "Enable (save to apply)"
                      }
                    >
                      {row.enabled ? (zh ? "停用" : "Disable") : zh ? "启用" : "Enable"}
                    </button>
                    {/* 顺序即手机尝试顺序：没有这两个按钮时，只能靠「删掉再按序加回」来凑 */}
                    <button type="button" className="set-btn" onClick={() => moveChannel(row.id, -1)} title={zh ? "上移（更优先）" : "Move up (higher priority)"}>
                      ↑
                    </button>
                    <button type="button" className="set-btn" onClick={() => moveChannel(row.id, 1)} title={zh ? "下移" : "Move down"}>
                      ↓
                    </button>
                    <button type="button" className="set-btn" onClick={() => setEditingChannelId(editing ? null : row.id)} title={zh ? "编辑" : "Edit"}>
                      {editing ? "收起" : zh ? "编辑" : "Edit"}
                    </button>
                    <button type="button" className="set-btn" onClick={() => removeChannel(row.id)} title={zh ? "删除" : "Delete"}>
                      {zh ? "删除" : "Delete"}
                    </button>
                  </div>
                )}
              </div>
              {editing && (
                <div style={{ marginTop: 8, paddingLeft: 16 }}>
                  <label className="set-addprov-field wide">
                    <span>{zh ? "名称" : "Label"}</span>
                    <input className="set-input" value={row.label} onChange={(e) => updateChannel(row.id, { label: e.target.value })} spellCheck={false} />
                  </label>
                  <label className="set-addprov-field wide">
                    <span>{zh ? "手机地址（公网可达，写进配对票）" : "Phone URL (public, goes into the ticket)"}</span>
                    <input
                      className="set-input"
                      value={row.phoneUrl}
                      onChange={(e) => updateChannel(row.id, { phoneUrl: e.target.value })}
                      placeholder={row.kind === "local" ? "wss://relay.example.com/ws" : "ws://<公网 IP 或域名>:10445/ws"}
                      spellCheck={false}
                    />
                  </label>
                  <label className="set-addprov-field wide">
                    <span>{zh ? "主机上行（留空 = 推导：本机→127.0.0.1，局域网→内网 IP）" : "Host uplink (empty = derived)"}</span>
                    <input className="set-input" value={row.hostUrlConfigured ? row.hostUrl : ""} onChange={(e) => updateChannel(row.id, { hostUrl: e.target.value })} placeholder={row.hostUrl || "ws://127.0.0.1:9001/ws"} spellCheck={false} />
                  </label>
                  <label className="set-addprov-field wide">
                    <span>{zh ? "准入 token（留空 = 保持现有 / 不启用）" : "Access token (empty = keep existing)"}</span>
                    <input
                      className="set-input"
                      value={row.tokenDraft}
                      onChange={(e) => updateChannel(row.id, { tokenDraft: e.target.value })}
                      placeholder={row.hasToken ? (zh ? "已设置，留空则保持不变" : "set; leave empty to keep") : zh ? "留空 = 中继未启用准入" : "empty = no allowlist"}
                      spellCheck={false}
                    />
                  </label>
                  <div className="set-hint">
                    {zh ? "更改手机地址后需重新生成配对二维码（二维码里记的是生成那一刻的地址）。" : "After changing the phone URL, regenerate the pairing QR."}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <button type="button" className="set-btn" style={{ marginTop: 8 }} onClick={addChannel}>
          {zh ? "＋ 添加新服务器地址" : "＋ Add server address"}
        </button>

        <div className="set-remote-toggle-row" style={{ marginTop: 12 }}>
          <div className="set-remote-toggle-copy">
            <span className="set-remote-toggle-label">{zh ? "自动选择最优通道" : "Auto-pick best channel"}</span>
            <span className="set-remote-toggle-state">
              {relayMode === "auto"
                ? zh
                  ? "自动：每条通道都挂上，手机按连通性选"
                  : "Auto: register all, phone picks by reachability"
                : zh
                  ? "手动：只用选中的那条"
                  : "Manual: only the selected one"}
            </span>
          </div>
          <button
            type="button"
            className={`set-toggle ${relayMode === "auto" ? "on" : ""}`}
            role="switch"
            aria-checked={relayMode === "auto"}
            aria-label={zh ? "切换自动选路" : "Toggle auto routing"}
            onClick={() => setRelayMode(relayMode === "auto" ? "manual" : "auto")}
            disabled={busy}
          >
            <span className="set-toggle-knob" />
          </button>
        </div>
        {relayMode === "manual" && channelRows.some((row) => row.id !== "lan") && (
          <label className="set-addprov-field wide">
            <span>{zh ? "当前使用" : "Active channel"}</span>
            <select className="set-input" value={activeChannelId} onChange={(e) => setActiveChannelId(e.target.value)}>
              {channelRows
                .filter((row) => row.enabled)
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.label}
                  </option>
                ))}
            </select>
          </label>
        )}
        <div className="set-hint">
          {zh
            ? "手机端没有 Tailscale，配对票里给它的必须是公网可达地址；留空则该条通道不会被写进票。"
            : "Phones have no Tailscale, so the ticket must carry a publicly reachable address. Empty = that channel is not advertised."}
        </div>
        {phoneNeedsAttention && (
          <div className="set-hint" style={{ color: "#c0392b" }}>
            {zh
              ? `⚠ 手机通道地址为空，会把「${relayUrl.trim()}」发给手机；tailnet/内网地址手机上连不上，配对会卡在“连不上中继”。请把上面的手机通道地址填成公网地址。`
              : `⚠ No phone-side relay URL — the ticket will carry “${relayUrl.trim()}”, which a phone without Tailscale cannot reach. Set a public address above.`}
          </div>
        )}
        <div className="set-hint">
          {zh
            ? "准入 token 现在写在每条通道里（只用于主机向中继注册，不进配对票）；改完点下面的「保存通道」。"
            : "Access tokens now live per channel (host→relay registration only; never in the ticket). Save below."}
        </div>
        {/* ---- 本机中继静态目录（S5 起：地址/开关已并入上面的通道列表）---- */}
        <label className="set-addprov-field wide" style={{ marginTop: 14 }}>
          <span>{zh ? "本机中继静态目录（托管 PWA / 下载页；可留空）" : "Local relay static dir (hosts the PWA; optional)"}</span>
          <input
            className="set-input"
            value={localRelayStaticDir}
            onChange={(event) => setLocalRelayStaticDir(event.target.value)}
            placeholder={zh ? "如 E:\\MyWorkspace\\Software\\cloudflared\\static" : "e.g. E:\\path\\to\\static"}
            spellCheck={false}
          />
        </label>
        <div className="set-hint">
          {zh
            ? "填了目录后，通道里那个公网域名打开就是 PWA 界面（同域名 /ws 是数据通道）——ECS 退场后网页版的界面由这里接管。留空 = 不托管。"
            : "With a directory set, the channel domain serves the PWA UI (same origin /ws is the data channel)."}
        </div>
        <div className="set-hint">
          {zh
            ? "主机同时挂在主中继与本机中继上（本机中继默认 ws://127.0.0.1:9001/ws，应用启动即运行）。主中继挂了时，手机改用这条地址即可——不必再碰这台电脑。留空 = 主机仍在备用通道在线，只是不把地址写进配对票。"
            : "The host stays registered on both the primary and the local relay (ws://127.0.0.1:9001/ws, always running). If the primary dies, the phone switches to this address — no need to touch this machine."}
        </div>
        <label className="set-addprov-field wide">
          <span>{zh ? "本机中继静态目录（托管 PWA / 下载页；可留空）" : "Local relay static dir (hosts the PWA; optional)"}</span>
          <input
            className="set-input"
            value={localRelayStaticDir}
            onChange={(event) => setLocalRelayStaticDir(event.target.value)}
            placeholder={zh ? "如 E:\\MyWorkspace\\Software\\cloudflared\\static" : "e.g. E:\\path\\to\\static"}
            spellCheck={false}
          />
        </label>
        <div className="set-hint">
          {zh
            ? "填了目录后，通道里那个公网域名打开就是 PWA 界面（同域名 /ws 是数据通道）——ECS 退场后网页版的界面由这里接管。留空 = 不托管。"
            : "With a directory set, the channel domain serves the PWA UI (same origin /ws is the data channel) — this replaces the ECS-hosted PWA once it retires."}
        </div>
        <button className="set-btn primary" style={{ marginTop: 10 }} onClick={saveChannels} disabled={busy}>
          {zh ? "保存通道" : "Save channels"}
        </button>
        <div className="set-hint">
          {zh
            ? "改完地址要重新生成配对二维码——二维码里记的是生成那一刻的地址。"
            : "After changing these addresses, generate a fresh pairing QR — the code embeds the addresses as of when it was made."}
        </div>
        <div className="set-remote-toggle-row">
          <div className="set-remote-toggle-copy">
            <span className="set-remote-toggle-label">{zh ? "启用中继 uplink" : "Enable relay uplink"}</span>
            <span className="set-remote-toggle-state">
              {relayStatus?.state !== "disabled" ? (zh ? "已启用" : "On") : (zh ? "已关闭" : "Off")}
            </span>
          </div>
          <button
            type="button"
            className={`set-toggle ${relayStatus?.state !== "disabled" ? "on" : ""}`}
            role="switch"
            aria-checked={relayStatus?.state !== "disabled"}
             aria-label={zh ? "切换中继 uplink" : "Toggle relay uplink"}
            onClick={() => void toggleRelay()}
            disabled={busy || !relayUrl.trim()}
          >
            <span className="set-toggle-knob" />
          </button>
        </div>
      </div>

      <div className="set-card">
        <div className="set-card-head">
          <span className="set-card-icon"><Plug size={14} /></span>
          <div className="set-card-title">{zh ? "局域网模式（手机同网段直连）" : "LAN mode (same network)"}</div>
        </div>
        <div className="set-hint">
          {zh
            ? "开启后桌面端自己起一个只绑局域网的中继，手机连内网地址即可远控：不依赖 Tailscale、不经公网中继，附件也走内网（更快）。代价：手机在后台收不到推送通知，只能回前台时同步。"
            : "Starts a LAN-only relay inside the desktop app so the phone can reach it on the local network: no Tailscale, no public relay, attachments go over the LAN. Trade-off: no background push notifications."}
        </div>
        {lanMode?.url && (
          <div className="set-hint" style={{ wordBreak: "break-all" }}>
            {zh ? "手机填写地址：" : "Phone relay URL: "}<code>{lanMode.url}</code>
            {lanMode.attachmentBase ? (
              <>
                <br />
                {zh ? "附件直连：" : "Attachments: "}<code>{lanMode.attachmentBase}</code>
              </>
            ) : null}
          </div>
        )}
        {lanMode?.enabled && lanMode.localUrl && (
          <div className="set-hint">
            {zh ? "本机中继进程：" : "Local relay: "}
            <code>{lanMode.bindHost}:{lanMode.port}</code>
            {" "}[<code>{lanMode.localUrl}</code>]
          </div>
        )}
        {lanMode?.lastError && <div className="set-hint" style={{ color: "#c0392b" }}>{lanMode.lastError}</div>}
        <div className="set-remote-toggle-row">
          <div className="set-remote-toggle-copy">
            <span className="set-remote-toggle-label">{zh ? "局域网模式" : "LAN mode"}</span>
            <span className="set-remote-toggle-state">
              {lanMode?.advertiseLan ? (zh ? "已开启" : "On") : zh ? "已关闭" : "Off"}
            </span>
          </div>
          <button
            type="button"
            className={`set-toggle ${lanMode?.advertiseLan ? "on" : ""}`}
            role="switch"
            aria-checked={!!lanMode?.advertiseLan}
            aria-label={zh ? "切换局域网模式" : "Toggle LAN mode"}
            onClick={() => void toggleLanMode()}
            disabled={busy}
          >
            <span className="set-toggle-knob" />
          </button>
        </div>
      </div>

      <div className="set-card">
        <div className="set-card-head">
          <span className="set-card-icon"><Download size={14} /></span>
          <div className="set-card-title">{zh ? "手机 App（安卓）" : "Phone app (Android)"}</div>
        </div>
        {phoneApp?.ok ? (
          <div className="set-remote-pairing">
            {appQr ? (
              <div className="set-app-qrs">
                <div className="set-app-qr">
                  <img src={appQr} alt={zh ? "下载安卓 App" : "Download the Android app"} width={172} height={172} title={phoneApp.url} />
                </div>
              </div>
            ) : (
              <div className="set-hint">{zh ? "中继暂不可达，用下面的备用地址" : "Relay unreachable — use the fallback below"}</div>
            )}
            {phoneApp.github && (
              <div className="set-hint">
                <a href={phoneApp.github} target="_blank" rel="noreferrer">{zh ? "GitHub 下载" : "Download from GitHub"}</a>
              </div>
            )}
          </div>
        ) : (
          <div className="set-hint">
            {zh
              ? `暂未取到安装包信息${phoneApp && !phoneApp.ok ? `（${phoneApp.error}）` : ""}`
              : `No package info${phoneApp && !phoneApp.ok ? ` (${phoneApp.error})` : ""}.`}
          </div>
        )}
      </div>

      <div className="set-card">
        <div className="set-card-head">
          <span className="set-card-icon"><QrCode size={14} /></span>
          <div className="set-card-title">{zh ? "配对手机" : "Pair a phone"}</div>
        </div>
        <div className="set-hint">
          {zh
            ? "扫码打开中继网页并自动配对（安卓 App 里也可以点「扫码配对」扫同一个码）。二维码含 5 分钟有效的票据。"
            : "Scanning opens the relay page and pairs automatically (the Android app's own scanner accepts the same code). The ticket expires after five minutes."}
        </div>
        <label className="set-check" style={{ marginTop: 10 }} title={zh ? "票在有效期内即代表你刚刚主动发起配对" : "The ticket itself is the credential"}>
          <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
          <span>{zh ? "扫码后自动批准（无需在桌面点允许）" : "Auto-approve after scan"}</span>
        </label>
        <label
          className="set-check"
          style={{ marginTop: 6 }}
          title={zh
            ? "手机端每换一个网址打开就是一套新的浏览器存储 → 新设备身份；打开它就用同名且离线的旧记录替换（只换最久没露面的那条）"
            : "Each different web address means a new browser storage and thus a new device identity; replacing the same-named offline record keeps the list from filling up"}
        >
          <input
            type="checkbox"
            checked={replaceSameName}
            onChange={async (e) => {
              const next = e.target.checked;
              setReplaceSameName(next);
              await window.pi.app.setConfig({ remoteReplaceSameNameOffline: next });
            }}
          />
          <span>{zh ? "同名离线设备自动替换（避免重复绑定）" : "Replace same-named offline device"}</span>
        </label>
        <button className="set-btn primary" style={{ marginTop: 12 }} onClick={createPairing} disabled={busy}>
          {zh ? "生成配对二维码" : "Generate pairing QR"}
        </button>
        <div className="set-hint" style={{ wordBreak: "break-all" }}>
          {zh ? "手机将连接的地址：" : "The phone will connect to: "}
          <code>{phoneRelayUrl || "—"}</code>
        </div>
        {unreachableForPhone(phoneRelayUrl) && (
          <div className="set-hint" style={{ color: "#c0392b" }}>
            {zh
              ? "⚠ 这是 tailnet / 内网地址——手机（没有 Tailscale、不在同一网段）连不上，扫描后会卡在连接超时。要到外网用就关掉「局域网模式」并把「手机通道地址」填成公网地址；要局域网直连就把手机连到同一 WiFi。"
              : "⚠ This is a tailnet/private address — a phone without Tailscale or outside that network cannot reach it and will time out. Turn off LAN mode and set a public phone-side URL, or join the phone to the same Wi-Fi."}
          </div>
        )}
        {pairing && (
          <div className="set-remote-pairing">
            {qr && <img src={qr} alt={zh ? "手机配对二维码" : "Phone pairing QR code"} width={260} height={260} />}
            {scanUrl && <div className="set-hint" style={{ wordBreak: "break-all" }}>{scanUrl}</div>}
            <div className="set-diag-btns">
              <button className="set-btn ghost" onClick={() => void copyScanUrl()}>{zh ? "复制链接" : "Copy link"}</button>
              {scanUrl?.startsWith("http") && (
                <a className="set-btn ghost" style={{ textDecoration: "none" }} href={scanUrl} target="_blank" rel="noreferrer">
                  {zh ? "在浏览器打开" : "Open in browser"}
                </a>
              )}
            </div>
            <details>
              <summary className="set-hint">{zh ? "粘贴到安卓 App（mpi:// 链接）" : "Paste into the Android app (mpi:// link)"}</summary>
              <textarea className="set-input" rows={4} readOnly value={pairingUri(pairing)} />
            </details>
            <div className="set-hint">{zh ? `指纹：${pairing.fingerprint}` : `Fingerprint: ${pairing.fingerprint}`}</div>
          </div>
        )}
      </div>

      {!!status?.pendingPairings.length && (
        <div className="set-card">
          <div className="set-card-head">
            <span className="set-card-icon"><Bell size={14} /></span>
            <div className="set-card-title">{zh ? "待批准设备" : "Pending devices"}</div>
          </div>
          {status.pendingPairings.map((device) => (
            <div className="set-diag-btns" key={device.connectionId}>
              <span>{device.name} · {device.deviceId}</span>
              <button className="set-btn primary" onClick={async () => { await window.pi.remote.approvePairing(device.connectionId); await refresh(); }}>
                {zh ? "允许" : "Approve"}
              </button>
              <button className="set-btn ghost" onClick={async () => { await window.pi.remote.rejectPairing(device.connectionId); await refresh(); }}>
                {zh ? "拒绝" : "Reject"}
              </button>
            </div>
          ))}
        </div>
      )}

      {!!status?.devices.length && (
        <div className="set-card">
          <div className="set-card-head">
            <span className="set-card-icon"><Check size={14} /></span>
            <div className="set-card-title">{zh ? "已信任设备" : "Trusted devices"}</div>
          </div>
          {status.devices.map((device) => (
            <div className="set-diag-btns" key={device.deviceId}>
              <span>
                {device.name}
                <span className="set-diag-k"> · #{shortDeviceId(device.deviceId)} · </span>
                {device.authenticated ? (zh ? "已连接" : "connected") : (zh ? "离线" : "offline")}
              </span>
              <button className="set-btn ghost" onClick={async () => { await window.pi.remote.revokeDevice(device.deviceId); await refresh(); }}>
                {zh ? "撤销" : "Revoke"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
