/**
 * 设置 →「服务器」（2026-10-16 定稿：**默认极简**）。
 *
 * 主界面只有一张卡：当前转发服务器 + 状态 + `[验证连通性]` + `[配置]`。
 * 所有可配置项都在 `[配置]` 弹窗里：
 *   · 授权码（填了就用内置服务器：转发与更新都走它）
 *   · 「用自己的服务器」（折叠：手机地址 / 主机上行 / 准入令牌）
 *   · 「高级」（折叠：多通道 / 本机静态目录 / 局域网模式）
 *
 * 三条设计约束（都是用户直接定的）：
 *   1. **不出现「内置/自定义」这类术语** —— 填码即用内置服务器，地址不展示（以混淆常量内置）；
 *   2. 选路交给手机：配对票始终带**全部候选**（局域网 → 云中继 → 备用），所以这里没有「手动/自动」开关；
 *   3. 一个授权码最多 3 台设备，额度由服务端按 hostId 记账；「验证连通性」会把用量显示出来。
 */
import { useEffect, useState } from "react";
import { useStore } from "../store";
import {
  channelDotColor,
  statusClass,
  statusLabel,
  unreachableForPhone,
  type LanModeStatus,
  type RelayChannelRow,
  type RelayStatus,
} from "../lib/remote-panel-shared";
import { Close, Cloud, Plug, Shield } from "./icons";

interface TestResult {
  ok: boolean;
  error?: string;
  server?: string;
  source?: "builtin" | "custom";
  open?: boolean;
  devices?: number;
  maxDevices?: number;
  enforcing?: boolean;
}

export function ServerPanel({ language }: { language: "en" | "zh" }) {
  const zh = language === "zh";
  const config = useStore((s) => s.config);
  const setServerConfig = useStore((s) => s.setServerConfig);
  const pushToast = useStore((s) => s.pushToast);

  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null);
  const [channelRows, setChannelRows] = useState<RelayChannelRow[]>([]);
  const [activeChannelId, setActiveChannelId] = useState("");
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [localRelayStaticDir, setLocalRelayStaticDir] = useState("");
  const [lanMode, setLanMode] = useState<LanModeStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // 弹窗草稿（打开时回填；授权码永远不回填值，只回填「有没有」）
  const [sourceDraft, setSourceDraft] = useState<"builtin" | "custom">("builtin");
  const [authCodeDraft, setAuthCodeDraft] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const authorized = Boolean(config?.serverAuthCodeSet);
  const usingBuiltin = (config?.serverSource ?? "builtin") !== "custom";
  const serverName = usingBuiltin
    ? zh
      ? "内置服务器（我的 ECS）"
      : "Built-in server (my ECS)"
    : zh
      ? "自定义服务器"
      : "Custom server";
  const lastError = (relayStatus as any)?.lastErrorText || relayStatus?.lastError || "";

  useEffect(() => {
    if (!config) return;
    setSourceDraft(config.serverSource === "custom" ? "custom" : "builtin");
    setShowCustom(config.serverSource === "custom");
    if (typeof config.localRelayStaticDir === "string") setLocalRelayStaticDir(config.localRelayStaticDir);
  }, [config?.serverSource, config?.localRelayStaticDir]);

  const loadRelay = async (syncDrafts: boolean) => {
    try {
      const relay = (await window.pi.remote.getRelayStatus()) as RelayStatus;
      setRelayStatus(relay);
      if (syncDrafts) {
        setChannelRows((relay.relayChannels ?? []).map((row) => ({ ...row, tokenDraft: "" })));
        setActiveChannelId(relay.activeChannelId || relay.relayChannels?.find((row) => row.enabled && row.id !== "lan")?.id || "");
      }
    } catch {
      /* 面板可能比 IPC 桥活得久一点（重载瞬间） */
    }
  };

  useEffect(() => {
    void loadRelay(true);
    void (async () => {
      try {
        setLanMode((await window.pi.remote.getLanMode()) as LanModeStatus);
      } catch {
        setLanMode(null);
      }
    })();
    const timer = window.setInterval(() => void loadRelay(false), 2000);
    return () => window.clearInterval(timer);
  }, []);

  /** 「验证连通性」：服务器可达 + 授权码有效 + 设备名额用量（一次请求）。 */
  const verify = async () => {
    setTesting(true);
    try {
      const result = (await window.pi.remote.testServer()) as TestResult;
      setTestResult(result);
      if (result.ok) {
        pushToast(
          "success",
          result.open
            ? zh
              ? `服务器可达：${result.server}（该服务器未启用授权码校验）`
              : `Reachable: ${result.server} (no access-code check)`
            : zh
              ? `已连通：已用 ${result.devices ?? 0}/${result.maxDevices ?? 0} 台设备`
              : `Connected: ${result.devices ?? 0}/${result.maxDevices ?? 0} devices used`,
        );
      } else {
        pushToast("error", verifyErrorText(result.error, zh));
      }
    } finally {
      setTesting(false);
    }
  };

  const saveSource = async (patch?: { serverAuthCode: string }) => {
    setBusy(true);
    try {
      await setServerConfig({
        serverSource: sourceDraft,
        ...(patch ?? (authCodeDraft.trim() ? { serverAuthCode: authCodeDraft.trim() } : {})),
      });
      if (!patch) setAuthCodeDraft("");
      await loadRelay(true);
      setDialogOpen(false);
      pushToast("success", zh ? "服务器设置已保存" : "Server settings saved");
    } catch {
      // store 已经弹过错误提示
    } finally {
      setBusy(false);
    }
  };

  const updateChannel = (id: string, patch: Partial<RelayChannelRow>) => {
    setChannelRows((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };
  const addChannel = () => {
    const id = `ch${Date.now().toString(36)}`;
    setChannelRows((rows) => [
      ...rows,
      { id, label: zh ? "新服务器" : "New server", phoneUrl: "", hostUrl: "", hostUrlConfigured: false, hasToken: false, enabled: true, kind: "remote", tokenDraft: "" },
    ]);
    setEditingChannelId(id);
  };
  const removeChannel = (id: string) => {
    setChannelRows((rows) => rows.filter((row) => row.id !== id));
    if (activeChannelId === id) setActiveChannelId("");
  };

  /** 保存自定义服务器（含高级里的通道列表与静态目录；token 留空 = 保持现有）。 */
  const saveCustom = async () => {
    setBusy(true);
    try {
      await window.pi.app.setConfig({
        serverSource: "custom",
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
        localRelayStaticDir: localRelayStaticDir.trim(),
      });
      await loadRelay(true);
      setDialogOpen(false);
      pushToast("success", zh ? "服务器已保存（配对二维码请重新生成）" : "Server saved (regenerate the pairing QR)");
    } catch (error: any) {
      pushToast("error", error?.message || (zh ? "保存服务器失败" : "Failed to save the server"));
    } finally {
      setBusy(false);
    }
  };

  const toggleLanMode = async () => {
    setBusy(true);
    try {
      setLanMode((await window.pi.remote.setLanMode({ enabled: !lanMode?.advertiseLan })) as LanModeStatus);
    } finally {
      setBusy(false);
    }
  };

  const primaryRow = channelRows.find((row) => row.kind === "remote" && row.enabled) || channelRows.find((row) => row.kind === "remote");
  const phoneRelayUrl = relayStatus?.phoneRelayUrl || "";

  return (
    <div className="set-remote-stack">
      {/* ---- 唯一的主卡：当前转发服务器 + 状态 + 两个按钮 ---- */}
      <div className="set-card">
        <div className="set-card-head">
          <span className="set-card-icon"><Cloud size={14} /></span>
          <div className="set-card-title">{zh ? "转发服务器" : "Relay server"}</div>
        </div>
        <div className="set-remote-status" aria-live="polite">
          <span className="set-diag-k">{serverName}</span>
          <span className={`set-remote-status-value ${statusClass(relayStatus?.state || "disabled")}`}>
            <span className="set-remote-status-dot" aria-hidden="true" />
            {statusLabel(relayStatus?.state || "disabled", zh)}
            {lastError ? ` · ${lastError}` : ""}
          </span>
        </div>
        {usingBuiltin && !authorized && (
          <div className="set-hint">
            {zh ? "还没填授权码：转发与更新都走 GitHub。点「配置」粘贴授权码即可用我的服务器。" : "No access code yet — forwarding and updates use GitHub. Click Configure to paste one."}
          </div>
        )}
        <div className="set-diag-btns" style={{ marginTop: 8 }}>
          <button className="set-btn ghost" onClick={() => void verify()} disabled={testing}>
            {testing ? (zh ? "验证中…" : "Testing…") : zh ? "验证连通性" : "Test connection"}
          </button>
          <button className="set-btn primary" onClick={() => setDialogOpen(true)} disabled={busy}>
            {zh ? "配置" : "Configure"}
          </button>
        </div>
        {testResult && (
          <div className="set-hint" style={testResult.ok ? undefined : { color: "#c0392b" }}>
            {testResult.ok
              ? testResult.open
                ? zh
                  ? `✓ ${testResult.server} 可达（该服务器未启用授权码校验）`
                  : `✓ ${testResult.server} reachable (no access-code check)`
                : zh
                  ? `✓ 已连通 ${testResult.server} · 设备名额 ${testResult.devices ?? 0}/${testResult.maxDevices ?? 0}`
                  : `✓ ${testResult.server} · devices ${testResult.devices ?? 0}/${testResult.maxDevices ?? 0}`
              : `✗ ${verifyErrorText(testResult.error, zh)}`}
          </div>
        )}
        {phoneRelayUrl && (
          <div className="set-hint" style={{ wordBreak: "break-all" }}>
            {zh ? "手机将连接：" : "Phone connects to: "}
            <code>{phoneRelayUrl}</code>
          </div>
        )}
      </div>

      {/* ---- 配置弹窗 ---- */}
      {dialogOpen && (
        <div className="settings-backdrop" onMouseDown={() => setDialogOpen(false)}>
          <div className="set-modal" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" style={{ width: "min(560px, 94vw)" }}>
            <section className="set-main">
              <header className="set-head">
                <h2><Cloud size={16} style={{ verticalAlign: "-3px", marginRight: 8 }} />{zh ? "配置服务器" : "Configure server"}</h2>
                <button className="set-iconbtn" onClick={() => setDialogOpen(false)} aria-label={zh ? "关闭" : "Close"}>
                  <Close size={14} />
                </button>
              </header>
              <div className="set-body">
                <div className="set-card">
                  <div className="set-card-title">{zh ? "授权码" : "Access code"}</div>
                  <div className="set-hint">
                    {zh
                      ? "有码：转发对话与安装包更新都走我的 ECS（地址内置、不显示）；没码：只能用你自己的服务器，更新走 GitHub。一个码最多 3 台设备。"
                      : "With a code, forwarding and app updates use my ECS (address built in, never shown). Without one, use your own server and updates come from GitHub. One code covers up to 3 devices."}
                  </div>
                  <label className="set-addprov-field wide">
                    <span>{zh ? "授权码" : "Access code"}</span>
                    <input
                      className="set-input"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={authCodeDraft}
                      onChange={(e) => {
                        setAuthCodeDraft(e.target.value);
                        if (e.target.value.trim()) setSourceDraft("builtin");
                      }}
                      placeholder={
                        authorized ? (zh ? "已设置，留空则保持不变" : "set; leave empty to keep") : zh ? "粘贴授权码" : "paste the access code"
                      }
                    />
                  </label>
                  <div className="set-diag-btns" style={{ marginTop: 8 }}>
                    <button className="set-btn primary" onClick={() => void saveSource()} disabled={busy || sourceDraft !== "builtin"}>
                      {busy ? (zh ? "保存中…" : "Saving…") : zh ? "保存并启用" : "Save & enable"}
                    </button>
                    {authorized && (
                      <button className="set-btn ghost" onClick={() => void saveSource({ serverAuthCode: "" })} disabled={busy}>
                        {zh ? "清除授权码" : "Clear code"}
                      </button>
                    )}
                  </div>
                  <div className="set-hint">
                    <Shield size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                    {authorized
                      ? zh
                        ? "当前：内置服务器（已授权）"
                        : "Current: built-in server (authorized)"
                      : zh
                        ? "当前：未授权"
                        : "Current: not authorized"}
                  </div>
                </div>

                <div className="set-card">
                  <details open={showCustom} onToggle={(e) => setShowCustom((e.target as HTMLDetailsElement).open)}>
                    <summary className="set-card-title" style={{ cursor: "pointer" }}>
                      <Plug size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
                      {zh ? "用自己的服务器" : "Use my own server"}
                    </summary>
                    <div className="set-hint" style={{ marginTop: 8 }}>
                      {zh
                        ? "把转发指向你自己的中继（应用更新仍走 GitHub）。保存后会切换到自定义服务器。"
                        : "Point forwarding at your own relay (app updates still come from GitHub). Saving switches to the custom server."}
                    </div>
                    {primaryRow ? (
                      <>
                        <label className="set-addprov-field wide">
                          <span>{zh ? "手机地址（公网可达）" : "Phone URL (public)"}</span>
                          <input
                            className="set-input"
                            value={primaryRow.phoneUrl}
                            onChange={(e) => updateChannel(primaryRow.id, { phoneUrl: e.target.value })}
                            placeholder="wss://relay.example.com/ws"
                            spellCheck={false}
                          />
                        </label>
                        <label className="set-addprov-field wide">
                          <span>{zh ? "主机上行（留空 = 推导）" : "Host uplink (empty = derived)"}</span>
                          <input
                            className="set-input"
                            value={primaryRow.hostUrlConfigured ? primaryRow.hostUrl : ""}
                            onChange={(e) => updateChannel(primaryRow.id, { hostUrl: e.target.value })}
                            placeholder={primaryRow.hostUrl || "ws://127.0.0.1:9001/ws"}
                            spellCheck={false}
                          />
                        </label>
                        <label className="set-addprov-field wide">
                          <span>{zh ? "准入令牌（你的中继要求的，可留空）" : "Access token (your relay's own; optional)"}</span>
                          <input
                            className="set-input"
                            value={primaryRow.tokenDraft}
                            onChange={(e) => updateChannel(primaryRow.id, { tokenDraft: e.target.value })}
                            placeholder={primaryRow.hasToken ? (zh ? "已设置，留空则保持不变" : "set; leave empty to keep") : ""}
                            spellCheck={false}
                          />
                        </label>
                        {unreachableForPhone(primaryRow.phoneUrl) && (
                          <div className="set-hint" style={{ color: "#c0392b" }}>
                            {zh ? "⚠ tailnet / 内网地址手机连不上，扫描后会卡在连接超时。" : "⚠ Tailnet/private address — a phone outside that network cannot reach it."}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="set-hint">{zh ? "还没有服务器，先加一条。" : "No server yet — add one."}</div>
                    )}
                    <div className="set-diag-btns" style={{ marginTop: 8 }}>
                      <button className="set-btn ghost" onClick={addChannel} disabled={busy}>
                        {zh ? "＋ 添加" : "＋ Add"}
                      </button>
                      <button className="set-btn primary" onClick={() => void saveCustom()} disabled={busy || !primaryRow}>
                        {busy ? (zh ? "保存中…" : "Saving…") : zh ? "改为使用它" : "Use this server"}
                      </button>
                    </div>
                  </details>
                </div>

                <div className="set-card">
                  <details open={showAdvanced} onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}>
                    <summary className="set-card-title" style={{ cursor: "pointer" }}>
                      {zh ? "高级（多通道 · 局域网 · 静态目录）" : "Advanced (channels · LAN · static dir)"}
                    </summary>
                    <div className="set-hint" style={{ marginTop: 8 }}>
                      {zh
                        ? "配对票会带上全部候选（局域网优先），手机按序试连——不需要手动选路。"
                        : "The pairing ticket carries every candidate (LAN first) and the phone tries them in order — no manual routing."}
                    </div>
                    {channelRows.map((row) => {
                      const state = relayStatus?.channels?.find((c) => c.key === row.id)?.state;
                      const editing = editingChannelId === row.id;
                      return (
                        <div key={row.id} style={{ borderTop: "1px solid var(--border, #2a3140)", padding: "8px 0" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span
                              style={{ width: 8, height: 8, borderRadius: "50%", background: channelDotColor(row, state), flex: "0 0 auto" }}
                              title={row.id === "lan" ? (zh ? "局域网通道（自动探测）" : "LAN channel (auto)") : state || (zh ? "未启用" : "disabled")}
                            />
                            <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                              <strong style={{ fontWeight: 600 }}>{row.label}</strong>
                              {row.id !== "lan" && !row.enabled && <em style={{ opacity: 0.7, fontSize: 12 }}>{zh ? " 已关闭" : " off"}</em>}
                              <div style={{ fontSize: 12, wordBreak: "break-all" }}>{row.phoneUrl || (zh ? "（未填手机地址）" : "(no phone URL)")}</div>
                            </div>
                            {row.id !== "lan" && (
                              <div style={{ display: "flex", gap: 6, flex: "0 0 auto" }}>
                                <button type="button" className="set-btn" onClick={() => updateChannel(row.id, { enabled: !row.enabled })}>
                                  {row.enabled ? (zh ? "停用" : "Disable") : zh ? "启用" : "Enable"}
                                </button>
                                <button type="button" className="set-btn" onClick={() => setEditingChannelId(editing ? null : row.id)}>
                                  {editing ? (zh ? "收起" : "Collapse") : zh ? "编辑" : "Edit"}
                                </button>
                                <button type="button" className="set-btn" onClick={() => removeChannel(row.id)}>
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
                                <span>{zh ? "手机地址" : "Phone URL"}</span>
                                <input className="set-input" value={row.phoneUrl} onChange={(e) => updateChannel(row.id, { phoneUrl: e.target.value })} spellCheck={false} />
                              </label>
                              <label className="set-addprov-field wide">
                                <span>{zh ? "主机上行（留空 = 推导）" : "Host uplink (empty = derived)"}</span>
                                <input
                                  className="set-input"
                                  value={row.hostUrlConfigured ? row.hostUrl : ""}
                                  onChange={(e) => updateChannel(row.id, { hostUrl: e.target.value })}
                                  placeholder={row.hostUrl || "ws://127.0.0.1:9001/ws"}
                                  spellCheck={false}
                                />
                              </label>
                              <label className="set-addprov-field wide">
                                <span>{zh ? "准入 token（留空 = 保持现有）" : "Access token (empty = keep)"}</span>
                                <input
                                  className="set-input"
                                  value={row.tokenDraft}
                                  onChange={(e) => updateChannel(row.id, { tokenDraft: e.target.value })}
                                  spellCheck={false}
                                />
                              </label>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    <button type="button" className="set-btn" style={{ marginTop: 8 }} onClick={addChannel}>
                      {zh ? "＋ 添加新服务器地址" : "＋ Add server address"}
                    </button>
                    <label className="set-addprov-field wide" style={{ marginTop: 12 }}>
                      <span>{zh ? "本机中继静态目录（托管 PWA / 下载页，可留空）" : "Local relay static dir (optional)"}</span>
                      <input
                        className="set-input"
                        value={localRelayStaticDir}
                        onChange={(event) => setLocalRelayStaticDir(event.target.value)}
                        spellCheck={false}
                      />
                    </label>
                    <div className="set-remote-toggle-row" style={{ marginTop: 12 }}>
                      <div className="set-remote-toggle-copy">
                        <span className="set-remote-toggle-label">{zh ? "局域网模式（手机同网段直连）" : "LAN mode (same network)"}</span>
                        <span className="set-remote-toggle-state">{lanMode?.advertiseLan ? (zh ? "已开启" : "On") : zh ? "已关闭" : "Off"}</span>
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
                    {lanMode?.url && (
                      <div className="set-hint" style={{ wordBreak: "break-all" }}>
                        {zh ? "手机填写地址：" : "Phone relay URL: "}
                        <code>{lanMode.url}</code>
                      </div>
                    )}
                    {lanMode?.lastError && <div className="set-hint" style={{ color: "#c0392b" }}>{lanMode.lastError}</div>}
                    <div className="set-diag-btns" style={{ marginTop: 10 }}>
                      <button className="set-btn primary" onClick={() => void saveCustom()} disabled={busy}>
                        {zh ? "保存高级设置" : "Save advanced"}
                      </button>
                    </div>
                  </details>
                </div>
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

/** 「验证连通性」失败原因 → 人话。 */
function verifyErrorText(error: string | undefined, zh: boolean): string {
  switch (error) {
    case "BAD_CODE":
      return zh ? "授权码不对（或已被撤销）。" : "Wrong access code (or revoked).";
    case "UNREACHABLE":
      return zh ? "连不上服务器：检查网络，或换一条地址。" : "Server unreachable — check the network or the address.";
    case "TIMEOUT":
      return zh ? "连接超时（8 秒）。" : "Timed out after 8s.";
    case "NO_SERVER":
      return zh ? "还没配置服务器。" : "No server configured.";
    case "BAD_URL":
      return zh ? "服务器地址不是 ws(s):// 形式。" : "Server address must be a ws(s):// URL.";
    default:
      return error ? `${zh ? "验证失败：" : "Test failed: "}${error}` : zh ? "验证失败。" : "Test failed.";
  }
}
