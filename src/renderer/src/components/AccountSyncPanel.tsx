import { useEffect, useState } from "react";

/**
 * 设置 → 账号：桌面端的「登录 + 配置同步」（与手机端同一套服务器协议）。
 *
 * 为什么桌面需要它：桌面是**主机**，身份文件（hostId + 私钥 + 已配对设备）丢了，所有手机
 * 都得重新扫码。登录后把这份身份加密同步走，换电脑/重装时登录同一账号即可恢复。
 *
 * 界面只做三件事：登录/注册、立即同步、退出；错误一律原样显示（来自主进程的中文文案）。
 */
type AccountStatus = {
  loggedIn: boolean;
  identifier: string | null;
  lastSyncAt: number | null;
  revision: number;
  base?: string | null;
};

export function AccountSyncPanel({ language }: { language: "zh" | "en" }) {
  const zh = language === "zh";
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const next = (await window.pi.account.status()) as AccountStatus;
      setStatus(next);
      if (next.identifier) setIdentifier(next.identifier);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const run = async (fn: () => Promise<{ lastSyncAt?: number | null; restored?: boolean }>, okText: string) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const result = await fn();
      setStatus((current) => ({ ...(current || { loggedIn: true, identifier, lastSyncAt: null, revision: 0 }), loggedIn: true, lastSyncAt: result.lastSyncAt ?? Date.now() }));
      setPassword("");
      setInfo(
        result.restored
          ? zh
            ? `${okText}，并恢复了这台机器的主机身份——**重启 MPI 后生效**（手机端不用重新配对）`
            : `${okText}; host identity restored — restart MPI to take effect`
          : okText,
      );
      void refresh();
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const lastSync = status?.lastSyncAt
    ? new Date(status.lastSyncAt).toLocaleString(zh ? "zh-CN" : "en-US", { hour12: false })
    : null;

  return (
    <div className="set-section">
      <h3 className="set-section-title">{zh ? "账号与配置同步" : "Account & config sync"}</h3>
      <p className="set-hint">
        {zh
          ? "登录后把「主机身份（hostId / 私钥 / 已配对设备）+ 语言与主题」加密同步到你的账号。换电脑或重装 MPI 后，登录同一账号即可恢复——手机端不用重新扫码。服务器只保存密文，解密密钥由密码在本机派生。"
          : "Sign in to sync this host's identity (hostId / private key / paired devices) plus language & theme. After reinstalling or moving to a new machine, sign in again to restore — phones do not need to re-pair. The server only stores ciphertext; the key is derived locally from your password."}
      </p>

      {status?.loggedIn ? (
        <div className="set-row">
          <div className="set-row-main">
            <div className="set-row-title">
              {zh ? "已登录" : "Signed in"}：{status.identifier}
            </div>
            <div className="set-row-sub">
              {lastSync
                ? zh
                  ? `上次同步：${lastSync}`
                  : `Last sync: ${lastSync}`
                : zh
                  ? "尚未同步"
                  : "Not synced yet"}
              {status.base ? ` · ${status.base}` : ""}
            </div>
          </div>
          <div className="set-row-actions">
            <button
              className="set-btn"
              disabled={busy}
              onClick={() => void run(() => window.pi.account.sync(), zh ? "已同步" : "Synced")}
            >
              {busy ? (zh ? "同步中…" : "Syncing…") : zh ? "立即同步" : "Sync now"}
            </button>
            <button
              className="set-btn ghost"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await window.pi.account.signOut();
                  setStatus({ loggedIn: false, identifier: null, lastSyncAt: null, revision: 0 });
                  return {};
                }, zh ? "已退出账号（配对未删除）" : "Signed out (pairings kept)")
              }
            >
              {zh ? "退出登录" : "Sign out"}
            </button>
          </div>
        </div>
      ) : (
        <div className="set-field-grid">
          <label className="set-field">
            <span>{zh ? "手机号或邮箱" : "Phone or email"}</span>
            <input
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder={zh ? "138… 或 name@example.com" : "138… or name@example.com"}
              autoComplete="username"
            />
          </label>
          <label className="set-field">
            <span>{zh ? "密码（至少 8 位）" : "Password (8+ chars)"}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          <div className="set-row-actions">
            <button
              className="set-btn"
              disabled={busy || !identifier.trim() || password.length < 8}
              onClick={() =>
                void run(
                  () => window.pi.account.signIn({ identifier, password, register: false }),
                  zh ? "已登录并完成首次同步" : "Signed in and synced",
                )
              }
            >
              {zh ? "登录" : "Sign in"}
            </button>
            <button
              className="set-btn ghost"
              disabled={busy || !identifier.trim() || password.length < 8}
              onClick={() =>
                void run(
                  () => window.pi.account.signIn({ identifier, password, register: true }),
                  zh ? "已注册并完成首次同步" : "Registered and synced",
                )
              }
            >
              {zh ? "注册" : "Register"}
            </button>
          </div>
        </div>
      )}

      {error && <div className="set-error">{error}</div>}
      {info && <div className="set-hint">{info}</div>}
    </div>
  );
}
