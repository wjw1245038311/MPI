/**
 * 记忆池面板（P4）——知芽面板的「记忆池」分页
 *
 * 设计取舍：
 * - 一次拉全量快照（条目 + 提案 + 统计），**过滤/排序在本地做**：面板里点来点去不该每次都往返主进程。
 * - 破坏性操作（归档）二次确认；提案的批准/拒绝沿用同一条执行路径（与命令行、扩展命令完全一致）。
 * - 主进程不可用（终端 pi / 未起端点）时页面自己说明原因，而不是空着让人猜。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { Close, Refresh, Sprout } from "./icons";

interface EntryView {
  id: string;
  createdAt: string;
  type: string;
  temporal: string;
  importance: number;
  recurrence: number;
  project: string;
  status: string;
  promotedTo: string | null;
  tags: string[];
  summary: string;
  length: number;
  evidenceCount: number;
  recurrenceCount: number;
  warnings: string[];
  path: string | null;
}

interface ProposalView {
  id: string;
  kind: string;
  status: string;
  title: string;
  reason: string;
  target: string | null;
  entries: string[];
  result: string | null;
}

interface Snapshot {
  entries: EntryView[];
  proposals: ProposalView[];
  broken: { path: string; reason: string }[];
  stats: {
    total: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
    projects: { name: string; count: number }[];
    pendingProposals: number;
    consolidation: { remaining: number; threshold: number; due: boolean; writes: number; lastRunAt: string | null };
    archiveDir: string | null;
    poolDir: string;
  };
  shown: number;
  matched: number;
}

const KIND_LABEL: Record<string, [string, string]> = {
  "promote-kb": ["→ 知识库", "→ KB lesson"],
  "promote-inject": ["→ 常驻注入", "→ Always-on"],
  "promote-now": ["→ 当前任务", "→ Current task"],
  archive: ["→ 归档", "→ Archive"],
};
const STATUS_LABEL: Record<string, [string, string]> = {
  inbox: ["池内", "In pool"],
  promoted: ["已晋升", "Promoted"],
  archived: ["已归档", "Archived"],
  superseded: ["被取代", "Superseded"],
  pending: ["待审批", "Pending"],
  approved: ["已批准", "Approved"],
  rejected: ["已拒绝", "Rejected"],
  applied: ["已落地", "Applied"],
  failed: ["失败", "Failed"],
};

const ago = (iso: string): string => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
};

export function MemoryPoolTab({ zh }: { zh: boolean }) {
  const pushToast = useStore((s) => s.pushToast);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [type, setType] = useState("all");
  const [project, setProject] = useState("all");
  const [sort, setSort] = useState<"recent" | "importance" | "recurrence">("recent");
  const [range, setRange] = useState<"all" | "today" | "7d" | "30d">("all");
  // 具体日期区间（与预设互斥：填了日期就以日期为准，选预设会清掉日期）
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [full, setFull] = useState<{ id: string; text: string; evidence: string[]; path: string | null } | null>(null);
  /** 应用内确认框（**不用原生 window.confirm**：原生模态在 Electron/Windows 上
   *  出现过点关闭后输入框夺不回鼠标焦点的问题，用户反馈"批准后无法输入"）。 */
  const [confirmAsk, setConfirmAsk] = useState<{ title: string; body: string; confirmLabel: string; run: () => Promise<void> } | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      // 过滤/排序在主进程侧做一次也行，但本地做更跟手：先取全量（默认 200 条上限）
      const s = (await window.pi.memory.snapshot({
        sort,
        status,
        type,
        project,
        q,
        range: from || to ? "all" : range, // 有具体日期时预设让位
        from: from || undefined,
        to: to || undefined,
      })) as Snapshot | null;
      if (!s) throw new Error(zh ? "主进程未返回数据" : "no data from main process");
      setSnap(s);
      setErr(null);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [q, sort, status, type, project, range, from, to, zh]);

  useEffect(() => {
    void load();
  }, [load]);

  const doArchive = (entry: EntryView) => {
    setConfirmAsk({
      title: zh ? "归档这条记忆？" : "Archive this memory?",
      body: `${entry.summary}\n\n${zh ? "归档≠删除，可在归档目录找回。" : "Archive ≠ delete — restorable from the archive folder."}`,
      confirmLabel: zh ? "归档" : "Archive",
      run: async () => {
        const r = await window.pi.memory.archive(entry.id);
        pushToast(r.ok ? "success" : "error", r.detail);
        await load();
      },
    });
  };

  const doDecide = (p: ProposalView, decision: "approve" | "reject") => {
    if (decision === "reject") {
      setConfirmAsk({
        title: `${zh ? "拒绝" : "Reject"}「${p.title}」？`,
        body: zh ? "只改提案状态（留痕），不动池子里的条目。" : "Only the proposal status changes; pool entries stay put.",
        confirmLabel: zh ? "拒绝" : "Reject",
        run: async () => {
          const r = await window.pi.memory.decide(p.id, "reject");
          pushToast(r.ok ? "success" : "error", r.detail);
          await load();
        },
      });
      return;
    }
    const what =
      p.kind === "archive"
        ? zh
          ? "把这些条记忆移到归档目录（可找回）"
          : "move the entries to the archive folder (restorable)"
        : p.kind === "promote-kb"
          ? zh
            ? `写入 ${p.target || "项目知识库（按同项目条目解析）"}（不自动 commit，留给你 git diff 审）`
            : `write to ${p.target || "the project KB (resolved from sibling entries)"} (no auto-commit; review with git diff)`
          : zh
            ? "标记为已批准，由你人工合并进长期内容"
            : "mark as approved; you merge it into long-term content yourself";
    setConfirmAsk({
      title: `${zh ? "批准" : "Approve"}「${p.title}」？`,
      body: what,
      confirmLabel: zh ? "批准" : "Approve",
      run: async () => {
        const r = await window.pi.memory.decide(p.id, "approve");
        pushToast(r.ok ? "success" : "error", r.detail);
        await load();
      },
    });
  };

  const runDream = async (dry: boolean) => {
    const r = await window.pi.memory.dream(dry);
    pushToast("info", r?.detail || (zh ? "已触发" : "started"));
  };

  const openFull = async (id: string) => {
    if (expanded === id) {
      setExpanded(null);
      setFull(null);
      return;
    }
    setExpanded(id);
    const f = await window.pi.memory.entryFull(id);
    if (f) setFull({ id: f.id, text: f.text, evidence: f.evidence || [], path: f.path });
  };

  const entries = snap?.entries ?? [];

  /** 按日期分组（只在"最新"排序下做：其它排序里日期是乱的，分组反而晕）。
   *  标签用本地日历：今天 / 昨天 / YYYY-MM-DD（周几）。 */
  const groups = useMemo(() => {
    if (sort !== "recent") return null;
    const label = (iso: string): string => {
      const t = Date.parse(iso);
      if (!Number.isFinite(t)) return zh ? "未知日期" : "Unknown date";
      const d = new Date(t);
      const p = (n: number) => String(n).padStart(2, "0");
      const key = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      const now = new Date();
      const todayKey = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
      const y = new Date(now.getTime() - 86400000);
      const yesterdayKey = `${y.getFullYear()}-${p(y.getMonth() + 1)}-${p(y.getDate())}`;
      const weekday = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
      if (key === todayKey) return zh ? "今天" : "Today";
      if (key === yesterdayKey) return zh ? "昨天" : "Yesterday";
      return zh ? `${key} 周${weekday}` : `${key} (${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]})`;
    };
    const out: { label: string; items: typeof entries }[] = [];
    for (const e of entries) {
      const l = label(e.createdAt);
      const last = out[out.length - 1];
      if (last && last.label === l) last.items.push(e);
      else out.push({ label: l, items: [e] });
    }
    return out;
  }, [entries, sort, zh]);
  const pending = useMemo(() => (snap?.proposals ?? []).filter((p) => p.status === "pending"), [snap]);

  return (
    <section className="zhiya-sec mempool-sec">
      <div className="zhiya-sec-head">
        <h3>
          {zh ? "记忆池" : "Memory pool"} <code>{snap?.stats.total ?? "—"}</code>
        </h3>
        <div className="mempool-actions">
          <button className="set-btn ghost" onClick={() => void runDream(true)} title={zh ? "预览：只分诊不落盘" : "Preview only"}>
            <Sprout size={13} /> {zh ? "预览分诊" : "Dry dream"}
          </button>
          <button className="set-btn ghost" onClick={() => void runDream(false)} title={zh ? "跑一次分诊（本地模型 1-2 分钟）" : "Run triage"}>
            <Sprout size={13} /> {zh ? "分诊" : "Dream"}
          </button>
          <button className="set-btn ghost" onClick={() => void load()} disabled={busy}>
            <Refresh size={13} /> {zh ? "刷新" : "Refresh"}
          </button>
        </div>
      </div>

      {err && <div className="mempool-warn">{zh ? "读取失败：" : "Load failed: "}{err}</div>}

      {/* 状态条 */}
      {snap && (
        <div className="mempool-stats">
          <span>
            {zh ? "池内" : "In pool"} <b>{snap.stats.byStatus.inbox ?? 0}</b>
          </span>
          <span>
            {zh ? "已晋升" : "Promoted"} <b>{snap.stats.byStatus.promoted ?? 0}</b>
          </span>
          <span>
            {zh ? "待审批提案" : "Pending proposals"} <b>{snap.stats.pendingProposals}</b>
          </span>
          <span title={zh ? "累计重要性每扣满阈值就该跑一次分诊" : "Consolidation counter"}>
            {zh ? "距巩固" : "To consolidate"} <b>{Math.max(0, snap.stats.consolidation.remaining)}</b>/{snap.stats.consolidation.threshold}
            {snap.stats.consolidation.due && <em> {zh ? "已到点" : "due"}</em>}
          </span>
          {snap.stats.archiveDir && (
            <button className="set-btn ghost" onClick={() => void window.pi.memory.openArchive()}>
              {zh ? "打开归档目录" : "Open archive"}
            </button>
          )}
        </div>
      )}

      {/* 过滤行 */}
      <div className="mempool-filters">
        <input
          className="set-input mempool-q"
          value={q}
          placeholder={zh ? "搜正文 / 项目 / 标签 / id" : "Search text / project / tag / id"}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="set-select" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">{zh ? "全部状态" : "All statuses"}</option>
          <option value="inbox">{zh ? "池内" : "In pool"}</option>
          <option value="promoted">{zh ? "已晋升" : "Promoted"}</option>
        </select>
        <select className="set-select" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="all">{zh ? "全部类型" : "All types"}</option>
          <option value="semantic">{zh ? "语义（事实/偏好）" : "Semantic"}</option>
          <option value="episodic">{zh ? "情景（发生过什么）" : "Episodic"}</option>
          <option value="procedural">{zh ? "程序性（怎么做）" : "Procedural"}</option>
        </select>
        <select className="set-select" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="all">{zh ? "全部项目" : "All projects"}</option>
          {(snap?.stats.projects ?? []).map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}（{p.count}）
            </option>
          ))}
        </select>
        <select
          className="set-select"
          value={from || to ? "custom" : range}
          onChange={(e) => {
            const v = e.target.value;
            setFrom("");
            setTo("");
            setRange(v === "custom" ? "all" : (v as never));
          }}
          title={zh ? "按写入日期" : "By date"}
        >
          <option value="custom" hidden>{zh ? "自定义日期" : "Custom dates"}</option>
          <option value="all">{zh ? "全部时间" : "All time"}</option>
          <option value="today">{zh ? "今天" : "Today"}</option>
          <option value="7d">{zh ? "近 7 天" : "Last 7 days"}</option>
          <option value="30d">{zh ? "近 30 天" : "Last 30 days"}</option>
        </select>
        <span className="mempool-dates">
          <input
            className="set-input mempool-date"
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              if (e.target.value) setRange("all");
            }}
            title={zh ? "起始日期（含当天）" : "From (inclusive)"}
          />
          <span className="zhiya-dim">→</span>
          <input
            className="set-input mempool-date"
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              if (e.target.value) setRange("all");
            }}
            title={zh ? "结束日期（含当天）" : "To (inclusive)"}
          />
          {(from || to) && (
            <button
              className="set-btn ghost"
              onClick={() => {
                setFrom("");
                setTo("");
              }}
              title={zh ? "清除日期" : "Clear dates"}
            >
              <Close size={12} />
            </button>
          )}
        </span>
        <select className="set-select" value={sort} onChange={(e) => setSort(e.target.value as never)}>
          <option value="recent">{zh ? "最新" : "Newest"}</option>
          <option value="importance">{zh ? "重要性" : "Importance"}</option>
          <option value="recurrence">{zh ? "复现次数" : "Recurrence"}</option>
        </select>
        {snap && (
          <span className="zhiya-dim">
            {zh ? `显示 ${snap.shown}/${snap.matched}` : `${snap.shown}/${snap.matched}`}
          </span>
        )}
      </div>

      {/* 提案区：待审批优先 */}
      {pending.length > 0 && (
        <div className="mempool-props">
          <div className="mempool-sub">
            {zh ? "待审批提案" : "Pending proposals"} · {pending.length}
          </div>
          {pending.map((p) => (
            <div className="mempool-prop" key={p.id}>
              <div className="mempool-prop-main">
                <div className="mempool-prop-title">
                  <span className="mempool-badge">{KIND_LABEL[p.kind]?.[zh ? 0 : 1] ?? p.kind}</span> {p.title}
                </div>
                <div className="mempool-prop-meta">{p.reason}</div>
                {p.target && <div className="mempool-prop-path">{p.target}</div>}
              </div>
              <div className="mempool-prop-btns">
                <button className="set-btn" onClick={() => void doDecide(p, "approve")}>
                  {zh ? "批准" : "Approve"}
                </button>
                <button className="set-btn ghost" onClick={() => void doDecide(p, "reject")}>
                  {zh ? "拒绝" : "Reject"}
                </button>
              </div>
            </div>
          ))}
          {pending.length > 20 && (
            <div className="zhiya-dim">
              {zh ? `（待审批提案较多，共 ${pending.length} 份，建议先批准/拒绝一批）` : `(${pending.length} pending — approve or reject a batch first)`}
            </div>
          )}
          {(snap?.proposals.length ?? 0) > pending.length && (
            <div className="zhiya-dim">
              {zh
                ? "（已处理的历史提案在池子的 proposals 目录里）"
                : "(Processed proposals live in the pool's proposals folder)"}
            </div>
          )}
        </div>
      )}

      {/* 条目列表 */}
      {entries.length === 0 ? (
        <div className="zhiya-empty">
          {snap?.stats.total
            ? zh
              ? "当前过滤条件下没有条目。"
              : "No entries match the current filters."
            : zh
              ? "池子还是空的。聊天几轮后会自动沉淀（需要设置记忆模型），也可以用 /memory-remember 手记一条。"
              : "The pool is empty. It fills up as you chat (needs a memory model), or use /memory-remember."}
        </div>
      ) : (
        <div className="mempool-list">
          {(groups ?? [{ label: "", items: entries }]).map((g) => (
            <div key={g.label || "flat"}>
              {g.label && (
                <div className="mempool-day">
                  {g.label}
                  <span className="zhiya-dim"> · {g.items.length}</span>
                </div>
              )}
              {g.items.map((e) => (
                <div className={`mempool-row${expanded === e.id ? " open" : ""}`} key={e.id}>
                  <div className="mempool-row-head">
                    <button className="mempool-row-title" onClick={() => void openFull(e.id)}>
                      {e.summary}
                      {e.length > e.summary.length && <span className="zhiya-dim"> …</span>}
                    </button>
                    <div className="mempool-row-btns">
                      <button
                        className="set-btn ghost"
                        onClick={() => void doArchive(e)}
                        title={zh ? "归档（不是删除）" : "Archive (not delete)"}
                      >
                        <Close size={12} />
                      </button>
                    </div>
                  </div>
                  <div className="mempool-row-meta">
                    <span>{ago(e.createdAt)}</span>
                    <span>{STATUS_LABEL[e.status]?.[zh ? 0 : 1] ?? e.status}</span>
                    <span>{e.project}</span>
                    <span title={zh ? "重要性" : "Importance"}>★{e.importance}</span>
                    {e.recurrence > 1 && (
                      <span title={zh ? "复现次数（≥3 够格晋升）" : "Recurrence (>=3 eligible)"}>↻{e.recurrence}</span>
                    )}
                    {e.evidenceCount > 0 && <span>{zh ? "证据" : "evidence"} {e.evidenceCount}</span>}
                    {e.warnings.length > 0 && <span className="mempool-warnflag">{zh ? "需复核" : "review"}</span>}
                  </div>
                  {expanded === e.id && full && full.id === e.id && (
                    <div className="mempool-full">
                      <pre>{full.text}</pre>
                      {full.evidence.length > 0 && (
                        <>
                          <div className="zhiya-dim">{zh ? "证据" : "Evidence"}</div>
                          <pre>{full.evidence.join("\n")}</pre>
                        </>
                      )}
                      {full.path && <div className="mempool-prop-path">{full.path}</div>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* 坏文件 */}
      {(snap?.broken.length ?? 0) > 0 && (
        <div className="mempool-warn">
          {zh ? "有 " : ""}
          {snap!.broken.length}
          {zh ? " 个文件无法解析（已跳过，未静默丢弃）：" : " unparseable file(s) (skipped, not silently dropped):"}
          <ul>
            {snap!.broken.slice(0, 5).map((b) => (
              <li key={b.path}>
                <code>{b.path}</code> — {b.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 应用内确认层：不用原生 window.confirm（原生模态在 Windows 上会留下焦点问题） */}
      {confirmAsk && (
        <div className="mempool-confirm-layer" onMouseDown={() => setConfirmAsk(null)}>
          <div className="mempool-confirm" onMouseDown={(e) => e.stopPropagation()} role="alertdialog" aria-modal="true">
            <div className="mempool-confirm-title">{confirmAsk.title}</div>
            <div className="mempool-confirm-body">{confirmAsk.body}</div>
            <div className="mempool-confirm-btns">
              <button className="set-btn ghost" onClick={() => setConfirmAsk(null)} autoFocus>
                {zh ? "取消" : "Cancel"}
              </button>
              <button
                className="set-btn"
                onClick={() => {
                  const run = confirmAsk.run;
                  setConfirmAsk(null);
                  void run();
                }}
              >
                {confirmAsk.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="zhiya-sec-foot">
        {zh
          ? "文件是真相源（池目录里是可读的 Markdown），索引随时可重建；归档不等于删除，晋升到知识库不会自动 commit。"
          : "Files are the source of truth (readable Markdown in the pool dir), the index is rebuildable; archiving is not deletion, and KB promotion never auto-commits."}
      </div>
    </section>
  );
}
