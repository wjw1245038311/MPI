import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { ProjectSummary, TodoItem } from "../lib/types";
import { parseQuickAdd } from "../lib/quick-add-date";
import {
  dueLabel,
  filterBySection,
  isOverdue,
  sectionCounts,
  sortTodos,
  TODO_SECTION_ORDER,
  type TodoSectionId,
} from "../lib/todo-sections";
import { CheckSquare, Close } from "./icons";

const SECTION_LABELS: Record<TodoSectionId, string> = {
  all: "全部",
  today: "今天",
  tomorrow: "明天",
  week: "本周",
  later: "稍后",
  nodate: "无日期",
  done: "已完成",
};

// String.fromCharCode(92) is a backslash; avoids literal-escape pitfalls in tooling.
const BACKSLASH = String.fromCharCode(92);
function baseName(p: string): string {
  const parts = p.replace(new RegExp(BACKSLASH, "g"), "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

/** Inline accordion editor for one todo (title / note / due date). */
function TodoEditor({ item, onClose }: { item: TodoItem; onClose: () => void }) {
  const [title, setTitle] = useState(item.title);
  const [note, setNote] = useState(item.note || "");
  const [dueDate, setDueDate] = useState(item.dueDate || "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    // Empty note clears it; empty date input clears the due date.
    const ok = await useStore.getState().updateTodo(item.id, { title, note: note.trim(), dueDate: dueDate || null });
    if (ok) onClose();
    else setBusy(false);
  };

  const del = async () => {
    if (busy) return;
    setBusy(true);
    await useStore.getState().deleteTodo(item.id); // direct delete, no confirm (Feishu-style)
    onClose();
  };

  return (
    <div className="todo-editor" onClick={(e) => e.stopPropagation()}>
      <input
        className="todo-edit-input todo-title"
        value={title}
        maxLength={500}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") onClose();
        }}
      />
      <textarea
        className="todo-edit-note todo-note"
        rows={2}
        placeholder="备注（可选）"
        value={note}
        maxLength={2000}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="todo-editor-row">
        <label className="todo-editor-label">截止日期</label>
        <input type="date" className="todo-edit-date" value={dueDate} max="9999-12-31" onChange={(e) => setDueDate(e.target.value)} />
        {dueDate && (
          <button type="button" className="set-btn ghost" onClick={() => setDueDate("")}>
            清除日期
          </button>
        )}
      </div>
      <div className="todo-editor-row">
        <button type="button" className="set-btn primary" disabled={busy || !title.trim()} onClick={() => void save()}>
          保存
        </button>
        <button type="button" className="set-btn danger" disabled={busy} onClick={() => void del()}>
          删除
        </button>
      </div>
    </div>
  );
}

export function TodoPanel() {
  const open = useStore((s) => s.todoPanelOpen);
  const close = useStore((s) => s.closeTodoPanel);
  const todos = useStore((s) => s.todos);
  const projects = useStore((s) => s.projects);
  const activeProjectCwd = useStore((s) => s.activeProjectCwd);
  const language = useStore((s) => s.config?.language || "en");

  // scope: null = all projects, otherwise a project cwd (left column selection).
  const [scopeCwd, setScopeCwd] = useState<string | null>(null);
  const [section, setSection] = useState<TodoSectionId>("all");
  const [quickText, setQuickText] = useState("");
  // Target project for quick-add while scope is "all projects".
  const [targetCwd, setTargetCwd] = useState(activeProjectCwd || "");
  const [editingId, setEditingId] = useState<string | null>(null);

  // Reset transient UI state each time the panel opens.
  useEffect(() => {
    if (open) {
      setQuickText("");
      setEditingId(null);
      setSection("all");
      setTargetCwd(useStore.getState().activeProjectCwd || "");
    }
  }, [open]);

  // Esc closes the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  const scoped = scopeCwd ? todos.filter((t) => t.cwd === scopeCwd) : todos;
  const counts = sectionCounts(scoped);
  const visible = sortTodos(filterBySection(scoped, section));

  const openCountFor = (cwd: string | null): number => {
    const list = cwd ? todos.filter((t) => t.cwd === cwd) : todos;
    return list.reduce((n, t) => n + (t.done ? 0 : 1), 0);
  };

  // Where a quick-add lands: the scoped project when one is selected, else the
  // chosen target (defaulting to the active project).
  const effectiveTargetCwd = scopeCwd || targetCwd || activeProjectCwd || "";

  const submitQuickAdd = async () => {
    const parsed = parseQuickAdd(quickText);
    if (!parsed.title) return;
    if (!effectiveTargetCwd) {
      useStore.getState().pushToast("warning", "请先打开一个项目再添加待办");
      return;
    }
    await useStore.getState().addTodo({ cwd: effectiveTargetCwd, title: parsed.title, dueDate: parsed.dueDate });
    setQuickText("");
  };

  // Which project a row belongs to — only shown in "all projects" scope.
  const projectName = (cwd: string): string => {
    const p = projects.find((x) => x.cwd === cwd);
    return p ? p.name || baseName(cwd) : baseName(cwd);
  };

  const sourceSession = (item: TodoItem): { project: ProjectSummary; file: string; title: string } | null => {
    if (!item.sessionFile) return null;
    for (const p of projects) {
      const t = p.threads.find((th) => th.file === item.sessionFile);
      if (t) return { project: p, file: t.file, title: t.title || baseName(t.file) };
    }
    return null;
  };

  return (
    <div className="settings-backdrop" onMouseDown={close}>
      <div className="plugins-modal todo-panel" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="plugins-head">
          <div className="plugins-head-title">
            <span className="set-brand-mark">
              <CheckSquare size={18} />
            </span>
            <div>
              <div className="set-brand-title">待办任务</div>
              <div className="set-brand-sub">
                {language === "zh"
                  ? "按项目记录待办，支持日期与备注；智能体也可在对话中添加"
                  : "Track todos per project with dates and notes; the agent can add them from conversations too"}
              </div>
            </div>
          </div>
          <button className="set-iconbtn" title="关闭" onClick={close}>
            <Close size={16} />
          </button>
        </header>

        <div className="todo-body">
          {/* Left: project scope list */}
          <div className="todo-side">
            <button type="button" className={`todo-proj ${scopeCwd === null ? "active" : ""}`} onClick={() => setScopeCwd(null)}>
              <span className="todo-proj-name">全部项目</span>
              <span className="todo-count">{openCountFor(null)}</span>
            </button>
            {projects.map((p) => (
              <button
                type="button"
                key={p.cwd}
                className={`todo-proj ${scopeCwd === p.cwd ? "active" : ""}`}
                onClick={() => setScopeCwd(p.cwd)}
              >
                <span className="todo-proj-name">{p.name || baseName(p.cwd)}</span>
                <span className="todo-count">{openCountFor(p.cwd)}</span>
              </button>
            ))}
          </div>

          {/* Right: quick-add + sections + list */}
          <div className="todo-main">
            <div className="todo-quick">
              {!scopeCwd && projects.length > 0 && (
                <select
                  className="todo-target"
                  value={effectiveTargetCwd}
                  onChange={(e) => setTargetCwd(e.target.value)}
                  title="目标项目"
                >
                  {projects.map((p) => (
                    <option key={p.cwd} className="todo-opt" value={p.cwd}>
                      {p.name || baseName(p.cwd)}
                    </option>
                  ))}
                </select>
              )}
              <input
                className="todo-quick-input"
                placeholder="添加待办，回车创建（支持：明天 / 周五 / 9月30日）"
                value={quickText}
                maxLength={500}
                onChange={(e) => setQuickText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitQuickAdd();
                }}
              />
            </div>

            <div className="todo-chips">
              {TODO_SECTION_ORDER.map((id) => (
                <button type="button" key={id} className={`todo-chip ${section === id ? "active" : ""}`} onClick={() => setSection(id)}>
                  {SECTION_LABELS[id]}
                  <span className="todo-chip-count">{counts[id]}</span>
                </button>
              ))}
            </div>

            <div className="todo-list">
              {visible.length === 0 && <div className="set-empty">暂无待办</div>}
              {visible.map((item) => (
                <div key={item.id}>
                  <div
                    className={`todo-row ${item.done ? "done" : ""}`}
                    onClick={() => {
                      if (!editingId) setEditingId(item.id);
                    }}
                  >
                    <button
                      type="button"
                      className="todo-check"
                      aria-label={item.done ? "标记为未完成" : "标记为已完成"}
                      title={item.done ? "标记为未完成" : "标记为已完成"}
                      onClick={(e) => {
                        e.stopPropagation();
                        void useStore.getState().toggleTodo(item.id);
                      }}
                    >
                      {item.done ? "✓" : ""}
                    </button>
                    <div className="todo-row-main">
                      <span className={`todo-title ${item.done ? "done" : ""}`}>{item.title}</span>
                      {item.note && <span className="todo-note">{item.note}</span>}
                    </div>
                    {!scopeCwd && item.cwd && <span className="todo-proj-tag">{projectName(item.cwd)}</span>}
                    {!item.done && item.dueDate && (
                      <span className={`todo-due ${isOverdue(item) ? "overdue" : ""}`}>{dueLabel(item.dueDate)}</span>
                    )}
                    {item.source === "agent" &&
                      (() => {
                        const s = sourceSession(item);
                        return (
                          <button
                            type="button"
                            className="todo-ai-badge"
                            title={s ? `由智能体添加 · ${s.title}` : "由智能体添加"}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!s) return;
                              close();
                              void useStore.getState().goToThread(s.project.cwd, s.file);
                            }}
                          >
                            AI
                          </button>
                        );
                      })()}
                  </div>
                  {editingId === item.id && <TodoEditor item={item} onClose={() => setEditingId(null)} />}
                </div>
              ))}
            </div>

            {section === "done" && counts.done > 0 && (
              <button type="button" className="todo-clear-done" onClick={() => void useStore.getState().clearCompletedTodos(scopeCwd)}>
                清空已完成
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
