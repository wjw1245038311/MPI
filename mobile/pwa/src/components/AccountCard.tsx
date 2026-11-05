import { useEffect, useState } from "react";
import type { KeyStore, PairingRecord } from "../lib/keystore";
import {
  accountBasesOf,
  accountSendCode,
  accountSignIn,
  deriveAccountKey,
  loadAccountState,
  saveAccountState,
  syncAccount,
  withAccountBase,
  type AccountSessionState,
} from "../lib/account-sync";
import { b64FromBytes } from "../lib/b64";

/**
 * 网页版的「账号同步」卡片（设备抽屉里）。
 *
 * 与手机/桌面同一套协议：登录后把主机配对清单 + 删除墓碑加密同步到账号，
 * 换设备或清了站点数据后登录即可恢复。密码只在本机派生密钥，服务器只见密文。
 */
export function AccountCard({
  store,
  pairings,
  onSynced,
}: {
  store: KeyStore;
  pairings: PairingRecord[];
  onSynced?: () => void;
}) {
  const [state, setState] = useState<AccountSessionState | null>(() => loadAccountState());
  const [identifier, setIdentifier] = useState(state?.identifier || "");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"password" | "code">("password");
  const [code, setCode] = useState("");
  const [syncPassword, setSyncPassword] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    setIdentifier((current) => current || state?.identifier || "");
  }, [state?.identifier]);

  /** 中继候选 → 账号基地址（只认 wss，公网优先）。 */
  const bases = () => {
    const candidates: string[] = [];
    for (const pairing of pairings) {
      candidates.push(pairing.relayUrl, ...(pairing.relayUrls || []));
      if (pairing.lastGoodRelayUrl) candidates.push(pairing.lastGoodRelayUrl);
    }
    return accountBasesOf(candidates.filter(Boolean));
  };

  const run = async (fn: () => Promise<void>, okText: string) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await fn();
      setInfo(okText);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const signIn = (register: boolean) =>
    run(async () => {
      const targets = bases();
      if (!targets.length) throw new Error("当前没有可用的 TLS 中继地址（先连接一台主机）");
      const viaCode = mode === "code";
      const keySecret = viaCode ? syncPassword : password;
      if (keySecret.length < 8) throw new Error(viaCode ? "同步密码至少 8 位" : "密码至少 8 位");
      const session = await withAccountBase(targets, (base) =>
        accountSignIn(base, {
          identifier,
          register,
          ...(viaCode ? { code } : { password }),
        }),
      );
      const key = await deriveAccountKey(keySecret, session.kdfSalt);
      const base = await withAccountBase(targets, async (candidate) => candidate);
      const next: AccountSessionState = {
        identifier,
        accountId: session.accountId,
        kdfSalt: session.kdfSalt,
        token: session.token,
        exp: session.exp,
        keyB64: b64FromBytes(key),
        lastSyncAt: 0,
        revision: 0,
        base,
        tombstones: [],
      };
      const synced = await syncAccount(store, next);
      saveAccountState(synced.state);
      setState(synced.state);
      setPassword("");
      setCode("");
      onSynced?.();
    }, "已登录并完成同步");

  const syncNow = () =>
    run(async () => {
      if (!state) throw new Error("尚未登录账号");
      const synced = await syncAccount(store, state);
      setState(synced.state);
      onSynced?.();
    }, "已同步");

  const signOut = () =>
    run(async () => {
      saveAccountState(null);
      setState(null);
    }, "已退出账号（配对未删除）");

  const lastSync = state?.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString() : null;

  return (
    <div className="account-card">
      <div className="account-card-head">
        <strong>账号同步</strong>
        {state && <span className="hint">{state.identifier}</span>}
      </div>

      {state ? (
        <>
          <p className="hint">
            {lastSync ? `上次同步：${lastSync}` : "尚未同步"} · 同步内容：主机配对清单 + 删除记录
          </p>
          <div className="account-card-actions">
            <button type="button" disabled={busy} onClick={() => void syncNow()}>
              {busy ? "同步中…" : "立即同步"}
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={() => void signOut()}>
              退出登录
            </button>
          </div>
        </>
      ) : (
        <>
          <input
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="手机号或邮箱"
            autoComplete="username"
          />
          <div className="account-card-actions">
            <button type="button" className={mode === "password" ? "" : "ghost"} onClick={() => setMode("password")}>
              密码
            </button>
            <button type="button" className={mode === "code" ? "" : "ghost"} onClick={() => setMode("code")}>
              验证码
            </button>
          </div>
          {mode === "password" ? (
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="密码（至少 8 位）"
              autoComplete="current-password"
            />
          ) : (
            <>
              <div className="account-card-actions">
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="6 位验证码"
                  inputMode="numeric"
                />
                <button
                  type="button"
                  className="ghost"
                  disabled={!identifier.trim()}
                  onClick={() =>
                    void run(async () => {
                      const targets = bases();
                      if (!targets.length) throw new Error("当前没有可用的 TLS 中继地址");
                      const devCode = await withAccountBase(targets, (base) => accountSendCode(base, identifier));
                      setCodeSent(true);
                      setInfo(devCode ? `已发送（自测码：${devCode}）` : "验证码已发到手机");
                    }, "")
                  }
                >
                  {codeSent ? "重新发送" : "发送"}
                </button>
              </div>
              <input
                type="password"
                value={syncPassword}
                onChange={(e) => setSyncPassword(e.target.value)}
                placeholder="同步密码（8 位以上，用于加密同步包）"
              />
            </>
          )}
          <div className="account-card-actions">
            <button
              type="button"
              disabled={busy || !identifier.trim() || (mode === "code" ? code.length !== 6 || syncPassword.length < 8 : password.length < 8)}
              onClick={() => void signIn(false)}
            >
              登录
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy || !identifier.trim() || (mode === "code" ? code.length !== 6 || syncPassword.length < 8 : password.length < 8)}
              onClick={() => void signIn(true)}
            >
              注册
            </button>
          </div>
        </>
      )}

      {error && <p className="account-card-error">{error}</p>}
      {info && <p className="hint">{info}</p>}
    </div>
  );
}
