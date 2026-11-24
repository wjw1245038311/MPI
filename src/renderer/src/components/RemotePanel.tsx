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
  const askConfirm = useStore((s) => s.askConfirm);
  /** 空态的「去扫码」按钮要把视口带回二维码。 */
  const qrRef = useRef<HTMLDivElement | null>(null);

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
  /** 首轮刷新是否已经落地 —— 没落地时设备列表处于「未知」而不是「空」，不能直接渲染空态。 */
  const [loaded, setLoaded] = useState(false);
  /** 读设备列表失败时的现象描述（UI-SPEC §1 empty/error 分支要求；只存人话，不存原始异常）。 */
  const [devicesError, setDevicesError] = useState<string | null>(null);
  /** 二维码生成失败（以前是静默：finally 只把 busy 置回 false）。 */
  const [qrError, setQrError] = useState(false);

  const refresh = async () => {
    try {
      setStatus((await window.pi.remote.getStatus()) as RemoteStatus);
      setDevicesError(null);
    } catch {
      // 面板可能在 reload 期间短暂活过 IPC 桥，这时不覆盖已有状态；但首轮失败要能看见。
      setDevicesError(zh ? "没读到设备列表" : "Could not read the device list");
    } finally {
      setLoaded(true);
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
    setQrError(false);
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
    } catch {
      // UI-SPEC §1：不再静默失败——二维码是这一屏唯一出路，生成不出来必须说清并给重试。
      setQr(null);
      setQrError(true);
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

  /**
   * 骨架屏延迟显示（UI-SPEC §1.1 三档）：首轮 refresh 通常几十毫秒就回来，
   * 直接渲染骨架反而会闪一下——闪得比空态还刺眼。150ms 内回来就不显示骨架。
   */
  const [skeletonVisible, setSkeletonVisible] = useState(false);
  useEffect(() => {
    if (loaded) {
      setSkeletonVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setSkeletonVisible(true), 150);
    return () => window.clearTimeout(timer);
  }, [loaded]);

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
  /**
   * UI-SPEC §1 error 三要素：「状态行」只放发生了什么（一行的位置放不下为什么/怎么办），
   * 完整三要素在诊断里的 `.set-diag-err`。原始错误串**只留在诊断**——以前它被拼在状态行末尾
   * 直接上屏，一行里塞进协议码。
   */
  const healthSummary =
    relayStatus?.state === "connected"
      ? ""
      : relayStatus?.state === "connecting"
        ? zh
          ? "正在连服务器"
          : "Connecting to the server"
        : relayStatus?.state === "error" && healthDetail
          ? zh
            ? "连不上服务器"
            : "Cannot reach the server"
          : "";
  /** 状态行不进诊断时的兜底说明：中继自己会指数退避重连（relay-uplink.ts），所以只需指向诊断。 */
  const healthNeedsDiag = relayStatus?.state === "error";
  const sourceLabel = relaySource === "builtin" ? (zh ? "内置服务器" : "built-in server") : zh ? "自定义中继" : "custom relay";

  const devices = status?.devices ?? [];
  const online = devices.filter((device) => device.authenticated);
  const offline = devices.filter((device) => !device.authenticated && !device.superseded);
  // 被「同名新设备」收敛的旧记录：令牌仍在（随时能重连），所以只置底 + 标灰 + 「旧」徽标，
  // 不隐藏——否则用户没法发现/移除一台仍然有效的设备。
  const superseded = devices.filter((device) => !device.authenticated && device.superseded);
  const pending = status?.pendingPairings ?? [];

  /**
   * 移除设备（危险操作）。UI-SPEC §3：当前主进程的 `revokeDevice` 只返回 boolean，
   * 没有撤销通道（令牌直接从 identity 里删掉并落盘），所以**做不到「立即执行 + 撤销」**，
   * 只能走次选方案「带去后果说明的确认框」。
   *
   * 文案按 §1.1 error 三要素写：发生了什么 / 为什么不可撤销 / 以后怎么办。
   * 以前这里是一个无确认、同款 ghost 按钮，点一下手机令牌就永久没了。
   */
  const askRemoveDevice = (deviceId: string, name: string) => {
    askConfirm({
      title: zh ? `移除「${name}」` : `Remove "${name}"`,
      body: zh
        ? `该设备需重新配对，此操作不可撤销。\n\n仅需断开连接时，可在手机上操作。`
        : `The device must pair again. This cannot be undone.\n\nTo disconnect only, do it on the phone.`,
      confirmLabel: zh ? "移除" : "Remove",
      cancelLabel: zh ? "保留" : "Keep it",
      danger: true,
      onConfirm: async () => {
        try {
          const ok = await window.pi.remote.revokeDevice(deviceId);
          await refresh();
          if (ok) pushToast("success", zh ? `已移除「${name}」` : `Removed "${name}"`);
          else pushToast("info", zh ? "设备已不存在" : "Device no longer exists");
        } catch {
          pushToast("error", zh ? `没移除掉「${name}」，设备列表可能没变。再试一次？` : `Could not remove "${name}". Try again?`);
        }
      },
    });
  };

  return (
    <div className="set-remote-stack">
      {/* ---- 状态：一行，不是卡片（"配好之后"的唯一常驻信息） ---- */}
      <div className="set-remote-line" aria-live="polite">
        <span className={`set-remote-status-value ${statusClass(relayStatus?.state || "disabled")}`}>
          <span className="set-remote-status-dot" aria-hidden="true" />
          {health.text} · {sourceLabel}
        </span>
        {healthNeedsDiag && healthSummary && (
          <span className="set-hint" style={{ marginTop: 0, marginRight: "auto" }}>
            {healthSummary} · {zh ? "详见「诊断」" : "see Details"}
          </span>
        )}
        <button className="set-btn ghost set-btn-sm" onClick={() => setDiagOpen((open) => !open)}>
          {diagOpen ? (zh ? "收起诊断" : "Hide details") : zh ? "诊断" : "Details"}
        </button>
      </div>

      {diagOpen && (
        <div className="set-card set-card-diag">
          <div className="set-hint" style={{ wordBreak: "break-all" }}>
            {zh ? "手机将连接：" : "Phone connects to: "}
            {relaySource === "builtin" ? (
              <span>{zh ? "内置服务器" : "Built-in server"}</span>
            ) : (
              <code>{phoneRelayUrl || "—"}</code>
            )}
          </div>
          <div className="set-hint" style={{ wordBreak: "break-all" }}>
            {zh ? "内网入口：" : "LAN entry: "}
            {lanMode?.urls?.length ? (
              lanMode.urls.map((url) => <div key={url}><code>{url}</code></div>)
            ) : (
              <span>{zh ? "未开启（手机走服务器）" : "off (phones go through the server)"}</span>
            )}
            {localPageUrl && (
              <div style={{ marginTop: 2 }}>
                {zh ? "地址变更会新增一条设备记录，旧记录可移除。" : "A changed address adds a new device entry; remove the old one."}
              </div>
            )}
          </div>
          {lanMode?.lastError && (
            <div className="set-diag-err">
              <div className="set-diag-err-title">{zh ? "局域网直连未启动" : "LAN direct did not start"}</div>
              <div>{lanMode.lastError}</div>
              <div className="set-hint" style={{ marginTop: 4 }}>
                {zh ? "修复后重试；也可不开启。" : "Retry after fixing, or leave it off."}
              </div>
            </div>
          )}
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
            <span>{zh ? "配对时替换同名离线设备" : "Replace same-named offline device on pairing"}</span>
          </label>
          {healthDetail && (
            <div className="set-diag-err">
              <div className="set-diag-err-title">{zh ? "中继连接失败" : "Relay unreachable"}</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{healthDetail}</div>
              <div className="set-hint" style={{ marginTop: 4 }}>
                {zh ? "检查转发设置中的服务器与授权码。" : "Check the server and access code in Relay settings."}
              </div>
            </div>
          )}
          <div className="set-diag-btns" style={{ marginTop: 10 }}>
            <button className="set-btn ghost" onClick={() => openSettings("server")}>
              <Cloud size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
              {zh ? "转发设置" : "Relay settings"}
            </button>
            <button className="set-btn ghost" onClick={() => void copyMpiUri()} disabled={!pairing || expired}>
              {zh ? "复制 mpi:// 链接" : "Copy mpi:// link"}
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
          <div className={`set-pair-qr${expired ? " faded" : ""}`} ref={qrRef}>
            {qr ? (
              <img src={qr} alt={zh ? "配对二维码" : "Pairing QR code"} width={QR_SIZE} height={QR_SIZE} />
            ) : qrError ? (
              /* UI-SPEC §1 error：发生了什么 + 为什么 + 怎么办（二维码是这一屏唯一出路，不能静默）。 */
              <div className="set-pair-qr-skeleton set-pair-qr-error">
                <strong>{zh ? "二维码没生成出来" : "Could not build the QR code"}</strong>
                <span>{zh ? "生成失败，扫码配对待用。" : "Generation failed — scanning is unavailable."}</span>
                <button className="set-btn ghost set-btn-sm" onClick={() => void createPairing()} disabled={busy}>
                  {busy ? (zh ? "重试中…" : "Retrying…") : zh ? "重试" : "Retry"}
                </button>
                <span className="set-hint" style={{ marginTop: 0 }}>
                  {zh ? "可改用下方「另一台电脑」链接" : "Use the link under \"Another computer\" instead"}
                </span>
              </div>
            ) : (
              <div className="set-pair-qr-skeleton">{busy ? (zh ? "生成中…" : "Generating…") : "—"}</div>
            )}
          </div>

          <div className="set-pair-side">
            <div className="set-pair-row">
              <span className="set-pair-k">{zh ? "手机" : "Phone"}</span>
              <div className="set-pair-v">{zh ? "扫描即完成，无需额外确认" : "Scan it — nothing else to confirm"}</div>
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
                        ? "粘贴到目标电脑的浏览器。首次打开会有证书提示，选「继续访问」。"
                        : "Paste into a browser on the target computer. Accept the certificate warning on first open."}
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
                            {zh ? "安装根证书可免除提示" : "install the root cert to skip it"}
                          </a>
                        </>
                      )}
                      {localPageUrl && (
                        <div style={{ marginTop: 2 }}>
                          {zh ? "（本机入口仅在该网络内有效；地址变更会将该设备视为新设备）" : "(the local entry works on that network only; a new address counts as a new device)"}
                        </div>
                      )}
                      {!pageVerified && (
                        <div className="set-hint-warn" style={{ marginTop: 2 }}>
                          {zh ? "中继无响应，该入口可能不可用" : "Relay not responding — this entry may not work"}
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <span className="set-hint">
                    {zh ? "不可用：未配置中继服务器（在「诊断」中打开转发设置）" : "Unavailable: no relay configured (open Relay settings under Details)"}
                  </span>
                )}
              </div>
            </div>

            <div className="set-pair-row">
              <span className="set-pair-k">{zh ? "有效期" : "Expires"}</span>
              <div className="set-pair-v">
                {pairing ? (
                  <span className="set-pair-countdown">
                    {expired ? (zh ? "已过期，需重新生成" : "Expired — generate again") : countdown}
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
                {zh ? "未安装 App？" : "No app yet? "}
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
              <div className="set-hint-warn">
                {zh
                  ? "当前为 tailnet / 内网地址，外网设备无法访问。"
                  : "This is a tailnet/private address — devices outside that network cannot reach it."}
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
              {zh ? "待批准" : "Waiting for approval"}
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
          pending.length === 0 &&
          /* UI-SPEC §1 empty：说明现状 + **一个主操作入口**（以前只有一行灰字，没入口）。
             骨架延迟 150ms：首轮 refresh 很快时不闪。 */
          (skeletonVisible ? (
            <div className="set-dev-skeleton" aria-hidden="true">
              <span />
              <span />
            </div>
          ) : devicesError ? (
            <div className="set-dev-empty">
              <div className="set-dev-empty-title">{devicesError}</div>
              <div className="set-hint">{zh ? "面板可能刚刷新。重试一次？" : "The panel may have just reloaded."}</div>
              <button className="set-btn ghost set-btn-sm" onClick={() => void refresh()}>
                {zh ? "重试" : "Retry"}
              </button>
            </div>
          ) : (
            <div className="set-dev-empty">
              <div className="set-dev-empty-title">
                {zh ? "尚无已配对设备" : "No devices paired yet"}
              </div>
              <div className="set-hint" style={{ marginTop: 0 }}>
                {zh
                  ? "扫描上方二维码完成配对；已配对设备在此列出，可单独移除。"
                  : "Scan the code above to pair; paired devices are listed here and can be removed individually."}
              </div>
              <button
                className="set-btn ghost set-btn-sm"
                onClick={() => qrRef.current?.scrollIntoView({ block: "center", behavior: "smooth" })}
              >
                {zh ? "前往扫码" : "Go to the code"}
              </button>
            </div>
          ))
        ) : (
          [...online, ...offline, ...superseded].map((device) => (
            <div className={`set-dev-row${device.superseded ? " set-dev-superseded" : ""}`} key={device.deviceId}>
              <span className="set-dev-name" title={device.name}>
                {device.name}
                <span className="set-diag-k"> · #{shortDeviceId(device.deviceId)}</span>
                <span className={`set-dev-state ${device.authenticated ? "on" : "off"}`}>
                  {device.authenticated
                    ? zh
                      ? "在线"
                      : "online"
                    : device.superseded
                      ? zh
                        ? "旧设备"
                        : "superseded"
                      : zh
                        ? "离线"
                        : "offline"}
                </span>
              </span>
              <button
                className="set-btn danger set-btn-sm"
                aria-label={zh ? `移除设备 ${device.name}` : `Remove device ${device.name}`}
                onClick={() => askRemoveDevice(device.deviceId, device.name)}
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
