import { useEffect, useState } from "react";
import QRCode from "qrcode";

const DEFAULT_SIGNALING_URL = "wss://mpi-remote.scholarcn.com/ws";

type Pairing = {
  hostId: string;
  fingerprint: string;
  hostPublicKeyPem: string;
  signalingUrl: string;
  stunUrls: string[];
  /** Cloud-relay URL (present when the relay is configured) — the PWA connects here. */
  relayUrl?: string;
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
 *  开始配对，已装安卓壳则被壳的 VIEW 过滤器接管。无中继时回退到 mpi:// 链接。 */
function pairingScanUrl(pairing: Pairing, relayHttp: string | null): string {
  const payload = base64Url(JSON.stringify(pairing));
  return relayHttp ? `${relayHttp}/#pair=${payload}` : pairingUri(pairing);
}

function formatSize(bytes: number): string {
  if (!bytes) return "—";
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
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
  /** 扫码后是否免去桌面端再点一次「允许」（票=凭据，默认开）。 */
  const [autoApprove, setAutoApprove] = useState(true);
  const [phoneApp, setPhoneApp] = useState<PhoneAppInfo | null>(null);
  /** 两张下载码：中继（主）+ GitHub（备选）。地址只放进 <img title>，不占版面。 */
  const [appQrs, setAppQrs] = useState<{ relay: string | null; github: string | null }>({ relay: null, github: null });
  const [signalingUrl, setSignalingUrl] = useState(DEFAULT_SIGNALING_URL);
  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null);
  const [relayUrl, setRelayUrl] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async (syncSignalUrl = true) => {
    try {
      const next = (await window.pi.remote.getStatus()) as RemoteStatus;
      setStatus(next);
      if (syncSignalUrl) setSignalingUrl(next.signalingUrl || DEFAULT_SIGNALING_URL);
    } catch {
      // The panel can briefly outlive the Electron IPC bridge during reload.
    }
    try {
      const relay = (await window.pi.remote.getRelayStatus()) as RelayStatus;
      setRelayStatus(relay);
      if (syncSignalUrl) setRelayUrl(relay.relayUrl || "");
    } catch { /* same reload race */ }
  };

  useEffect(() => {
    void refresh();
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
    const make = async (text?: string) =>
      text ? QRCode.toDataURL(text, { width: 172, margin: 1, errorCorrectionLevel: "M" }).catch(() => null) : null;
    void (async () => {
      if (!phoneApp?.ok) {
        if (alive) setAppQrs({ relay: null, github: null });
        return;
      }
      const relay = phoneApp.stale ? null : await make(phoneApp.url);
      const github = await make(phoneApp.github || undefined);
      if (alive) setAppQrs({ relay, github });
    })();
    return () => {
      alive = false;
    };
  }, [phoneApp]);

  const saveTransport = async () => {
    setBusy(true);
    try {
      await window.pi.remote.setConfig({ signalingUrl: signalingUrl.trim() });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const createPairing = async () => {
    setBusy(true);
    try {
      const next = (await window.pi.remote.createPairing(autoApprove)) as Pairing;
      setPairing(next);
      setQr(await QRCode.toDataURL(pairingScanUrl(next, relayOrigin(relayUrl)), { width: 260, margin: 1, errorCorrectionLevel: "M" }));
    } finally {
      setBusy(false);
    }
  };

  const enableRemote = async () => {
    setBusy(true);
    try {
      await window.pi.remote.enableSignaling(true);
      await refresh(false);
    } finally {
      setBusy(false);
    }
  };

  const disableRemote = async () => {
    setBusy(true);
    try {
      await window.pi.remote.disableSignaling();
      await refresh(false);
    } finally {
      setBusy(false);
    }
  };

  const toggleRemote = async () => {
    if (status?.signalingEnabled) await disableRemote();
    else await enableRemote();
  };

  const saveRelayUrl = async () => {
    setBusy(true);
    try {
      await window.pi.app.setConfig({ remoteRelayUrl: relayUrl.trim() });
      await refresh(false);
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

  const state = status?.signalingState || "disabled";

  return (
    <div className="set-remote-stack">
      <div className="set-card">
        <div className="set-card-title">{zh ? "Android 手机远程控制" : "Android remote companion"}</div>
        <div className="set-hint">
          {zh
             ? "使用 WSS 信令和 STUN 直连 WebRTC。信令服务不会接收提示词、代码、会话或文件；TURN/relay 候选会被拒绝。"
            : "Uses WSS signaling and direct STUN WebRTC only. Signaling never receives prompts, code, sessions, or files; TURN/relay candidates are rejected."}
        </div>
        <div className="set-remote-status" aria-live="polite">
          <span className="set-diag-k">{zh ? "信令连接状态" : "Signal connection"}</span>
          <span className={`set-remote-status-value ${statusClass(state)}`}>
            <span className="set-remote-status-dot" aria-hidden="true" />
            {statusLabel(state, zh)}
          </span>
        </div>
      </div>

      <div className="set-card">
        <div className="set-card-title">{zh ? "信令配置" : "Signal settings"}</div>
        <label className="set-addprov-field wide">
           <span>{zh ? "信令地址（WSS）" : "Signal URL (WSS)"}</span>
          <input
            className="set-input"
            value={signalingUrl}
            onChange={(event) => setSignalingUrl(event.target.value)}
            placeholder={DEFAULT_SIGNALING_URL}
            spellCheck={false}
          />
        </label>
        <button className="set-btn primary" style={{ marginTop: 10 }} onClick={saveTransport} disabled={busy || !signalingUrl.trim()}>
          {zh ? "保存并重连" : "Save and reconnect"}
        </button>
        <div className="set-hint" style={{ marginTop: 10 }}>
          {zh
             ? "手动开启后信令会保持连接；配对或重连流程临时开启的信令会在直连认证完成后自动关闭。"
            : "Signal stays connected when enabled manually; pairing or reconnect flows close it after direct authentication."}
        </div>
        <div className="set-remote-toggle-row">
          <div className="set-remote-toggle-copy">
            <span className="set-remote-toggle-label">{zh ? "启用信令" : "Enable Signal"}</span>
            <span className="set-remote-toggle-state">
              {status?.signalingEnabled ? (zh ? "已启用" : "On") : (zh ? "已关闭" : "Off")}
            </span>
          </div>
          <button
            type="button"
            className={`set-toggle ${status?.signalingEnabled ? "on" : ""}`}
            role="switch"
            aria-checked={!!status?.signalingEnabled}
             aria-label={zh ? "切换信令" : "Toggle Signal"}
            onClick={() => void toggleRemote()}
            disabled={busy || !signalingUrl.trim()}
          >
            <span className="set-toggle-knob" />
          </button>
        </div>
      </div>

      <div className="set-card">
        <div className="set-card-title">{zh ? "手机版云中继（PWA）" : "Mobile cloud relay (PWA)"}</div>
        <div className="set-hint">
          {zh
            ? "手机 PWA 经自建中继连接本机的 WSS uplink；中继只转发不解析，应用内容 E2E 加密（S3）。托盘驻留 + 常开即守护模式。"
            : "The phone PWA reaches this machine through the self-hosted relay over a persistent WSS uplink; the relay only forwards, content is E2E-encrypted (S3). Tray-resident + always-on = daemon mode."}
        </div>
        <div className="set-remote-status" aria-live="polite">
          <span className="set-diag-k">{zh ? "中继连接状态" : "Relay connection"}</span>
          <span className={`set-remote-status-value ${statusClass(relayStatus?.state || "disabled")}`}>
            <span className="set-remote-status-dot" aria-hidden="true" />
            {statusLabel(relayStatus?.state || "disabled", zh)}
            {relayStatus?.lastError ? ` · ${relayStatus.lastError}` : ""}
          </span>
        </div>
        <label className="set-addprov-field wide">
           <span>{zh ? "中继地址（WSS）" : "Relay URL (WSS)"}</span>
          <input
            className="set-input"
            value={relayUrl}
            onChange={(event) => setRelayUrl(event.target.value)}
            placeholder="wss://your-relay-host/ws"
            spellCheck={false}
          />
        </label>
        <button className="set-btn primary" style={{ marginTop: 10 }} onClick={saveRelayUrl} disabled={busy || !relayUrl.trim()}>
          {zh ? "保存地址" : "Save URL"}
        </button>
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
        <div className="set-card-title">{zh ? "手机 App（安卓）" : "Phone app (Android)"}</div>
        <div className="set-hint">
          {zh
            ? "手机先加入同一个 Tailscale 网络，再用相机/扫码器扫下面的码下载安装（支持覆盖升级）。"
            : "Join the same Tailscale network, then scan one of these with the camera to install the APK."}
        </div>
        {phoneApp?.ok ? (
          <div className="set-remote-pairing">
            <div className="set-app-qrs">
              {appQrs.relay && !phoneApp.stale && (
                <div className="set-app-qr">
                  <img src={appQrs.relay} alt={zh ? "从中继下载手机 App" : "Download the app from the relay"} width={172} height={172} title={phoneApp.url} />
                  <div className="set-hint">{zh ? "中继（推荐）" : "Relay (preferred)"}</div>
                </div>
              )}
              {appQrs.github && (
                <div className="set-app-qr">
                  <img src={appQrs.github} alt={zh ? "从 GitHub 下载手机 App" : "Download the app from GitHub"} width={172} height={172} title={phoneApp.github} />
                  <div className="set-hint">{zh ? "GitHub（备选）" : "GitHub (fallback)"}</div>
                </div>
              )}
            </div>
            <div className="set-hint">
              {zh
                ? `版本 ${phoneApp.version} · ${formatSize(phoneApp.size)}${phoneApp.stale ? " · 中继暂不可达，用备选源" : ""}`
                : `Version ${phoneApp.version} · ${formatSize(phoneApp.size)}${phoneApp.stale ? " · relay unreachable, use the fallback" : ""}`}
            </div>
            {phoneApp.sha256 && (
              <div className="set-hint" title={phoneApp.sha256}>
                {zh ? `SHA256 ${phoneApp.sha256.slice(0, 16)}…` : `SHA256 ${phoneApp.sha256.slice(0, 16)}…`}
              </div>
            )}
            <div className="set-hint">
              {zh
                ? `也可以直接在手机上打开 Seafile，从 Agent 目录下载 MPI-Android-${phoneApp.version}.apk（中继/GitHub 都可能慢）。`
                : `Or open Seafile on the phone and grab MPI-Android-${phoneApp.version}.apk from the Agent folder.`}
            </div>
          </div>
        ) : (
          <div className="set-hint">
            {zh
              ? `暂未取到安装包信息${phoneApp && !phoneApp.ok ? `（${phoneApp.error}）` : ""}——先把 APK 发到中继的 /download/ 目录。`
              : `No package info${phoneApp && !phoneApp.ok ? ` (${phoneApp.error})` : ""}.`}
          </div>
        )}
      </div>

      <div className="set-card">
        <div className="set-card-title">{zh ? "配对手机" : "Pair a phone"}</div>
        <div className="set-hint">
          {zh
            ? "二维码包含短期票据、主机指纹、协议版本和连接地址，五分钟后失效。手机扫码即配对（需先装好上面的 App，或不装壳直接用浏览器打开）。"
            : "The QR contains a short-lived ticket, host fingerprint, protocol, and endpoints. It expires after five minutes."}
        </div>
        <label className="set-check" style={{ marginTop: 10 }} title={zh ? "票在有效期内即代表你刚刚主动发起配对" : "The ticket itself is the credential"}>
          <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
          <span>{zh ? "扫码后自动批准（无需在桌面点允许）" : "Auto-approve after scan"}</span>
        </label>
        <button className="set-btn primary" style={{ marginTop: 12 }} onClick={createPairing} disabled={busy || !signalingUrl.trim()}>
          {zh ? "生成配对二维码" : "Generate pairing QR"}
        </button>
        {pairing && (
          <div className="set-remote-pairing">
            {qr && <img src={qr} alt={zh ? "手机配对二维码" : "Phone pairing QR code"} width={260} height={260} />}
            <div className="set-hint">
            {zh ? "无法扫码时，可将下面的链接粘贴到 Android 应用。" : "If scanning is unavailable, paste this link into the Android app."}
            </div>
            <textarea className="set-input" rows={4} readOnly value={pairingUri(pairing)} />
            <div className="set-hint">{zh ? `指纹：${pairing.fingerprint}` : `Fingerprint: ${pairing.fingerprint}`}</div>
          </div>
        )}
      </div>

      {!!status?.pendingPairings.length && (
        <div className="set-card">
          <div className="set-card-title">{zh ? "待批准设备" : "Pending devices"}</div>
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
          <div className="set-card-title">{zh ? "已信任设备" : "Trusted devices"}</div>
          {status.devices.map((device) => (
            <div className="set-diag-btns" key={device.deviceId}>
              <span>{device.name} · {device.authenticated ? (zh ? "已连接" : "connected") : (zh ? "离线" : "offline")}</span>
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
