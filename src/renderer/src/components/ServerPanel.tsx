/**
 * 设置 →「服务器」分栏（2026-10-16）。
 *
 * 为什么单独一栏：中继转发地址原先埋在「手机远程控制」弹层里（通道列表），
 * 而自更新源又从同一个地方推导——两件互不相干的事被绑在一起，结果是「没配手机通道
 * 就永远查不到更新」；面板本身也太重（多通道/局域网/静态目录全铺在用户面前）。
 * 现在：
 *   · **服务器来源**只有两种选法：内置服务器（我的 ECS，凭**授权码**）或自定义服务器；
 *   · 授权码同时是「中继上行注册」与「安装包镜像下载」的凭证（服务端 `RELAY_HOST_TOKENS`
 *     + `RELAY_APP_TOKENS` 校验），所以**更新源跟随这里**，不再有独立的更新源开关；
 *   · 多通道 / 选路模式 / 局域网模式 / 本机静态目录收进「高级」（原样保留能力）；
 *   · 「手机远程控制」弹层只剩跟手机有关的事（配对 / 设备 / 装 App）。
 *
 * 地址本身不进配置：内置服务器的地址以混淆形式写死在 `shared/builtin-server.ts`。
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
import { Cloud, Plug, Shield } from "./icons";

export function ServerPanel({ language }: { language: "en" | "zh" }) {
  const zh = language === "zh";
  const config = useStore((s) => s.config);
  const setServerConfig = useStore((s) => s.setServerConfig);
  const pushToast = useStore((s) => s.pushToast);

  const [serverSource, setServerSource] = useState<"builtin" | "custom">("builtin");
  const [authCodeDraft, setAuthCodeDraft] = useState("");
  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null);
  const [channelRows, setChannelRows] = useState<RelayChannelRow[]>([]);
  const [relayMode, setRelayMode] = useState<"manual" | "auto">("manual");
  const [activeChannelId, setActiveChannelId] = useState("");
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [localRelayStaticDir, setLocalRelayStaticDir] = useState("");
  const [lanMode, setLanMode] = useState<LanModeStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!config) return;
    setServerSource(config.serverSource === "custom" ? "custom" : "builtin");
    if (typeof config.localRelayStaticDir === "string") setLocalRelayStaticDir(config.localRelayStaticDir);
  }, [config?.serverSource, config?.localRelayStaticDir]);

  const refreshLanMode = async () => {
    try {
      setLanMode((await window.pi.remote.getLanMode()) as LanModeStatus);
    } catch {
      setLanMode(null);
    }
  };

  useEffect(() => {
    const load = async (syncDrafts: boolean) => {
      try {
        const relay = (await window.pi.remote.getRelayStatus()) as RelayStatus;
        setRelayStatus(relay);
        if (syncDrafts) {
          setChannelRows((relay.relayChannels ?? []).map((row) => ({ ...row, tokenDraft: "" })));
          setRelayMode(relay.relayMode === "auto" ? "auto" : "manual");
          setActiveChannelId(
            relay.activeChannelId || relay.relayChannels?.find((row) => row.enabled && row.id !== "lan")?.id || "",
          );
        }
      } catch {
        // 面板可能比 IPC 桥活得久一点（重载瞬间），静默即可。
      }
    };
    void load(true);
    void refreshLanMode();
    const timer = window.setInterval(() => void load(false), 2000);
    return () => window.clearInterval(timer);
  }, []);

  /** 保存「服务器来源」（+ 新填的授权码；留空 = 保持现有）。 */
  const saveServerSource = async (patch?: { serverAuthCode: string }) => {
    setBusy(true);
    try {
      await setServerConfig({
        serverSource,
        ...(patch ?? (authCodeDraft.trim() ? { serverAuthCode: authCodeDraft.trim() } : {})),
      });
      if (!patch) setAuthCodeDraft("");
      pushToast("success", zh ? "服务器设置已保存" : "Server settings saved");
    } catch {
      // store 已经弹过错误提示。
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
      {
        id,
        label: zh ? "新服务器" : "New server",
        phoneUrl: "",
        hostUrl: "",
        hostUrlConfigured: false,
        hasToken: false,
        enabled: true,
        kind: "remote",
        tokenDraft: "",
      },
    ]);
    setEditingChannelId(id);
  };
  /** 上下移动一条通道（顺序 = 手机尝试的顺序，首个优先）；局域网通道不让越过。 */
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

  /** 保存自定义服务器（通道列表 + 选路 + 静态目录；token 留空 = 保持现有）。 */
  const saveChannels = async () => {
    setBusy(true);
    try {
      await window.pi.app.setConfig({
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
      pushToast("success", zh ? "服务器已保存（配对二维码请重新生成）" : "Server saved (regenerate the pairing QR)");
    } catch (error: any) {
      pushToast("error", error?.message || (zh ? "保存服务器失败" : "Failed to save the server"));
    } finally {
      setBusy(false);
    }
  };

  const toggleRelay = async () => {
    setBusy(true);
    try {
      await window.pi.app.setConfig({ remoteRelayEnabled: relayStatus?.state !== "disabled" ? false : true });
      setRelayStatus((await window.pi.remote.getRelayStatus()) as RelayStatus);
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

  const authorized = Boolean(config?.serverAuthCodeSet);
  /** 自定义服务器栏的「主服务器」= 第一条启用的 remote 通道（没有就取第一条 remote）。 */
  const primaryRow = channelRows.find((row) => row.kind === "remote" && row.enabled) || channelRows.find((row) => row.kind === "remote");
  const phoneRelayUrl = relayStatus?.phoneRelayUrl || "";

  return (
    <div className="set-remote-stack">
      {/* ---- ① 服务器来源 ---- */}
      <div className="set-card">
        <div className="set-card-head">
          <span className="set-card-icon"><Cloud size={14} /></span>
          <div className="set-card-title">{zh ? "服务器" : "Server"}</div>
        </div>
        <div className="set-hint">
          {zh
            ? "手机经它连到本机；中继只转发不解析，提示词、代码、会话与文件端到端加密。有授权码就用内置服务器，没有就填自己的中继。"
            : "Phones reach this machine through it; the relay only forwards, prompts, code, sessions and files stay end-to-end encrypted. Use the built-in server with an access code, or point it at your own relay."}
        </div>
        <label className="set-addprov-field wide">
          <span>{zh ? "服务器来源" : "Server source"}</span>
          <select
            className="set-input"
            value={serverSource}
            onChange={(e) => setServerSource(e.target.value === "custom" ? "custom" : "builtin")}
          >
            <option value="builtin">{zh ? "内置服务器（我的 ECS）" : "Built-in server (my ECS)"}</option>
            <option value="custom">{zh ? "自定义服务器" : "Custom server"}</option>
          </select>
        </label>

        {serverSource === "builtin" && (
          <>
            <label className="set-addprov-field wide">
              <span>{zh ? "授权码" : "Access code"}</span>
              <input
                className="set-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={authCodeDraft}
                onChange={(e) => setAuthCodeDraft(e.target.value)}
                placeholder={
                  authorized
                    ? zh
                      ? "已设置，留空则保持不变"
                      : "set; leave empty to keep"
                    : zh
                      ? "粘贴授权码后启用"
                      : "paste the access code to enable"
                }
              />
            </label>
            <div className="set-hint">
              {authorized
                ? zh
                  ? "已授权：转发对话与安装包更新都走内置服务器；更新不通时（5 秒超时）自动回退 GitHub。"
                  : "Authorized: forwarding and app updates use the built-in server; updates fall back to GitHub after a 5s timeout."
                : zh
                  ? "未授权：不连内置服务器（也不会去探测它的更新镜像），更新走 GitHub。"
                  : "Not authorized: the built-in server is not used (nor its update mirror); updates come from GitHub."}
            </div>
            <div className="set-diag-btns" style={{ marginTop: 8 }}>
              <button className="set-btn primary" onClick={() => void saveServerSource()} disabled={busy}>
                {busy ? (zh ? "保存中…" : "Saving…") : zh ? "保存" : "Save"}
              </button>
              {authorized && (
                <button className="set-btn ghost" onClick={() => void saveServerSource({ serverAuthCode: "" })} disabled={busy}>
                  {zh ? "清除授权码" : "Clear access code"}
                </button>
              )}
            </div>
          </>
        )}

        {serverSource === "custom" && (
          <>
            <div className="set-hint" style={{ fontWeight: 600 }}>{zh ? "自定义服务器（主）" : "Custom server (primary)"}</div>
            {primaryRow ? (
              <>
                <label className="set-addprov-field wide">
                  <span>{zh ? "手机地址（公网可达，写进配对票）" : "Phone URL (public, goes into the ticket)"}</span>
                  <input
                    className="set-input"
                    value={primaryRow.phoneUrl}
                    onChange={(e) => updateChannel(primaryRow.id, { phoneUrl: e.target.value })}
                    placeholder="wss://relay.example.com/ws"
                    spellCheck={false}
                  />
                </label>
                <label className="set-addprov-field wide">
                  <span>{zh ? "主机上行（留空 = 按类型推导）" : "Host uplink (empty = derived)"}</span>
                  <input
                    className="set-input"
                    value={primaryRow.hostUrlConfigured ? primaryRow.hostUrl : ""}
                    onChange={(e) => updateChannel(primaryRow.id, { hostUrl: e.target.value })}
                    placeholder={primaryRow.hostUrl || "ws://127.0.0.1:9001/ws"}
                    spellCheck={false}
                  />
                </label>
                <label className="set-addprov-field wide">
                  <span>{zh ? "准入令牌（你自己中继要求的，留空 = 不用）" : "Access token (your relay's own; empty = none)"}</span>
                  <input
                    className="set-input"
                    value={primaryRow.tokenDraft}
                    onChange={(e) => updateChannel(primaryRow.id, { tokenDraft: e.target.value })}
                    placeholder={
                      primaryRow.hasToken
                        ? zh
                          ? "已设置，留空则保持不变"
                          : "set; leave empty to keep"
                        : zh
                          ? "留空 = 中继未启用准入"
                          : "empty = no allowlist"
                    }
                    spellCheck={false}
                  />
                </label>
                {unreachableForPhone(primaryRow.phoneUrl) && (
                  <div className="set-hint" style={{ color: "#c0392b" }}>
                    {zh
                      ? "⚠ 这是 tailnet / 内网地址——手机（没有 Tailscale、不在同一网段）连不上，扫码后会卡在连接超时。"
                      : "⚠ This is a tailnet/private address — a phone without Tailscale or outside that network cannot reach it."}
                  </div>
                )}
              </>
            ) : (
              <div className="set-hint">{zh ? "还没有服务器，先加一条。" : "No server yet — add one."}</div>
            )}
            <div className="set-diag-btns" style={{ marginTop: 8 }}>
              <button className="set-btn primary" onClick={() => void saveChannels()} disabled={busy}>
                {busy ? (zh ? "保存中…" : "Saving…") : zh ? "保存服务器" : "Save server"}
              </button>
              <button className="set-btn ghost" onClick={addChannel} disabled={busy}>
                {zh ? "＋ 添加" : "＋ Add"}
              </button>
            </div>
            <div className="set-hint">
              {zh
                ? "自定义服务器不托管安装包 → 应用更新走 GitHub（小版本不推 GitHub，只有大版本才有）。"
                : "A custom server does not mirror installers, so app updates come from GitHub (major releases only)."}
            </div>
          </>
        )}
      </div>

      {/* ---- ② 连接状态 ---- */}
      <div className="set-card">
        <div className="set-card-head">
          <span className="set-card-icon"><Plug size={14} /></span>
          <div className="set-card-title">{zh ? "连接状态" : "Connection"}</div>
        </div>
        <div className="set-remote-status" aria-live="polite">
          <span className="set-diag-k">{zh ? "中继连接状态" : "Relay connection"}</span>
          <span className={`set-remote-status-value ${statusClass(relayStatus?.state || "disabled")}`}>
            <span className="set-remote-status-dot" aria-hidden="true" />
            {statusLabel(relayStatus?.state || "disabled", zh)}
            {relayStatus?.lastError ? ` · ${relayStatus.lastError}` : ""}
          </span>
        </div>
        {serverSource === "builtin" && relayStatus?.state === "disabled" && !authorized && (
          <div className="set-hint">{zh ? "填了授权码并保存后，这里才会开始连接。" : "Enter an access code and save to enable this."}</div>
        )}
        <div className="set-hint" style={{ wordBreak: "break-all" }}>
          {zh ? "手机将连接：" : "Phone connects to: "}
          <code>{phoneRelayUrl || "—"}</code>
        </div>
        {serverSource === "custom" && (relayStatus?.channels ?? []).length > 0 && (
          <div style={{ marginTop: 6 }}>
            {(relayStatus?.channels ?? []).map((channel) => {
              const row = channelRows.find((item) => item.id === channel.key);
              return (
                <div key={channel.key} style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      flex: "0 0 auto",
                      background: row ? channelDotColor(row, channel.state) : "#8b95a5",
                    }}
                  />
                  <span>{row?.label || channel.key}</span>
                  <span style={{ opacity: 0.7 }}>{channel.state}</span>
                  {channel.lastError ? <span style={{ color: "#c0392b" }}>{channel.lastError}</span> : null}
                </div>
              );
            })}
          </div>
        )}
        <div className="set-remote-toggle-row">
          <div className="set-remote-toggle-copy">
            <span className="set-remote-toggle-label">{zh ? "启用中继 uplink" : "Enable relay uplink"}</span>
            <span className="set-remote-toggle-state">
              {relayStatus?.state !== "disabled" ? (zh ? "已启用" : "On") : zh ? "已关闭" : "Off"}
            </span>
          </div>
          <button
            type="button"
            className={`set-toggle ${relayStatus?.state !== "disabled" ? "on" : ""}`}
            role="switch"
            aria-checked={relayStatus?.state !== "disabled"}
            aria-label={zh ? "切换中继 uplink" : "Toggle relay uplink"}
            onClick={() => void toggleRelay()}
            // 按「有没有可挂的上行」判断，而不是看某个地址字段（那个坑见 RemotePanel 的历史注释）。
            disabled={busy || (serverSource === "builtin" ? !authorized : !channelRows.some((row) => row.enabled))}
          >
            <span className="set-toggle-knob" />
          </button>
        </div>
      </div>

      {/* ---- ③ 高级：多通道 / 选路 / 局域网 / 静态目录 ---- */}
      <details className="set-card">
        <summary className="set-card-title" style={{ cursor: "pointer" }}>
          {zh ? "高级（多通道 / 局域网 / 静态目录）" : "Advanced (channels / LAN / static dir)"}
        </summary>
        <div className="set-hint" style={{ marginTop: 8 }}>
          {zh
            ? "只有自定义服务器会用到这些：多条中继、选路顺序、本机中继的局域网模式与静态托管。"
            : "Only relevant for a custom server: multiple relays, routing order, LAN mode and local static hosting."}
        </div>
        {channelRows.map((row) => {
          const state = relayStatus?.channels?.find((c) => c.key === row.id)?.state;
          const editing = editingChannelId === row.id;
          return (
            <div key={row.id} style={{ borderTop: "1px solid var(--border, #2a3140)", padding: "8px 0" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{ width: 8, height: 8, borderRadius: "50%", background: channelDotColor(row, state), flex: "0 0 auto" }}
                  title={row.id === "lan" ? (zh ? "局域网通道（运行时自动探测）" : "LAN channel (auto)") : state || (zh ? "未启用" : "disabled")}
                />
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
                    <button type="button" className="set-btn" onClick={() => updateChannel(row.id, { enabled: !row.enabled })}>
                      {row.enabled ? (zh ? "停用" : "Disable") : zh ? "启用" : "Enable"}
                    </button>
                    <button type="button" className="set-btn" onClick={() => moveChannel(row.id, -1)} title={zh ? "上移（更优先）" : "Move up"}>
                      ↑
                    </button>
                    <button type="button" className="set-btn" onClick={() => moveChannel(row.id, 1)} title={zh ? "下移" : "Move down"}>
                      ↓
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
                    <input
                      className="set-input"
                      value={row.hostUrlConfigured ? row.hostUrl : ""}
                      onChange={(e) => updateChannel(row.id, { hostUrl: e.target.value })}
                      placeholder={row.hostUrl || "ws://127.0.0.1:9001/ws"}
                      spellCheck={false}
                    />
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
              {relayMode === "auto" ? (zh ? "自动：每条都挂上，手机按连通性选" : "Auto: register all, phone picks") : zh ? "手动：只用选中的那条" : "Manual: only the selected one"}
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
        <button className="set-btn primary" style={{ marginTop: 10 }} onClick={() => void saveChannels()} disabled={busy}>
          {zh ? "保存通道与高级设置" : "Save channels & advanced"}
        </button>

        <div className="set-remote-toggle-row" style={{ marginTop: 14 }}>
          <div className="set-remote-toggle-copy">
            <span className="set-remote-toggle-label">{zh ? "局域网模式（手机同网段直连）" : "LAN mode (same network)"}</span>
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
        {lanMode?.url && (
          <div className="set-hint" style={{ wordBreak: "break-all" }}>
            {zh ? "手机填写地址：" : "Phone relay URL: "}
            <code>{lanMode.url}</code>
          </div>
        )}
        {lanMode?.lastError && <div className="set-hint" style={{ color: "#c0392b" }}>{lanMode.lastError}</div>}
      </details>

      <div className="set-hint" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Shield size={13} />
        {zh
          ? "授权码只存在本机配置里，用于向服务器证明「这台电脑是我授权的」；中继与镜像都会校验它。"
          : "The access code is stored locally and proves to the server that this machine is authorized; both the relay and the mirror check it."}
      </div>
    </div>
  );
}
