import { useEffect, useMemo, useRef, useState, Fragment } from "react";
import { createPortal } from "react-dom";
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { localizeAutomationThreadTitle, remapLastActiveThread, useStore } from "../store";
import { formatTokens } from "../lib/format";
import { bucketLabel, dayBucket, sessionTimeLabel } from "../lib/relative-time";
import { FileTypeIcon } from "./FileTypeIcon";
import { MPI_FILE_MIME, MPI_SESSION_MIME } from "../lib/file-drag";
import { useOutsideClose } from "../lib/useOutsideClose";
import type { FileNode } from "../lib/types";
import { AppStore, Plus, Folder, Archive, Trash, Check, Close, Minus, Pin, ChevronRight, ChevronUp, ChevronDown, Copy, Download, Edit, Clock, CheckSquare, Plug, MessageSquare, Search, Smartphone, Sprout, Sidebar as SidebarIcon } from "./icons";

const treeKey = (cwd: string, rel?: string) => `${cwd}::${rel || ""}`;

/** The pinned zone is the leading contiguous run of pinned entries in a displayed list. */
function leadingPinned<T extends { pinned?: boolean }>(list: T[]): number {
  let n = 0;
  while (n < list.length && list[n].pinned) n++;
  return n;
}

/** 圆形印章里的首字：中文取首字，拉丁字母转大写。 */
function firstGlyph(text: string): string {
  const first = Array.from(text.trim())[0] || "?";
  return /[a-z]/.test(first) ? first.toUpperCase() : first;
}

/** 会话列表按自然日分段：返回该行之前应插入的组标题（不需插标题时返回 null）。
 *
 * 置顶区（列表前导的 pinned 区）**不插组标题**——拖拽排序按下标工作，插行会打乱视觉顺序；
 * 同一段内的行返回 null（只在桶变化时出一个标题）。 */
function recentGroupLabel<T extends { updatedAt: number; pinned?: boolean }>(
  list: T[],
  index: number,
  now: number,
  zh: boolean,
): string | null {
  const pinnedCount = leadingPinned(list);
  if (index < pinnedCount) return null;
  const bucket = dayBucket(list[index].updatedAt, now);
  if (index === pinnedCount) return bucketLabel(bucket, zh);
  return dayBucket(list[index - 1].updatedAt, now) === bucket ? null : bucketLabel(bucket, zh);
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

/** Human-readable toast for a failed project-path remap (main-process error code). */
function remapProjectPathError(code: string | undefined, language: "zh" | "en"): string {
  switch (code) {
    case "same-path":
      return language === "zh" ? "新位置与当前项目路径相同" : "New location is the same as the current project path";
    case "target-not-dir":
      return language === "zh" ? "所选位置不存在或不是文件夹" : "Selected location does not exist or is not a folder";
    case "target-sessions-dir-exists":
      return language === "zh"
        ? "会话存储中已存在该目标项目的目录，请换一个位置"
        : "A session directory for the target project already exists — pick another location";
    case "project-busy":
      return language === "zh"
        ? "该项目还有正在运行的会话或自动化任务，请先停止后再试"
        : "This project still has a running session or automation task — stop it first";
    default:
      return code || (language === "zh" ? "未知错误" : "Unknown error");
  }
}

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
  // 会话分组 / 行内相对时间的基准。每次渲染重算：跨零点或列表刷新时分组会自己跟着变。
  const now = Date.now();
  const zhiyaOpen = useStore((s) => s.zhiyaOpen);
  // Zhiya（知芽）is a dev-only panel: hidden in packaged releases.
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

  // 进程被空闲回收的会话（内存已释放，点回来自动重启）。稳定字符串避免每 token 重渲染。
  const reclaimedKey = useStore((s) =>
    Object.keys(s.threads)
      .filter((id) => s.threads[id].reclaimed)
      .sort()
      .join("\u0000")
  );
  const reclaimedSet = useMemo(() => new Set(reclaimedKey ? reclaimedKey.split("\u0000") : []), [reclaimedKey]);

  // 「会话 / 项目」由 tab 切换（不再在同一个列表里叠两个分区：同一个会话只出现一次）。
  // 置顶会话的全局顺序来自 config.pinnedThreads（与 main 侧 reorderPinned 的下标语义一致）。
  const pinnedThreadOrder = useStore((s) => s.config?.pinnedThreads);
  // 「会话」tab 顶部宫格的悬停信息卡（自制 tooltip：portal + fixed，不用原生 title）。
  const [tileTip, setTileTip] = useState<{ file: string; x: number; y: number } | null>(null);
  // 「会话」tab 的两段：置顶会话进顶部宫格（不再重复出现在下方列表），其余按 updatedAt 降序。
  const { pinnedRows, restThreads } = useMemo(() => {
    const order = new Map((pinnedThreadOrder || []).map((file, index) => [file.toLowerCase(), index]));
    const pinnedCount = pinnedThreadOrder?.length || 0;
    const rows = projects.flatMap((p) =>
      p.threads.map((t) => {
        const rank = order.get(t.file.toLowerCase());
        return {
          file: t.file,
          cwd: p.cwd,
          projectName: p.name,
          title: t.title,
          preview: t.preview,
          messageCount: t.messageCount,
          updatedAt: t.updatedAt,
          pinned: rank !== undefined,
          pinnedRank: rank ?? -1,
          pinnedCount,
        };
      }),
    );
    const pinnedRows = rows.filter((r) => r.pinned).sort((a, b) => a.pinnedRank - b.pinnedRank);
    const rest = rows.filter((r) => !r.pinned).sort((a, b) => b.updatedAt - a.updatedAt);
    return { pinnedRows, restThreads: rest };
  }, [projects, pinnedThreadOrder]);
  // token-usage readout in the sidebar footer (today + all-time), always visible
  const [usageData, setUsageData] = useState<any>(null);
  const [projectMenu, setProjectMenu] = useState<{ cwd: string; name: string; pinned: boolean; pinnedRank: number; pinnedCount: number; x: number; y: number } | null>(null);
  const [threadMenu, setThreadMenu] = useState<{ cwd: string; file: string; name: string; pinned: boolean; pinnedRank: number; pinnedCount: number; x: number; y: number } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ cwd: string; file: string; name: string } | null>(null);
  // 批量操作（会话列表多选）：只作用于下方时间列表，置顶圆印不参与。
  const [batchMode, setBatchMode] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(() => new Set());
  // Shift 范围选择的范围锚点（上一次普通点击的行下标）。
  const [batchAnchor, setBatchAnchor] = useState<number | null>(null);
  // 批量删除必须二次确认（归档可逆，不拦）。
  const [batchConfirm, setBatchConfirm] = useState<{
    action: "delete";
    items: { cwd: string; file: string; title: string }[];
  } | null>(null);
  // Pinned-zone drag & drop state (projects and threads share the same rules).
  const [dragItem, setDragItem] = useState<{ kind: "project" | "thread"; id: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ kind: "project" | "thread"; id: string; pos: "before" | "after" } | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const threadMenuRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number; width: number } | null>(null);
  useOutsideClose(projectMenuRef, !!projectMenu, () => setProjectMenu(null));
  useOutsideClose(threadMenuRef, !!threadMenu, () => setThreadMenu(null));

  // 菜单高度随内容变化（分组分隔线 / 可选的上移下移），开右键时的估算夹取会溢出，
  // 所以渲染后按真实尺寸再夹一次（DESIGN.md：浮层坐标必须夹在视口内）。
  useEffect(() => {
    if (threadMenu) {
      const rect = threadMenuRef.current?.getBoundingClientRect();
      if (!rect) return;
      const maxX = Math.max(8, window.innerWidth - rect.width - 8);
      const maxY = Math.max(8, window.innerHeight - rect.height - 8);
      if (threadMenu.x > maxX || threadMenu.y > maxY) {
        setThreadMenu({ ...threadMenu, x: Math.min(threadMenu.x, maxX), y: Math.min(threadMenu.y, maxY) });
      }
      return;
    }
    if (projectMenu) {
      const rect = projectMenuRef.current?.getBoundingClientRect();
      if (!rect) return;
      const maxX = Math.max(8, window.innerWidth - rect.width - 8);
      const maxY = Math.max(8, window.innerHeight - rect.height - 8);
      if (projectMenu.x > maxX || projectMenu.y > maxY) {
        setProjectMenu({ ...projectMenu, x: Math.min(projectMenu.x, maxX), y: Math.min(projectMenu.y, maxY) });
      }
    }
  }, [threadMenu, projectMenu]);

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

  /** 导出单个会话为 Markdown：主进程弹保存框、写文件，这里只负责 toast 反馈。 */
  const exportSession = async (title: string, cwd: string, file: string) => {
    try {
      const res = await window.pi.app.exportThread({ file, title, cwd });
      if (!res) return; // 用户在保存框点了取消
      const zh = language === "zh";
      if (res.ok) {
        const extra = res.attachments ? (zh ? `（含 ${res.attachments} 个附件` : ` (${res.attachments} attachment(s)`) : "";
        const tail = extra ? (res.skipped ? (zh ? `，${res.skipped} 个跳过）` : `, ${res.skipped} skipped)`) : (zh ? "）" : ")")) : "";
        useStore.getState().pushToast("success", zh ? `已导出会话包：${res.path}${extra}${tail}` : `Session pack exported: ${res.path}${extra}${tail}`);
      } else {
        useStore.getState().pushToast("error", zh ? `导出失败：${res.error}` : `Export failed: ${res.error}`);
      }
    } catch (error: any) {
      useStore.getState().pushToast(
        "error",
        language === "zh" ? `导出失败：${error?.message || error}` : `Export failed: ${error?.message || error}`,
      );
    }
  };

  // ---- 批量操作 ---------------------------------------------------------
  const batchItems = (): { cwd: string; file: string; title: string }[] =>
    restThreads
      .filter((t) => selectedFiles.has(t.file))
      .map((t) => ({
        cwd: t.cwd,
        file: t.file,
        title: localizeAutomationThreadTitle(t.title, language) || (language === "zh" ? "未命名会话" : "Untitled"),
      }));

  const exitBatch = () => {
    setBatchMode(false);
    setSelectedFiles(new Set());
    setBatchAnchor(null);
  };

  const toggleSelected = (file: string) =>
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });

  /**
   * 批量模式下点一行：
   * - Shift + 点击（已有锚点）→ 选中「锚点 ↔ 当前行」整段（替换选区，和资源管理器一致，anchor 不动，
   *   所以可以接着 Shift 点更远的一行扩大范围）；
   * - 普通点击 → 切换该行并把它设为新锚点。
   * 非批量模式仍是打开会话。
   */
  const handleRowClick = (event: { shiftKey: boolean }, index: number, cwd: string, file: string) => {
    if (!batchMode) {
      onThreadClick(cwd, file);
      return;
    }
    if (event.shiftKey && batchAnchor != null) {
      const from = Math.min(batchAnchor, index);
      const to = Math.max(batchAnchor, index);
      setSelectedFiles(new Set(restThreads.slice(from, to + 1).map((row) => row.file)));
      return;
    }
    setBatchAnchor(index);
    toggleSelected(file);
  };

  const allListedSelected = restThreads.length > 0 && restThreads.every((t) => selectedFiles.has(t.file));
  /** 勾选框 / 「全选」：已全选则清空，否则全选（列表里没有项时不动作）。 */
  const toggleSelectAll = () => {
    if (!restThreads.length) return;
    setSelectedFiles(allListedSelected ? new Set() : new Set(restThreads.map((t) => t.file)));
    setBatchAnchor(null);
  };

  /** 批量归档（可逆，直接执行）／批量删除（先弹确认）／批量导出（合成一个包）。 */
  const runBatch = async (action: "archive" | "delete" | "export") => {
    const items = batchItems();
    if (!items.length) return;
    if (action === "delete") {
      setBatchConfirm({ action, items });
      return;
    }
    if (action === "export") {
      try {
        const res = await window.pi.app.exportThreads({
          items: items.map((it) => ({ file: it.file, title: it.title, cwd: it.cwd })),
        });
        if (!res) return; // 用户取消保存框
        const zh = language === "zh";
        if (!res.ok) {
          useStore.getState().pushToast("error", zh ? `导出失败：${res.error}` : `Export failed: ${res.error}`);
          return;
        }
        const parts = [
          zh ? `${res.sessions ?? items.length} 个会话` : `${res.sessions ?? items.length} sessions`,
          res.attachments ? (zh ? `${res.attachments} 个附件` : `${res.attachments} attachments`) : "",
          res.skipped ? (zh ? `${res.skipped} 个附件跳过` : `${res.skipped} skipped`) : "",
        ].filter(Boolean);
        useStore
          .getState()
          .pushToast("success", zh ? `已导出会话包（${parts.join("，")}）：${res.path}` : `Exported (${parts.join(", ")}): ${res.path}`);
        exitBatch();
      } catch (error: any) {
        useStore
          .getState()
          .pushToast("error", language === "zh" ? `导出失败：${error?.message || error}` : `Export failed: ${error?.message || error}`);
      }
      return;
    }
    for (const it of items) await archiveThread(it.cwd, it.file, it.title);
    useStore
      .getState()
      .pushToast("success", language === "zh" ? `已归档 ${items.length} 个会话。` : `Archived ${items.length} sessions.`);
    exitBatch();
  };

  const confirmBatchDelete = async () => {
    const pending = batchConfirm;
    setBatchConfirm(null);
    if (!pending) return;
    for (const it of pending.items) await deleteThread(it.cwd, it.file, it.title);
    useStore
      .getState()
      .pushToast(
        trashEnabled ? "info" : "success",
        language === "zh" ? `已删除 ${pending.items.length} 个会话。` : `Deleted ${pending.items.length} sessions.`,
      );
    exitBatch();
  };

  // The user moved a project folder outside of MPI; pick the new location and
  // let the main process re-point sessions + every path-keyed reference.
  const remapProjectPath = async (oldCwd: string) => {
    setProjectMenu(null);
    let newCwd: string | null;
    try {
      newCwd = await window.pi.app.showOpenDialog("folder");
    } catch (error: any) {
      const detail = error?.message || String(error);
      useStore.getState().pushToast(
        "error",
        language === "zh" ? `选择新位置失败：${detail}` : `Could not open folder picker: ${detail}`,
      );
      return;
    }
    if (!newCwd) return; // user cancelled
    try {
      const res = await window.pi.app.remapProjectPath(oldCwd, newCwd);
      if (!res.ok) {
        useStore.getState().pushToast("error", remapProjectPathError(res.error, language));
        return;
      }
      useStore.getState().pushToast(
        "success",
        language === "zh"
          ? `项目路径已更新（会话 ${res.sessionsMoved} 个，引用 ${res.refsUpdated} 处）`
          : `Project path updated (${res.sessionsMoved} sessions, ${res.refsUpdated} references)`,
      );
      await useStore.getState().refreshProjects();
      // If the user was inside this project, follow it to the new location.
      if (useStore.getState().activeProjectCwd === oldCwd) {
        useStore.getState().setActiveProject(newCwd);
      }
      // Keep next launch's auto-restore from pointing at the moved folder.
      remapLastActiveThread(oldCwd, newCwd, res.sessionsFromDir, res.sessionsToDir);
    } catch (error: any) {
      const detail = error?.message || String(error);
      useStore.getState().pushToast(
        "error",
        language === "zh" ? `更新项目路径失败：${detail}` : `Failed to update project path: ${detail}`,
      );
    }
  };

  // HTML5 drag & drop for reordering the pinned zone. `list` is the displayed
  // order (pinned first); see resolveDrop() for the cross-zone semantics.
  // Thread rows additionally carry a session-reference payload so they can be
  // dropped onto the composer as an attachment (the agent reads the .jsonl).
  const dndHandlers = (
    kind: "project" | "thread",
    list: Array<{ id: string; pinned?: boolean }>,
    id: string,
    sessionRef?: { file: string; title: string },
  ) => ({
    draggable: true,
    onDragStart: (event: ReactDragEvent) => {
      event.dataTransfer.effectAllowed = "move";
      // Some browsers refuse to start a drag without payload data.
      event.dataTransfer.setData("text/plain", id);
      if (sessionRef) {
        event.dataTransfer.setData(MPI_SESSION_MIME, JSON.stringify(sessionRef));
      }
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

  // 宫格悬停卡：按 file 回查当前行数据（悬停期间列表刷新也能拿到最新的标题/时间）。
  const tileTipRow = tileTip ? pinnedRows.find((r) => r.file === tileTip.file) : undefined;

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
          <button
            className="sb-nav-item"
            onClick={() =>
              useStore.getState().automationOpen ? useStore.getState().closeAutomation() : useStore.getState().openAutomation()
            }
          >
            <span className="ico">
              <Clock size={15} />
            </span>
            定时任务
          </button>
          <button
            className="sb-nav-item"
            onClick={() =>
              useStore.getState().todoPanelOpen ? useStore.getState().closeTodoPanel() : useStore.getState().openTodoPanel()
            }
          >
            <span className="ico">
              <CheckSquare size={15} />
            </span>
            待办任务
          </button>
          <button
            className="sb-nav-item"
            onClick={() =>
              useStore.getState().pluginsOpen ? useStore.getState().closePlugins() : useStore.getState().openPlugins()
            }
          >
            <span className="ico">
              <Plug size={15} />
            </span>
            {language === "zh" ? "扩展功能" : "Extensions"}
          </button>
          <button
            className="sb-nav-item"
            onClick={() =>
              useStore.getState().appsOpen ? useStore.getState().closeAppStore() : useStore.getState().openAppStore()
            }
          >
            <span className="ico">
              <AppStore size={15} />
            </span>
            {language === "zh" ? "应用商店" : "App Store"}
          </button>
          <button
            className="sb-nav-item"
            onClick={() =>
              useStore.getState().messagingOpen ? useStore.getState().closeMessaging() : useStore.getState().openMessaging()
            }
          >
            <span className="ico">
              <MessageSquare size={15} />
            </span>
            {language === "zh" ? "消息接入" : "Messaging"}
          </button>
          {/* 知芽：**所有版本都开放**（2026-09-21 用户要求）。
              之前用 isDev 门挡住，导致打包版看不到——而其它设备（thinkbook 等）正是装着打包版来用记忆系统，
              门一挡就没法用。面板内部的“开发工具”菜单仍然只在 dev 显示。 */}
          <button
            className={`sb-nav-item zhiya-nav${zhiyaOpen ? " active" : ""}`}
            onClick={() =>
              useStore.getState().zhiyaOpen ? useStore.getState().closeZhiya() : useStore.getState().openZhiya()
            }
            title={language === "zh" ? "知芽：智能体的大脑与灵魂" : "Zhiya: the agent's brain & soul"}
          >
            <span className="ico">
              <Sprout size={15} />
            </span>
            {language === "zh" ? "知芽" : "Zhiya"}
          </button>
        </div>

        <div className="sb-tabs">
          <button className={`sb-tab ${sidebarTab === "threads" ? "active" : ""}`} onClick={() => { setSidebarTab("threads"); exitBatch(); }}>
            {language === "zh" ? "会话" : "Sessions"}
          </button>
          <button className={`sb-tab ${sidebarTab === "projects" ? "active" : ""}`} onClick={() => { setSidebarTab("projects"); exitBatch(); }}>
            {language === "zh" ? "项目" : "Projects"}
          </button>
          <button className={`sb-tab ${sidebarTab === "files" ? "active" : ""}`} onClick={() => { setSidebarTab("files"); exitBatch(); }}>
            {language === "zh" ? "文件" : "Files"}
          </button>
        </div>

        {sidebarTab === "threads" ? (
          <>
            {/* 置顶项目宫格（飞书头像墙式）：一行 4–5 个，悬停出信息卡，点击直达该项目最近的会话。 */}
            {/* 置顶会话圆形印章（不填色 + 双环描边）：一行 6 个，悬停出信息卡，
                点击直达该会话。置顶会话只在这里出现一次，下方列表不再重复。 */}
            {pinnedRows.length > 0 && (
              <div className="sb-pinwall">
                {pinnedRows.map((t, index) => {
                  const title =
                    localizeAutomationThreadTitle(t.title, language) || (language === "zh" ? "未命名会话" : "Untitled");
                  return (
                    <button
                      key={t.cwd + "::" + t.file}
                      type="button"
                      // 颜色按下标固定分配（第 1 块永远色 1），不再跟标题散列绑定 ——
                      // 否则会话标题自动更新一次，颜色就跟着变。
                      className={`pinwall-tile tone-${index % 10} ${activeThreadId === t.file ? "active" : ""}`}
                      aria-label={`${title} · ${t.projectName}`}
                      onClick={() => onThreadClick(t.cwd, t.file)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setProjectMenu(null);
                        setTileTip(null);
                        setThreadMenu({
                          cwd: t.cwd,
                          file: t.file,
                          name: title,
                          pinned: true,
                          pinnedRank: t.pinnedRank,
                          pinnedCount: t.pinnedCount,
                          x: Math.min(event.clientX, window.innerWidth - 232),
                          y: Math.min(event.clientY, window.innerHeight - 300),
                        });
                      }}
                      onMouseEnter={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        setTileTip({ file: t.file, x: rect.left, y: rect.bottom + 6 });
                      }}
                      onMouseLeave={() => setTileTip(null)}
                      onFocus={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        setTileTip({ file: t.file, x: rect.left, y: rect.bottom + 6 });
                      }}
                      onBlur={() => setTileTip(null)}
                    >
                      <span className="pinwall-mark">{firstGlyph(title)}</span>
                      <span className="pinwall-name">{title}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {/* 批量操作条：多选模式下固定在列表上方，已选计数 + 全选 + 归档/删除 + 退出。 */}
            {batchMode && (
              <div className="sb-batch-bar">
                {/* 第一行：勾选框 + 全选 + 已选计数，右侧 × 退出 */}
                <div className="sb-batch-head">
                  <button
                    type="button"
                    className={`sb-batch-check${allListedSelected ? " on" : ""}`}
                    onClick={toggleSelectAll}
                    aria-label={language === "zh" ? (allListedSelected ? "取消全选" : "全选") : allListedSelected ? "Deselect all" : "Select all"}
                    disabled={restThreads.length === 0}
                  >
                    {allListedSelected ? <Check size={13} /> : selectedFiles.size > 0 ? <Minus size={13} /> : null}
                  </button>
                  <button type="button" className="sb-batch-all" onClick={toggleSelectAll} disabled={restThreads.length === 0}>
                    {language === "zh" ? "全选" : "Select all"}
                  </button>
                  <span className="sb-batch-count">({selectedFiles.size})</span>
                  <button
                    type="button"
                    className="sb-batch-close"
                    onClick={exitBatch}
                    title={language === "zh" ? "退出批量操作" : "Exit batch mode"}
                    aria-label={language === "zh" ? "退出批量操作" : "Exit batch mode"}
                  >
                    <Close size={14} />
                  </button>
                </div>
                {/* 第二行：两个等宽大按钮（删除在前，归档在后），未选中时禁用 */}
                <div className="sb-batch-actions">
                  <button
                    type="button"
                    className="danger"
                    onClick={() => void runBatch("delete")}
                    disabled={selectedFiles.size === 0}
                  >
                    <Trash size={14} />
                    {language === "zh" ? "删除" : "Delete"}
                  </button>
                  <button type="button" onClick={() => void runBatch("archive")} disabled={selectedFiles.size === 0}>
                    <Archive size={14} />
                    {language === "zh" ? "归档" : "Archive"}
                  </button>
                  <button type="button" onClick={() => void runBatch("export")} disabled={selectedFiles.size === 0}>
                    <Download size={14} />
                    {language === "zh" ? "导出" : "Export"}
                  </button>
                </div>
              </div>
            )}
            {/* 会话 tab：跨项目全量列表（置顶会话已在上面宫格，不再重复）；按自然日分段。 */}
            <div className={`sb-sessions${batchMode ? " batch" : ""}`}>
            {restThreads.length === 0 && pinnedRows.length === 0 && (
              <div className="ft-empty">
                {language === "zh" ? "还没有会话，点左上角 + 新建。" : "No sessions yet — hit + to start one."}
              </div>
            )}
            {restThreads.map((t, index) => {
              const groupLabel = recentGroupLabel(restThreads, index, now, language === "zh");
              const running = runningSet.has(t.file);
              const reclaimed = reclaimedSet.has(t.file);
              const bucket = dayBucket(t.updatedAt, now);
              const title = localizeAutomationThreadTitle(t.title, language) || (language === "zh" ? "未命名会话" : "Untitled");
              return (
                <Fragment key={t.cwd + "::" + t.file}>
                  {groupLabel && <div className="thread-group">{groupLabel}</div>}
                  <div
                    className={`srow ${activeThreadId === t.file ? "active" : ""} ${batchMode ? "batch" : ""} ${selectedFiles.has(t.file) ? "selected" : ""}`}
                    role="button"
                    tabIndex={0}
                    // 拖到输入框 = 引用这个会话（和项目树里的行同一套 MIME；批量模式下禁用，避免误拖）
                    draggable={!batchMode}
                    onDragStart={(event) => {
                      if (batchMode) return;
                      event.dataTransfer.effectAllowed = "copy";
                      event.dataTransfer.setData(MPI_SESSION_MIME, JSON.stringify({ file: t.file, title }));
                    }}
                    onClick={(event: ReactMouseEvent) => handleRowClick(event, index, t.cwd, t.file)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        handleRowClick(event, index, t.cwd, t.file);
                      }
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setProjectMenu(null);
                      setThreadMenu({
                        cwd: t.cwd,
                        file: t.file,
                        name: title,
                        pinned: t.pinned,
                        pinnedRank: t.pinnedRank,
                        pinnedCount: t.pinnedCount,
                        x: Math.min(event.clientX, window.innerWidth - 232),
                        y: Math.min(event.clientY, window.innerHeight - 300),
                      });
                    }}
                    title={`${title}\n${t.projectName} · ${new Date(t.updatedAt).toLocaleString()}`}
                  >
                    <div className="srow-main">
                      {batchMode && (
                        <span className={`srow-check${selectedFiles.has(t.file) ? " on" : ""}`} aria-hidden>
                          {selectedFiles.has(t.file) ? <Check size={11} /> : null}
                        </span>
                      )}
                      {running && <span className="thread-running" />}
                      {t.pinned && (
                        <span className="thread-pin" title={language === "zh" ? "已置顶会话" : "Pinned session"}>
                          <Pin size={11} />
                        </span>
                      )}
                      <span className="srow-title">{title}</span>
                      <span className={`srow-time ${bucket === "today" ? "today" : ""}`}>
                        {sessionTimeLabel(t.updatedAt, language === "zh", now)}
                      </span>
                      <span className="srow-actions">
                        <button
                          type="button"
                          className={t.pinned ? "on" : ""}
                          title={t.pinned ? (language === "zh" ? "取消置顶" : "Unpin") : language === "zh" ? "置顶" : "Pin"}
                          aria-label={t.pinned ? (language === "zh" ? "取消置顶：" : "Unpin: ") + title : (language === "zh" ? "置顶：" : "Pin: ") + title}
                          onClick={(event) => {
                            event.stopPropagation();
                            void setThreadPinned(t.file, !t.pinned);
                          }}
                        >
                          <Pin size={13} />
                        </button>
                        <button
                          type="button"
                          title={language === "zh" ? "归档" : "Archive"}
                          aria-label={(language === "zh" ? "归档：" : "Archive: ") + title}
                          onClick={(event) => {
                            event.stopPropagation();
                            void archiveThread(t.cwd, t.file, title);
                          }}
                        >
                          <Check size={13} />
                        </button>
                      </span>
                    </div>
                    {/* 副行：项目名 + 首条消息预览 —— 同名会话（「接收邮件」× N）靠这行区分。 */}
                    <div className="srow-sub">
                      {t.projectName}
                      {t.preview ? ` · ${t.preview}` : ""}
                      {reclaimed && (language === "zh" ? " · 已回收" : " · reclaimed")}
                    </div>
                  </div>
                </Fragment>
              );
            })}
          </div>
          </>
        ) : sidebarTab === "projects" ? (
          <>
            <div className="sb-section-head">
              <span className="sb-section-label">
                {language === "zh" ? "项目" : "Projects"}
                <span className="sb-section-count">{projects.length}</span>
              </span>
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
                        x: Math.min(event.clientX, window.innerWidth - 232),
                        y: Math.min(event.clientY, window.innerHeight - 240),
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
                        <Pin size={12} />
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
                  </div>
                  {open && (
                    <div className="thread-list">
                      {p.threads.length === 0 && <div className="ft-empty">暂无会话</div>}
                      {p.threads.map((t, index) => {
                        const running = runningSet.has(t.file);
                        const title = localizeAutomationThreadTitle(t.title, language);
                        const openThread = () => onThreadClick(p.cwd, t.file);
                        const bucket = dayBucket(t.updatedAt, now);
                        const groupLabel = recentGroupLabel(p.threads, index, now, language === "zh");
                        return (
                          <Fragment key={t.file}>
                            {groupLabel && <div className="thread-group">{groupLabel}</div>}
                            <div
                              className={`thread ${activeThreadId === t.file ? "active" : ""} ${bucket === "today" ? "fresh" : ""} ${dropClass("thread", t.file)} ${dragItem?.id === t.file ? "dragging" : ""}`}
                              role="button"
                              tabIndex={0}
                              onClick={openThread}
                              onContextMenu={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                setProjectMenu(null);
                                // 用 config.pinnedThreads 的全局下标（main 侧 reorderPinned 就是这个下标语义），
                                // 与「会话」tab 的上移/下移保持一致。
                                const globalRank = (pinnedThreadOrder || []).findIndex(
                                  (f) => f.toLowerCase() === t.file.toLowerCase(),
                                );
                                setThreadMenu({
                                  cwd: p.cwd,
                                  file: t.file,
                                  name: title,
                                  pinned: globalRank >= 0,
                                  pinnedRank: globalRank,
                                  pinnedCount: pinnedThreadOrder?.length || 0,
                                  x: Math.min(event.clientX, window.innerWidth - 232),
                                  y: Math.min(event.clientY, window.innerHeight - 300),
                                });
                              }}
                              {...dndHandlers(
                                "thread",
                                p.threads.map((x) => ({ id: x.file, pinned: x.pinned })),
                                t.file,
                                { file: t.file, title },
                              )}
                              onKeyDown={(event) => {
                                if (event.target !== event.currentTarget) return;
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  openThread();
                                }
                              }}
                              title={
                                language === "zh"
                                  ? `${title}（拖到输入框可引用此会话）`
                                  : `${title} (drag to the composer to reference this session)`
                              }
                            >
                            <div className="thread-title">
                              {running && <span className="thread-running" />}
                              {t.pinned && (
                                <span className="thread-pin" title={language === "zh" ? "已置顶会话" : "Pinned session"}>
                                  <Pin size={11} />
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
                                <Pin size={13} />
                              </button>
                              <button
                                type="button"
                                className="thread-archive-btn"
                                title={language === "zh" ? "归档" : "Archive"}
                                aria-label={`${language === "zh" ? "归档" : "Archive"}：${title}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void archiveThread(p.cwd, t.file, title);
                                }}
                              >
                                <Check size={13} />
                              </button>
                            </div>
                            {t.preview && t.preview !== t.title && <div className="thread-preview">{t.preview}</div>}
                            <div className="thread-meta">
                              {language === "zh" ? `${t.messageCount} 条` : `${t.messageCount} ${t.messageCount === 1 ? "message" : "messages"}`}
                              {" · "}
                              <span className={`thread-time ${bucket === "today" ? "today" : ""}`} title={new Date(t.updatedAt).toLocaleString()}>
                                {sessionTimeLabel(t.updatedAt, language === "zh", now)}

                              {reclaimedSet.has(t.file) && (
                                <>
                                  {" · "}
                                  <span
                                    className="thread-reclaimed"
                                    title={language === "zh" ? "进程已回收以释放内存，点击打开会自动恢复" : "Process released to free memory; opening restores it"}
                                  >
                                    {language === "zh" ? "已回收" : "reclaimed"}
                                  </span>
                                </>
                              )}                              </span>
                              </div>
                            </div>
                          </Fragment>
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

      {/* 设置/帮助已随顶部标题栏去重移除；手机远程控制入口（P1-10，S8 恢复）。 */}
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
        <button
          className={`sb-foot-remote ${remoteOpen ? "on" : ""}`}
          title={language === "zh" ? "手机远程控制（云中继）" : "Phone remote control (cloud relay)"}
          aria-label={language === "zh" ? "打开手机远程控制配置" : "Open phone remote control settings"}
          onClick={onOpenRemote}
        >
          <Smartphone size={15} />
        </button>
      </div>
      {projectMenu && (
        <div
          ref={projectMenuRef}
          className="project-context-menu"
          style={{ left: projectMenu.x, top: projectMenu.y }}
          role="menu"
        >
          <div className="project-context-name" title={projectMenu.cwd}>{projectMenu.name}</div>
          {/* 菜单按语义分组（参考 WorkBuddy）：排序 → 置顶 → 位置/路径 → 归档，组间细分隔线。 */}
          {projectMenu.pinnedRank > 0 && (
            <button
              role="menuitem"
              onClick={() => {
                const item = projectMenu;
                setProjectMenu(null);
                void movePinned("project", item.cwd, item.pinnedRank - 1);
              }}
            >
              <span className="pcm-label"><ChevronUp size={13} />{language === "zh" ? "上移" : "Move up"}</span>
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
              <span className="pcm-label"><ChevronDown size={13} />{language === "zh" ? "下移" : "Move down"}</span>
            </button>
          )}
          <button
            role="menuitem"
            onClick={() => {
              const item = projectMenu;
              setProjectMenu(null);
              void setProjectPinned(item.cwd, !item.pinned);
            }}
          >
            <span className="pcm-label">
              <Pin size={13} className={projectMenu.pinned ? "pin-on" : undefined} />
              {projectMenu.pinned
                ? language === "zh"
                  ? "取消置顶项目"
                  : "Unpin project"
                : language === "zh"
                  ? "置顶项目"
                  : "Pin project"}
            </span>
          </button>
          <div className="pcm-sep" role="separator" />
          <button
            role="menuitem"
            onClick={() => void openProjectInExplorer(projectMenu.cwd)}
          >
            <span className="pcm-label"><Folder size={13} />{language === "zh" ? "在资源管理器中打开" : "Open in File Explorer"}</span>
          </button>
          <button
            role="menuitem"
            title={language === "zh" ? "项目文件夹被移动后，把会话与配置指向新位置" : "Re-point sessions and settings after the project folder moved"}
            onClick={() => void remapProjectPath(projectMenu.cwd)}
          >
            <span className="pcm-label"><Edit size={13} />{language === "zh" ? "更新项目路径…" : "Update project path…"}</span>
          </button>
          <div className="pcm-sep" role="separator" />
          <button
            role="menuitem"
            onClick={() => {
              const cwd = projectMenu.cwd;
              setProjectMenu(null);
              archiveProject(cwd);
            }}
          >
            <span className="pcm-label"><Archive size={13} />{language === "zh" ? "归档项目" : "Archive project"}</span>
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
          {/* 不再显示会话标题行：菜单是紧贴右键位置弹出的，标题属于上下文冗余。 */}
          {/* 分组：排序/置顶 → 会话操作（克隆/导出/归档）→ 位置 → 危险项单独一组。 */}
          {threadMenu.pinnedRank > 0 && (
            <button
              role="menuitem"
              onClick={() => {
                const item = threadMenu;
                setThreadMenu(null);
                void movePinned("thread", item.file, item.pinnedRank - 1);
              }}
            >
              <span className="pcm-label"><ChevronUp size={13} />{language === "zh" ? "上移" : "Move up"}</span>
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
              <span className="pcm-label"><ChevronDown size={13} />{language === "zh" ? "下移" : "Move down"}</span>
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
            <span className="pcm-label">
              <Pin size={13} className={threadMenu.pinned ? "pin-on" : undefined} />
              {threadMenu.pinned
                ? language === "zh"
                  ? "取消置顶"
                  : "Unpin"
                : language === "zh"
                  ? "置顶"
                  : "Pin"}
            </span>
          </button>
          <div className="pcm-sep" role="separator" />
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
            <span className="pcm-label"><Copy size={13} />{language === "zh" ? "克隆" : "Clone"}</span>
          </button>
          <button
            role="menuitem"
            title={
              language === "zh"
                ? "导出为会话包（ZIP：原始 JSONL + 会话用到的附件），可在另一台机器的「设置 › 数据管理 › 导入会话」直接导入"
                : "Export a session package (ZIP: raw JSONL + attachments) that imports directly on another machine"
            }
            onClick={() => {
              const item = threadMenu;
              setThreadMenu(null);
              void exportSession(item.name, item.cwd, item.file);
            }}
          >
            <span className="pcm-label"><Download size={13} />{language === "zh" ? "导出" : "Export"}</span>
          </button>
          <button
            role="menuitem"
            title={language === "zh" ? "进入多选模式，批量归档或删除会话" : "Multi-select to archive or delete in bulk"}
            onClick={() => {
              setThreadMenu(null);
              setBatchMode(true);
              setSelectedFiles(new Set());
              setBatchAnchor(null);
            }}
          >
            <span className="pcm-label"><CheckSquare size={13} />{language === "zh" ? "批量操作" : "Batch"}</span>
          </button>
          <div className="pcm-sep" role="separator" />
          <button
            role="menuitem"
            title={threadMenu.cwd}
            onClick={() => {
              const cwd = threadMenu.cwd;
              setThreadMenu(null);
              void openProjectInExplorer(cwd);
            }}
          >
            <span className="pcm-label"><Folder size={13} />{language === "zh" ? "在文件夹中打开" : "Reveal in folder"}</span>
          </button>
          <div className="pcm-sep" role="separator" />
          <button
            role="menuitem"
            title={
              language === "zh"
                ? "移出会话列表（不删文件，可在 设置 › 归档与回收 恢复）"
                : "Hide from the session list (file kept; restore in Settings › Archive & trash)"
            }
            onClick={() => {
              const item = threadMenu;
              setThreadMenu(null);
              void archiveThread(item.cwd, item.file, item.name);
            }}
          >
            <span className="pcm-label"><Archive size={13} />{language === "zh" ? "归档" : "Archive"}</span>
          </button>
          <button
            className="danger"
            role="menuitem"
            onClick={() => openDeleteConfirmation(threadMenu.cwd, threadMenu.file, threadMenu.name)}
          >
            <span className="pcm-label"><Trash size={13} />{language === "zh" ? "删除" : "Delete"}</span>
          </button>
        </div>
      )}
      {tileTip && tileTipRow &&
        createPortal(
          <div
            className="pinwall-tip"
            style={{
              left: Math.max(8, Math.min(tileTip.x, window.innerWidth - 256)),
              top: Math.min(tileTip.y, window.innerHeight - 100),
            }}
            role="tooltip"
          >
            <div className="pinwall-tip-name">
              {localizeAutomationThreadTitle(tileTipRow.title, language) ||
                (language === "zh" ? "未命名会话" : "Untitled")}
            </div>
            <div className="pinwall-tip-path">{tileTipRow.projectName}</div>
            <div className="pinwall-tip-meta">
              {language === "zh" ? `${tileTipRow.messageCount} 条` : `${tileTipRow.messageCount} msgs`}
              {` · ${sessionTimeLabel(tileTipRow.updatedAt, language === "zh", now)}`}
            </div>
          </div>,
          document.body,
        )}
      {batchConfirm && (
        <div className="modal-backdrop thread-delete-backdrop" onMouseDown={() => setBatchConfirm(null)}>
          <div
            className="modal thread-delete-confirm"
            onMouseDown={(event) => event.stopPropagation()}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="batch-delete-title"
          >
            <div className="modal-title" id="batch-delete-title">
              {language === "zh" ? `批量删除 ${batchConfirm.items.length} 个会话？` : `Delete ${batchConfirm.items.length} sessions?`}
            </div>
            <div className="modal-msg">
              {trashEnabled
                ? language === "zh"
                  ? "这些会话将被移入回收站，可在设置「数据管理」中恢复或永久删除。"
                  : "They will move to the trash. Restore or purge them from Settings → Data management."
                : language === "zh"
                  ? "这些会话及其完整记录将被永久删除，删除后无法恢复。"
                  : "These sessions and their full history will be permanently deleted. This cannot be undone."}
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setBatchConfirm(null)}>
                {language === "zh" ? "取消" : "Cancel"}
              </button>
              <button className="btn danger" onClick={() => void confirmBatchDelete()}>
                <Trash size={13} />
                {language === "zh" ? `删除 ${batchConfirm.items.length} 个` : `Delete ${batchConfirm.items.length}`}
              </button>
            </div>
          </div>
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
                  ? `“${deleteConfirm.name}”将被移入回收站，可在设置「数据管理」中恢复或永久删除。`
                  : `“${deleteConfirm.name}” will be moved to the trash. You can restore or permanently delete it from Settings → Data management.`
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
    // Right-click on empty space (rows stopPropagation themselves): native
    // menu with 刷新文件列表 — the tree only auto-refreshes after agent turns.
    <div
      className="filetree"
      onContextMenu={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        void window.pi.app.showTreeMenu(cwd);
      }}
    >
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
          // ctx lets the main-side menu add 刷新此文件夹 for directories.
          void window.pi.app.showFileContextMenu(node.abs, { cwd, rel: node.rel });
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
          <span className="ft-ico"><FileTypeIcon ext={node.ext} size={14} /></span>
        )}
        <span className="ft-name">{node.name}</span>
      </div>
      {node.isDir && expanded && entry?.loaded && entry.nodes.map((c) => <FileRow key={c.rel} cwd={cwd} node={c} depth={depth + 1} />)}
    </>
  );
}
