import { useCallback, useEffect, useState } from "react";
import { useStore } from "../store";
import { Markdown } from "../lib/markdown";
import { Close, Refresh, Sprout } from "./icons";

type KbFile = { path: string; size: number; mtime: number };
type Mem0Status = { online: boolean; baseUrl: string; userId: string; count: number | null };
type ZhiyaTab = "persona" | "agreement" | "workspace" | "kb" | "tasks" | "inbox";
/** The three editable runtime files, mirroring main/zhiya.ts ZHIYA_FILES. */
type ZhiyaFileName = "persona.md" | "agreement.md" | "workspace.md";

const EDITABLE: {
  name: ZhiyaFileName;
  tab: ZhiyaTab;
  zh: string;
  en: string;
  hintZh: string;
  hintEn: string;
  placeholderZh: string;
  placeholderEn: string;
}[] = [
  {
    name: "persona.md",
    tab: "persona",
    zh: "人物画像",
    en: "Persona",
    hintZh: "全文注入每个会话的系统提示词",
    hintEn: "injected in full into every session's system prompt",
    placeholderZh: "你是谁、偏好什么、怎么沟通……（Markdown）",
    placeholderEn: "Who you are, what you prefer, how you talk… (Markdown)",
  },
  {
    name: "agreement.md",
    tab: "agreement",
    zh: "协作约定",
    en: "Agreement",
    hintZh: "只有「## 硬规则（常驻注入）」节注入；全文按需读取",
    hintEn: "only the `## 硬规则（常驻注入）` section is injected; the rest is read on demand",
    placeholderZh: "家规：怎么用工作空间、不能动什么……（Markdown）",
    placeholderEn: "House rules: how to use the workspace, what not to touch… (Markdown)",
  },
  {
    name: "workspace.md",
    tab: "workspace",
    zh: "工作空间",
    en: "Workspace",
    hintZh: "空间布局 + 本机速查，注入时去掉空节",
    hintEn: "layout + local quick reference; empty sections are dropped when injected",
    placeholderZh: "房间（目录）用途，一行一间；本机服务/工具，一行一条……",
    placeholderEn: "One room (directory) per line, then one local service/tool per line…",
  },
];

/** 知芽 Zhiya — the agent's brain & soul panel.
 * Static declarations on the left of the tab bar (persona / agreement /
 * workspace — all injected), dynamic memory on the right (knowledge base for
 * frozen project knowledge, current tasks, and the mem0 inbox).
 *
 * Master (git truth source) = AgentSetting; the files edited here are its
 * one-way synced copies, so saving writes the master first. */
export function ZhiyaPanel() {
  const open = useStore((s) => s.zhiyaOpen);
  const close = useStore((s) => s.closeZhiya);
  const language = useStore((s) => s.config?.language || "en");
  const zh = language === "zh";
  const cwd = useStore((s) => s.activeProjectCwd);

  // ---- editable files (injected into every session's system prompt) ----
  const [dir, setDir] = useState("");
  const [masterDir, setMasterDir] = useState<string | null>(null);
  const [budget, setBudget] = useState(4000);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [initial, setInitial] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  // ---- knowledge base (per-project) ----
  const [kbExists, setKbExists] = useState(false);
  const [kbFiles, setKbFiles] = useState<KbFile[]>([]);
  const [selPath, setSelPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");

  // ---- inbox (mem0) ----
  const [mem0, setMem0] = useState<Mem0Status | null>(null);

  // ---- top tab bar（顶部分栏，同 PluginsPanel 的 .plugin-tab 样式）----
  const [tab, setTab] = useState<ZhiyaTab>("persona");

  const toast = useCallback((kind: "info" | "error", text: string) => {
    useStore.getState().pushToast(kind, text);
  }, []);

  const loadCore = useCallback(async () => {
    try {
      const d = await window.pi.zhiya.get();
      setDir(d.dir);
      setMasterDir(d.masterDir);
      setBudget(d.budget);
      const next: Record<string, string> = {};
      for (const f of d.files) next[f.name] = f.text;
      setTexts(next);
      setInitial(next);
    } catch (e: any) {
      toast("error", (zh ? "加载知芽失败：" : "Failed to load Zhiya: ") + (e?.message || e));
    }
  }, [toast, zh]);

  const loadKb = useCallback(async () => {
    if (!cwd) return;
    try {
      const r = await window.pi.zhiya.listKb(cwd);
      setKbExists(r.exists);
      setKbFiles(r.files || []);
      // Keep the selection valid; default to Architecture.md, else first file.
      setSelPath((prev) => {
        if (prev && r.files.some((f) => f.path === prev)) return prev;
        const arch = r.files.find((f) => f.path === "Architecture.md");
        return arch?.path || r.files[0]?.path || null;
      });
    } catch {
      setKbExists(false);
      setKbFiles([]);
    }
  }, [cwd]);

  const loadMem0 = useCallback(async () => {
    try {
      setMem0(await window.pi.zhiya.mem0Status());
    } catch {
      setMem0(null);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void loadCore();
      void loadMem0();
    }
  }, [open, loadCore, loadMem0]);

  useEffect(() => {
    if (open) void loadKb();
  }, [open, cwd, loadKb]);

  // Load the selected KB file's content.
  useEffect(() => {
    if (!open || !cwd || !selPath) return;
    let cancelled = false;
    window.pi.zhiya
      .getKbFile(cwd, selPath)
      .then((r) => {
        if (!cancelled) setFileContent(r.content);
      })
      .catch(() => {
        if (!cancelled) setFileContent("");
      });
    return () => {
      cancelled = true;
    };
  }, [open, cwd, selPath]);

  const save = async (name: ZhiyaFileName) => {
    setSaving(name);
    try {
      const api = window.pi.zhiya;
      const setter =
        name === "persona.md" ? api.setPersona : name === "agreement.md" ? api.setAgreement : api.setWorkspace;
      const r = await setter(texts[name] ?? "");
      setInitial((prev) => ({ ...prev, [name]: texts[name] ?? "" }));
      toast(
        "info",
        r.master
          ? zh
            ? "已保存（母版 + 本机副本），对新会话生效。"
            : "Saved (master + local copy). Applies to new sessions."
          : zh
            ? "已保存到本机副本（未探测到母版目录），对新会话生效。"
            : "Saved to the local copy (no master dir detected). Applies to new sessions.",
      );
    } catch (e: any) {
      toast("error", (zh ? "保存失败：" : "Save failed: ") + (e?.message || e));
    } finally {
      setSaving(null);
    }
  };

  const resyncMaster = async () => {
    try {
      const r = await window.pi.zhiya.syncMaster();
      setMasterDir(r.masterDir);
      await loadCore();
      toast(
        r.masterDir ? "info" : "error",
        r.masterDir
          ? zh
            ? "已找到母版目录并完成同步。"
            : "Master dir found and synced."
          : zh
            ? "仍未找到 AgentSetting 母版目录。"
            : "Still no AgentSetting master dir found.",
      );
    } catch (e: any) {
      toast("error", (zh ? "同步失败：" : "Sync failed: ") + (e?.message || e));
    }
  };

  const openObsidian = async () => {
    if (!cwd) return;
    try {
      const r = await window.pi.zhiya.openObsidian(cwd);
      if (!r.ok) toast("error", zh ? "无法打开 Obsidian（未安装或 URI 被拒绝）" : "Could not open Obsidian (not installed?)");
    } catch (e: any) {
      toast("error", (zh ? "打开失败：" : "Open failed: ") + (e?.message || e));
    }
  };

  if (!open) return null;

  const latestMtime = kbFiles.length ? Math.max(...kbFiles.map((f) => f.mtime)) : null;
  const active = EDITABLE.find((f) => f.tab === tab);
  const activeText = active ? texts[active.name] ?? "" : "";
  const activeDirty = active ? activeText !== (initial[active.name] ?? "") : false;

  return (
    <div className="settings-backdrop" onMouseDown={close}>
      <div className="zhiya-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="zhiya-head">
          <div className="zhiya-head-title">
            <span className="set-brand-mark zhiya-sprout">
              <Sprout size={19} />
            </span>
            <div>
              <div className="zhiya-title">{zh ? "知芽 · 智能体的大脑与灵魂" : "Zhiya · the agent's brain & soul"}</div>
              <div className="zhiya-subtitle">
                {zh
                  ? "画像全文常驻；约定的硬规则与指针常驻、全文按需；工作空间速查常驻；知识库与记忆按需检索。"
                  : "Persona injected in full; agreement's hard rules + pointers always on, full text on demand; workspace quick reference injected; knowledge base & memory queried on demand."}
              </div>
            </div>
          </div>
          <button className="iconbtn" onClick={close} title={zh ? "关闭" : "Close"} aria-label={zh ? "关闭" : "Close"}>
            <Close size={16} />
          </button>
        </header>

        <div className="zhiya-tabs-row">
          <div className="plugins-module-tabs" role="tablist" aria-label={zh ? "知芽模块" : "Zhiya modules"}>
            <button type="button" role="tab" aria-selected={tab === "persona"} className={`plugin-tab${tab === "persona" ? " active" : ""}`} onClick={() => setTab("persona")}>
              {zh ? "人物画像" : "Persona"}
            </button>
            <button type="button" role="tab" aria-selected={tab === "agreement"} className={`plugin-tab${tab === "agreement" ? " active" : ""}`} onClick={() => setTab("agreement")}>
              {zh ? "协作约定" : "Agreement"}
            </button>
            <button type="button" role="tab" aria-selected={tab === "workspace"} className={`plugin-tab${tab === "workspace" ? " active" : ""}`} onClick={() => setTab("workspace")}>
              {zh ? "工作空间" : "Workspace"}
            </button>
            <button type="button" role="tab" aria-selected={tab === "kb"} className={`plugin-tab${tab === "kb" ? " active" : ""}`} onClick={() => setTab("kb")}>
              {zh ? "知识库" : "Knowledge base"} <span className="tabs-count">{kbFiles.length}</span>
            </button>
            <button type="button" role="tab" aria-selected={tab === "tasks"} className={`plugin-tab${tab === "tasks" ? " active" : ""}`} onClick={() => setTab("tasks")}>
              {zh ? "当前任务" : "Current tasks"}
            </button>
            <button type="button" role="tab" aria-selected={tab === "inbox"} className={`plugin-tab${tab === "inbox" ? " active" : ""}`} onClick={() => setTab("inbox")}>
              {zh ? "记忆收件箱" : "Memory inbox"}
              {typeof mem0?.count === "number" && <span className="tabs-count">{mem0.count}</span>}
            </button>
          </div>
        </div>

        <div className="zhiya-body">
          {active && (
            <section className="zhiya-sec zhiya-sec-fill">
              <div className="zhiya-sec-head">
                <h3>
                  {zh ? active.zh : active.en} <code>{active.name}</code>
                </h3>
                <button className="set-btn primary" onClick={() => save(active.name)} disabled={!activeDirty || !!saving}>
                  {saving === active.name ? <span className="spinner" /> : zh ? "保存" : "Save"}
                  {activeDirty && !saving && <span className="set-dot" />}
                </button>
              </div>
              <textarea
                className="zhiya-editor"
                value={activeText}
                onChange={(e) => setTexts((prev) => ({ ...prev, [active.name]: e.target.value }))}
                spellCheck={false}
                placeholder={zh ? active.placeholderZh : active.placeholderEn}
              />
              <div className="zhiya-sec-foot">
                {zh ? active.hintZh : active.hintEn} · {activeText.length}/{budget}
                {activeText.length > budget && (
                  <span className="zhiya-warn">{zh ? " ⚠ 单文件已超出总预算" : " ⚠ over the shared budget"}</span>
                )}
              </div>
            </section>
          )}

          {tab === "kb" && (
            <section className="zhiya-sec zhiya-sec-fill">
              <div className="zhiya-sec-head">
                <h3>
                  {zh ? "知识库" : "Knowledge base"} <code>.alexandria/knowledge/</code>
                </h3>
                {kbExists && (
                  <button className="set-btn ghost" onClick={openObsidian}>
                    {zh ? "在 Obsidian 中打开" : "Open in Obsidian"}
                  </button>
                )}
              </div>
              {cwd ? (
                kbExists ? (
                  <div className="zhiya-kb">
                    <ul className="zhiya-kb-list">
                      {kbFiles.map((f) => (
                        <li key={f.path} className={selPath === f.path ? "active" : ""} onClick={() => setSelPath(f.path)}>
                          {f.path}
                        </li>
                      ))}
                    </ul>
                    <div className="zhiya-kb-view">
                      {selPath ? (
                        <Markdown text={fileContent} />
                      ) : (
                        <span className="zhiya-dim">{zh ? "选择左侧文档查看" : "Pick a document on the left"}</span>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="zhiya-empty">
                    {zh
                      ? "当前项目还没有 .alexandria/knowledge/（尚未初始化知识库）。"
                      : "This project has no .alexandria/knowledge/ yet (knowledge base not initialized)."}
                  </div>
                )
              ) : (
                <div className="zhiya-empty">{zh ? "打开一个项目后显示其知识库。" : "Open a project to see its knowledge base."}</div>
              )}
              {kbExists && (
                <div className="zhiya-sec-foot">
                  {zh
                    ? `${kbFiles.length} 篇文档` +
                      (latestMtime ? ` · 最近更新 ${new Date(latestMtime).toLocaleString()}` : "") +
                      " · 不注入正文，由系统提示里的指针按需检索"
                    : `${kbFiles.length} document(s)` +
                      (latestMtime ? ` · last updated ${new Date(latestMtime).toLocaleString()}` : "") +
                      " · content is never injected; the system-prompt pointer drives on-demand lookup"}
                </div>
              )}
            </section>
          )}

          {tab === "tasks" && (
            <section className="zhiya-sec">
              <div className="zhiya-sec-head">
                <h3>{zh ? "当前任务" : "Current tasks"}</h3>
              </div>
              <div className="zhiya-empty">
                {zh
                  ? "聚合视图（最新 HANDOFF + changelog Unreleased + 待办面板）属于下一批，本次只留入口。"
                  : "The aggregated view (latest HANDOFF + changelog Unreleased + todo panel) ships in the next batch; only the entry point exists for now."}
              </div>
              <div className="zhiya-sec-foot">
                {zh ? "现在时记忆：最活跃的一类，目标是「不再重新解释项目状态」。" : "Present-tense memory: the most active kind — its goal is to stop re-explaining project state."}
              </div>
            </section>
          )}

          {tab === "inbox" && (
            <section className="zhiya-sec">
              <div className="zhiya-sec-head">
                <h3>
                  {zh ? "记忆收件箱" : "Memory inbox"} <code>mem0</code>
                </h3>
                <button className="set-btn ghost" onClick={loadMem0} title={zh ? "刷新状态" : "Refresh status"}>
                  <Refresh size={13} /> {zh ? "刷新" : "Refresh"}
                </button>
              </div>
              {mem0 ? (
                <div className="zhiya-mem0">
                  <span className={`zhiya-dot ${mem0.online ? "on" : "off"}`} />
                  {mem0.online ? (
                    <span>
                      {zh ? "在线" : "Online"} · {mem0.baseUrl}
                      {typeof mem0.count === "number" && (
                        <>
                          {" "}· {mem0.count} {zh ? "条记忆" : "memories"}
                        </>
                      )}
                    </span>
                  ) : (
                    <span className="zhiya-dim">
                      {zh ? "离线" : "Offline"}（{mem0.baseUrl}）
                    </span>
                  )}
                </div>
              ) : (
                <span className="zhiya-dim">{zh ? "查询中…" : "Querying…"}</span>
              )}
              <div className="zhiya-empty">
                {zh
                  ? "列表、删除与「晋升」按钮（分流到画像/约定/工作空间/知识库，或遗忘）属于下一批。"
                  : "The list, delete and “promote” actions (draining into persona/agreement/workspace/KB, or forgetting) ship in the next batch."}
              </div>
              <div className="zhiya-sec-foot">
                {zh
                  ? "agent 自动捕获的未归类事实；不进系统提示。稳定的内容请写进上方三份文件——画像类事实只写 persona.md，不再靠 mem0 沉淀。"
                  : "Unfiled facts the agent captures automatically; never injected. Keep anything stable in the three files above — persona facts go to persona.md only, not mem0."}
              </div>
            </section>
          )}

          {/* file location hint */}
          <div className="zhiya-loc">
            {masterDir ? (
              <>
                {zh ? "母版（git 真相源）：" : "Master (git truth source): "}
                <code>{masterDir}</code>
                {" · "}
                {zh ? "本机副本：" : "local copies: "}
                <code>{dir}</code>
              </>
            ) : (
              <>
                <span className="zhiya-warn">{zh ? "未探测到 AgentSetting 母版目录" : "No AgentSetting master dir detected"}</span>
                {" · "}
                {zh ? "当前只读写本机副本：" : "using local copies only: "}
                <code>{dir}</code>
                <button className="set-btn ghost zhiya-resync" onClick={resyncMaster}>
                  {zh ? "重新探测" : "Detect again"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
