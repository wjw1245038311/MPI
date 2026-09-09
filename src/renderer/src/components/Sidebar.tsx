import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { localizeAutomationThreadTitle, useStore } from "../store";
import { fileIcon, formatTokens } from "../lib/format";
import { MPI_FILE_MIME } from "../lib/file-drag";
import { useOutsideClose } from "../lib/useOutsideClose";
import type { FileNode } from "../lib/types";
import { Plus, Folder, Archive, Trash, Star, ChevronRight, Edit, Clock, Plug, Search, Sidebar as SidebarIcon } from "./icons";

const treeKey = (cwd: string, rel?: string) => `${cwd}::${rel || ""}`;

/** The pinned zone is the leading contiguous run of pinned entries in a displayed list. */
function leadingPinned<T extends { pinned?: boolean }>(list: T[]): number {
  let n = 0;
  while (n < list.length && list[n].pinned) n++;
  return n;
}

/**
 * Resolve a drop onto `hoverId` into an action on the pinned zone.
 * - Pinned item dropped inside the zone → reorder to that rank.
 * - Pinned item dropped at/after the end of the zone → unpin.
 * - Unpinned item dropped inside the zone (or at the very top when nothing is
 *   pinned yet) → pin it there.
 * - Anything else → null: the recent zone stays auto-sorted by activity.
 */
type DropAction = { type: "move" | "pin"; target: number } | { type: "unpin" } | null;
function resolveDrop<T extends { id: string; pinned?: boolean }>(
  list: T[],
  dragId: string,
  hoverId: string,
  pos: "before" | "after",
): DropAction {
  if (dragId === hoverId) return null;
  const di = list.findIndex((x) => x.id === dragId);
  const hi = list.findIndex((x) => x.id === hoverId);
  if (di < 0 || hi < 0) return null;
  const P = leadingPinned(list);
  const i = hi + (pos === "after" ? 1 : 0); // insertion index in the displayed list
  if (list[di].pinned) {
    if (i >= P) return { type: "unpin" };
    const j = i > di ? i - 1 : i;
    return j === di ? null : { type: "move", target: j };
  }
  if (P > 0 && i < P) return { type: "pin", target: i };
  if (P === 0 && i === 0) return { type: "pin", target: 0 };
  return null;
}

const SIDEBAR_WIDTH_KEY = "mpi.sidebar-width";
const SIDEBAR_DEFAULT_WIDTH = 286;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 520;
const clampSidebarWidth = (width: number) => Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));

function initialSidebarWidth(): number {
  try {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampSidebarWidth(saved) : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

export function Sidebar({ onOpenRemote, remoteOpen = false }: { onOpenRemote: () => void; remoteOpen?: boolean }) {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const projects = useStore((s) => s.projects);
  const activeProjectCwd = useStore((s) => s.activeProjectCwd);
  const expandedProjects = useStore((s) => s.expandedProjects);
  const activeThreadId = useStore((s) => s.activeThreadId);
  const sidebarTab = useStore((s) => s.sidebarTab);
  const language = useStore((s) => s.config?.language || "en");
  // Absent/corrupt config means the trash is on (safe default, see main/config.ts).
  const trashEnabled = useStore((s) => s.config?.trashEnabled !== false);

  // ids of threads currently streaming, joined into a stable string so this
  // component only re-renders when the running set changes (not on every token).
  const runningKey = useStore((s) =>
    Object.keys(s.threads)
      .filter((id) => s.threads[id].isStreaming)
      .sort()
      .join("\u0000")
  );
  const runningSet = useMemo(() => new Set(runningKey ? runningKey.split("\u0000") : []), [runningKey]);

  // token-usage readout in the sidebar footer (today + all-time), always visible
  const [usageData, setUsageData] = useState<any>(null);
  const [projectMenu, setProjectMenu] = useState<{ cwd: string; name: string; pinned: boolean; pinnedRank: number; pinnedCount: number; x: number; y: number } | null>(null);
  const [threadMenu, setThreadMenu] = useState<{ cwd: string; file: string; name: string; pinned: boolean; pinnedRank: number; pinnedCount: number; x: number; y: number } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ cwd: string; file: string; name: string } | null>(null);
  // Pinned-zone drag & drop state (projects and threads share the same rules).
  const [dragItem, setDragItem] = useState<{ kind: "project" | "thread"; id: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ kind: "project" | "thread"; id: string; pos: "before" | "after" } | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const threadMenuRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number; width: number } | null>(null);
  useOutsideClose(projectMenuRef, !!projectMenu, () => setProjectMenu(null));
  useOutsideClose(threadMenuRef, !!threadMenu, () => setThreadMenu(null));

  useEffect(() => {
    if (!deleteConfirm) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDeleteConfirm(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteConfirm]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = resizeRef.current;
      if (!drag) return;
      drag.width = clampSidebarWidth(drag.startWidth + event.clientX - drag.startX);
      setSidebarWidth(drag.width);
    };
    const onPointerUp = () => {
      const drag = resizeRef.current;
      if (!drag) return;
      resizeRef.current = null;
      document.body.classList.remove("sidebar-resizing");
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(drag.width)));
      } catch {
        // A persisted width is convenient, but resizing must still work when
        // storage is unavailable.
      }
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      document.body.classList.remove("sidebar-resizing");
    };
  }, []);

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeRef.current = { startX: event.clientX, startWidth: sidebarWidth, width: sidebarWidth };
    document.body.classList.add("sidebar-resizing");
  };

  const persistSidebarWidth = (width: number) => {
    const next = clampSidebarWidth(width);
    setSidebarWidth(next);
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(next)));
    } catch {
      // See pointer-up persistence note above.
    }
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      persistSidebarWidth(sidebarWidth - 16);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      persistSidebarWidth(sidebarWidth + 16);
    } else if (event.key === "Home") {
      event.preventDefault();
      persistSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    }
  };

  const loadUsage = async () => {
    try {
      setUsageData(await window.pi.app.getTotalUsage());
    } catch {
      // Keep whatever was shown before; the readout is best-effort.
    }
  };

  // The sidebar unmounts when collapsed, so this also runs on every reopen.
  // Refresh again once streaming finishes (new usage lands then) and poll
  // lightly to pick up activity from terminal pi sessions.
  useEffect(() => {
    void loadUsage();
    const id = setInterval(loadUsage, 60_000);
    return () => clearInterval(id);
  }, []);

  const prevRunningKey = useRef(runningKey);
  useEffect(() => {
    if (prevRunningKey.current && !runningKey) void loadUsage();
    prevRunningKey.current = runningKey;
  }, [runningKey]);

  const toggleProject = useStore((s) => s.toggleProject);
  const openThread = useStore((s) => s.openThread);
  const goToThread = useStore((s) => s.goToThread);
  const openProjectFolder = useStore((s) => s.openProjectFolder);
  const setProjectPinned = useStore((s) => s.setProjectPinned);
  const unpinProject = useStore((s) => s.unpinProject);
  const setThreadPinned = useStore((s) => s.setThreadPinned);
  const movePinned = useStore((s) => s.movePinned);
  const archiveProject = useStore((s) => s.archiveProject);
  const archiveThread = useStore((s) => s.archiveThread);
  const cloneThread = useStore((s) => s.cloneThread);
  const deleteThread = useStore((s) => s.deleteThread);
  const setSidebarTab = useStore((s) => s.setSidebarTab);
  const toggleSidebar = useStore((s) => s.toggleSidebar);

  if (!sidebarOpen) return null;

  const newTask = async () => {
    const cwd = useStore.getState().activeProjectCwd;
    if (!cwd) {
      await openProjectFolder();
      return;
    }
    await openThread(cwd);
  };

  const onThreadClick = (cwd: string, file: string) => {
    void goToThread(cwd, file);
  };

  const openDeleteConfirmation = (cwd: string, file: string, name: string) => {
    setProjectMenu(null);
    setThreadMenu(null);
    setDeleteConfirm({ cwd, file, name });
  };

  const openProjectInExplorer = async (cwd: string) => {
    setProjectMenu(null);
    try {
      await window.pi.app.openFolderInExplorer(cwd);
    } catch (error: any) {
      const detail = error?.message || String(error);
      useStore.getState().pushToast(
        "error",
        language === "zh" ? `打开项目文件夹失败：${detail}` : `Could not open project folder: ${detail}`,
      );
    }
  };

  // HTML5 drag & drop for reordering the pinned zone. `list` is the displayed
  // order (pinned first); see resolveDrop() for the cross-zone semantics.
  const dndHandlers = (
    kind: "project" | "thread",
    list: Array<{ id: string; pinned?: boolean }>,
    id: string,
  ) => ({
    draggable: true,
    onDragStart: (event: ReactDragEvent) => {
      event.dataTransfer.effectAllowed = "move";
      // Some browsers refuse to start a drag without payload data.
      event.dataTransfer.setData("text/plain", id);
      setDragItem({ kind, id });
    },
    onDragEnd: () => {
      setDragItem(null);
      setDropTarget(null);
    },
    onDragOver: (event: ReactDragEvent) => {
      if (!dragItem || dragItem.kind !== kind) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const pos: "before" | "after" = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
      const action = resolveDrop(list, dragItem.id, id, pos);
      if (action) {
        event.preventDefault(); // required to allow the drop
        event.dataTransfer.dropEffect = "move";
        setDropTarget({ kind, id, pos });
      } else if (dropTarget?.kind === kind && dropTarget.id === id) {
        setDropTarget(null);
      }
    },
    onDragLeave: () => {
      if (dropTarget?.kind === kind && dropTarget.id === id) setDropTarget(null);
    },
    onDrop: (event: ReactDragEvent) => {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      const pos: "before" | "after" = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
      const action = dragItem && dragItem.kind === kind ? resolveDrop(list, dragItem.id, id, pos) : null;
      const dragged = dragItem;
      setDragItem(null);
      setDropTarget(null);
      if (!action || !dragged) return;
      if (action.type === "unpin") {
        if (kind === "project") void unpinProject(dragged.id);
        else void setThreadPinned(dragged.id, false);
      } else {
        void movePinned(kind, dragged.id, action.target);
      }
    },
  });

  const dropClass = (kind: "project" | "thread", id: string) =>
    dropTarget?.kind === kind && dropTarget.id === id ? `drop-${dropTarget.pos}` : "";

  return (
    <aside className="sidebar" style={{ width: sidebarWidth, flexBasis: sidebarWidth }}>
      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={language === "zh" ? "调整导航栏宽度" : "Resize sidebar"}
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={Math.round(sidebarWidth)}
        tabIndex={0}
        onPointerDown={beginResize}
        onKeyDown={resizeWithKeyboard}
        onDoubleClick={() => persistSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
        title={language === "zh" ? "拖动调整导航栏宽度；双击恢复默认" : "Drag to resize; double-click to reset"}
      />
      <div className="sb-head">
        <button className="sb-head-btn" title="搜索会话与文件" onClick={() => useStore.getState().openSearch()}>
          <Search size={16} />
        </button>
        <button className="sb-head-btn" title="折叠导航栏" aria-label="折叠导航栏" onClick={toggleSidebar}>
          <SidebarIcon size={16} />
        </button>
      </div>
      <div className="sb-scroll">
        <div className="sb-nav">
          <button className="sb-nav-item" onClick={newTask}>
            <span className="ico">
              <Edit size={15} />
            </span>
            新建会话
          </button>
          <button className="sb-nav-item" onClick={() => useStore.getState().openAutomation()}>
            <span className="ico">
              <Clock size={15} />
            </span>
            定时任务
          </button>
          <button className="sb-nav-item" onClick={() => useStore.getState().openPlugins()}>
            <span className="ico">
              <Plug size={15} />
            </span>
            扩展功能
          </button>
        </div>

        <div className="sb-tabs">
          <button className={`sb-tab ${sidebarTab === "threads" ? "active" : ""}`} onClick={() => setSidebarTab("threads")}>
            会话
          </button>
          <button className={`sb-tab ${sidebarTab === "files" ? "active" : ""}`} onClick={() => setSidebarTab("files")}>
            文件
          </button>
        </div>

        {sidebarTab === "threads" ? (
          <>
            <div className="sb-section-head">
              <span>项目</span>
              <button onClick={openProjectFolder} title={language === "zh" ? "打开文件夹" : "Open folder"}>
                <Plus size={14} />
              </button>
            </div>
            {projects.length === 0 && <div className="ft-empty">尚无项目，点击 + 打开一个文件夹。</div>}
            {projects.map((p) => {
              const open = !!expandedProjects[p.cwd];
              return (
                <div className="project" key={p.cwd}>
                  <div
                    className={`project-head ${open ? "open" : ""} ${dropClass("project", p.cwd)} ${dragItem?.id === p.cwd ? "dragging" : ""}`}
                    onClick={() => toggleProject(p.cwd)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setThreadMenu(null);
                      const P = leadingPinned(projects);
                      const idx = projects.findIndex((x) => x.cwd === p.cwd);
                      setProjectMenu({
                        cwd: p.cwd,
                        name: p.name,
                        pinned: !!p.pinned,
                        pinnedRank: idx < P ? idx : -1,
                        pinnedCount: P,
                        x: Math.min(event.clientX, window.innerWidth - 190),
                        y: Math.min(event.clientY, window.innerHeight - 70),
                      });
                    }}
                    {...dndHandlers("project", projects.map((x) => ({ id: x.cwd, pinned: x.pinned })), p.cwd)}
                  >
                    <span className="caret">
                      <ChevronRight size={10} />
                    </span>
                    <Folder size={15} />
                    {p.pinned && (
                      <span className="pin-indicator" title={language === "zh" ? "已置顶项目" : "Pinned project"}>
                        <Star size={12} />
                      </span>
                    )}
                    <span className="pname" title={p.cwd}>
                      {p.name}
                    </span>
                    <span className="pcount">{p.threads.length}</span>
                    <button
                      className="pact"
                      title={language === "zh" ? "新会话" : "New session"}
                      onClick={(e) => {
                        e.stopPropagation();
                        openThread(p.cwd);
                      }}
                    >
                      <Plus size={13} />
                    </button>
                    {p.pinned && (
                      <button
                        className="pact"
                        title={language === "zh" ? "取消置顶项目" : "Unpin project"}
                        onClick={(e) => {
                          e.stopPropagation();
                          unpinProject(p.cwd);
                        }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                  {open && (
                    <div className="thread-list">
                      {p.threads.length === 0 && <div className="ft-empty">暂无会话</div>}
                      {p.threads.map((t) => {
                        const running = runningSet.has(t.file);
                        const title = localizeAutomationThreadTitle(t.title, language);
                        const openThread = () => onThreadClick(p.cwd, t.file);
                        return (
                          <div
                            key={t.file}
                            className={`thread ${activeThreadId === t.file ? "active" : ""} ${dropClass("thread", t.file)} ${dragItem?.id === t.file ? "dragging" : ""}`}
                            role="button"
                            tabIndex={0}
                            onClick={openThread}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              setProjectMenu(null);
                              const P = leadingPinned(p.threads);
                              const idx = p.threads.findIndex((x) => x.file === t.file);
                              setThreadMenu({
                                cwd: p.cwd,
                                file: t.file,
                                name: title,
                                pinned: !!t.pinned,
                                pinnedRank: idx < P ? idx : -1,
                                pinnedCount: P,
                                x: Math.min(event.clientX, window.innerWidth - 190),
                                y: Math.min(event.clientY, window.innerHeight - 70),
                              });
                            }}
                            {...dndHandlers("thread", p.threads.map((x) => ({ id: x.file, pinned: x.pinned })), t.file)}
                            onKeyDown={(event) => {
                              if (event.target !== event.currentTarget) return;
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                openThread();
                              }
                            }}
                            title={title}
                          >
                            <div className="thread-title">
                              {running && <span className="thread-running" />}
                              {t.pinned && (
                                <span className="thread-pin" title={language === "zh" ? "已置顶会话" : "Pinned session"}>
                                  <Star size={11} />
                                </span>
                              )}
                              <span className="tt-text">{title}</span>
                              <button
                                type="button"
                                className={`thread-pin-btn ${t.pinned ? "on" : ""}`}
                                title={
                                  t.pinned
                                    ? language === "zh"
                                      ? "取消置顶会话"
                                      : "Unpin session"
                                    : language === "zh"
                                      ? "置顶会话"
                                      : "Pin session"
                                }
                                aria-label={`${
                                  t.pinned
                                    ? language === "zh"
                                      ? "取消置顶会话"
                                      : "Unpin session"
                                    : language === "zh"
                                      ? "置顶会话"
                                      : "Pin session"
                                }：${title}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void setThreadPinned(t.file, !t.pinned);
                                }}
                              >
                                <Star size={13} fill={t.pinned ? "currentColor" : "none"} />
                              </button>
                              <button
                                type="button"
                                className="thread-archive-btn"
                                title="归档"
                                aria-label={`归档：${title}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void archiveThread(p.cwd, t.file, title);
                                }}
                              >
                                <Archive size={13} />
                              </button>
                              <button
                                type="button"
                                className="thread-delete-btn"
                                title={language === "zh" ? "删除" : "Delete"}
                                aria-label={`${language === "zh" ? "删除" : "Delete"}：${title}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openDeleteConfirmation(p.cwd, t.file, title);
                                }}
                              >
                                <Trash size={13} />
                              </button>
                            </div>
                            {t.preview && t.preview !== t.title && <div className="thread-preview">{t.preview}</div>}
                            <div className="thread-meta">
                              {language === "zh" ? `${t.messageCount} 条` : `${t.messageCount} ${t.messageCount === 1 ? "message" : "messages"}`} · {new Date(t.updatedAt).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        ) : (
          <FileTreeView cwd={activeProjectCwd} />
        )}
      </div>

      {/* 设置/帮助已随顶部标题栏去重移除；手机远程控制入口暂缓（待办 P1-10，见
          improvement-suggestions.md）——onOpenRemote/remoteOpen props 保留，恢复时加回按钮即可。 */}
      <div className="sb-foot">
        <div
          className="usage-inline"
          title={
            usageData
              ? language === "zh"
                ? `今日 ${formatTokens(usageData.todayTokens)} · 总计 ${formatTokens(usageData.tokens)}${usageData.cost > 0 ? ` · $${usageData.cost.toFixed(4)}` : ""}（${usageData.sessions} 个会话）`
                : `Today ${formatTokens(usageData.todayTokens)} · Total ${formatTokens(usageData.tokens)}${usageData.cost > 0 ? ` · $${usageData.cost.toFixed(4)}` : ""} (${usageData.sessions} sessions)`
              : undefined
          }
        >
          <span className="ui-row">
            <span className="ui-label">{language === "zh" ? "今日用量" : "Today"}</span>
            <b>{formatTokens(usageData?.todayTokens)}</b>
          </span>
          <span className="ui-sep" aria-hidden="true">·</span>
          <span className="ui-row">
            <span className="ui-label">{language === "zh" ? "总用量" : "Total"}</span>
            <b>{formatTokens(usageData?.tokens)}</b>
          </span>
        </div>
      </div>
      {projectMenu && (
        <div
          ref={projectMenuRef}
          className="project-context-menu"
          style={{ left: projectMenu.x, top: projectMenu.y }}
          role="menu"
        >
          <div className="project-context-name" title={projectMenu.cwd}>{projectMenu.name}</div>
          {projectMenu.pinnedRank > 0 && (
            <button
              role="menuitem"
              onClick={() => {
                const item = projectMenu;
                setProjectMenu(null);
                void movePinned("project", item.cwd, item.pinnedRank - 1);
              }}
            >
              上移
            </button>
          )}
          {projectMenu.pinnedRank >= 0 && projectMenu.pinnedRank < projectMenu.pinnedCount - 1 && (
            <button
              role="menuitem"
              onClick={() => {
                const item = projectMenu;
                setProjectMenu(null);
                void movePinned("project", item.cwd, item.pinnedRank + 1);
              }}
            >
              下移
            </button>
          )}
          <button
            role="menuitem"
            onClick={() => void openProjectInExplorer(projectMenu.cwd)}
          >
            {language === "zh" ? "在资源管理器中打开" : "Open in File Explorer"}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              const item = projectMenu;
              setProjectMenu(null);
              void setProjectPinned(item.cwd, !item.pinned);
            }}
          >
            {projectMenu.pinned
              ? language === "zh"
                ? "取消置顶项目"
                : "Unpin project"
              : language === "zh"
                ? "置顶项目"
                : "Pin project"}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              const cwd = projectMenu.cwd;
              setProjectMenu(null);
              archiveProject(cwd);
            }}
          >
            归档项目
          </button>
        </div>
      )}
      {threadMenu && (
        <div
          ref={threadMenuRef}
          className="project-context-menu"
          style={{ left: threadMenu.x, top: threadMenu.y }}
          role="menu"
        >
          <div className="project-context-name" title={threadMenu.file}>{threadMenu.name}</div>
          {threadMenu.pinnedRank > 0 && (
            <button
              role="menuitem"
              onClick={() => {
                const item = threadMenu;
                setThreadMenu(null);
                void movePinned("thread", item.file, item.pinnedRank - 1);
              }}
            >
              上移
            </button>
          )}
          {threadMenu.pinnedRank >= 0 && threadMenu.pinnedRank < threadMenu.pinnedCount - 1 && (
            <button
              role="menuitem"
              onClick={() => {
                const item = threadMenu;
                setThreadMenu(null);
                void movePinned("thread", item.file, item.pinnedRank + 1);
              }}
            >
              下移
            </button>
          )}
          <button
            role="menuitem"
            onClick={() => {
              const item = threadMenu;
              setThreadMenu(null);
              void setThreadPinned(item.file, !item.pinned);
            }}
          >
            {threadMenu.pinned
              ? language === "zh"
                ? "取消置顶会话"
                : "Unpin session"
              : language === "zh"
                ? "置顶会话"
              : "Pin session"}
          </button>
          <button
            role="menuitem"
            title={language === "zh" ? "把当前会话完整复制成一个新会话" : "Duplicate the whole session into a new one"}
            onClick={() => {
              const item = threadMenu;
              setThreadMenu(null);
              // openThread guarantees the thread exists in the store and kicks off
              // (or reuses) its connection; cloneThread's ensureConnected awaits it.
              void openThread(item.cwd, item.file).then((id) => {
                if (id) void cloneThread(id);
              });
            }}
          >
            {language === "zh" ? "克隆会话" : "Clone session"}
          </button>
          <button
            className="danger"
            role="menuitem"
            onClick={() => openDeleteConfirmation(threadMenu.cwd, threadMenu.file, threadMenu.name)}
          >
            {language === "zh" ? "删除" : "Delete"}
          </button>
        </div>
      )}
      {deleteConfirm && (
        <div className="modal-backdrop thread-delete-backdrop" onMouseDown={() => setDeleteConfirm(null)}>
          <div
            className="modal thread-delete-confirm"
            onMouseDown={(event) => event.stopPropagation()}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="thread-delete-title"
          >
            <div className="modal-title" id="thread-delete-title">
              {language === "zh" ? "删除？" : "Delete?"}
            </div>
            <div className="modal-msg">
              {trashEnabled
                ? language === "zh"
                  ? `“${deleteConfirm.name}”将被移入回收站，可在设置「归档回收」中恢复或永久删除。`
                  : `“${deleteConfirm.name}” will be moved to the trash. You can restore or permanently delete it from Settings → Archive & trash.`
                : language === "zh"
                  ? `“${deleteConfirm.name}”及其完整会话记录将被永久删除，删除后无法恢复。`
                  : `“${deleteConfirm.name}” and its complete session history will be permanently deleted and cannot be recovered.`}
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setDeleteConfirm(null)}>
                {language === "zh" ? "取消" : "Cancel"}
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  const item = deleteConfirm;
                  setDeleteConfirm(null);
                  void deleteThread(item.cwd, item.file, item.name);
                }}
              >
                <Trash size={13} />
                {language === "zh" ? "删除" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

function FileTreeView({ cwd }: { cwd: string | null }) {
  const loadFileTree = useStore((s) => s.loadFileTree);
  const fileTree = useStore((s) => s.fileTree);
  useEffect(() => {
    if (cwd && !fileTree[treeKey(cwd, "")]?.loaded) loadFileTree(cwd, "");
  }, [cwd, loadFileTree, fileTree]);
  if (!cwd) return <div className="ft-empty">先在“会话”页打开一个项目。</div>;
  const root = fileTree[treeKey(cwd, "")];
  if (!root?.loaded) return <div className="ft-empty">加载中…</div>;
  return (
    <div className="filetree">
      {root.nodes.map((n) => (
        <FileRow key={n.rel} cwd={cwd} node={n} depth={0} />
      ))}
    </div>
  );
}

function FileRow({ cwd, node, depth }: { cwd: string; node: FileNode; depth: number }) {
  const toggleFolder = useStore((s) => s.toggleFolder);
  const openPreview = useStore((s) => s.openPreview);
  const fileTree = useStore((s) => s.fileTree);
  // Highlight any file that has an open preview tab (not only the active one).
  const inPreview = useStore((s) => s.previewTabs.some((t) => t.path === node.abs));
  const entry = node.isDir ? fileTree[treeKey(cwd, node.rel)] : undefined;
  const expanded = !!entry?.expanded;

  return (
    <>
      <div
        className={`ft-row ${!node.isDir && inPreview ? "active" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => (node.isDir ? toggleFolder(cwd, node.rel) : openPreview(node.abs, cwd))}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void window.pi.app.showFileContextMenu(node.abs);
        }}
        title={node.abs}
        draggable={!node.isDir}
        onDragStart={(event) => {
          if (node.isDir) return;
          event.dataTransfer.effectAllowed = "copy";
          // In-app drags expose no File objects; the composer reads the path from this type.
          event.dataTransfer.setData(MPI_FILE_MIME, node.abs);
        }}
      >
        {node.isDir ? (
          <span className="ft-ico" style={{ transform: expanded ? "rotate(90deg)" : "none", display: "inline-block", transition: "transform .12s" }}>
            <ChevronRight size={11} />
          </span>
        ) : (
          <span className="ft-ico">{fileIcon(node.ext, false)}</span>
        )}
        <span className="ft-name">{node.name}</span>
      </div>
      {node.isDir && expanded && entry?.loaded && entry.nodes.map((c) => <FileRow key={c.rel} cwd={cwd} node={c} depth={depth + 1} />)}
    </>
  );
}
