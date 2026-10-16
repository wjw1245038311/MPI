/**
 * 设置 →「转发设置」（2026-10-16 定稿，照用户给的参考界面）。
 *
 * 用户口径与参考图（某国产软件「代理设置」+「激活授权」两张图）：
 *   · **转发地址**：一个复选框 + 地址 + 令牌，就这三行 —— 「用户自己设置代理就用用户自己的，
 *     没设置看激活情况走内置」。所以这里没有来源下拉、没有状态卡、没有通道列表、没有手动选路；
 *   · **授权**：是另一件事，放在独立的「激活授权」小窗里（设备标识 / 设备名称 / 粘贴激活码 /
 *     激活状态 / 立即激活 · 解除绑定），入口就是本页一个按钮。
 *
 * 多通道通道列表已按用户决定删除；局域网模式与本机静态目录「位置待定」，暂存在本页折叠区，
 * 不占默认版面（等用户整理清楚再决定搬去「高级设置」还是删掉）。
 */
import { useEffect, useState } from "react";
import { useStore } from "../store";
import { unreachableForPhone, type LanModeStatus, type RelayStatus } from "../lib/remote-panel-shared";
import { ActivationDialog } from "./ActivationDialog";
import { Cloud, Shield } from "./icons";

export function ServerPanel({ language }: { language: "en" | "zh" }) {
  const zh = language === "zh";
  const config = useStore((s) => s.config);
  const setServerConfig = useStore((s) => s.setServerConfig);
  const pushToast = useStore((s) => s.pushToast);

  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null);
  /** 本机中继状态（局域网入口 / TLS 入口）——只在高级区展示。 */
  const [lanMode, setLanMode] = useState<LanModeStatus | null>(null);
  const [localRelayStaticDir, setLocalRelayStaticDir] = useState("");
  const [certDraft, setCertDraft] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [tlsPortDraft, setTlsPortDraft] = useState("9443");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [activationOpen, setActivationOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // 表单草稿（打开页面时从配置回填；令牌/激活码永不回填值，只回填「有没有」）
  const [custom, setCustom] = useState(false);
  const [relayUrl, setRelayUrl] = useState("");
  const [relayToken, setRelayToken] = useState("");

  const activated = Boolean(config?.serverAuthCodeSet);
  const customTokenSet = Boolean(config?.customRelayTokenSet);
  const lastError = (relayStatus as any)?.lastErrorText || relayStatus?.lastError || "";

  useEffect(() => {
    if (!config) return;
    setCustom(Boolean((config.customRelayUrl || "").trim()));
    setRelayUrl(config.customRelayUrl || "");
    if (typeof config.localRelayStaticDir === "string") setLocalRelayStaticDir(config.localRelayStaticDir);
    setCertDraft(config.localRelayCertFile || "");
    setKeyDraft(config.localRelayKeyFile || "");
    if (config.localRelayTlsPort) setTlsPortDraft(String(config.localRelayTlsPort));
  }, [config?.customRelayUrl, config?.localRelayStaticDir]);

  const loadRelay = async () => {
    try {
      setRelayStatus((await window.pi.remote.getRelayStatus()) as RelayStatus);
      setLanMode((await window.pi.remote.getLanMode()) as LanModeStatus);
    } catch {
      /* 面板可能比 IPC 桥活得久一点（重载瞬间） */
    }
  };

  useEffect(() => {
    void loadRelay();
    const timer = window.setInterval(() => void loadRelay(), 3000);
    return () => window.clearInterval(timer);
  }, []);

  /** 「验证连通性」：服务器可达 + 激活码有效 + 本机是否已登记 + 名额用量。 */
  const verify = async () => {
    setTesting(true);
    try {
      const result: any = await window.pi.remote.testServer();
      if (!result?.ok) {
        setTestResult({ ok: false, text: verifyErrorText(result?.error, zh) });
        pushToast("error", verifyErrorText(result?.error, zh));
        return;
      }
      // 分两层说：① 转发通道（WS 握手）② 授权/名额（有 /authz/check 才说得清）
      const parts: string[] = [];
      // 内置服务器的地址不打印（它本来就以混淆常量内置、不该出现在界面上）；自定义中继显示用户自己的地址。
      const where = result.source === "builtin" ? (zh ? "内置服务器" : "built-in server") : result.wsUrl || result.server || "";
      parts.push(zh ? `转发通道可达（${where}）` : `Forwarding reachable (${where})`);
      if (result.authzError === "BAD_CODE") {
        parts.push(zh ? "激活码无效" : "access code rejected");
      } else if (result.enforcing) {
        parts.push(
          zh
            ? `设备名额 ${result.devices ?? 0}/${result.maxDevices ?? 0}${result.activated === false ? "（本机尚未登记）" : ""}`
            : `devices ${result.devices ?? 0}/${result.maxDevices ?? 0}`,
        );
      } else {
        parts.push(zh ? "该服务器未启用激活码校验" : "no access-code check on that server");
      }
      const text = parts.join(" · ");
      setTestResult({ ok: true, text });
      pushToast("success", text);
    } finally {
      setTesting(false);
    }
  };

  /** 保存「转发地址」：勾了就用自定义中继（清掉内置激活码以外的绑定不影响），没勾就回到内置。 */
  const saveRelay = async () => {
    setSaving(true);
    try {
      const url = relayUrl.trim();
      if (custom && !/^wss?:\/\//i.test(url)) {
        pushToast("error", zh ? "地址要以 ws:// 或 wss:// 开头" : "Address must start with ws:// or wss://");
        return;
      }
      await setServerConfig({
        customRelayUrl: custom ? url : "",
        ...(custom && relayToken.trim() ? { customRelayToken: relayToken.trim() } : {}),
        ...(!custom ? { customRelayToken: "" } : {}),
        localRelayStaticDir: localRelayStaticDir.trim(),
        localRelayCertFile: certDraft.trim(),
        localRelayKeyFile: keyDraft.trim(),
        ...(/^\d+$/.test(tlsPortDraft.trim()) ? { localRelayTlsPort: Number(tlsPortDraft.trim()) } : {}),
      });
      setRelayToken("");
      await loadRelay();
      pushToast("success", zh ? "转发设置已保存" : "Relay settings saved");
    } catch {
      // store 已经弹过错误提示
    } finally {
      setSaving(false);
    }
  };

  /** 当前生效的是谁：自定义地址 > 内置（激活码）> 仅局域网/本机。 */
  const effectiveSource = custom
    ? zh
      ? "自定义中继（自建）"
      : "Custom relay (self-hosted)"
    : activated
      ? zh
        ? "内置服务器（已激活）"
        : "Built-in server (activated)"
      : zh
        ? "未激活：仅局域网与本机中继可用"
        : "Not activated: LAN and local relay only";

  return (
    <div className="set-remote-stack">
      <div className="set-card">
        <div className="set-card-head">
          <span className="set-card-icon"><Cloud size={14} /></span>
          <div className="set-card-title">{zh ? "转发设置" : "Relay settings"}</div>
        </div>
        <div className="set-hint">
          {zh
            ? "本页用于指定手机与本机之间所经的中继服务器。默认使用内置服务器（须先在「激活授权」中填写激活码）；若你已自行部署中继，可启用下方选项并填写其地址。中继仅转发数据帧、不解析内容，提示词、代码、会话与文件均以端到端加密传输。"
            : "This page selects the relay that carries traffic between your phone and this machine. The built-in server is used by default (enter an access code under Activation first); if you run your own relay, enable the option below and fill in its address. The relay only forwards frames and never parses them — prompts, code, sessions and files stay end-to-end encrypted."}
        </div>

        <label className="set-check" style={{ marginTop: 10 }}>
          <input
            type="checkbox"
            checked={custom}
            onChange={(e) => {
              setCustom(e.target.checked);
              setTestResult(null);
            }}
          />
          <span>{zh ? "自定义中继（使用自建中继，地址与令牌由你维护）" : "Custom relay (use my own relay; address and token are mine)"}</span>
        </label>

        {custom && (
          <>
            <label className="set-addprov-field wide">
              <span>{zh ? "中继地址（WebSocket 服务地址）" : "Relay address (WebSocket endpoint)"}</span>
              <input
                className="set-input"
                value={relayUrl}
                onChange={(e) => setRelayUrl(e.target.value)}
                placeholder={zh ? "例如 wss://relay.example.com/ws（手机亦经此地址接入，须为手机可达）" : "e.g. wss://relay.example.com/ws (the phone uses it too, so it must be reachable)"}
                spellCheck={false}
              />
            </label>
            <label className="set-addprov-field wide">
              <span>{zh ? "准入令牌（中继端校验使用方身份）" : "Access token (the relay checks it)"}</span>
              <input
                className="set-input"
                type="password"
                autoComplete="off"
                value={relayToken}
                onChange={(e) => setRelayToken(e.target.value)}
                placeholder={customTokenSet ? (zh ? "已设置；留空则保持不变" : "set; leave empty to keep") : zh ? "中继未启用准入校验时可留空" : "leave empty if your relay has no allowlist"}
                spellCheck={false}
              />
            </label>
            <div className="set-hint">
              {zh
                ? "令牌的作用：向中继证明「本机获准使用该中继」。中继若未启用准入校验（未配置令牌列表），留空即可；若已启用，此处须与中继端配置的令牌一致，否则主机注册会被拒绝（HOST_UNAUTHORIZED），转发与更新均不可用。令牌仅随主机注册与镜像请求发送，不写入配对二维码，不会下发给手机。"
                : "What the token does: it proves to the relay that this machine is allowed to use it. If your relay has no allowlist configured, leave it empty; if it has one, the value must match, otherwise host registration is rejected (HOST_UNAUTHORIZED) and neither forwarding nor updates will work. The token is only sent with host registration and mirror requests — never written into the pairing QR code or handed to the phone."}
            </div>
            <details>
              <summary className="set-hint" style={{ cursor: "pointer" }}>
                {zh ? "如何设置自己的中继" : "How to set up your own relay"}
              </summary>
              <div className="set-hint" style={{ marginTop: 4 }}>
                {zh
                  ? "① 在中继主机上部署 MPI 中继服务（mobile/relay/index.mjs），使其监听 ws(s)://<主机>:<端口>/ws；② 如需限制使用，在中继端配置准入令牌（环境变量 RELAY_TOKEN_FILE 指向一个文本文件，每行一个令牌）；③ 回到本页启用自定义中继，填入地址（中继端已启用准入时一并填入相同令牌），点击「验证连通性」；④ 显示「转发通道可达」即表示主机已能通过该中继服务手机，随后在「配对手机」中重新生成二维码即可。"
                  : "① Deploy the MPI relay (mobile/relay/index.mjs) on the relay host so it listens on ws(s)://<host>:<port>/ws; ② optionally restrict access by configuring an allowlist on the relay (env RELAY_TOKEN_FILE pointing at a text file with one token per line); ③ enable Custom relay here, fill in the address (and the same token if the relay enforces one), then click Test connection; ④ once it reports the forwarding channel as reachable, regenerate the pairing QR under “Pair a phone”."}
              </div>
            </details>
            {unreachableForPhone(relayUrl) && (
              <div className="set-hint" style={{ color: "#c0392b" }}>
                {zh ? "⚠ tailnet / 内网地址手机连不上，扫描后会卡在连接超时。" : "⚠ Tailnet/private address — a phone outside that network cannot reach it."}
              </div>
            )}
          </>
        )}

        <div className="set-diag-btns" style={{ marginTop: 10 }}>
          <button className="set-btn primary" onClick={() => void saveRelay()} disabled={saving}>
            {saving ? (zh ? "保存中…" : "Saving…") : zh ? "保存" : "Save"}
          </button>
          <button className="set-btn ghost" onClick={() => void verify()} disabled={testing}>
            {testing ? (zh ? "验证中…" : "Testing…") : zh ? "验证连通性" : "Test connection"}
          </button>
        </div>

        {testResult && (
          <div className="set-hint" style={testResult.ok ? undefined : { color: "#c0392b" }}>
            {testResult.ok ? `✓ ${testResult.text}` : `✗ ${testResult.text}`}
          </div>
        )}

        <div className="set-remote-status" style={{ marginTop: 10 }}>
          <span className="set-diag-k">{zh ? "当前生效" : "In effect"}</span>
          <span className={`set-remote-status-value ${custom || activated ? "connected" : "disabled"}`}>
            <span className="set-remote-status-dot" aria-hidden="true" />
            {effectiveSource}
            {lastError ? ` · ${lastError}` : ""}
          </span>
        </div>
      </div>

      {/* ---- 激活（授权）：独立小窗，这里只放入口 ---- */}
      <div className="set-card">
        <div className="set-card-head">
          <span className="set-card-icon"><Shield size={14} /></span>
          <div className="set-card-title">{zh ? "激活授权" : "Activation"}</div>
        </div>
        <div className="set-hint">
          {zh
            ? "激活码用于启用内置服务器，从而经它转发对话并从它获取应用更新。每个激活码最多绑定三台设备；应用自身的功能不受激活状态限制。"
            : "The access code enables the built-in server, which forwards conversations and delivers app updates. Each code binds at most three devices; the application itself is never restricted by activation."}
        </div>
        <div className="set-diag-btns" style={{ marginTop: 8 }}>
          <button className="set-btn primary" onClick={() => setActivationOpen(true)}>
            {zh
              ? activated
                ? "查看激活状态 / 解除绑定"
                : "立即激活"
              : activated
                ? "View activation / unbind"
                : "Activate now"}
          </button>
        </div>
      </div>

      {/* ---- 高级：本机中继静态目录（自托管 PWA / 下载页）----
          局域网模式已搬到「手机远程控制」（那是"手机怎么连"的事），这里只剩这项：
          它决定本机中继要不要托管一份 PWA 界面（`relay.whomidas.cn` 那条 CF 隧道就是它在服务）。 */}
      <details className="set-card">
        <summary className="set-card-title" style={{ cursor: "pointer" }}>
          {zh ? "高级：本机中继静态目录" : "Advanced: local relay static dir"}
        </summary>
        <div className="set-hint" style={{ marginTop: 8 }}>
          {zh
            ? "填了目录后，本机中继会用它托管 PWA 界面与下载页（把网页版放在这台电脑上，不依赖云中继）。留空 = 不托管。"
            : "With a directory set, the local relay hosts the PWA UI and downloads from this machine (no cloud relay needed). Empty = not hosted."}
        </div>
        <label className="set-addprov-field wide" style={{ marginTop: 8 }}>
          <span>{zh ? "静态目录" : "Static directory"}</span>
          <input
            className="set-input"
            value={localRelayStaticDir}
            onChange={(event) => setLocalRelayStaticDir(event.target.value)}
            placeholder={zh ? "例如 E:\MyWorkspace\Software\cloudflared\static" : "e.g. E:\path\to\static"}
            spellCheck={false}
          />
        </label>
        <div className="set-hint" style={{ marginTop: 12, fontWeight: 600 }}>
          {zh ? "局域网 TLS（https 页面走局域网直连的前提）" : "LAN TLS (required for LAN direct from https pages)"}
        </div>
        <div className="set-hint">
          {zh
            ? "证书与私钥都填（PEM 路径）时，本机中继会在下面这个端口上同时提供 wss 入口：https 页面里的浏览器禁止连明文 ws，只有 wss 才能走局域网。证书由自签 CA 签发，使用前需在各设备上安装一次根证书。"
            : "With both files set (PEM paths), the local relay also serves wss on the port below: browsers on https pages refuse plain ws, so only wss can stay on the LAN. The cert is issued by the self-signed CA — install that root once per device."}
        </div>
        <label className="set-addprov-field wide">
          <span>{zh ? "证书（.crt）" : "Certificate (.crt)"}</span>
          <input className="set-input" value={certDraft} onChange={(e) => setCertDraft(e.target.value)} spellCheck={false} />
        </label>
        <label className="set-addprov-field wide">
          <span>{zh ? "私钥（.key）" : "Private key (.key)"}</span>
          <input className="set-input" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} spellCheck={false} />
        </label>
        <label className="set-addprov-field wide">
          <span>{zh ? "TLS 端口" : "TLS port"}</span>
          <input className="set-input" value={tlsPortDraft} onChange={(e) => setTlsPortDraft(e.target.value)} spellCheck={false} />
        </label>
        {(lanMode?.tlsUrls?.length ?? 0) > 0 && (
          <div className="set-hint" style={{ wordBreak: "break-all" }}>
            {zh ? "局域网 TLS 入口：" : "LAN TLS entry: "}
            {(lanMode?.tlsUrls || []).map((url) => (
              <div key={url}><code>{url}</code></div>
            ))}
          </div>
        )}
        <div className="set-diag-btns" style={{ marginTop: 8 }}>
          <button className="set-btn ghost" onClick={() => void saveRelay()} disabled={saving}>
            {zh ? "保存" : "Save"}
          </button>
        </div>
      </details>

      {activationOpen && <ActivationDialog language={language} onClose={() => setActivationOpen(false)} />}
    </div>
  );
}

/** 「验证连通性」失败原因 → 人话。 */
export function verifyErrorText(error: string | undefined, zh: boolean): string {
  switch (error) {
    case "BAD_CODE":
      return zh ? "激活码不对（或已被撤销）。" : "Wrong access code (or revoked).";
    case "UNREACHABLE":
      return zh ? "连不上服务器：检查网络或地址。" : "Server unreachable — check the network or the address.";
    case "TIMEOUT":
      return zh ? "连接超时。" : "Timed out.";
    case "NO_SERVER":
      return zh ? "还没配置服务器。" : "No server configured.";
    case "NO_CODE":
      return zh ? "还没填激活码。" : "No access code yet.";
    case "HOST_DEVICE_LIMIT":
      return zh ? "此激活码已达设备上限（3 台），请先解除绑定一台。" : "Device limit reached (3) — unbind one first.";
    default:
      return error ? `${zh ? "失败：" : "Failed: "}${error}` : zh ? "失败。" : "Failed.";
  }
}
