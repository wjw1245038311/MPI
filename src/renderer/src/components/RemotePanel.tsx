/**
 * 「Android 手机远程控制」面板（侧栏弹层）。
 *
 * 2026-10-16 拆分：**中继/服务器相关的一切已搬到「设置 → 服务器」分栏**（`ServerPanel.tsx`）——
 * 通道列表、选路模式、授权码、局域网模式、本机静态目录都在那边。这里只保留「跟手机有关的事」：
 * 连接状态摘要、手机 App 下载、配对二维码、待批准/已信任设备。
 *
 * 为什么分：这块面板原来 800 多行，转发地址、自更新源、`token` 草稿混在一起，用户找不到重点，
 * 也让「更新源」跟「手机面板」互相绑架（没配手机通道 → 永远查不到更新）。
 */
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useStore } from "../store";
import { shortDeviceId } from "../../../shared/remote-device-match";
import {
  pairingScanUrl,
  pairingUri,
  relayOrigin,
  statusClass,
  statusLabel,
  unreachableForPhone,
  type Pairing,
  type PhoneAppInfo,
  type RelayStatus,
  type RemoteStatus,
} from "../lib/remote-panel-shared";
import { Bell, Check, Cloud, Plug, QrCode, Smartphone } from "./icons";

export function RemotePanel({ language }: { language: "en" | "zh" }) {
  const zh = language === "zh";
  const openSettings = useStore((s) => s.openSettings);
  const pushToast = useStore((s) => s.pushToast);

  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  /** 配对二维码的内容：有中继时是打开中继网页的 https 链接，无中继时是 mpi:// 链接。 */
  const [scanUrl, setScanUrl] = useState<string | null>(null);
  /** 扫码后是否免去桌面端再点一次「允许」（票=凭据，默认开）。 */
  const [autoApprove, setAutoApprove] = useState(true);
  /** 同名且离线的旧绑定是否在配对时被替换（= config.remoteReplaceSameNameOffline）。 */
  const [replaceSameName, setReplaceSameName] = useState(true);
  const [phoneApp, setPhoneApp] = useState<PhoneAppInfo | null>(null);
  /** 下载码只留一个：中继（主）；GitHub 降级为一行文本备用地址。地址只放进 <img title>，不占版面。 */
  const [appQr, setAppQr] = useState<string | null>(null);
  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null);
  /** 本次配对票里实际会告诉手机的地址（主进程算好；由「服务器」决定）。 */
  const [phoneRelayUrl, setPhoneRelayUrl] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      setStatus((await window.pi.remote.getStatus()) as RemoteStatus);
    } catch {
      // The panel can briefly outlive the Electron IPC bridge during reload.
    }
    try {
      const relay = (await window.pi.remote.getRelayStatus()) as RelayStatus;
      setRelayStatus(relay);
      setPhoneRelayUrl(relay.phoneRelayUrl || "");
    } catch {
      /* same reload race */
    }
  };

  useEffect(() => {
    void refresh();
    void (async () => {
      // 「同名离线自动替换」开关的当前值存在 config 里（不在 remote 状态里）
      try {
        const cfg = (await window.pi.app.getConfig()) as { remoteReplaceSameNameOffline?: boolean };
        if (typeof cfg?.remoteReplaceSameNameOffline === "boolean") setReplaceSameName(cfg.remoteReplaceSameNameOffline);
      } catch {
        /* IPC 未就绪 */
      }
    })();
    const timer = window.setInterval(() => void refresh(), 1500);
    const off = window.pi.remote.onPairingRequest(() => void refresh());
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
  }, [relayStatus?.relayUrl]);

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
      // 二维码的**网址**优先用给手机的地址（公网）：用系统相机/浏览器扫时也不该去打开打不开的
      // tailnet 页（典型症状：浏览器 timeout，而中继日志里一条 pair.request 都没有）。
      // App 内「扫码配对」只读 payload，用哪个网址都一样。
      const url = pairingScanUrl(next, relayOrigin(phoneRelayUrl) ?? relayOrigin(next.relayUrl || ""));
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

  return (
    <div className="set-remote-stack">
      <div className="set-card">
        <div className="set-card-head">
          <span className="set-card-icon"><Smartphone size={14} /></span>
          <div className="set-card-title">{zh ? "Android 手机远程控制" : "Android remote companion"}</div>
        </div>
        <div className="set-hint">
          {zh
            ? "手机经服务器（或局域网直连）连到本机；中继只转发不解析，提示词、代码、会话与文件端到端加密。"
            : "Phones reach this machine through the server (or over the LAN); the relay only forwards, prompts, code, sessions and files stay end-to-end encrypted."}
        </div>
        <div className="set-remote-status" aria-live="polite">
          <span className="set-diag-k">{zh ? "中继连接状态" : "Relay connection"}</span>
          <span className={`set-remote-status-value ${statusClass(relayStatus?.state || "disabled")}`}>
            <span className="set-remote-status-dot" aria-hidden="true" />
            {statusLabel(relayStatus?.state || "disabled", zh)}
            {relayStatus?.lastError ? ` · ${relayStatus.lastError}` : ""}
          </span>
        </div>
        <div className="set-hint" style={{ wordBreak: "break-all" }}>
          {zh ? "手机将连接：" : "Phone connects to: "}
          <code>{phoneRelayUrl || "—"}</code>
        </div>
        {/* 服务器（转发地址 / 授权码 / 局域网 / 多通道）在设置里，这里只给入口 —— 
            面板从 800 行瘦下来就靠这一刀：本面板不再承担转发地址的编辑。 */}
        <div className="set-diag-btns" style={{ marginTop: 8 }}>
          <button className="set-btn ghost" onClick={() => openSettings("server")}>
            <Cloud size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            {zh ? "打开「设置 → 服务器」" : "Open Settings → Server"}
          </button>
        </div>
        <div className="set-hint">
          {zh
            ? "转发地址、授权码（内置服务器）、自定义中继、局域网模式与多通道都在那一栏。"
            : "Relay address, access code (built-in server), custom relays, LAN mode and multi-channel setup all live there."}
        </div>
      </div>

      <div className="set-card">
        <div className="set-card-head">
          <span className="set-card-icon"><Plug size={14} /></span>
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
          title={
            zh
              ? "手机端每换一个网址打开就是一套新的浏览器存储 → 新设备身份；打开它就用同名且离线的旧记录替换（只换最久没露面的那条）"
              : "Each different web address means a new browser storage and thus a new device identity; replacing the same-named offline record keeps the list from filling up"
          }
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
        {unreachableForPhone(phoneRelayUrl) && (
          <div className="set-hint" style={{ color: "#c0392b" }}>
            {zh
              ? "⚠ 这是 tailnet / 内网地址——手机（没有 Tailscale、不在同一网段）连不上，扫描后会卡在连接超时。要到外网用就关掉「局域网模式」并在「设置 → 服务器」里换成公网地址；要局域网直连就把手机连到同一 WiFi。"
              : "⚠ This is a tailnet/private address — a phone without Tailscale or outside that network cannot reach it and will time out. Turn off LAN mode and set a public address in Settings → Server, or join the phone to the same Wi-Fi."}
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
                {device.authenticated ? (zh ? "已连接" : "connected") : zh ? "离线" : "offline"}
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
