/**
 * 项目记忆面板（L2）——知芽面板的「项目记忆」分页
 *
 * 和「记忆池」的区别（这是本组件的存在理由）：
 *   记忆池 = 流水（1837 条原始记录），粒度是「一句话」，用途是原料；
 *   项目记忆 = 成品（每项目十几条规矩），粒度是「一次操作」，用途是进系统提示词。
 *
 * 设计取舍：
 * - **挖簇必须显式点**：它跑 embedding（全池 12~20s），不能让面板一打开就卡。
 * - 草稿正文是抽取式的（机器只负责发现「这事写过很多遍」），所以这里编辑器是主角 ——
 *   人工润色后 `edited=true`，再挖簇不会覆盖。
 * - 每条都带证据（条数 / 时间跨度 / 最近一次），用户可以随时怀疑并点开验证。
 */
import { useCallback, useEffect, useState } from "react";
import { useStore } from "../store";
import { Close, Refresh, Sprout } from "./icons";

interface RuleView {
  id: string;
  root: string;
  project: string;
  topic: string;
  title: string;
  body: string;
  sources: string[];
  evidenceCount: number;
  firstAt: string;
  lastAt: string;
  status: "draft" | "approved" | "muted";
  targetRel: string;
  edited: boolean;
  updatedAt: string;
}

interface GroupView {
  root: string;
  project: string;
  rules: RuleView[];
  pending: number;
  approved: number;
  targetRel: string;
  targetExists: boolean;
  poolCount: number;
}

interface Snapshot {
  groups: GroupView[];
  stats: {
    total: number;
    draft: number;
    approved: number;
    muted: number;
    groups: number;
    candidates: number;
    lastDigest: { at: string; rules: number; clusters: number; dropped: number; embedError?: string } | null;
  };
  broken: { path: string; reason: string }[];
  poolDir: string;
}

const TOPIC_LABEL: Record<string, [string, string]> = {
  restart: ["改动生效 / 重启", "Restart"],
  "test-scope": ["测试范围", "Test scope"],
  release: ["发版分发", "Release"],
  "shell-env": ["执行环境", "Shell"],
  network: ["网络 / 超时", "Network"],
  image: ["图片 / 附件", "Images"],
  ipc: ["IPC / preload", "IPC"],
  memory: ["记忆池", "Memory"],
  package: ["打包", "Packaging"],
  git: ["提交 / 推送", "Git"],
  mobile: ["手机端", "Mobile"],
  remote: ["远程 / PWA", "Remote"],
  model: ["模型 / 供应商", "Models"],
  context: ["会话 / 上下文", "Context"],
  ui: ["界面 / 面板", "UI"],
  kb: ["知识库 / 文档", "Docs"],
};

const ago = (iso: string, zh: boolean): string => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return zh ? "刚刚" : "just now";
  if (m < 60) return zh ? `${m} 分钟前` : `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return zh ? `${h} 小时前` : `${h}h ago`;
  return zh ? `${Math.round(h / 24)} 天前` : `${Math.round(h / 24)}d ago`;
};

const day = (iso: string): string => (iso || "").slice(0, 10);

export function ProjectMemoryTab({ zh }: { zh: boolean }) {
  const pushToast = useStore((s) => s.pushToast);
  const askConfirm = useStore((s) => s.askConfirm);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [digesting, setDigesting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** 正在编辑的规则 id（同一时刻只编辑一条，避免多份未保存草稿） */
  const [editing, setEditing] = useState<{ id: string; title: string; body: string } | null>(null);
  /** 展开看证据的规则 id */
  const [openEvidence, setOpenEvidence] = useState<string | null>(null);
  /** 折叠的项目组（默认全展开） */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const s = (await window.pi.memory.projectSnapshot()) as Snapshot | null;
      if (!s) {
        setErr(zh ? "主进程没返回数据（终端 pi 或未起端点时不支持面板）" : "No data from main process");
        setSnap(null);
      } else {
        setSnap(s);
        setErr(null);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [zh]);

  useEffect(() => {
    void load();
  }, [load]);

  const toast = (ok: boolean, msg: string) => pushToast(ok ? "success" : "error", msg);

  const digest = async () => {
    setDigesting(true);
    try {
      const r = await window.pi.memory.projectDigest();
      toast(r.ok, r.detail);
      await load();
    } catch (e) {
      toast(false, (e as Error).message);
    } finally {
      setDigesting(false);
    }
  };

  const patch = async (id: string, p: Parameters<typeof window.pi.memory.projectUpdate>[1]) => {
    const r = await window.pi.memory.projectUpdate(id, p);
    if (!r.ok) toast(false, r.detail);
    await load();
    return r.ok;
  };

  const saveEdit = async () => {
    if (!editing) return;
    const ok = await patch(editing.id, { title: editing.title, body: editing.body });
    if (ok) {
      toast(true, zh ? "已保存（重新挖簇不会覆盖你改过的正文）" : "Saved (digest won't overwrite your edits)");
      setEditing(null);
    }
  };

  const drop = (r: RuleView) => {
    askConfirm({
      title: zh ? "丢弃这条经验？" : "Discard this rule?",
      body: zh
        ? `「${r.title}」的规则文件会被删除（原始记录仍在池子里，重新挖簇能再挖出来）。`
        : `The rule file will be deleted (raw entries stay in the pool).`,
      confirmLabel: zh ? "丢弃" : "Discard",
      danger: true,
      onConfirm: async () => {
        const res = await window.pi.memory.projectDelete(r.id);
        toast(res.ok, res.detail);
        await load();
      },
    });
  };

  const toggleGroup = (root: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });
  };

  const stat = snap?.stats;

  return (
    <div className="mempool">
      <div className="mempool-actions">
        <button className="set-btn" onClick={digest} disabled={digesting || busy} title={zh ? "扫描池子，把反复出现的经验聚成草稿" : "Scan the pool and cluster repeated lessons"}>
          <Sprout size={13} /> {digesting ? (zh ? "挖簇中…" : "Digesting…") : zh ? "挖簇" : "Digest"}
        </button>
        <button className="set-btn ghost" onClick={() => void load()} disabled={busy || digesting}>
          <Refresh size={13} /> {zh ? "刷新" : "Refresh"}
        </button>
      </div>

      {err && <div className="mempool-warn">{err}</div>}

      {stat && (
        <div className="mempool-stats">
          <span>
            {zh ? "经验" : "Rules"} <b>{stat.total}</b>
          </span>
          <span>
            {zh ? "待审" : "Draft"} <b>{stat.draft}</b>
          </span>
          <span>
            {zh ? "已批准" : "Approved"} <em>{stat.approved}</em>
          </span>
          {stat.muted > 0 && (
            <span>
              {zh ? "已停用" : "Muted"} <b>{stat.muted}</b>
            </span>
          )}
          <span>
            {zh ? "可挖原料" : "Raw"} <b>{stat.candidates}</b>
          </span>
          {stat.lastDigest && (
            <span title={stat.lastDigest.embedError ? `embedding 降级：${stat.lastDigest.embedError}` : undefined}>
              {zh ? "上次挖簇" : "Last digest"} {ago(stat.lastDigest.at, zh)}
            </span>
          )}
        </div>
      )}

      {snap && !snap.groups.length && (
        <div className="zhiya-empty">
          {busy
            ? zh ? "读取中…" : "Loading…"
            : zh
              ? "还没有项目经验。点上面的「挖簇」：它会扫描记忆池里反复出现的坑，按项目聚成草稿，你审一遍再批准。"
              : "No project rules yet. Hit Digest to cluster repeated lessons into drafts."}
        </div>
      )}

      <div className="mempool-list">
        {snap?.groups.map((g) => {
          const key = g.root || `project:${g.project}`;
          const isCollapsed = collapsed.has(key);
          return (
            <div key={key} className="pmem-group">
              <button className="pmem-group-head" onClick={() => toggleGroup(key)}>
                <span className="pmem-caret">{isCollapsed ? "▸" : "▾"}</span>
                <span className="pmem-group-name">{g.project || (zh ? "未绑定项目" : "Unbound")}</span>
                <span className="pmem-group-count">
                  {zh ? `${g.rules.length} 条经验` : `${g.rules.length} rules`}
                  {g.pending > 0 && ` · ${zh ? `${g.pending} 待审` : `${g.pending} draft`}`}
                </span>
              </button>
              <div className="pmem-group-meta">
                <span className="pmem-root" title={g.root}>{g.root || (zh ? "（无项目根，只按项目名归组）" : "(no root)")}</span>
                <span className="mempool-badge">
                  {zh ? "注入 →" : "inject →"} {g.targetRel}
                  {g.root ? (g.targetExists ? (zh ? "（已存在）" : " (exists)") : zh ? "（将新建）" : " (will create)") : ""}
                </span>
                <span className="mempool-badge">{zh ? `池内 ${g.poolCount} 条` : `${g.poolCount} raw`}</span>
              </div>

              {!isCollapsed &&
                g.rules.map((r) => {
                  const isEditing = editing?.id === r.id;
                  const badge =
                    r.status === "approved"
                      ? zh ? "已批准" : "Approved"
                      : r.status === "muted"
                        ? zh ? "已停用" : "Muted"
                        : zh ? "草稿" : "Draft";
                  const topicLabel = TOPIC_LABEL[r.topic]?.[zh ? 0 : 1] ?? r.topic;
                  return (
                    <div key={r.id} className={`pmem-rule ${r.status}`}>
                      <div className="pmem-rule-head">
                        <span className={`pmem-state ${r.status}`}>{badge}</span>
                        <span className="mempool-badge">{topicLabel}</span>
                        {r.edited && <span className="mempool-badge">{zh ? "已润色" : "edited"}</span>}
                        <span className="pmem-rule-evidence">
                          {zh
                            ? `证据 ${r.evidenceCount} 条 · ${day(r.firstAt)} ~ ${day(r.lastAt)}`
                            : `${r.evidenceCount} evidence · ${day(r.firstAt)} ~ ${day(r.lastAt)}`}
                        </span>
                      </div>

                      {isEditing ? (
                        <div className="pmem-edit">
                          <input
                            className="set-input"
                            value={editing.title}
                            onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                            placeholder={zh ? "一句话规矩（建议写成祈使句）" : "One-line rule"}
                          />
                          <textarea
                            className="set-input pmem-textarea"
                            value={editing.body}
                            rows={5}
                            onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                            placeholder={zh ? "要点 / 命令 / 为什么" : "Details, commands, reasons"}
                          />
                          <div className="pmem-rule-btns">
                            <button className="set-btn" onClick={saveEdit}>
                              {zh ? "保存" : "Save"}
                            </button>
                            <button className="set-btn ghost" onClick={() => setEditing(null)}>
                              {zh ? "取消" : "Cancel"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="pmem-rule-title">{r.title}</div>
                          <div className="pmem-rule-body">{r.body}</div>
                        </>
                      )}

                      {!isEditing && (
                        <div className="pmem-rule-btns">
                          {r.status !== "approved" && (
                            <button
                              className="set-btn"
                              onClick={() => void patch(r.id, { status: "approved" })}
                              title={zh ? "批准后这条会进项目 AGENTS.md 的常驻块" : "Approve → goes into AGENTS.md"}
                            >
                              {zh ? "批准" : "Approve"}
                            </button>
                          )}
                          {r.status === "approved" && (
                            <button className="set-btn ghost" onClick={() => void patch(r.id, { status: "muted" })}>
                              {zh ? "停用" : "Mute"}
                            </button>
                          )}
                          {r.status === "muted" && (
                            <button className="set-btn ghost" onClick={() => void patch(r.id, { status: "approved" })}>
                              {zh ? "重新启用" : "Re-enable"}
                            </button>
                          )}
                          <button
                            className="set-btn ghost"
                            onClick={() => setEditing({ id: r.id, title: r.title, body: r.body })}
                          >
                            {zh ? "润色" : "Edit"}
                          </button>
                          <button
                            className="set-btn ghost"
                            onClick={() => setOpenEvidence(openEvidence === r.id ? null : r.id)}
                            disabled={!r.sources.length}
                          >
                            {openEvidence === r.id ? (zh ? "收起证据" : "Hide") : zh ? `看证据 ${r.sources.length}` : `${r.sources.length} evidence`}
                          </button>
                          {r.status !== "approved" && (
                            <button className="set-btn ghost" onClick={() => drop(r)}>
                              <Close size={12} /> {zh ? "丢弃" : "Discard"}
                            </button>
                          )}
                          <span className="pmem-updated">{zh ? "更新" : "updated"} {ago(r.updatedAt, zh)}</span>
                        </div>
                      )}

                      {openEvidence === r.id && (
                        <div className="pmem-evidence">
                          <div className="mempool-sub">{zh ? "支撑这条规则的原始记录" : "Source entries"}</div>
                          <ul>
                            {r.sources.slice(0, 12).map((id) => (
                              <li key={id} className="pmem-src">{id}</li>
                            ))}
                          </ul>
                          {r.sources.length > 12 && (
                            <div className="pmem-more">
                              {zh ? `…共 ${r.sources.length} 条（超出部分只计数，不落盘）` : `…${r.sources.length} total`}
                            </div>
                          )}
                          <div className="pmem-more">
                            {zh
                              ? "在「记忆池」分页用这些 id 搜正文；确认措辞是不是你想让 agent 每次都读到的。"
                              : "Search these ids in the Memory pool tab to read the originals."}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>

      {snap?.broken.length ? (
        <div className="mempool-warn">
          {zh ? "无法解析的规则文件：" : "Unreadable rule files:"}
          <ul>
            {snap.broken.map((b) => (
              <li key={b.path}>
                {b.path} — {b.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
