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
  const [lanMode, setLanMode] = useState<LanModeStatus | null>(null);
  const [localRelayStaticDir, setLocalRelayStaticDir] = useState("");
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
      const text = result.open
        ? zh
          ? `${result.server} 可达（该服务器未启用激活码校验）`
          : `${result.server} reachable (no access-code check)`
        : zh
          ? `${result.server} 已连通 · 设备名额 ${result.devices ?? 0}/${result.maxDevices ?? 0}${result.activated === false ? "（本机尚未登记）" : ""}`
          : `${result.server} connected · devices ${result.devices ?? 0}/${result.maxDevices ?? 0}`;
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

  const toggleLanMode = async () => {
    try {
      setLanMode((await window.pi.remote.setLanMode({ enabled: !lanMode?.advertiseLan })) as LanModeStatus);
    } catch {
      /* 忽略：状态会由轮询纠正 */
    }
  };

  /** 当前生效的是谁：自定义地址 > 内置（激活码）> 仅局域网/本机。 */
  const effectiveSource = custom
    ? zh
      ? "自定义中继"
      : "Custom relay"
    : activated
      ? zh
        ? "内置服务器（我的 ECS）"
        : "Built-in server (my ECS)"
      : zh
        ? "未激活（仅局域网/本机）"
        : "Not activated (LAN/local only)";

  return (
    <div className="set-remote-stack">
      <div className="set-card">
        <div className="set-card-head">
          <span className="set-card-icon"><Cloud size={14} /></span>
          <div className="set-card-title">{zh ? "转发设置" : "Relay settings"}</div>
        </div>
        <div className="set-hint">
          {zh
            ? "手机经它连到本机；中继只转发不解析，提示词、代码、会话与文件端到端加密。自己没搭中继就不用勾，填个激活码走内置服务器就行。"
            : "Phones reach this machine through it; the relay only forwards, prompts, code, sessions and files stay end-to-end encrypted. If you don't run your own relay, leave this unchecked and just paste an access code."}
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
          <span>{zh ? "自定义中继" : "Custom relay"}</span>
        </label>

        {custom && (
          <>
            <label className="set-addprov-field wide">
              <span>{zh ? "地址" : "Address"}</span>
              <input
                className="set-input"
                value={relayUrl}
                onChange={(e) => setRelayUrl(e.target.value)}
                placeholder="例如 wss://relay.example.com/ws"
                spellCheck={false}
              />
            </label>
            <label className="set-addprov-field wide">
              <span>{zh ? "令牌" : "Token"}</span>
              <input
                className="set-input"
                type="password"
                autoComplete="off"
                value={relayToken}
                onChange={(e) => setRelayToken(e.target.value)}
                placeholder={customTokenSet ? (zh ? "已设置，留空则保持不变" : "set; leave empty to keep") : zh ? "你的中继要求的准入令牌（可留空）" : "your relay's token (optional)"}
                spellCheck={false}
              />
            </label>
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
          <span className="set-diag-k">{zh ? "当前" : "Current"}</span>
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
            ? "激活码用于「用我的内置服务器转发对话 + 从它更新」；一个码最多 3 台设备。软件功能本身不受限制。"
            : "The access code enables forwarding and app updates through my built-in server; one code covers up to 3 devices. The app itself is never restricted."}
        </div>
        <div className="set-diag-btns" style={{ marginTop: 8 }}>
          <button className="set-btn primary" onClick={() => setActivationOpen(true)}>
            {zh ? (activated ? "查看 / 解除绑定" : "立即激活…") : activated ? "Manage activation" : "Activate…"}
          </button>
        </div>
      </div>

      {/* ---- 待定：局域网模式与本机静态目录（位置未定，暂放折叠区） ---- */}
      <details className="set-card">
        <summary className="set-card-title" style={{ cursor: "pointer" }}>
          {zh ? "局域网直连 / 本机静态目录（位置待定）" : "LAN direct / local static dir (placement TBD)"}
        </summary>
        <div className="set-hint" style={{ marginTop: 8 }}>
          {zh
            ? "这两项还没定好放哪，先留在这里：局域网模式让手机在同一网段直连（不依赖公网中继）。"
            : "These two are not finalised yet: LAN mode lets the phone connect on the same network without the public relay."}
        </div>
        <div className="set-remote-toggle-row">
          <div className="set-remote-toggle-copy">
            <span className="set-remote-toggle-label">{zh ? "局域网模式" : "LAN mode"}</span>
            <span className="set-remote-toggle-state">{lanMode?.advertiseLan ? (zh ? "已开启" : "On") : zh ? "已关闭" : "Off"}</span>
          </div>
          <button
            type="button"
            className={`set-toggle ${lanMode?.advertiseLan ? "on" : ""}`}
            role="switch"
            aria-checked={!!lanMode?.advertiseLan}
            aria-label={zh ? "切换局域网模式" : "Toggle LAN mode"}
            onClick={() => void toggleLanMode()}
          >
            <span className="set-toggle-knob" />
          </button>
        </div>
        {lanMode?.url && (
          <div className="set-hint" style={{ wordBreak: "break-all" }}>
            {zh ? "手机填写地址：" : "Phone relay URL: "}
            <code>{lanMode.url}</code>
          </div>
        )}
        {lanMode?.lastError && <div className="set-hint" style={{ color: "#c0392b" }}>{lanMode.lastError}</div>}
        <label className="set-addprov-field wide" style={{ marginTop: 10 }}>
          <span>{zh ? "本机中继静态目录（托管 PWA / 下载页，可留空）" : "Local relay static dir (optional)"}</span>
          <input
            className="set-input"
            value={localRelayStaticDir}
            onChange={(event) => setLocalRelayStaticDir(event.target.value)}
            spellCheck={false}
          />
        </label>
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
