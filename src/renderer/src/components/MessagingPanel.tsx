import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useStore } from "../store";
import type { MessagingState, WeChatMessagingState } from "../lib/types";
import { Close, Folder, MessageSquare, Plug } from "./icons";

type ChannelId = "feishu" | "wechat";

interface Draft {
  enabled: boolean;
  appId: string;
  appSecret: string; // empty = keep the stored secret (it is never shown back)
  projectCwd: string;
  permission: "sandbox" | "full";
}

/** WeChat draft — credentials come from QR onboarding only, never typed in. */
interface WeChatDraft {
  enabled: boolean;
  projectCwd: string;
  permission: "sandbox" | "full";
}

const STATUS_TEXT: Record<MessagingState["status"], { zh: string; en: string }> = {
  off: { zh: "未启用", en: "Off" },
  connecting: { zh: "连接中…", en: "Connecting…" },
  connected: { zh: "已连接，等待消息", en: "Connected, waiting for messages" },
  reconnecting: { zh: "连接中断，重连中…", en: "Connection lost, reconnecting…" },
  error: { zh: "连接失败", en: "Connection failed" },
};

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className={`set-toggle ${checked ? "on" : ""}`} aria-checked={checked} role="switch" onClick={() => onChange(!checked)}>
      <span className="set-toggle-knob" />
    </button>
  );
}

export function MessagingPanel() {
  const open = useStore((s) => s.messagingOpen);
  const close = useStore((s) => s.closeMessaging);
  const state = useStore((s) => s.messagingState);
  const wechatState = useStore<WeChatMessagingState | null>((s) => s.wechatState);
  const saveConfig = useStore((s) => s.saveMessagingConfig);
  const config = useStore((s) => s.config);
  const language = useStore((s) => s.config?.language || "en");

  // Re-seed the draft each time the panel opens. Deliberately NOT dependent on
  // `config`: saving (or any unrelated setConfig) would otherwise wipe typing.
  const [channel, setChannel] = useState<ChannelId>("feishu");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [wxDraft, setWxDraft] = useState<WeChatDraft | null>(null);
  useEffect(() => {
    if (!open) return;
    setChannel("feishu");
    const ch = config?.feishuChannel;
    setDraft({
      enabled: ch?.enabled ?? false,
      appId: ch?.appId ?? "",
      appSecret: "",
      projectCwd: ch?.projectCwd ?? "",
      permission: ch?.permission === "full" ? "full" : "sandbox",
    });
    const wch = config?.wechatChannel;
    setWxDraft({
      enabled: wch?.enabled ?? false,
      projectCwd: wch?.projectCwd ?? "",
      permission: wch?.permission === "full" ? "full" : "sandbox",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ---- one-click app creation via QR scan (registerApp) ---------------------
  type RegState = { kind: "idle" } | { kind: "qr"; url: string; expireAt: number } | { kind: "expired" } | { kind: "error"; code: string; description: string };
  const [reg, setReg] = useState<RegState>({ kind: "idle" });
  const [qrData, setQrData] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  useEffect(() => {
    const unsub = window.pi.on.messagingRegistration((e) => {
      if (e.phase === "qr_ready" && e.url) {
        setReg({ kind: "qr", url: e.url, expireAt: Date.now() + (e.expireIn ?? 240) * 1000 });
      } else if (e.phase === "success") {
        setReg({ kind: "idle" });
        // Refresh the draft so a later “Save configuration” doesn't overwrite
        // the freshly registered credentials with the stale App ID.
        setDraft((d) => (d && e.clientId ? { ...d, appId: e.clientId } : d));
        const zh = (useStore.getState().config?.language ?? "en") === "zh";
        useStore.getState().pushToast("success", zh ? `应用创建成功，凭证已保存（${e.clientId}）` : `App created, credentials saved (${e.clientId})`);
        void useStore.getState().loadMessaging();
      } else if (e.phase === "error") {
        setReg({ kind: "error", code: e.code ?? "unknown", description: e.description ?? "" });
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (reg.kind !== "qr") {
      setQrData(null);
      return;
    }
    let alive = true;
    QRCode.toDataURL(reg.url, { width: 240, margin: 1 }).then((d) => {
      if (alive) setQrData(d);
    });
    return () => {
      alive = false;
    };
  }, [reg]);

  useEffect(() => {
    if (reg.kind !== "qr") return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [reg]);
  const regRemaining = reg.kind === "qr" ? Math.max(0, Math.round((reg.expireAt - nowTick) / 1000)) : 0;
  useEffect(() => {
    if (reg.kind === "qr" && regRemaining <= 0) setReg({ kind: "expired" });
  }, [reg, regRemaining]);

  // ---- WeChat (iLink bot) QR onboarding --------------------------------------
  type WxRegState =
    | { kind: "idle" }
    | { kind: "qr"; url: string; scanned: boolean; needCode: boolean }
    | { kind: "error"; code: string; description: string };
  const [wxReg, setWxReg] = useState<WxRegState>({ kind: "idle" });
  const [wxQrData, setWxQrData] = useState<string | null>(null);
  const [verifyCodeInput, setVerifyCodeInput] = useState("");

  useEffect(() => {
    if (typeof window.pi.on.wechatRegistration !== "function") return () => undefined;
    const unsub = window.pi.on.wechatRegistration((e) => {
      if (e.phase === "qr_ready" && e.url) {
        setWxReg({ kind: "qr", url: e.url, scanned: false, needCode: false });
      } else if (e.phase === "status") {
        setWxReg((r) => (r.kind === "qr" ? { ...r, scanned: e.status === "scanned" } : r));
      } else if (e.phase === "need_verifycode") {
        setVerifyCodeInput("");
        setWxReg((r) => (r.kind === "qr" ? { ...r, needCode: true } : r));
      } else if (e.phase === "success") {
        setWxReg({ kind: "idle" });
        const zh = (useStore.getState().config?.language ?? "en") === "zh";
        useStore.getState().pushToast("success", zh ? `微信连接成功，凭证已保存（${e.botId}）` : `WeChat connected, credentials saved (${e.botId})`);
        void useStore.getState().loadWeChatMessaging();
      } else if (e.phase === "error") {
        setWxReg({ kind: "error", code: e.code ?? "unknown", description: e.description ?? "" });
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (wxReg.kind !== "qr") {
      setWxQrData(null);
      return;
    }
    let alive = true;
    QRCode.toDataURL(wxReg.url, { width: 240, margin: 1 }).then((d) => {
      if (alive) setWxQrData(d);
    });
    return () => {
      alive = false;
    };
  }, [wxReg]);

  // ---- Feishu MCP (official @larksuiteoapi/lark-mcp via mcp.json) -----------
  const [mcpEnabled, setMcpEnabled] = useState<boolean | null>(null); // null = not loaded yet
  const [mcpBusy, setMcpBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    window.pi.plugins
      .getMcpServers()
      .then((servers) => {
        if (!alive) return;
        const s = servers.find((x) => x.name === "lark-mcp");
        setMcpEnabled(!!s && !s.disabled);
      })
      .catch(() => {
        if (alive) setMcpEnabled(null);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  if (!open || !draft || !wxDraft) return null;

  const zh = language === "zh";
  // `state` is null only when the main service never reported (e.g. an old
  // dev preload) — show off rather than a misleading spinner.
  const status = state?.status ?? "off";
  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  // target="wechat" writes the WeChat draft — the Feishu and WeChat tabs keep
  // separate drafts, so a shared button must not silently update the wrong one.
  const pickFolder = async (target?: "wechat") => {
    const p = await window.pi.app.showOpenDialog("folder");
    if (!p || Array.isArray(p)) return;
    if (target === "wechat") patchWx({ projectCwd: p });
    else patch({ projectCwd: p });
  };

  const save = async () => {
    if (!draft.appId.trim()) return useStore.getState().pushToast("warning", zh ? "请填写 App ID" : "App ID is required");
    if (draft.enabled && !draft.projectCwd) return useStore.getState().pushToast("warning", zh ? "请选择绑定的项目文件夹" : "Pick the project folder to bind");
    if (draft.enabled && !draft.appSecret.trim() && !(state?.configured || config?.feishuChannel?.appId)) {
      return useStore.getState().pushToast("warning", zh ? "请填写 App Secret" : "App Secret is required");
    }
    const p: Partial<Draft> = {
      enabled: draft.enabled,
      appId: draft.appId.trim(),
      projectCwd: draft.projectCwd,
      permission: draft.permission,
    };
    if (draft.appSecret.trim()) p.appSecret = draft.appSecret.trim(); // empty keeps the stored one
    await saveConfig(p);
  };

  const wxSave = async () => {
    if (!wxDraft) return;
    if (wxDraft.enabled && !wxDraft.projectCwd) return useStore.getState().pushToast("warning", zh ? "请选择绑定的项目文件夹" : "Pick the project folder to bind");
    await useStore.getState().saveWeChatConfig({
      enabled: wxDraft.enabled,
      projectCwd: wxDraft.projectCwd,
      permission: wxDraft.permission,
    });
  };
  const patchWx = (p: Partial<WeChatDraft>) => setWxDraft((d) => (d ? { ...d, ...p } : d));

  const guideSteps = zh
    ? [
        "打开飞书开放平台开发者后台 open.feishu.cn/app。如果没有企业/组织，先免费创建一个（个人可自建，无需营业执照）——⚠️ 个人版租户不支持长连接事件推送，机器人会连上但永远收不到消息，且没有「发布」入口。",
        "在新企业下创建「企业自建应用」，在「凭证与基础信息」页记下 App ID 和 App Secret。",
        "在「应用能力 → 机器人」页添加机器人能力。",
        "在「权限管理」页开通：im:message.p2p_msg:readonly（接收单聊消息）、im:message.group_at_msg:readonly（接收群聊 @机器人 消息）、im:message:send_as_bot（以应用身份发消息）。",
        "在「事件与回调」页选择「使用长连接接收事件」，并添加事件 im.message.receive_v1（接收消息 v2.0）。",
        "创建版本并发布（或先设置测试可用范围），然后在飞书里搜索你的机器人开始对话。",
      ]
    : [
        "Open the Feishu Open Platform console at open.feishu.cn/app. If you don't have an enterprise/organization yet, create one for free first (individuals can create their own, no business license needed) — ⚠️ personal tenants do NOT support WebSocket event push: the bot connects but never receives messages, and there is no publish option.",
        "Create a custom (enterprise) app under it; note the App ID and App Secret on the Credentials page.",
        "Add the Bot capability under App Capabilities → Bots.",
        "Enable scopes: im:message.p2p_msg:readonly (receive p2p messages), im:message.group_at_msg:readonly (receive group @-mentions), im:message:send_as_bot (send as bot).",
        "On Events & Callbacks, choose the WebSocket long-connection mode and subscribe to im.message.receive_v1.",
        "Create a version and publish it (or set a test availability scope), then find your bot in Feishu and start chatting.",
      ];

  const wxStatus = wechatState?.status ?? "off";
  const channels: { id: ChannelId; name: string; sub: string; disabled?: boolean }[] = [
    { id: "feishu", name: zh ? "飞书" : "Feishu", sub: STATUS_TEXT[status][language] },
    { id: "wechat", name: zh ? "微信" : "WeChat", sub: STATUS_TEXT[wxStatus][language] },
  ];

  // ---- QR registration helpers ----------------------------------------------
  const startWxReg = () => {
    setVerifyCodeInput("");
    void window.pi.wechat.startQrLogin();
  };
  const cancelWxReg = () => {
    void window.pi.wechat.cancelQrLogin();
    setWxReg({ kind: "idle" });
  };
  const submitVerifyCode = () => {
    if (!verifyCodeInput.trim()) return;
    void window.pi.wechat.submitVerifyCode(verifyCodeInput);
    setVerifyCodeInput("");
    setWxReg((r) => (r.kind === "qr" ? { ...r, needCode: false } : r));
  };

  const startReg = () => void window.pi.messaging.startAppRegistration();
  const cancelReg = () => {
    void window.pi.messaging.cancelAppRegistration();
    setReg({ kind: "idle" });
  };
  const enableFeishuMcp = async () => {
    if (mcpBusy) return;
    setMcpBusy(true);
    try {
      const res = await window.pi.messaging.enableFeishuMcp();
      if (res.ok) {
        setMcpEnabled(true);
        useStore.getState().pushToast("success", zh ? "飞书 MCP 已启用（lark-mcp），对新会话生效" : "Feishu MCP enabled (lark-mcp); applies to new sessions");
      } else if (res.error === "not_configured") {
        useStore.getState().pushToast("warning", zh ? "请先保存 App ID / Secret，再启用飞书 MCP" : "Save the App ID / Secret first, then enable Feishu MCP");
      } else {
        useStore.getState().pushToast("error", `${zh ? "启用失败：" : "Enable failed: "}${res.error ?? "unknown error"}`);
      }
    } finally {
      setMcpBusy(false);
    }
  };
  const fmtCountdown = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const regErrorText = (r: { code: string; description: string }) => {
    if (r.code === "access_denied") return zh ? "已在手机上取消授权。" : "Authorization was cancelled on your phone.";
    if (r.code === "expired_token") return zh ? "二维码已过期，请重新生成。" : "The QR code expired — regenerate it.";
    return r.description || r.code;
  };

  return (
    <div className="settings-backdrop" onMouseDown={close}>
      <div className="plugins-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="plugins-head">
          <div className="plugins-head-title">
            <span className="set-brand-mark">
              <MessageSquare size={18} />
            </span>
            <div>
              <div className="set-brand-title">{zh ? "消息接入" : "Messaging"}</div>
              <div className="set-brand-sub">
                {zh ? "通过聊天工具与 MPI 会话对话（仅 MPI 运行时在线）" : "Chat with your MPI sessions from messaging apps (online while MPI is running)"}
              </div>
            </div>
          </div>
          <button className="set-iconbtn" title={zh ? "关闭" : "Close"} onClick={close}>
            <Close size={16} />
          </button>
        </header>

        <div className="plugins-body msg-body">
          <div className="msg-split">
            {/* channel list */}
            <aside className="msg-channels" aria-label={zh ? "消息通道" : "Channels"}>
              <div className="msg-channels-label">{zh ? "通道" : "Channels"}</div>
              {channels.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  disabled={c.disabled}
                  aria-current={channel === c.id ? "true" : undefined}
                  className={`msg-channel${channel === c.id ? " active" : ""} ${c.id === "feishu" ? `msg-status-${status}` : `msg-status-${wxStatus}`}`}
                  onClick={() => setChannel(c.id)}
                >
                  <span className="msg-dot" aria-hidden="true" />
                  <span className="msg-channel-text">
                    <span className="msg-channel-name">{c.name}</span>
                    <span className="msg-channel-sub">{c.sub}</span>
                  </span>
                </button>
              ))}
            </aside>

            {/* detail pane */}
            <section className="msg-detail">
              {channel === "feishu" ? (
                <>
                  {/* status */}
                  <div className={`msg-status msg-status-${status}`}>
                    <span className="msg-dot" aria-hidden="true" />
                    <span>{STATUS_TEXT[status][language]}</span>
                    {state?.appIdMasked && <span className="muted msg-appid">{state.appIdMasked}</span>}
                  </div>
                  {status === "error" && state?.lastError && (
                    <div className="msg-error" title={state.lastError}>
                      {state.lastError}
                    </div>
                  )}

                  {/* quick connect: one-click app creation via QR scan */}
                  <div className={`msg-qr-card${reg.kind === "idle" && state?.configured ? " compact" : ""}`}>
                    {reg.kind === "idle" && !state?.configured && (
                      <>
                        <div className="msg-qr-title">{zh ? "快速接入（推荐）" : "Quick setup (recommended)"}</div>
                        <p className="set-hint msg-qr-desc">
                          {zh
                            ? "用飞书手机扫描下方二维码，确认后自动创建机器人应用并保存凭证——无需手动建应用、找 App ID。"
                            : "Scan the QR code with mobile Feishu; after confirming, a bot app is created and its credentials are saved automatically — no console steps needed."}
                        </p>
                        <button className="set-btn primary" onClick={startReg}>
                          {zh ? "📱 扫码创建应用" : "📱 Create app via scan"}
                        </button>
                      </>
                    )}
                    {reg.kind === "idle" && state?.configured && (
                      <div className="msg-qr-bound">
                        <span className="set-hint">
                          {zh ? `已绑定应用` : `Bound app`}
                          {state.appIdMasked ? ` · ${state.appIdMasked}` : ""}
                        </span>
                        <button className="set-btn ghost" onClick={startReg} title={zh ? "会创建一个新应用，旧应用仍保留在飞书后台" : "Creates a NEW app; the old one stays in your Feishu console"}>
                          {zh ? "重新扫码创建新应用" : "Create a new app via scan"}
                        </button>
                      </div>
                    )}
                    {(reg.kind === "qr" || reg.kind === "expired") && (
                      <>
                        <div className="msg-qr-row">
                          {qrData ? (
                            <img className="msg-qr-img" src={qrData} alt="QR code" />
                          ) : (
                            <div className="msg-qr-box msg-qr-loading">
                              <span className="spinner" />
                            </div>
                          )}
                          <div className="msg-qr-side">
                            <div className="msg-qr-title">{zh ? "用飞书扫码确认" : "Confirm with Feishu"}</div>
                            {reg.kind === "qr" ? (
                              <>
                                <p className="set-hint">
                                  {zh
                                    ? "打开手机飞书 → 扫一扫，在确认页点「同意 / 创建」。"
                                    : "Open mobile Feishu → scan, then tap confirm on the page."}
                                </p>
                                <div className={`msg-qr-countdown${regRemaining <= 10 ? " urgent" : ""}`}>⏱ {fmtCountdown(regRemaining)}</div>
                              </>
                            ) : (
                              <div className="msg-qr-countdown expired">{zh ? "二维码已过期，请重新生成。" : "QR code expired — regenerate it."}</div>
                            )}
                          </div>
                        </div>
                        <div className="auto-editor-actions">
                          <button className="set-btn ghost" onClick={cancelReg}>
                            {zh ? "取消" : "Cancel"}
                          </button>
                          <button className="set-btn primary" onClick={startReg}>
                            {zh ? "重新生成二维码" : "Regenerate QR"}
                          </button>
                        </div>
                      </>
                    )}
                    {reg.kind === "error" && (
                      <>
                        <div className="msg-qr-title">{zh ? "扫码创建失败" : "Scan setup failed"}</div>
                        <p className="set-hint msg-error-text">{regErrorText(reg)}</p>
                        <div className="auto-editor-actions">
                          <button className="set-btn ghost" onClick={() => setReg({ kind: "idle" })}>
                            {zh ? "关闭" : "Dismiss"}
                          </button>
                          <button className="set-btn primary" onClick={startReg}>
                            {zh ? "重试" : "Retry"}
                          </button>
                        </div>
                      </>
                    )}
                  </div>

                  {/* feishu card */}
                  <div className="set-row wide">
                    <label className="set-label">{zh ? "启用飞书接入" : "Enable Feishu channel"}</label>
                    <div className="set-control">
                      <Toggle checked={draft.enabled} onChange={(v) => patch({ enabled: v })} />
                    </div>
                  </div>

                  <div className="set-row wide">
                    <label className="set-label">App ID</label>
                    <div className="set-control">
                      <input
                        className="set-input"
                        placeholder={zh ? "cli_xxx（开发者后台 → 凭证与基础信息）" : "cli_xxx (Credentials page)"}
                        value={draft.appId}
                        onChange={(e) => patch({ appId: e.target.value })}
                      />
                    </div>
                  </div>

                  <div className="set-row wide">
                    <label className="set-label">App Secret</label>
                    <div className="set-control">
                      <input
                        className="set-input"
                        type="password"
                        autoComplete="off"
                        placeholder={state?.configured ? (zh ? "已配置，留空保持不变" : "Configured — leave empty to keep") : zh ? "开发者后台 → 凭证与基础信息" : "Credentials page"}
                        value={draft.appSecret}
                        onChange={(e) => patch({ appSecret: e.target.value })}
                      />
                    </div>
                  </div>

                  <div className="set-row wide">
                    <label className="set-label">{zh ? "绑定项目" : "Bound project"}</label>
                    <div className="set-control">
                      <div className="auto-folder">
                        <input
                          className="set-input"
                          placeholder={zh ? "消息将进入该项目下的专属会话" : "Messages go to a dedicated session in this folder"}
                          value={draft.projectCwd}
                          onChange={(e) => patch({ projectCwd: e.target.value })}
                        />
                        <button className="set-btn" onClick={() => void pickFolder()}>
                          <Folder size={14} /> {zh ? "选择" : "Browse"}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="set-row wide">
                    <label className="set-label">{zh ? "会话权限" : "Session permission"}</label>
                    <div className="set-control">
                      <div className="auto-permission-block">
                        <strong>{zh ? "聊天驱动的会话无法等待授权确认：" : "Chat-driven sessions cannot wait for approval prompts:"}</strong>
                        <div className="auto-freq-tabs">
                          <button
                            className={`set-btn ${draft.permission !== "full" ? "primary" : "ghost"}`}
                            onClick={() => patch({ permission: "sandbox" })}
                          >
                            {zh ? "沙盒（默认）" : "Sandbox (default)"}
                          </button>
                          <button className={`set-btn ${draft.permission === "full" ? "primary" : "ghost"}`} onClick={() => patch({ permission: "full" })}>
                            {zh ? "完全权限" : "Full access"}
                          </button>
                        </div>
                        <div className="set-hint">
                          {zh
                            ? "沙盒下需要授权的操作会在聊天里通知你，60 秒内未在 MPI 中批准则自动拒绝（任务继续）；完全权限不弹任何确认。切换后对新会话生效。"
                            : "In Sandbox, operations needing approval are announced in chat and auto-denied after 60s if not approved in MPI (the task continues); Full access never prompts. Applies to new sessions."}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="set-row wide">
                    <label className="set-label">{zh ? "飞书 MCP" : "Feishu MCP"}</label>
                    <div className="set-control">
                      <button
                        className={`set-btn ${mcpEnabled ? "" : "primary"}`}
                        disabled={mcpBusy || !state?.configured}
                        onClick={() => void enableFeishuMcp()}
                      >
                        {mcpBusy ? (
                          zh ? "启用中…" : "Enabling…"
                        ) : mcpEnabled ? (
                          <>
                            ✓ {zh ? "已启用（点击刷新凭证）" : "Enabled (click to refresh credentials)"}
                          </>
                        ) : (
                          <>
                            <Plug size={14} /> {zh ? "启用飞书 MCP" : "Enable Feishu MCP"}
                          </>
                        )}
                      </button>
                      <div className="set-hint">
                        {zh
                          ? "让会话中的智能体直接调用飞书 API（发消息、文档、日历等默认工具集），使用当前渠道凭证。写入 mcp.json 的 lark-mcp 条目，对新会话生效；可在「扩展功能 → 我的 MCP」中停用或删除。需本机已安装 Node.js ≥ 20。"
                          : "Lets agents in sessions call Feishu APIs directly (default tool set: messages, docs, calendar…) using the current channel credentials. Writes a lark-mcp entry to mcp.json; applies to new sessions. Manage it under Extensions → My MCP. Requires local Node.js ≥ 20."}
                      </div>
                    </div>
                  </div>

                  <div className="auto-editor-actions">
                    <button className="set-btn ghost" onClick={close}>
                      {zh ? "取消" : "Cancel"}
                    </button>
                    <button className="set-btn primary" onClick={() => void save()}>
                      {zh ? "保存配置" : "Save configuration"}
                    </button>
                  </div>

                  {/* setup guide */}
                  <details className="msg-guide">
                    <summary>{zh ? "飞书应用创建指南（手动方式）" : "Feishu app setup guide (manual)"}</summary>
                    <div className="set-hint msg-guide-note">
                      {zh
                        ? "推荐：直接用上方「扫码创建应用」一键完成——自动配好机器人能力、权限与事件订阅。以下为手动方式（个人版租户不可用，需企业账号）。"
                        : "Recommended: use the “Create app via scan” card above — it sets up bot capability, scopes and event subscription automatically. Manual steps below (requires an enterprise account; personal tenants are not supported)."}
                    </div>
                    <ol>
                      {guideSteps.map((step, i) => (
                        <li key={i}>{step}</li>
                      ))}
                    </ol>
                    <div className="set-hint">
                      {zh
                        ? "接入后：私聊机器人或群里 @它 发送文本即可提问；回复会流式更新在同一条消息里。命令：/new 新建会话，/help 帮助。"
                        : "Once connected: DM the bot or @-mention it in a group with plain text. Replies stream into one message. Commands: /new for a fresh session, /help for help."}
                    </div>
                  </details>
                </>
              ) : (
                <>
                  {/* status */}
                  <div className={`msg-status msg-status-${wxStatus}`}>
                    <span className="msg-dot" aria-hidden="true" />
                    <span>{STATUS_TEXT[wxStatus][language]}</span>
                    {wechatState?.botIdMasked && <span className="muted msg-appid">{wechatState.botIdMasked}</span>}
                  </div>
                  {wxStatus === "error" && wechatState?.lastError && (
                    <div className="msg-error" title={wechatState.lastError}>
                      {wechatState.lastError}
                    </div>
                  )}

                  {/* QR onboarding */}
                  <div className={`msg-qr-card${wxReg.kind === "idle" && wechatState?.configured ? " compact" : ""}`}>
                    {wxReg.kind === "idle" && !wechatState?.configured && (
                      <>
                        <div className="msg-qr-title">{zh ? "扫码连接微信（推荐）" : "Connect via QR scan (recommended)"}</div>
                        <p className="set-hint msg-qr-desc">
                          {zh
                            ? "用手机微信扫描下方二维码并确认，凭证自动保存——无需注册企业、配置回调地址。仅支持私聊（灰度功能，需账号在开放范围内）。"
                            : "Scan the QR code with mobile WeChat and confirm; credentials are saved automatically — no enterprise setup or callback URL needed. P2P chat only (gray-release feature)."}
                        </p>
                        <button className="set-btn primary" onClick={startWxReg}>
                          {zh ? "📱 扫码连接微信" : "📱 Connect WeChat via scan"}
                        </button>
                      </>
                    )}
                    {wxReg.kind === "idle" && wechatState?.configured && (
                      <div className="msg-qr-bound">
                        <span className="set-hint">
                          {zh ? "已绑定微信" : "Bound WeChat"}
                          {wechatState.botIdMasked ? ` · ${wechatState.botIdMasked}` : ""}
                        </span>
                        <button className="set-btn ghost" onClick={startWxReg} title={zh ? "重新扫码会覆盖当前凭证" : "Re-scanning replaces the current credentials"}>
                          {zh ? "重新扫码连接" : "Re-scan to connect"}
                        </button>
                      </div>
                    )}
                    {wxReg.kind === "qr" && (
                      <>
                        <div className="msg-qr-row">
                          {wxQrData ? (
                            <img className="msg-qr-img" src={wxQrData} alt="QR code" />
                          ) : (
                            <div className="msg-qr-box msg-qr-loading">
                              <span className="spinner" />
                            </div>
                          )}
                          <div className="msg-qr-side">
                            <div className="msg-qr-title">{zh ? "用微信扫码确认" : "Confirm with WeChat"}</div>
                            {wxReg.needCode ? (
                              <>
                                <p className="set-hint">{zh ? "请在手机微信上查看要输入的验证码：" : "Enter the verification code shown in mobile WeChat:"}</p>
                                <input
                                  className="set-input"
                                  inputMode="numeric"
                                  placeholder={zh ? "输入验证码" : "Verification code"}
                                  value={verifyCodeInput}
                                  onChange={(e) => setVerifyCodeInput(e.target.value)}
                                  onKeyDown={(e) => e.key === "Enter" && submitVerifyCode()}
                                />
                                <button className="set-btn primary" onClick={submitVerifyCode} disabled={!verifyCodeInput.trim()}>
                                  {zh ? "提交验证码" : "Submit code"}
                                </button>
                              </>
                            ) : (
                              <p className="set-hint">
                                {wxReg.scanned
                                  ? zh ? "已扫码，请在手机上确认。" : "Scanned — confirm on your phone."
                                  : zh ? "打开手机微信 → 扫一扫，在确认页点「同意」。二维码过期会自动刷新。" : "Open mobile WeChat → scan, then tap confirm. The QR refreshes automatically when it expires."}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="auto-editor-actions">
                          <button className="set-btn ghost" onClick={cancelWxReg}>
                            {zh ? "取消" : "Cancel"}
                          </button>
                          <button className="set-btn primary" onClick={startWxReg}>
                            {zh ? "重新生成二维码" : "Regenerate QR"}
                          </button>
                        </div>
                      </>
                    )}
                    {wxReg.kind === "error" && (
                      <>
                        <div className="msg-qr-title">{zh ? "连接失败" : "Connection failed"}</div>
                        <p className="set-hint msg-error-text">{wxReg.description || wxReg.code}</p>
                        <div className="auto-editor-actions">
                          <button className="set-btn ghost" onClick={() => setWxReg({ kind: "idle" })}>
                            {zh ? "关闭" : "Dismiss"}
                          </button>
                          <button className="set-btn primary" onClick={startWxReg}>
                            {zh ? "重试" : "Retry"}
                          </button>
                        </div>
                      </>
                    )}
                  </div>

                  {/* enable + binding */}
                  <div className="set-row wide">
                    <label className="set-label">{zh ? "启用微信接入" : "Enable WeChat channel"}</label>
                    <div className="set-control">
                      <Toggle checked={wxDraft.enabled} onChange={(v) => patchWx({ enabled: v })} />
                    </div>
                  </div>

                  {!wechatState?.configured && (
                    <div className="msg-error" style={{ marginBottom: 8 }}>
                      {zh ? "⚠️ 尚未扫码连接——先完成上方二维码登录，再启用。" : "⚠️ Not connected yet — complete the QR login above before enabling."}
                    </div>
                  )}

                  <div className="set-row wide">
                    <label className="set-label">{zh ? "绑定项目" : "Bound project"}</label>
                    <div className="set-control">
                      <div className="auto-folder">
                        <input
                          className="set-input"
                          placeholder={zh ? "消息将进入该项目下的专属会话" : "Messages go to a dedicated session in this folder"}
                          value={wxDraft.projectCwd}
                          onChange={(e) => patchWx({ projectCwd: e.target.value })}
                        />
                        <button className="set-btn" onClick={() => void pickFolder("wechat")}>
                          <Folder size={14} /> {zh ? "选择" : "Browse"}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="set-row wide">
                    <label className="set-label">{zh ? "会话权限" : "Session permission"}</label>
                    <div className="set-control">
                      <div className="auto-permission-block">
                        <strong>{zh ? "聊天驱动的会话无法等待授权确认：" : "Chat-driven sessions cannot wait for approval prompts:"}</strong>
                        <div className="auto-freq-tabs">
                          <button
                            className={`set-btn ${wxDraft.permission !== "full" ? "primary" : "ghost"}`}
                            onClick={() => patchWx({ permission: "sandbox" })}
                          >
                            {zh ? "沙盒（默认）" : "Sandbox (default)"}
                          </button>
                          <button className={`set-btn ${wxDraft.permission === "full" ? "primary" : "ghost"}`} onClick={() => patchWx({ permission: "full" })}>
                            {zh ? "完全权限" : "Full access"}
                          </button>
                        </div>
                        <div className="set-hint">
                          {zh
                            ? "沙盒下需要授权的操作会在聊天里通知你，60 秒内未在 MPI 中批准则自动拒绝（任务继续）；完全权限不弹任何确认。切换后对新会话生效。"
                            : "In Sandbox, operations needing approval are announced in chat and auto-denied after 60s if not approved in MPI (the task continues); Full access never prompts. Applies to new sessions."}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="auto-editor-actions">
                    <button className="set-btn ghost" onClick={close}>
                      {zh ? "取消" : "Cancel"}
                    </button>
                    <button className="set-btn primary" onClick={() => void wxSave()}>
                      {zh ? "保存配置" : "Save configuration"}
                    </button>
                  </div>

                  {/* usage notes */}
                  <details className="msg-guide">
                    <summary>{zh ? "使用说明与限制" : "Usage notes & limitations"}</summary>
                    <ol>
                      {zh ? (
                        <>
                          <li>连接后：在微信里私聊这个 bot 发送文本即可提问；处理中会显示「正在输入」，完成后单独发一条结果消息。</li>
                          <li>命令：/new 新建会话，/list 列出最近会话，/use &lt;序号&gt; 切换会话，/help 帮助。</li>
                          <li>仅支持私聊与文本消息（图片/文件暂不支持）；一个微信账号绑定一个 MPI 实例。</li>
                          <li>这是腾讯灰度中的个人微信 bot 通道：若扫码后长时间无反应或提示不可用，说明你的账号暂未在开放范围内。</li>
                        </>
                      ) : (
                        <>
                          <li>Once connected: DM the bot with plain text; a typing indicator shows while working, and the result arrives as a new message.</li>
                          <li>Commands: /new for a fresh session, /list to list recent sessions, /use &lt;n&gt; to switch, /help for help.</li>
                          <li>P2P text messages only (no images/files yet); one WeChat account binds to one MPI instance.</li>
                          <li>This is Tencent's gray-release personal-WeChat bot channel: if scanning does nothing or reports unavailability, your account may not be in the rollout scope yet.</li>
                        </>
                      )}
                    </ol>
                  </details>
                </>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
