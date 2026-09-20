import { useCallback, useEffect, useState } from "react";
import { useStore } from "../store";
import { Markdown } from "../lib/markdown";
import { Close, Refresh, Sprout } from "./icons";
import { MemoryPoolTab } from "./MemoryPoolTab";

type KbFile = { path: string; size: number; mtime: number };
type ZhiyaTab = "persona" | "agreement" | "workspace" | "kb" | "tasks" | "pool";
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
 * frozen project knowledge, current tasks, and the memory pool).
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
  const [paths, setPaths] = useState<Record<string, { path: string; masterPath: string | null }>>({});
  const [saving, setSaving] = useState<string | null>(null);
  /** 编辑 / 预览 两种模式（预览复用聊天同款 Markdown 渲染）。 */
  const [mode, setMode] = useState<"edit" | "preview">("edit");

  // ---- knowledge base (per-project) ----
  const [kbExists, setKbExists] = useState(false);
  const [kbFiles, setKbFiles] = useState<KbFile[]>([]);
  const [selPath, setSelPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");


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
      const nextPaths: Record<string, { path: string; masterPath: string | null }> = {};
      for (const f of d.files) {
        next[f.name] = f.text;
        nextPaths[f.name] = { path: f.path, masterPath: f.masterPath };
      }
      setTexts(next);
      setInitial(next);
      setPaths(nextPaths);
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

  /** 当前任务聚合：待办 + HANDOFF + changelog（全部只读）。 */
  const [tasks, setTasks] = useState<{
    handoffs: { path: string; name: string; mtime: string; title: string }[];
    changelog: { path: string; hasUnreleased: boolean; recent: { version: string; items: string[] }[] } | null;
    searched: string[];
  } | null>(null);
  const [todos, setTodos] = useState<{ id: string; title: string; done: boolean; dueDate: string | null }[]>([]);
  const [handoffText, setHandoffText] = useState<{ path: string; text: string } | null>(null);

  /** 当前任务聚合：待办 + HANDOFF + changelog（全部只读）。 */
  const loadTasks = useCallback(async () => {
    const r = await window.pi.zhiya.tasks(cwd || undefined).catch(() => null);
    setTasks(r);
    const list = await window.pi.todo.list().catch(() => []);
    setTodos((list || []).filter((t: { done: boolean }) => !t.done));
  }, [cwd]);

  useEffect(() => {
    if (open) void loadCore();
  }, [open, loadCore]);

  useEffect(() => {
    if (open && tab === "tasks") void loadTasks();
  }, [open, tab, loadTasks]);

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

  const openObsidian = async (relPath?: string) => {
    if (!cwd) return;
    try {
      const r = await window.pi.zhiya.openObsidian(cwd, relPath);
      if (!r.ok) toast("error", zh ? "无法打开 Obsidian（未安装或 URI 被拒绝）" : "Could not open Obsidian (not installed?)");
    } catch (e: any) {
      toast("error", (zh ? "打开失败：" : "Open failed: ") + (e?.message || e));
    }
  };

  /** Open one of the three files in Obsidian. Main prefers the git master, so
   * edits there are not clobbered by the next master→copy sync. */
  const openFileObsidian = async (name: ZhiyaFileName) => {
    try {
      const r = await window.pi.zhiya.openFileObsidian(name);
      if (!r.ok) {
        toast("error", zh ? "无法打开 Obsidian（未安装或 URI 被拒绝）" : "Could not open Obsidian (not installed?)");
      } else if (!r.master) {
        toast("info", zh ? "已打开本机副本（未探测到母版目录）" : "Opened the local copy (no master dir detected)");
      }
    } catch (e: any) {
      toast("error", (zh ? "打开失败：" : "Open failed: ") + (e?.message || e));
    }
  };

  // Ctrl/Cmd+S saves the current tab (only meaningful in edit mode).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      const f = EDITABLE.find((x) => x.tab === tab);
      if (f && (texts[f.name] ?? "") !== (initial[f.name] ?? "")) void save(f.name);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, tab, texts, initial]);

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
            <button type="button" role="tab" aria-selected={tab === "pool"} className={`plugin-tab${tab === "pool" ? " active" : ""}`} onClick={() => setTab("pool")}>
              {zh ? "记忆池" : "Memory pool"}
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
                <div className="zhiya-sec-actions">
                  <div className="zhiya-mode" role="group" aria-label={zh ? "编辑 / 预览" : "Edit / preview"}>
                    <button type="button" className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")}>
                      {zh ? "编辑" : "Edit"}
                    </button>
                    <button type="button" className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")}>
                      {zh ? "预览" : "Preview"}
                    </button>
                  </div>
                  <button
                    className="set-btn ghost"
                    onClick={() => openFileObsidian(active.name)}
                    title={zh ? "用 Obsidian 打开（优先母版，改动不会被同步覆盖）" : "Open in Obsidian (prefers the git master)"}
                  >
                    {zh ? "用 Obsidian 打开" : "Open in Obsidian"}
                  </button>
                  <button className="set-btn primary" onClick={() => save(active.name)} disabled={!activeDirty || !!saving}>
                    {saving === active.name ? <span className="spinner" /> : zh ? "保存" : "Save"}
                    {activeDirty && !saving && <span className="set-dot" />}
                  </button>
                </div>
              </div>
              {mode === "edit" ? (
                <textarea
                  className="zhiya-editor"
                  value={activeText}
                  onChange={(e) => setTexts((prev) => ({ ...prev, [active.name]: e.target.value }))}
                  spellCheck={false}
                  placeholder={zh ? active.placeholderZh : active.placeholderEn}
                />
              ) : (
                <div className="zhiya-preview">
                  <Markdown
                    text={activeText}
                    fileBasePath={paths[active.name]?.masterPath || paths[active.name]?.path || null}
                  />
                </div>
              )}
              <div className="zhiya-sec-foot">
                {(zh ? active.hintZh : active.hintEn) + " · " + `${activeText.length}/${budget}`}
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
                  <button className="set-btn ghost" onClick={() => void openObsidian(selPath ?? undefined)}>
                    {zh ? (selPath ? "用 Obsidian 打开所选" : "在 Obsidian 中打开") : selPath ? "Open selected in Obsidian" : "Open in Obsidian"}
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
            <section className="zhiya-sec mempool-sec">
              <div className="zhiya-sec-head">
                <h3>
                  {zh ? "当前任务" : "Current tasks"}
                  <code>{todos.length}</code>
                </h3>
                <button className="set-btn ghost" onClick={() => void loadTasks()}>
                  <Refresh size={13} /> {zh ? "刷新" : "Refresh"}
                </button>
              </div>

              {/* ① 待办：我说要做的事 */}
              <div className="zhiya-task-sec">
                <div className="mempool-sub">
                  {zh ? "待办（未完成）" : "Open todos"} · {todos.length}
                </div>
                {todos.length === 0 ? (
                  <div className="zhiya-dim">{zh ? "没有未完成待办。" : "No open todos."}</div>
                ) : (
                  <ul className="zhiya-task-list">
                    {todos.slice(0, 12).map((t) => (
                      <li key={t.id}>
                        <span className={t.dueDate ? "zhiya-due" : "zhiya-dim"}>
                          {t.dueDate || (zh ? "无日期" : "no date")}
                        </span>
                        <span>{t.title}</span>
                      </li>
                    ))}
                    {todos.length > 12 && <li className="zhiya-dim">{zh ? `…还有 ${todos.length - 12} 条` : `…+${todos.length - 12} more`}</li>}
                  </ul>
                )}
              </div>

              {/* ② HANDOFF：上一个会话/设备交接时的状态 */}
              <div className="zhiya-task-sec">
                <div className="mempool-sub">
                  {zh ? "HANDOFF（交接快照）" : "HANDOFF snapshots"} · {tasks?.handoffs.length ?? 0}
                </div>
                {!tasks?.handoffs.length ? (
                  <div className="zhiya-dim">
                    {zh ? "没找到 HANDOFF 文件（找过：" : "No HANDOFF found (searched: "}
                    {(tasks?.searched || []).slice(0, 3).join("、") || "—"}）
                  </div>
                ) : (
                  <ul className="zhiya-task-list">
                    {tasks.handoffs.slice(0, 5).map((h) => (
                      <li key={h.path}>
                        <span className="zhiya-dim">{new Date(h.mtime).toLocaleDateString()}</span>
                        <button
                          className="zhiya-linklike"
                          onClick={async () => {
                            if (handoffText?.path === h.path) {
                              setHandoffText(null);
                              return;
                            }
                            const t = await window.pi.zhiya.readHandoff(h.path);
                            setHandoffText(t ? { path: h.path, text: t } : null);
                          }}
                        >
                          {h.title || h.name}
                        </button>
                        <button className="set-btn ghost" onClick={() => void useStore.getState().openPreview(h.path)} title={zh ? "在预览页打开" : "Open in preview"}>
                          {zh ? "打开" : "Open"}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {handoffText && (
                  <pre className="zhiya-handoff-preview">{handoffText.text}</pre>
                )}
              </div>

              {/* ③ changelog：已经做完的事 */}
              <div className="zhiya-task-sec">
                <div className="mempool-sub">
                  {zh ? "changelog" : "Changelog"}
                  {tasks?.changelog && !tasks.changelog.hasUnreleased && (
                    <span className="zhiya-dim"> · {zh ? "无未发版条目" : "nothing unreleased"}</span>
                  )}
                </div>
                {!tasks?.changelog ? (
                  <div className="zhiya-dim">
                    {zh ? "当前项目没有 changelog.md（随项目根探测）。" : "No changelog.md for the current project."}
                  </div>
                ) : (
                  <>
                    {(tasks.changelog.recent || []).map((v) => (
                      <div key={v.version} className="zhiya-task-ver">
                        <div className="zhiya-task-ver-name">{v.version}</div>
                        <ul className="zhiya-task-list">
                          {v.items.slice(0, 3).map((it: string, i: number) => (
                            <li key={i}>
                              <span>{it}</span>
                            </li>
                          ))}
                          {v.items.length > 3 && <li className="zhiya-dim">{zh ? `…共 ${v.items.length} 条` : `…${v.items.length} total`}</li>}
                        </ul>
                      </div>
                    ))}
                    <button className="set-btn ghost" onClick={() => void useStore.getState().openPreview(tasks.changelog!.path)}>
                      {zh ? "打开 changelog" : "Open changelog"}
                    </button>
                  </>
                )}
              </div>

              <div className="zhiya-sec-foot">
                {zh
                  ? "现在时记忆的三个来源：待办（要做）· HANDOFF（交接状态）· changelog（已做完）。本页只读，不改任何文件。"
                  : "Three sources of present-tense memory: todos (to do), HANDOFF (handover state), changelog (done). Read-only."}
              </div>
            </section>
          )}

          {tab === "pool" && <MemoryPoolTab zh={zh} />}

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
