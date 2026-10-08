import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useStore } from "../store";
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
  /** 配对二维码的内容：有中继时是打开中继网页的 https 链接，无中继时是 mpi:// 链接。 */
  const [scanUrl, setScanUrl] = useState<string | null>(null);
  const pushToast = useStore((s) => s.pushToast);
  /** 扫码后是否免去桌面端再点一次「允许」（票=凭据，默认开）。 */
  const [autoApprove, setAutoApprove] = useState(true);
  const [phoneApp, setPhoneApp] = useState<PhoneAppInfo | null>(null);
  /** 下载码只留一个：中继（主）；GitHub 降级为一行文本备用地址。地址只放进 <img title>，不占版面。 */
  const [appQr, setAppQr] = useState<string | null>(null);
  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null);
  const [relayUrl, setRelayUrl] = useState("");
  /** 中继准入 token（P1）：与地址一起保存，不回显已有值的提示（避免在界面上留明文）。 */
  const [relayToken, setRelayToken] = useState("");
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
    } catch { /* same reload race */ }
  };

  useEffect(() => {
    void refresh();
    void refreshLanMode();
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
      const url = pairingScanUrl(next, relayOrigin(relayUrl));
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

  const saveRelayUrl = async () => {
    setBusy(true);
    try {
      await window.pi.app.setConfig({ remoteRelayUrl: relayUrl.trim(), remoteRelayToken: relayToken.trim() });
      await refresh(false);
    } finally {
      setBusy(false);
    }
  };

  /** 局域网模式（P2）：开关 + 当前地址。 */
  const [lanMode, setLanMode] = useState<{
    enabled: boolean;
    url: string | null;
    attachmentBase: string | null;
    port: number;
    address: string | null;
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
      setLanMode(await window.pi.remote.setLanMode({ enabled: !lanMode?.enabled }));
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
        <label className="set-addprov-field wide">
          <span>{zh ? "中继准入 token（服务方要求时填）" : "Relay access token (if required)"}</span>
          <input
            className="set-input"
            value={relayToken}
            onChange={(event) => setRelayToken(event.target.value)}
            placeholder={zh ? "留空 = 中继未启用准入" : "Empty = relay has no allowlist"}
            spellCheck={false}
          />
        </label>
        <div className="set-hint">
          {zh
            ? "token 只用于主机向中继注册（服务方在 RELAY_HOST_TOKENS 里配）；它不会进配对票，设备拿不到它。"
            : "The token only authenticates this host to the relay (RELAY_HOST_TOKENS on the relay); it never goes into the pairing ticket."}
        </div>
        <button className="set-btn primary" style={{ marginTop: 10 }} onClick={saveRelayUrl} disabled={busy || !relayUrl.trim()}>
          {zh ? "保存地址与 token" : "Save URL & token"}
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
        {lanMode?.lastError && <div className="set-hint" style={{ color: "#c0392b" }}>{lanMode.lastError}</div>}
        <div className="set-remote-toggle-row">
          <div className="set-remote-toggle-copy">
            <span className="set-remote-toggle-label">{zh ? "局域网模式" : "LAN mode"}</span>
            <span className="set-remote-toggle-state">
              {lanMode?.enabled ? (zh ? "已开启" : "On") : zh ? "已关闭" : "Off"}
            </span>
          </div>
          <button
            type="button"
            className={`set-toggle ${lanMode?.enabled ? "on" : ""}`}
            role="switch"
            aria-checked={!!lanMode?.enabled}
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
        <div className="set-hint">
          {zh
            ? "扫下面的码从中继下载安装（支持覆盖升级）；中继不可达时用下面的 GitHub 备用地址。"
            : "Scan the code below to install from the relay (in-place upgrades supported); use the GitHub fallback address when the relay is unreachable."}
        </div>
        {phoneApp?.ok ? (
          <div className="set-remote-pairing">
            {appQr && (
              <div className="set-app-qrs">
                <div className="set-app-qr">
                  <img src={appQr} alt={zh ? "从中继下载手机 App" : "Download the app from the relay"} width={172} height={172} title={phoneApp.url} />
                  <div className="set-hint">{zh ? "中继（推荐）" : "Relay (preferred)"}</div>
                </div>
              </div>
            )}
            <div className="set-hint">
              {zh
                ? `版本 ${phoneApp.version} · ${formatSize(phoneApp.size)}${phoneApp.stale ? " · 中继暂不可达，用下面的备用地址" : ""}`
                : `Version ${phoneApp.version} · ${formatSize(phoneApp.size)}${phoneApp.stale ? " · relay unreachable, use the fallback below" : ""}`}
            </div>
            {phoneApp.sha256 && (
              <div className="set-hint" title={phoneApp.sha256}>
                {zh ? `SHA256 ${phoneApp.sha256.slice(0, 16)}…` : `SHA256 ${phoneApp.sha256.slice(0, 16)}…`}
              </div>
            )}
            {phoneApp.github && (
              <div className="set-hint" style={{ wordBreak: "break-all" }}>
                {zh ? "GitHub 备用源：" : "GitHub fallback: "}
                <a href={phoneApp.github} target="_blank" rel="noreferrer">{phoneApp.github}</a>
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
        <button className="set-btn primary" style={{ marginTop: 12 }} onClick={createPairing} disabled={busy}>
          {zh ? "生成配对二维码" : "Generate pairing QR"}
        </button>
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
