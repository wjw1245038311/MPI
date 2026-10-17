/**
 * 「Android 手机远程控制」面板 —— 2026-10 定稿形状：**只有两块**。
 *
 *   ① 配对     ：一个二维码（打开即生成）+ 倒计时 + 「另一台电脑」复制链接 + 重新生成
 *   ② 设备管理 ：待批准（有才出现）+ 已信任设备（在线优先）
 *
 * 其余一切都收进顶部那一行状态里的「诊断」折叠：手机将连的地址、内网入口、局域网开关、
 * 同名替换开关、转发设置入口、原始错误码。
 *
 * 为什么这么改（上一版是 5 张平铺卡片）：
 *   · 转发地址/局域网/App 下载三块对"配好之后"的用户毫无用处，却占了大半屏；
 *   · 「扫码将打开：（当前没有可用的网页入口）」是一段把系统配置失败甩给用户的红字，
 *     而且它和下面的二维码**判定源不同**（pairingPageUrl vs 三级兜底），会自相矛盾；
 *   · 两个复选框的默认值都等于唯一选择（自动批准 / 同名替换都默认 true），勾选框是噪音。
 *
 * 服务器（转发地址 / 授权码）仍在「设置 → 服务器」，这里只留一个诊断里的入口。
 */
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { useStore } from "../store";
import { shortDeviceId } from "../../../shared/remote-device-match";
import {
  pairingScanUrl,
  pairingUri,
  statusClass,
  unreachableForPhone,
  type Pairing,
  type PhoneAppInfo,
  type LanModeStatus,
  type RelayStatus,
  type RemoteStatus,
} from "../lib/remote-panel-shared";
import { Bell, Check, Cloud, QrCode } from "./icons";

/** 二维码尺寸（屏幕像素）：比上一版小一档，配对卡不再压满整屏。 */
const QR_SIZE = 220;

export function RemotePanel({ language }: { language: "en" | "zh" }) {
  const zh = language === "zh";
  const openSettings = useStore((s) => s.openSettings);
  const pushToast = useStore((s) => s.pushToast);

  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  /** 配对链接：手机扫它、另一台电脑粘贴它。 */
  const [scanUrl, setScanUrl] = useState<string | null>(null);
  const [phoneApp, setPhoneApp] = useState<PhoneAppInfo | null>(null);
  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null);
  const [phoneRelayUrl, setPhoneRelayUrl] = useState("");
  const [relaySource, setRelaySource] = useState<"builtin" | "custom">("builtin");
  /** 二维码指向的 https 页面入口（主进程算好；null = 没有可用的网页入口）。 */
  const [pairingPageUrl, setPairingPageUrl] = useState<string | null>(null);
  /** 该入口的探测结果（false = 中继暂时不可达，入口仍可用但未确认）。 */
  const [pageVerified, setPageVerified] = useState(false);
  /** 本机快路径入口（同一局域网 / tailnet；仅当本机确实托管了 PWA 时给）。 */
  const [localPageUrl, setLocalPageUrl] = useState<string | null>(null);
  /** 本机 CA 证书路径（装一次根证书就不再弹警告）。 */
  const [localCaFile, setLocalCaFile] = useState<string | null>(null);
  /** 本机入口对应的配对链接（同一张票，只换 origin 前缀）。 */
  const [localScanUrl, setLocalScanUrl] = useState<string | null>(null);
  const [lanMode, setLanMode] = useState<LanModeStatus | null>(null);
  const [lanBusy, setLanBusy] = useState(false);
  /** 同名离线替换（默认 true；设置项本身没变，只是从主界面挪进诊断）。 */
  const [replaceSameName, setReplaceSameName] = useState(true);
  const [busy, setBusy] = useState(false);
  /** 诊断折叠（默认收起）。 */
  const [diagOpen, setDiagOpen] = useState(false);
  /** 票据剩余时间每秒刷新。 */
  const [now, setNow] = useState(() => Date.now());

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
      setRelaySource(relay.source === "custom" ? "custom" : "builtin");
      setPairingPageUrl(relay.pairingPageUrl ?? null);
      setPageVerified(Boolean(relay.webEntryVerified));
      setLocalPageUrl(relay.localPageUrl ?? null);
      setLocalCaFile(relay.localCaFile ?? null);
    } catch {
      /* same reload race */
    }
    try {
      setLanMode((await window.pi.remote.getLanMode()) as LanModeStatus);
    } catch {
      /* same reload race */
    }
  };

  const toggleLanMode = async () => {
    setLanBusy(true);
    try {
      setLanMode((await window.pi.remote.setLanMode({ enabled: !lanMode?.advertiseLan })) as LanModeStatus);
    } catch {
      /* 状态会由轮询纠正 */
    } finally {
      setLanBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    void (async () => {
      // 「同名离线自动替换」的当前值存在 config 里（不在 remote 状态里）
      try {
        const cfg = (await window.pi.app.getConfig()) as { remoteReplaceSameNameOffline?: boolean };
        if (typeof cfg?.remoteReplaceSameNameOffline === "boolean") setReplaceSameName(cfg.remoteReplaceSameNameOffline);
      } catch {
        /* IPC 未就绪 */
      }
    })();
    const timer = window.setInterval(() => void refresh(), 1500);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const off = window.pi.remote.onPairingRequest(() => void refresh());
    return () => {
      window.clearInterval(timer);
      window.clearInterval(tick);
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

  /**
   * 网页入口：**只有一个来源**（主进程探测过的中继 origin）。
   * 不再做「本机 TLS → 中继」那种多源兜底 —— 那个兜底正是“红字说没入口、二维码却有入口”的起因。
   */
  const entryOrigin = pairingPageUrl;

  const createPairing = async () => {
    setBusy(true);
    try {
      // 票本身就是凭据（5 分钟过期 + 只能换一次设备身份），所以固定自动批准。
      const next = (await window.pi.remote.createPairing(true)) as Pairing;
      const url = pairingScanUrl(next, entryOrigin);
      setPairing(next);
      setScanUrl(url);
      // 本机入口用**同一张票**，只把 origin 前缀换成本机 https（两条链接互通）。
      setLocalScanUrl(localPageUrl ? pairingScanUrl(next, localPageUrl) : null);
      setNow(Date.now());
      setQr(await QRCode.toDataURL(url, { width: QR_SIZE, margin: 1, errorCorrectionLevel: "M" }));
    } finally {
      setBusy(false);
    }
  };

  // 打开即生成一次（服务器状态还没到位时先等第一轮 refresh，否则会退化成一串 mpi:// 链接）。
  const autoGenerated = useRef(false);
  useEffect(() => {
    if (autoGenerated.current || !relayStatus) return;
    autoGenerated.current = true;
    void createPairing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayStatus]);

  const copyScanUrl = async () => {
    await copyLink(scanUrl, zh ? "链接已复制" : "Link copied");
  };

  const copyLocalScanUrl = async () => {
    await copyLink(localScanUrl, zh ? "本机入口链接已复制" : "Local entry link copied");
  };

  const copyLink = async (value: string | null, okText: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      pushToast("success", okText);
    } catch {
      pushToast("error", zh ? "复制失败" : "Copy failed");
    }
  };

  /** 没有扫码能力时（例如把链接发给自己）——App 的粘贴框只认 mpi:// 载荷。 */
  const copyMpiUri = async () => {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairingUri(pairing));
      pushToast("success", zh ? "App 链接已复制" : "App link copied");
    } catch {
      pushToast("error", zh ? "复制失败" : "Copy failed");
    }
  };

  const remaining = pairing ? Math.max(0, Math.floor((pairing.expiresAt - now) / 1000)) : 0;
  const expired = Boolean(pairing) && remaining <= 0;
  const countdown = `${String(Math.floor(remaining / 60)).padStart(1, "0")}:${String(remaining % 60).padStart(2, "0")}`;

  const health = (() => {
    const state = relayStatus?.state || "disabled";
    if (state === "connected") return { tone: "connected", text: zh ? "就绪" : "Ready" };
    if (state === "connecting") return { tone: "connecting", text: zh ? "连接中" : "Connecting" };
    return { tone: "error", text: zh ? "未就绪" : "Not ready" };
  })();
  const healthDetail = relayStatus?.state === "connected" ? "" : (relayStatus?.lastErrorText || "").trim();
  const sourceLabel = relaySource === "builtin" ? (zh ? "内置服务器" : "built-in server") : zh ? "自定义中继" : "custom relay";

  const devices = status?.devices ?? [];
  const online = devices.filter((device) => device.authenticated);
  const offline = devices.filter((device) => !device.authenticated);
  const pending = status?.pendingPairings ?? [];

  return (
    <div className="set-remote-stack">
      {/* ---- 状态：一行，不是卡片（"配好之后"的唯一常驻信息） ---- */}
      <div className="set-remote-line" aria-live="polite">
        <span className={`set-remote-status-value ${statusClass(relayStatus?.state || "disabled")}`}>
          <span className="set-remote-status-dot" aria-hidden="true" />
          {health.text} · {sourceLabel}
          {healthDetail ? ` · ${healthDetail}` : ""}
        </span>
        <button className="set-btn ghost set-btn-sm" onClick={() => setDiagOpen((open) => !open)}>
          {diagOpen ? (zh ? "收起诊断" : "Hide details") : zh ? "诊断" : "Details"}
        </button>
      </div>

      {diagOpen && (
        <div className="set-card set-card-diag">
          <div className="set-hint" style={{ wordBreak: "break-all" }}>
            {zh ? "手机将连接：" : "Phone connects to: "}
            {relaySource === "builtin" ? (
              <span>{zh ? "内置服务器（地址含在配对链接里）" : "Built-in server (address is inside the pairing link)"}</span>
            ) : (
              <code>{phoneRelayUrl || "—"}</code>
            )}
          </div>
          <div className="set-hint" style={{ wordBreak: "break-all" }}>
            {zh ? "内网入口：" : "LAN entry: "}
            {lanMode?.urls?.length ? (
              lanMode.urls.map((url) => <div key={url}><code>{url}</code></div>)
            ) : (
              <span>{zh ? "未开启（同一 Wi-Fi 下的手机会走服务器）" : "off (phones on the same Wi-Fi go through the server)"}</span>
            )}
          </div>
          {lanMode?.lastError && <div className="set-hint" style={{ color: "#c0392b" }}>{lanMode.lastError}</div>}
          <div className="set-remote-toggle-row">
            <div className="set-remote-toggle-copy">
              <span className="set-remote-toggle-label">{zh ? "局域网直连" : "LAN direct"}</span>
              <span className="set-remote-toggle-state">{lanMode?.advertiseLan ? (zh ? "已开启" : "On") : zh ? "已关闭" : "Off"}</span>
            </div>
            <button
              type="button"
              className={`set-toggle ${lanMode?.advertiseLan ? "on" : ""}`}
              role="switch"
              aria-checked={!!lanMode?.advertiseLan}
              aria-label={zh ? "切换局域网直连" : "Toggle LAN direct"}
              onClick={() => void toggleLanMode()}
              disabled={lanBusy}
            >
              <span className="set-toggle-knob" />
            </button>
          </div>
          <label className="set-check" style={{ marginTop: 8 }}>
            <input
              type="checkbox"
              checked={replaceSameName}
              onChange={async (e) => {
                const next = e.target.checked;
                setReplaceSameName(next);
                await window.pi.app.setConfig({ remoteReplaceSameNameOffline: next });
              }}
            />
            <span>{zh ? "同名且离线的旧设备在配对时被替换" : "Replace same-named offline device on pairing"}</span>
          </label>
          {healthDetail && <div className="set-hint" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{healthDetail}</div>}
          <div className="set-diag-btns" style={{ marginTop: 10 }}>
            <button className="set-btn ghost" onClick={() => openSettings("server")}>
              <Cloud size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
              {zh ? "转发设置（服务器 / 授权码）" : "Relay settings (server / access code)"}
            </button>
            <button className="set-btn ghost" onClick={() => void copyMpiUri()} disabled={!pairing || expired}>
              {zh ? "复制 mpi:// 链接（粘贴进 App）" : "Copy mpi:// link (paste into app)"}
            </button>
          </div>
        </div>
      )}

      {/* ---- ① 配对 ---- */}
      <div className="set-card">
        <div className="set-card-head">
          <span className="set-card-icon"><QrCode size={14} /></span>
          <div className="set-card-title">{zh ? "配对" : "Pair a device"}</div>
        </div>

        <div className="set-pair-body">
          <div className={`set-pair-qr${expired ? " faded" : ""}`}>
            {qr ? (
              <img src={qr} alt={zh ? "配对二维码" : "Pairing QR code"} width={QR_SIZE} height={QR_SIZE} />
            ) : (
              <div className="set-pair-qr-skeleton">{busy ? (zh ? "生成中…" : "Generating…") : "—"}</div>
            )}
          </div>

          <div className="set-pair-side">
            <div className="set-pair-row">
              <span className="set-pair-k">{zh ? "手机" : "Phone"}</span>
              <div className="set-pair-v">{zh ? "扫码即可，无需再点确认" : "Scan it — nothing else to confirm"}</div>
            </div>

            <div className="set-pair-row">
              <span className="set-pair-k">{zh ? "另一台电脑" : "Another computer"}</span>
              <div className="set-pair-v">
                {entryOrigin ? (
                  <>
                    <div className="set-pair-entry">
                      <span className="set-pair-scope">{zh ? "任何网络" : "Any network"}</span>
                      <code className="set-pair-url">{entryOrigin}</code>
                      <button className="set-btn ghost set-btn-sm" onClick={() => void copyScanUrl()} disabled={!scanUrl || expired}>
                        {zh ? "复制链接" : "Copy"}
                      </button>
                    </div>
                    {localPageUrl && (
                      <div className="set-pair-entry" style={{ marginTop: 6 }}>
                        <span className="set-pair-scope">{zh ? "同网段更快" : "LAN / tailnet"}</span>
                        <code className="set-pair-url">{localPageUrl}</code>
                        <button className="set-btn ghost set-btn-sm" onClick={() => void copyLocalScanUrl()} disabled={!localScanUrl || expired}>
                          {zh ? "复制" : "Copy"}
                        </button>
                      </div>
                    )}
                    <div className="set-hint" style={{ marginTop: 4 }}>
                      {zh
                        ? "粘贴到那台电脑的浏览器即可；首次会有证书提示，点「继续访问」"
                        : "Paste it into that computer's browser; accept the certificate warning on first open"}
                      {localCaFile && (
                        <>
                          {" · "}
                          <a
                            href="#"
                            onClick={(event) => {
                              event.preventDefault();
                              void window.pi.settings.openPath(localCaFile);
                            }}
                          >
                            {zh ? "装一次根证书可免提示" : "install the root cert once"}
                          </a>
                        </>
                      )}
                      {localPageUrl && (
                        <div style={{ marginTop: 2 }}>
                          {zh ? "（本机入口换了网络就打不开，也不要频繁换：每换一个地址就是一台新设备）" : "(the local entry only works on that network — and every new address means a new device)"}
                        </div>
                      )}
                      {!pageVerified && (
                        <div style={{ color: "#b26a00", marginTop: 2 }}>
                          {zh ? "中继暂未响应，上面的中继入口未验证" : "Relay not responding — the any-network entry is unverified"}
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <span className="set-hint">
                    {zh ? "暂不可用：还没配中继服务器（去「诊断」里打开转发设置）" : "Unavailable: no relay configured (open Relay settings under Details)"}
                  </span>
                )}
              </div>
            </div>

            <div className="set-pair-row">
              <span className="set-pair-k">{zh ? "有效期" : "Expires"}</span>
              <div className="set-pair-v">
                {pairing ? (
                  <span className="set-pair-countdown">
                    {expired ? (zh ? "已过期，请重新生成" : "Expired — generate again") : countdown}
                  </span>
                ) : (
                  <span className="set-hint">—</span>
                )}
                <button className="set-btn ghost set-btn-sm" style={{ marginLeft: 8 }} onClick={() => void createPairing()} disabled={busy}>
                  {busy ? (zh ? "生成中…" : "Generating…") : zh ? "重新生成" : "Regenerate"}
                </button>
              </div>
            </div>

            {phoneApp?.ok && (phoneApp.url || phoneApp.github) && (
              <div className="set-hint" style={{ marginTop: 2 }}>
                {zh ? "还没装 App？" : "No app yet? "}
                {phoneApp.url && (
                  <a href={phoneApp.url} target="_blank" rel="noreferrer">
                    {zh ? "下载安卓安装包" : "Download the Android app"}
                  </a>
                )}
                {phoneApp.url && phoneApp.github ? " · " : null}
                {phoneApp.github && (
                  <a href={phoneApp.github} target="_blank" rel="noreferrer">
                    GitHub
                  </a>
                )}
              </div>
            )}

            {relaySource === "custom" && unreachableForPhone(phoneRelayUrl) && (
              <div className="set-hint" style={{ color: "#c0392b" }}>
                {zh
                  ? "⚠ 当前是 tailnet / 内网地址，外网设备连不上。"
                  : "⚠ This is a tailnet/private address — devices outside that network cannot reach it."}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ---- ② 设备管理（待批准 + 已信任） ---- */}
      <div className="set-card">
        <div className="set-card-head">
          <span className="set-card-icon"><Check size={14} /></span>
          <div className="set-card-title">
            {zh ? "已信任设备" : "Trusted devices"}
            {devices.length > 0 && (
              <span className="set-diag-k" style={{ fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
                {zh ? `${online.length} 在线 / ${offline.length} 离线` : `${online.length} online / ${offline.length} offline`}
              </span>
            )}
          </div>
        </div>

        {pending.length > 0 && (
          <div className="set-dev-pending">
            <div className="set-hint" style={{ marginBottom: 6 }}>
              {zh ? "待批准（有人在扫你的码）" : "Waiting for approval"}
            </div>
            {pending.map((device) => (
              <div className="set-dev-row" key={device.connectionId}>
                <span className="set-dev-name">
                  <Bell size={12} style={{ verticalAlign: "-1px", marginRight: 6 }} />
                  {device.name}
                </span>
                <span className="set-dev-actions">
                  <button
                    className="set-btn primary set-btn-sm"
                    onClick={async () => {
                      await window.pi.remote.approvePairing(device.connectionId);
                      await refresh();
                    }}
                  >
                    {zh ? "允许" : "Approve"}
                  </button>
                  <button
                    className="set-btn ghost set-btn-sm"
                    onClick={async () => {
                      await window.pi.remote.rejectPairing(device.connectionId);
                      await refresh();
                    }}
                  >
                    {zh ? "拒绝" : "Reject"}
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}

        {devices.length === 0 ? (
          pending.length === 0 && (
            <div className="set-hint">{zh ? "还没有配对任何设备。用上面的二维码配一台。" : "No devices yet — pair one with the code above."}</div>
          )
        ) : (
          [...online, ...offline].map((device) => (
            <div className="set-dev-row" key={device.deviceId}>
              <span className="set-dev-name" title={device.name}>
                {device.name}
                <span className="set-diag-k"> · #{shortDeviceId(device.deviceId)}</span>
                <span className={`set-dev-state ${device.authenticated ? "on" : "off"}`}>
                  {device.authenticated ? (zh ? "在线" : "online") : zh ? "离线" : "offline"}
                </span>
              </span>
              <button
                className="set-btn ghost set-btn-sm"
                onClick={async () => {
                  await window.pi.remote.revokeDevice(device.deviceId);
                  await refresh();
                }}
              >
                {zh ? "移除" : "Remove"}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
