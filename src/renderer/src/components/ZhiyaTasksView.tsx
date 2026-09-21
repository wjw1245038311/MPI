import { useCallback, useEffect, useState } from "react";
import { useStore } from "../store";
import { Refresh } from "./icons";

type Handoff = { path: string; name: string; mtime: string; title: string };
type Changelog = { path: string; hasUnreleased: boolean; recent: { version: string; items: string[] }[] };
type Tasks = { handoffs: Handoff[]; changelog: Changelog | null; searched: string[] };

/**
 * 知芽「当前任务」视图：待办 + HANDOFF + changelog（全部只读）。
 * 从原 ZhiyaPanel 模态迁出，供右侧侧板复用。
 */
export function ZhiyaTasksView({ zh }: { zh: boolean }) {
  const cwd = useStore((s) => s.activeProjectCwd);
  const [tasks, setTasks] = useState<Tasks | null>(null);
  const [todos, setTodos] = useState<{ id: string; title: string; dueDate: string | null; done: boolean }[]>([]);
  const [handoffText, setHandoffText] = useState<{ path: string; text: string } | null>(null);

  const loadTasks = useCallback(async () => {
    const r = await window.pi.zhiya.tasks(cwd || undefined).catch(() => null);
    setTasks(r);
    const list = await window.pi.todo.list().catch(() => []);
    setTodos((list || []).filter((t: { done: boolean }) => !t.done));
  }, [cwd]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  return (
    <div className="zhiya-view">
      <div className="zhiya-sec-head">
        <h3>
          {zh ? "当前任务" : "Current tasks"} <code>{todos.length}</code>
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
                <span className={t.dueDate ? "zhiya-due" : "zhiya-dim"}>{t.dueDate || (zh ? "无日期" : "no date")}</span>
                <span>{t.title}</span>
              </li>
            ))}
            {todos.length > 12 && (
              <li className="zhiya-dim">{zh ? `…还有 ${todos.length - 12} 条` : `…+${todos.length - 12} more`}</li>
            )}
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
                <button
                  className="set-btn ghost"
                  onClick={() => void useStore.getState().openPreview(h.path)}
                  title={zh ? "在预览页打开" : "Open in preview"}
                >
                  {zh ? "打开" : "Open"}
                </button>
              </li>
            ))}
          </ul>
        )}
        {handoffText && <pre className="zhiya-handoff-preview">{handoffText.text}</pre>}
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
                  {v.items.length > 3 && (
                    <li className="zhiya-dim">{zh ? `…共 ${v.items.length} 条` : `…${v.items.length} total`}</li>
                  )}
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
    </div>
  );
}
