import { useEffect, useRef, useState, type ReactNode } from "react";
import { localizeAutomationThreadTitle, useStore } from "../store";
import type { ThreadSearchHit } from "../lib/types";
import { Search, Close, Folder } from "./icons";

/** Split text around case-insensitive matches of `query` and wrap them in <mark>. */
function highlight(text: string, query: string): ReactNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [text];
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  let idx = lower.indexOf(q);
  let key = 0;
  while (idx !== -1) {
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark key={key++} className="hl">
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    i = idx + q.length;
    idx = lower.indexOf(q, i);
  }
  if (i < text.length) parts.push(text.slice(i));
  return parts;
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString([], { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function SearchModal() {
  const open = useStore((s) => s.searchOpen);
  const close = useStore((s) => s.closeSearch);
  const goToThread = useStore((s) => s.goToThread);
  const restoreProject = useStore((s) => s.restoreProject);
  const restoreThread = useStore((s) => s.restoreThread);
  const restoreFromTrash = useStore((s) => s.restoreFromTrash);
  const language = useStore((s) => s.config?.language || "en");

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ThreadSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [active, setActive] = useState(0);
  // When checked, archived sessions and trash entries are searched too.
  const [includeArchive, setIncludeArchive] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const reqId = useRef(0);

  // reset + focus each time the palette opens
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setSearched(false);
      setLoading(false);
      setActive(0);
      setIncludeArchive(false);
      reqId.current++;
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // debounced search with a stale-response guard
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearched(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    const myId = ++reqId.current;
    const t = setTimeout(async () => {
      try {
        const res = await window.pi.app.searchThreads(q, includeArchive);
        if (reqId.current !== myId) return;
        setResults(res);
        setSearched(true);
        setActive(0);
      } catch {
        if (reqId.current !== myId) return;
        setResults([]);
        setSearched(true);
      } finally {
        if (reqId.current === myId) setLoading(false);
      }
    }, 220);
    return () => clearTimeout(t);
  }, [query, includeArchive]);

  // keep the highlighted row in view while arrowing
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // Esc closes even when focus is elsewhere in the modal
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  const go = async (hit: ThreadSearchHit) => {
    close();
    await goToThread(hit.cwd, hit.file);
  };

  // One-click restore for archived/trashed hits; drop the row once it is live again.
  const restoreHit = async (hit: ThreadSearchHit) => {
    if (!hit.state) return;
    if (hit.state === "trashed") {
      const id = hit.file.split(/[\\/]/).pop()?.replace(/\.jsonl$/i, "");
      if (!id) return;
      await restoreFromTrash(id);
      const stillTrashed = useStore.getState().trashEntries.some((e) => e.id === id);
      if (!stillTrashed) setResults((rs) => rs.filter((r) => r.file !== hit.file));
    } else if (hit.state === "thread-archived") {
      await restoreThread(hit.file);
      const cfg = useStore.getState().config;
      const stillArchived = (cfg?.archivedThreads || []).some((t) => t.file.toLowerCase() === hit.file.toLowerCase());
      if (!stillArchived) setResults((rs) => rs.filter((r) => r.file !== hit.file));
    } else {
      await restoreProject(hit.cwd);
      const cfg = useStore.getState().config;
      const stillArchived = (cfg?.archivedProjects || []).some((c) => c.toLowerCase() === hit.cwd.toLowerCase());
      if (!stillArchived) setResults((rs) => rs.filter((r) => !(r.state === "project-archived" && r.cwd.toLowerCase() === hit.cwd.toLowerCase())));
    }
  };

  const stateLabel = (state: NonNullable<ThreadSearchHit["state"]>) => {
    if (language === "zh") return state === "trashed" ? "回收站" : state === "project-archived" ? "项目已归档" : "已归档";
    return state === "trashed" ? "Trashed" : state === "project-archived" ? "Project archived" : "Archived";
  };

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[active];
      if (hit) go(hit);
    }
  };

  const q = query.trim();

  return (
    <div className="search-backdrop" onMouseDown={close}>
      <div className="search-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="搜索会话">
        <div className="search-input-row">
          <span className="search-ico">
            <Search size={17} />
          </span>
          <input
            ref={inputRef}
            className="search-input"
            placeholder="搜索所有会话中的关键词…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            spellCheck={false}
          />
          {loading ? (
            <span className="spinner search-spin" />
          ) : query ? (
            <button className="search-clear" title={language === "zh" ? "清空" : "Clear"} onClick={() => setQuery("")}>
              <Close size={14} />
            </button>
          ) : null}
          <label
            className="search-arch-toggle"
            title={
              language === "zh"
                ? "勾选后同时搜索已归档会话和回收站中的会话，结果可直接恢复"
                : "Also search archived sessions and trash entries; results can be restored in place"
            }
          >
            <input type="checkbox" checked={includeArchive} onChange={(e) => setIncludeArchive(e.target.checked)} />
            {language === "zh" ? "归档回收" : "Archived & trashed"}
          </label>
          <button className="kbd search-esc-btn" title={language === "zh" ? "关闭搜索（Esc）" : "Close (Esc)"} onClick={close}>
            {language === "zh" ? "退出" : "Esc"}
          </button>
        </div>

        <div className="search-results" ref={listRef}>
          {!q && (
            <div className="search-empty">
              {language === "zh" ? "输入关键词，在全部项目的会话中搜索。" : "Type a keyword to search across all project sessions."}
              <br />
              <span className="muted">{language === "zh" ? "匹配会话标题与用户 / 助手消息内容。" : "Matches session titles and user/assistant message content."}</span>
              <br />
              <span className="muted">
                {language === "zh"
                  ? "勾选「归档回收」可一并搜索已归档和回收站中的会话，并支持直接恢复。"
                  : 'Tick "Archived & trashed" to also search archived and trashed sessions, with one-click restore.'}
              </span>
            </div>
          )}

          {q && searched && results.length === 0 && !loading && (
            <div className="search-empty">
              未找到包含 <b>“{q}”</b> 的会话。
            </div>
          )}

          {results.map((hit, i) => {
            const title = localizeAutomationThreadTitle(hit.title, language);
            return (
              <button
                key={hit.file}
                data-idx={i}
                className={`search-item ${i === active ? "active" : ""}`}
                style={{ animationDelay: `${Math.min(i, 10) * 22}ms` }}
                onClick={() => go(hit)}
                onMouseEnter={() => setActive(i)}
              >
                <div className="search-item-top">
                  <span className="search-item-title">{highlight(title, q)}</span>
                  {hit.state && (
                    <span className={`search-item-badge ${hit.state === "trashed" ? "trashed" : ""}`}>{stateLabel(hit.state)}</span>
                  )}
                  <span className="search-item-count">{language === "zh" ? `${hit.matchCount} 处匹配` : `${hit.matchCount} match${hit.matchCount === 1 ? "" : "es"}`}</span>
                  {hit.state && (
                    <span
                      className="search-item-restore"
                      role="button"
                      title={language === "zh" ? "恢复到侧栏" : "Restore to sidebar"}
                      onClick={(e) => {
                        e.stopPropagation();
                        void restoreHit(hit);
                      }}
                    >
                      {language === "zh" ? "恢复" : "Restore"}
                    </span>
                  )}
                </div>
                <div className="search-item-snippet">{highlight(hit.snippet, q)}</div>
                <div className="search-item-meta">
                  <span className="search-item-proj">
                    <Folder size={11} /> {hit.projectName}
                  </span>
                  <span>{hit.messageCount} 条</span>
                  <span>{fmtDate(hit.updatedAt)}</span>
                </div>
              </button>
            );
          })}
        </div>

        <div className="search-foot">
          <span>
            <span className="kbd">↑</span> <span className="kbd">↓</span> 选择
          </span>
          <span>
            <span className="kbd">{language === "zh" ? "回车" : "Enter"}</span> {language === "zh" ? "打开" : "Open"}
          </span>
          <span>
            <span className="kbd">{language === "zh" ? "退出" : "Esc"}</span> {language === "zh" ? "关闭" : "Close"}
          </span>
          <span className="search-foot-n">{results.length > 0 ? `${results.length} 个会话` : ""}</span>
        </div>
      </div>
    </div>
  );
}
