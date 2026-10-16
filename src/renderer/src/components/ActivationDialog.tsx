/**
 * 「激活授权」小窗（2026-10-16 定稿，照用户给的参考界面）。
 *
 * 参考图里那套字段我们照抄，但去掉没有对应概念的东西（离线激活码 / 立即购买 / 找回激活码）：
 *   设备标识（本机 hostId，可复制）· 设备名称（机器名，可复制）· 粘贴激活码 ·
 *   激活状态（含设备名额用量）· [立即激活] [解除绑定] [验证连通性]
 *
 * 为什么要展示设备标识：服务端按 **hostId** 记账（一个激活码最多 3 台），
 * 你把标识复制给我/贴到服务器侧就能对上具体是哪台机器；「解除绑定」让换机/重装不用手工改服务器文件。
 */
import { useEffect, useState } from "react";
import { useStore } from "../store";
import { Close, Shield } from "./icons";
import { verifyErrorText } from "./ServerPanel";

interface ActivationState {
  ok: boolean;
  error?: string;
  hostId: string;
  name: string;
  authorized: boolean;
  server: string | null;
  customRelay: boolean;
  open?: boolean;
  activated?: boolean;
  devices?: number;
  maxDevices?: number;
  enforcing?: boolean;
}

export function ActivationDialog({ language, onClose }: { language: "en" | "zh"; onClose: () => void }) {
  const zh = language === "zh";
  const pushToast = useStore((s) => s.pushToast);
  const [state, setState] = useState<ActivationState | null>(null);
  const [codeDraft, setCodeDraft] = useState("");
  const [busy, setBusy] = useState<"" | "load" | "activate" | "deactivate" | "verify">("load");

  const load = async () => {
    setBusy("load");
    try {
      setState((await window.pi.remote.activationState()) as ActivationState);
    } catch {
      setState(null);
    } finally {
      setBusy("");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      pushToast("success", zh ? `${label}已复制` : `${label} copied`);
    } catch {
      pushToast("error", zh ? "复制失败" : "Copy failed");
    }
  };

  const activate = async () => {
    const code = codeDraft.trim() || undefined;
    setBusy("activate");
    try {
      const result: any = await window.pi.remote.activate(code ?? "");
      if (!result?.ok) {
        pushToast("error", verifyErrorText(result?.error, zh));
        setState((prev) => (prev ? { ...prev, error: result?.error } : prev));
        return;
      }
      setCodeDraft("");
      await load();
      pushToast("success", zh ? "已激活：转发与更新都走内置服务器" : "Activated: forwarding and updates now use the built-in server");
    } finally {
      setBusy("");
    }
  };

  const deactivate = async () => {
    setBusy("deactivate");
    try {
      const result: any = await window.pi.remote.deactivate();
      if (!result?.ok) {
        pushToast("error", verifyErrorText(result?.error, zh));
        return;
      }
      await load();
      pushToast(
        "info",
        result.removed
          ? zh
            ? "已解除绑定（名额已释放）"
            : "Unbound (quota released)"
          : zh
            ? "本机本来就没绑定"
            : "This machine was not bound",
      );
    } finally {
      setBusy("");
    }
  };

  const verify = async () => {
    setBusy("verify");
    try {
      const result: any = await window.pi.remote.testServer();
      pushToast(result?.ok ? "success" : "error", result?.ok ? (zh ? "服务器可达且激活码有效" : "Server reachable, code accepted") : verifyErrorText(result?.error, zh));
      await load();
    } finally {
      setBusy("");
    }
  };

  const activated = Boolean(state?.activated ?? state?.open);
  const quota = state?.maxDevices ? `${state.devices ?? 0}/${state.maxDevices}` : "—";

  return (
    <div className="settings-backdrop" onMouseDown={onClose}>
      <div
        className="set-modal"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{ width: "min(560px, 94vw)" }}
      >
        <section className="set-main">
          <header className="set-head">
            <h2>
              <Shield size={16} style={{ verticalAlign: "-3px", marginRight: 8 }} />
              {zh ? "激活授权" : "Activation"}
            </h2>
            <button className="set-iconbtn" onClick={onClose} aria-label={zh ? "关闭" : "Close"}>
              <Close size={14} />
            </button>
          </header>
          <div className="set-body">
            {/* 设备标识/名称都是**系统自动获取**的：标识 = 本机 id（随安装目录持久化），
                名称 = 系统机器名。这里只展示 + 复制，不做输入（用户反馈：看着像要自己填）。 */}
            <div className="set-row wide">
              <label className="set-label">{zh ? "设备标识" : "Device ID"}</label>
              <div className="set-control">
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <code style={{ flex: "1 1 auto", wordBreak: "break-all", fontSize: 13 }}>{busy === "load" ? "…" : state?.hostId || "—"}</code>
                  <button
                    type="button"
                    className="set-btn ghost"
                    onClick={() => void copy(state?.hostId || "", zh ? "设备标识" : "Device ID")}
                    disabled={!state?.hostId}
                  >
                    {zh ? "复制" : "Copy"}
                  </button>
                </div>
                <div className="set-hint">
                  {zh
                    ? "由本机自动生成，无需填写。服务器依据它区分不同设备；每个激活码最多绑定三台。"
                    : "Generated automatically on this machine. The server uses it to distinguish devices; each access code binds at most three."}
                </div>
              </div>
            </div>
            <div className="set-row wide">
              <label className="set-label">{zh ? "设备名称" : "Device name"}</label>
              <div className="set-control">
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <code style={{ flex: "1 1 auto", wordBreak: "break-all", fontSize: 13 }}>{state?.name || "—"}</code>
                  <button type="button" className="set-btn ghost" onClick={() => void copy(state?.name || "", zh ? "设备名称" : "Device name")} disabled={!state?.name}>
                    {zh ? "复制" : "Copy"}
                  </button>
                </div>
                <div className="set-hint">
                  {zh
                    ? "取自系统主机名，仅用于在服务器端辨认本机，不影响功能。"
                    : "Taken from the OS hostname; used only to identify this machine server-side."}
                </div>
              </div>
            </div>

            <label className="set-addprov-field wide" style={{ marginTop: 6 }}>
              <span>{zh ? "激活码" : "Access code"}</span>
              <textarea
                className="set-input"
                rows={3}
                value={codeDraft}
                onChange={(e) => setCodeDraft(e.target.value)}
                placeholder={
                  state?.authorized
                    ? zh
                      ? "已设置；粘贴新码可替换"
                      : "set; paste a new one to replace"
                    : zh
                      ? "粘贴激活码（Ctrl+V）"
                      : "Paste the access code (Ctrl+V)"
                }
                spellCheck={false}
              />
            </label>

            <div className="set-hint">
              {zh ? "激活状态：" : "Status: "}
              <strong>
                {busy === "load"
                  ? "…"
                  : state?.ok === false
                    ? verifyErrorText(state.error, zh)
                    : state?.open
                      ? zh
                        ? "该服务器未启用激活码校验"
                        : "This server has no access-code check"
                      : activated
                        ? zh
                          ? "已激活"
                          : "Activated"
                        : zh
                          ? "未激活（本机尚未登记）"
                          : "Not activated (this machine is not registered)"}
              </strong>
            </div>
            {state?.enforcing ? (
              <div className="set-hint">
                {zh ? "设备名额：" : "Device quota: "}
                <strong>{quota}</strong>
                {zh ? "（一个激活码最多三台）" : " (up to three per code)"}
              </div>
            ) : null}

            <div className="set-diag-btns" style={{ marginTop: 10 }}>
              <button className="set-btn primary" onClick={() => void activate()} disabled={!!busy}>
                {busy === "activate" ? (zh ? "激活中…" : "Activating…") : zh ? "立即激活" : "Activate"}
              </button>
              <button className="set-btn ghost" onClick={() => void verify()} disabled={!!busy}>
                {busy === "verify" ? (zh ? "验证中…" : "Testing…") : zh ? "验证连通性" : "Test connection"}
              </button>
              <button className="set-btn ghost" onClick={() => void deactivate()} disabled={!!busy || !state?.authorized}>
                {busy === "deactivate" ? (zh ? "解除中…" : "Unbinding…") : zh ? "解除绑定" : "Unbind"}
              </button>
            </div>
            <div className="set-hint">
              {zh
                ? "解除绑定仅解除服务器端的设备登记并释放名额，不影响本机任何设置；需要时重新激活即可再次绑定。"
                : "Unbinding only clears the device registration on the server and releases the slot; no local setting is affected, and you can bind again by activating anew."}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
