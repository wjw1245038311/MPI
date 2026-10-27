import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import type {
  CredentialInput,
  CredentialKind,
  CredentialLevel,
  CredentialScope,
  CredentialSummary,
} from "../lib/types";

/**
 * 设置 → 凭据（P1a）。
 *
 * 只做「存 / 管」：新增、改名、改等级、改作用域、删除，以及**遮蔽显示 / 复制明文**。
 * 值由主进程加密落盘（safeStorage → Windows DPAPI），列表接口永不返回值；
 * 只有「显示 / 复制」会调 `reveal()` 并留一条审计。
 *
 * 闸门（显示时要求 Windows Hello）尚未接入，见 docs/CREDENTIALS-VAULT.md §5：
 * 接入后这里只需在 reveal 之前多一步验证，UI 不用改。
 */

const KINDS: CredentialKind[] = ["password", "token", "passphrase", "ssh-key"];
const LEVELS: CredentialLevel[] = ["silent", "confirm", "local-only"];
/** 明文显示 15 秒后自动收起（避免定格在屏幕上）。 */
const REVEAL_TTL_MS = 15000;

type Draft = {
  id?: string;
  name: string;
  kind: CredentialKind;
  level: CredentialLevel;
  scopeType: CredentialScope["type"];
  scopeRoot: string;
  hint: string;
  value: string;
};

const emptyDraft = (): Draft => ({
  name: "",
  kind: "password",
  level: "confirm",
  scopeType: "global",
  scopeRoot: "",
  hint: "",
  value: "",
});

const kindLabel = (k: CredentialKind, zh: boolean): string => {
  if (zh) return { password: "密码", token: "令牌", passphrase: "私钥口令", "ssh-key": "SSH 私钥" }[k];
  return { password: "Password", token: "Token", passphrase: "Key passphrase", "ssh-key": "SSH key" }[k];
};

const levelLabel = (l: CredentialLevel, zh: boolean): string => {
  if (zh) return { silent: "远程直接用", confirm: "远程需确认", "local-only": "仅本机" }[l];
  return { silent: "Remote OK", confirm: "Remote: confirm", "local-only": "Local only" }[l];
};

const levelHint = (l: CredentialLevel, zh: boolean): string => {
  if (zh) {
    return {
      silent: "远程会话也能直接展开使用（如只读查询、最小权限账号）",
      confirm: "远程会话使用前需要在手机上确认一次（P2 实现）",
      "local-only": "任何远程来源一律拒绝，只能在本机使用",
    }[l];
  }
  return {
    silent: "Remote sessions may use it without asking (read-only / least-privilege accounts)",
    confirm: "Remote sessions must confirm once on the phone (lands in P2)",
    "local-only": "Refused for every remote origin; local use only",
  }[l];
};

export function CredentialsPanel() {
  const language = useStore((s) => s.config?.language || "en");
  const zh = language === "zh";
  const pushToast = useStore((s) => s.pushToast);

  const [items, setItems] = useState<CredentialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  /** 旧主进程没有 credentials 通道（改了主进程但只按了 Ctrl+R）：显式提示重启。 */
  const [needsRestart, setNeedsRestart] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState<{ id: string; value: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const errorText = useCallback(
    (res: { code: string; message: string }) => {
      if (res.code === "CRED_ENCRYPTION_UNAVAILABLE") {
        return zh ? "本机加密不可用，已拒绝保存（不会退化成明文）" : "Encryption unavailable on this machine; nothing was saved (no plaintext fallback)";
      }
      if (res.code === "CRED_NAME_TAKEN") return zh ? "名称已存在" : "Name already exists";
      if (res.code === "CRED_NAME_INVALID") return zh ? "名称只允许小写字母/数字/._-，2–64 位" : "Name allows lowercase letters/digits/._- only, 2–64 chars";
      if (res.code === "CRED_VALUE_EMPTY") return zh ? "值不能为空" : "Value cannot be empty";
      return res.message;
    },
    [zh],
  );

  const refresh = useCallback(async () => {
    const api = window.pi?.credentials;
    if (!api) {
      // 旧实例：preload 里还没有这套通道。不能静默失败，否则面板永远转圈。
      setNeedsRestart(true);
      setLoading(false);
      return;
    }
    const res = await api.list();
    if (res.ok) setItems(res.data);
    else pushToast("error", errorText(res));
    setLoading(false);
  }, [errorText, pushToast]);

  useEffect(() => {
    void refresh();
    return () => {
      if (revealTimer.current) clearTimeout(revealTimer.current);
    };
  }, [refresh]);

  const hide = useCallback(() => {
    if (revealTimer.current) clearTimeout(revealTimer.current);
    revealTimer.current = null;
    setRevealed(null);
  }, []);

  const onReveal = useCallback(
    async (id: string) => {
      if (revealed?.id === id) {
        hide();
        return;
      }
      const res = await window.pi.credentials.reveal(id);
      if (!res.ok) {
        pushToast("error", errorText(res));
        return;
      }
      setRevealed({ id, value: res.data.value });
      if (revealTimer.current) clearTimeout(revealTimer.current);
      revealTimer.current = setTimeout(() => setRevealed(null), REVEAL_TTL_MS);
      void refresh();
    },
    [errorText, hide, pushToast, refresh, revealed],
  );

  const onCopy = useCallback(
    async (id: string) => {
      const res = await window.pi.credentials.reveal(id);
      if (!res.ok) {
        pushToast("error", errorText(res));
        return;
      }
      try {
        await navigator.clipboard.writeText(res.data.value);
        pushToast("info", zh ? "已复制（15 秒后自动隐藏显示）" : "Copied (display auto-hides in 15s)");
      } catch {
        pushToast("error", zh ? "复制失败" : "Copy failed");
      }
      setRevealed({ id, value: res.data.value });
      if (revealTimer.current) clearTimeout(revealTimer.current);
      revealTimer.current = setTimeout(() => setRevealed(null), REVEAL_TTL_MS);
      void refresh();
    },
    [errorText, pushToast, refresh, zh],
  );

  const startCreate = () => setDraft(emptyDraft());

  const startEdit = (item: CredentialSummary) => {
    setDraft({
      id: item.id,
      name: item.name,
      kind: item.kind,
      level: item.level,
      scopeType: item.scope.type,
      scopeRoot: item.scope.type === "project" ? item.scope.root : "",
      hint: item.hint || "",
      value: "",
    });
  };

  const submit = async () => {
    if (!draft) return;
    if (!draft.id && !draft.value) {
      pushToast("error", zh ? "新增凭据需要填写值" : "A value is required when creating");
      return;
    }
    if (draft.scopeType === "project" && !draft.scopeRoot.trim()) {
      pushToast("error", zh ? "项目作用域需要填写项目根目录" : "Project scope needs a root path");
      return;
    }
    setSaving(true);
    const scope: CredentialScope = draft.scopeType === "project" ? { type: "project", root: draft.scopeRoot.trim() } : { type: "global" };
    try {
      if (draft.id) {
        const patch = {
          name: draft.name,
          kind: draft.kind,
          level: draft.level,
          scope,
          hint: draft.hint.trim() ? draft.hint.trim() : null,
          ...(draft.value ? { value: draft.value } : {}),
        };
        const res = await window.pi.credentials.update(draft.id, patch);
        if (!res.ok) {
          pushToast("error", errorText(res));
          return;
        }
        pushToast("info", zh ? "已更新" : "Updated");
      } else {
        const input: CredentialInput = {
          name: draft.name,
          kind: draft.kind,
          level: draft.level,
          scope,
          ...(draft.hint.trim() ? { hint: draft.hint.trim() } : {}),
          value: draft.value,
        };
        const res = await window.pi.credentials.create(input);
        if (!res.ok) {
          pushToast("error", errorText(res));
          return;
        }
        pushToast("info", zh ? "已保存到本机凭据库" : "Saved to the local vault");
      }
      setDraft(null);
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    const res = await window.pi.credentials.remove(id);
    if (!res.ok) {
      pushToast("error", errorText(res));
      return;
    }
    setConfirmDelete(null);
    hide();
    pushToast("info", zh ? "已删除" : "Deleted");
    await refresh();
  };

  const levelOrder = useMemo(() => LEVELS, []);

  if (needsRestart) {
    return (
      <div className="set-card">
        <h3>{zh ? "凭据库需要重启" : "Restart required"}</h3>
        <p className="set-hint">
          {zh
            ? "这次改动含主进程与 preload，Ctrl+R 不会加载它们。请用 scripts/restart-dev.sh 重启 dev（或重开 MPI）后再回来。"
            : "This change touches the main process and preload; Ctrl+R does not reload them. Restart dev (scripts/restart-dev.sh) or reopen MPI, then come back."}
        </p>
      </div>
    );
  }

  return (
    <div className="cred-panel">
      <div className="set-card">
        <div className="cred-head">
          <div>
            <h3>{zh ? "本机凭据库" : "Local credential vault"}</h3>
            <p className="set-hint">
              {zh
                ? "密码 / 令牌 / 私钥口令只存在本机，用系统加密（Windows DPAPI）落盘；AI 对话里只会看到引用名，永远拿不到值。手机与网页端不能查看或获取这些值。"
                : "Passwords, tokens and key passphrases stay on this machine, encrypted at rest with the OS keychain (Windows DPAPI). Conversations only ever see the reference name — never the value. Phones and the web client cannot read them."}
            </p>
          </div>
          <button className="set-btn" onClick={startCreate} disabled={!!draft}>
            {zh ? "新增凭据" : "Add credential"}
          </button>
        </div>

        {loading ? (
          <div className="ft-empty">{zh ? "加载中…" : "Loading…"}</div>
        ) : items.length === 0 && !draft ? (
          <div className="ft-empty">
            {zh ? "还没有凭据。新增后，AI 需要时可以按名称引用（{{secret:名字}}），值不会进入对话。" : "No credentials yet. Once added, the agent can reference one by name ({{secret:name}}) without the value ever entering the conversation."}
          </div>
        ) : null}

        {items.length > 0 && (
          <div className="cred-list">
            {items.map((item) => (
              <div className={`cred-row${revealed?.id === item.id ? " revealing" : ""}`} key={item.id}>
                <div className="cred-main">
                  <div className="cred-name">
                    <code>{`{{secret:${item.name}}}`}</code>
                    <span className={`cred-pill kind-${item.kind}`}>{kindLabel(item.kind, zh)}</span>
                    <span className={`cred-pill level-${item.level}`} title={levelHint(item.level, zh)}>
                      {levelLabel(item.level, zh)}
                    </span>
                    {item.scope.type === "project" && (
                      <span className="cred-pill scope" title={item.scope.root}>
                        {zh ? "项目" : "Project"}
                      </span>
                    )}
                  </div>
                  <div className="cred-meta">
                    {item.hint && <span>{item.hint}</span>}
                    <span className="cred-dot">·</span>
                    <span>
                      {item.useCount > 0
                        ? zh
                          ? `使用 ${item.useCount} 次`
                          : `used ${item.useCount}×`
                        : zh
                          ? "尚未使用"
                          : "never used"}
                    </span>
                    {item.lastUsedAt ? (
                      <>
                        <span className="cred-dot">·</span>
                        <span>{new Date(item.lastUsedAt).toLocaleString()}</span>
                      </>
                    ) : null}
                  </div>
                  {revealed?.id === item.id && (
                    <div className="cred-plain">
                      <code>{revealed.value}</code>
                      <span className="cred-plain-note">{zh ? `15 秒后自动隐藏` : "hides in 15s"}</span>
                    </div>
                  )}
                </div>
                <div className="cred-actions">
                  <button className="set-btn-sm" onClick={() => void onReveal(item.id)}>
                    {revealed?.id === item.id ? (zh ? "隐藏" : "Hide") : zh ? "显示" : "Show"}
                  </button>
                  <button className="set-btn-sm" onClick={() => void onCopy(item.id)}>
                    {zh ? "复制" : "Copy"}
                  </button>
                  <button className="set-btn-sm" onClick={() => startEdit(item)} disabled={!!draft}>
                    {zh ? "编辑" : "Edit"}
                  </button>
                  {confirmDelete === item.id ? (
                    <>
                      <button className="set-btn-sm danger" onClick={() => void remove(item.id)}>
                        {zh ? "确认删除" : "Confirm"}
                      </button>
                      <button className="set-btn-sm" onClick={() => setConfirmDelete(null)}>
                        {zh ? "取消" : "Cancel"}
                      </button>
                    </>
                  ) : (
                    <button className="set-btn-sm" onClick={() => setConfirmDelete(item.id)}>
                      {zh ? "删除" : "Delete"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {draft && (
        <div className="set-card cred-form">
          <h3>{draft.id ? (zh ? "编辑凭据" : "Edit credential") : zh ? "新增凭据" : "New credential"}</h3>
          <div className="cred-grid">
            <label>
              <span>{zh ? "名称（引用用）" : "Name (used for reference)"}</span>
              <input
                className="set-input"
                autoFocus
                value={draft.name}
                placeholder="aliyun-prod-root"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              <small>{`{{secret:${draft.name || "name"}}}`}</small>
            </label>
            <label>
              <span>{zh ? "类型" : "Kind"}</span>
              <select
                className="set-input"
                value={draft.kind}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value as CredentialKind })}
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {kindLabel(k, zh)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{zh ? "远程使用级别" : "Remote usage"}</span>
              <select
                className="set-input"
                value={draft.level}
                onChange={(e) => setDraft({ ...draft, level: e.target.value as CredentialLevel })}
              >
                {levelOrder.map((l) => (
                  <option key={l} value={l}>
                    {levelLabel(l, zh)}
                  </option>
                ))}
              </select>
              <small>{levelHint(draft.level, zh)}</small>
            </label>
            <label>
              <span>{zh ? "作用域" : "Scope"}</span>
              <select
                className="set-input"
                value={draft.scopeType}
                onChange={(e) => setDraft({ ...draft, scopeType: e.target.value as CredentialScope["type"] })}
              >
                <option value="global">{zh ? "全局" : "Global"}</option>
                <option value="project">{zh ? "仅本项目" : "This project"}</option>
              </select>
            </label>
            {draft.scopeType === "project" && (
              <label className="cred-span">
                <span>{zh ? "项目根目录" : "Project root"}</span>
                <input
                  className="set-input"
                  value={draft.scopeRoot}
                  placeholder="E:/MyWorkspace/Project/MPI"
                  onChange={(e) => setDraft({ ...draft, scopeRoot: e.target.value })}
                />
              </label>
            )}
            <label className="cred-span">
              <span>{zh ? "用途说明（不要写值）" : "What it is for (never the value)"}</span>
              <input
                className="set-input"
                value={draft.hint}
                placeholder={zh ? "阿里云部署机，仅 sudo 用" : "Deploy box, sudo only"}
                onChange={(e) => setDraft({ ...draft, hint: e.target.value })}
              />
            </label>
            <label className="cred-span">
              <span>{draft.id ? (zh ? "新值（留空则不修改）" : "New value (blank keeps current)") : zh ? "值" : "Value"}</span>
              <input
                className="set-input"
                type="password"
                autoComplete="off"
                value={draft.value}
                onChange={(e) => setDraft({ ...draft, value: e.target.value })}
              />
              <small>{zh ? "保存后只显示掩码；查看需要经过验证（P2 接入 Windows Hello）。" : "Stored encrypted; viewing will require verification once Windows Hello gating lands (P2)."}</small>
            </label>
          </div>
          <div className="cred-form-actions">
            <button className="set-btn primary" onClick={() => void submit()} disabled={saving}>
              {saving ? <span className="spinner" /> : draft.id ? (zh ? "保存修改" : "Save changes") : zh ? "保存" : "Save"}
            </button>
            <button className="set-btn" onClick={() => setDraft(null)} disabled={saving}>
              {zh ? "取消" : "Cancel"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
