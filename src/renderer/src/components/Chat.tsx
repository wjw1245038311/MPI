import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type WheelEvent as ReactWheelEvent } from "react";
import { getDisplayThreadTitle, normalizeThreadFile, useStore } from "../store";
import { getTtsState, speakMessage, stopTts, subscribeTts } from "../lib/tts";
import { parseSkillBlock } from "../lib/skill-block";
import { Markdown } from "../lib/markdown";
import { formatClock } from "../lib/format";
import { collectFileArtifacts } from "../lib/artifacts";
import { parseHtmlReferenceText } from "../lib/html-reference";
import { diffLines } from "../lib/diff";
import { extractEditPairs, normalizeTranscriptText } from "../lib/tool-args";
import { findMessageOccurrences } from "../lib/chat-search";
import { MarkedDiv, useSearchMark } from "../lib/search-mark";
import { getExpandState, setExpandState } from "../lib/expand-state";
import type { ContentBlock, HtmlElementReference, ToolRun, ViewMessage } from "../lib/types";
import { Composer } from "./Composer";
import { ExtUiPromptCard } from "./ExtUiPromptCard";
import { choiceOptions, parseChoiceOutcome } from "../lib/choice";
import { splitChoiceSegments } from "../lib/choice-block";
import { ChoicePanel } from "./ChoicePanel";
import { Sidebar, PanelRight, Copy, ThumbUp, ThumbDown, Refresh, Edit, Folder, Files, Branch, Check, ChevronRight, ChevronUp, ChevronDown, ChevronsDown, Close, Search, Star, Terminal, Stop, Volume } from "./icons";
import { TuiView } from "./TuiView";
import doraemonAvatarUrl from "../../../../resources/doraemon.jpeg";
import nobitaAvatarUrl from "../../../../resources/nobita.jpg";

// Minimum user messages before the left dot rail appears. Kept low (2) so it
// shows up in essentially every real conversation — a single message has
// nowhere to jump to, but from two on the rail is useful.
const USER_MESSAGE_NAV_MIN_ITEMS = 2;
// Distance from the transcript bottom that counts as "at the latest": half of
// the visible viewport, so it scales with window size / resolution instead of
// a fixed pixel count. Scrolling back down partway into a reply re-arms
// auto-follow well before hitting the very bottom; scrolling up past this band
// is a deliberate read-history gesture and pauses follow.
const nearBottomPx = (el: HTMLElement): number => Math.floor(el.clientHeight / 2);

export function Chat() {
  const activeThreadId = useStore((s) => s.activeThreadId);
  const thread = useStore((s) => (activeThreadId ? s.threads[activeThreadId] : null));
  const projects = useStore((s) => s.projects);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const togglePreview = useStore((s) => s.togglePreview);
  const newSessionInThread = useStore((s) => s.newSessionInThread);
  const setThreadPinned = useStore((s) => s.setThreadPinned);
  const renameThread = useStore((s) => s.renameThread);
  const switchThreadFolder = useStore((s) => s.switchThreadFolder);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollPositionsRef = useRef(new Map<string, number>());
  const previousActiveThreadIdRef = useRef(activeThreadId);
  const lastAutoScrollThreadIdRef = useRef<string | null>(null);
  const lastRestoreThreadIdRef = useRef<string | null>(null);
  const highlightedUserMessageRef = useRef<HTMLElement | null>(null);
  const jumpHighlightTimerRef = useRef<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  // In-conversation search (header button / Ctrl+F): find occurrences across
  // the finalized messages of this thread and step through them.
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState("");
  // The query that actually drives the search. It follows the input with a
  // short delay so typing only triggers a full-transcript scan once per pause,
  // not on every keystroke; clearing applies immediately.
  const [debouncedChatQuery, setDebouncedChatQuery] = useState("");
  const [chatSearchIdx, setChatSearchIdx] = useState(0);
  const chatSearchInputRef = useRef<HTMLInputElement>(null);
  const searchFlashElRef = useRef<HTMLElement | null>(null);
  const searchFlashTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (chatSearchQuery === debouncedChatQuery) return;
    const t = window.setTimeout(
      () => setDebouncedChatQuery(chatSearchQuery),
      chatSearchQuery.trim() ? 200 : 0,
    );
    return () => window.clearTimeout(t);
  }, [chatSearchQuery, debouncedChatQuery]);
  // True while the viewport sits within the near-bottom band (half viewport)
  // of the transcript end. Drives the floating "jump to latest" button.
  const [atBottom, setAtBottom] = useState(true);
  // Sticky-bottom intent: stays true until the user scrolls up — wheel,
  // scrollbar drag, or keys, even a little. Unlike a per-frame distance check
  // this survives large content deltas during fast streaming (a growth larger
  // than the near-bottom band must not silently disable auto-follow — that
  // forced users to scroll down manually after each turn). Re-armed when the
  // user scrolls back into the near-bottom band.
  const stickRef = useRef(true);
  // Last scrollTop seen by handleUserScroll. Programmatic writes sync this
  // first, so their scroll events read as "no direction change" and never get
  // mistaken for a user scrolling up (or down).
  const lastScrollTopRef = useRef<number | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const language = useStore((s) => s.config?.language || "en");
  // Pi TUI mode: the whole dialog becomes an interactive pi terminal.
  const tuiMode = useStore((s) => !!s.tuiThreads[activeThreadId ?? ""]);
  const tuiPrevThreadRef = useRef(activeThreadId);
  useEffect(() => {
    const prev = tuiPrevThreadRef.current;
    tuiPrevThreadRef.current = activeThreadId;
    if (!activeThreadId) return;
    const st = useStore.getState();
    // TUI mode is tied to what's on screen: switching away from a thread in
    // TUI mode auto-exits it (PTY dies; its RPC bridge reloads from disk via
    // tuiDirty when the user comes back).
    if (prev && prev !== activeThreadId && st.tuiThreads[prev]) void st.exitTui(prev);
    if (st.tuiDirty[activeThreadId]) void st.reopenTuiThread(activeThreadId);
  }, [activeThreadId]);

  const streaming = thread?.streaming;
  const count = (thread?.messages.length || 0) + (streaming ? 1 : 0);

  const rememberScrollPosition = () => {
    const el = scrollRef.current;
    if (!el || !activeThreadId) return;
    lastScrollTopRef.current = el.scrollTop;
    scrollPositionsRef.current.set(activeThreadId, el.scrollTop);
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < nearBottomPx(el);
    stickRef.current = near;
    setAtBottom(near);
  };

  // Wheel up = intent to read history. Captured synchronously on the wheel
  // event because scroll events fire a frame late — during fast streaming
  // that gap let stale bottom positions get re-applied over an in-progress
  // scroll-up. Scrolling down is left to the scroll event, which re-arms
  // follow once we're back inside the near-bottom band (half viewport).
  const handleWheelUp = (e: ReactWheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0) stickRef.current = false;
  };

  // Direction-aware scroll handler. Any upward movement — wheel, scrollbar
  // drag, or keys — is a read-history gesture and pauses follow, even for
  // small moves that stay inside the near-bottom band (the old distance-only
  // check re-armed on the very next event, so slow drags / single wheel ticks
  // within half a viewport got yanked back down by content growth). Downward
  // movement re-arms via rememberScrollPosition once we're back in the band.
  const handleUserScroll = () => {
    const el = scrollRef.current;
    if (!el || !activeThreadId) return;
    const prev = lastScrollTopRef.current;
    const cur = el.scrollTop;
    lastScrollTopRef.current = cur;
    if (prev !== null && cur < prev - 1) {
      stickRef.current = false;
      scrollPositionsRef.current.set(activeThreadId, cur);
      setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < nearBottomPx(el));
      return;
    }
    rememberScrollPosition();
  };

  // Length of the last streaming block's content. blocks.length only changes
  // when a NEW block starts; without this, text/thinking deltas inside one
  // block never re-run the effect and long replies stop following the bottom.
  const streamTailLen = (() => {
    const blocks = streaming?.blocks;
    if (!blocks || blocks.length === 0) return 0;
    const last = blocks[blocks.length - 1];
    return last.type === "text" ? last.text.length : last.type === "thinking" ? last.thinking.length : 0;
  })();

  // auto-scroll to bottom on new content
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const switchedThread =
      lastAutoScrollThreadIdRef.current !== null &&
      lastAutoScrollThreadIdRef.current !== activeThreadId;
    lastAutoScrollThreadIdRef.current = activeThreadId;
    // A restored position is authoritative during a thread switch. Within the
    // already active thread, follow only while the user's intent is to follow
    // (stick): any upward scroll — wheel or scrollbar drag — pauses it until
    // they scroll back into the near-bottom band (handleUserScroll).
    if (!switchedThread && stickRef.current) {
      el.scrollTop = el.scrollHeight;
      rememberScrollPosition();
    } else if (!switchedThread && activeThreadId && !scrollPositionsRef.current.has(activeThreadId)) {
      // Capture the initial position too, including an intentional scroll at
      // the top, so it can be restored even if no scroll event fires later.
      rememberScrollPosition();
    }
  }, [activeThreadId, count, streamTailLen, streaming?.blocks?.length, thread?.messages.length]);

  // When the active thread's turn finishes (streaming → null), jump back to
  // the latest message — users expect the transcript to end at the bottom.
  const prevStreamRef = useRef<{ id: string | null; on: boolean }>({ id: activeThreadId, on: false });
  useEffect(() => {
    const now = !!thread?.streaming;
    const prev = prevStreamRef.current;
    prevStreamRef.current = { id: activeThreadId, on: now };
    if (prev.id === activeThreadId && prev.on && !now) {
      // Only pull back to the latest message when the user was following —
      // scrolling up mid-turn means they're reading history, and yanking them
      // down on turn end is exactly what this guard prevents. The floating
      // "jump to latest" button covers the explicit return.
      if (!stickRef.current) return;
      const el = scrollRef.current;
      if (el) {
        // The restore layout-effect re-applies the saved position on the
        // count change that finalizes the turn; its rAF callback would snap
        // back up over a same-commit scroll. Queue ours after it instead.
        stickRef.current = true;
        setAtBottom(true);
        const frame = requestAnimationFrame(() => {
          el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        });
        return () => cancelAnimationFrame(frame);
      }
    }
  }, [thread?.streaming, activeThreadId]);

  // The chat DOM is reused when activeThreadId changes. Without an explicit
  // per-thread position, the browser clamps the reused scroll container to
  // the new transcript's top, so returning to a thread loses its last view.
  useLayoutEffect(() => {
    const previousThreadId = previousActiveThreadIdRef.current;
    const el = scrollRef.current;
    if (
      previousThreadId &&
      previousThreadId !== activeThreadId &&
      el &&
      !scrollPositionsRef.current.has(previousThreadId)
    ) {
      scrollPositionsRef.current.set(previousThreadId, el.scrollTop);
    }
    previousActiveThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !activeThreadId || thread?.loading) return;
    const switchedThread = lastRestoreThreadIdRef.current !== activeThreadId;
    // First restore after mount (e.g. the session reopened on startup): keep
    // stick as-is so a fresh long transcript still lands at the latest message
    // instead of being treated as "reading history".
    const firstRestore = lastRestoreThreadIdRef.current === null;
    lastRestoreThreadIdRef.current = activeThreadId;
    const saved = scrollPositionsRef.current.get(activeThreadId);

    if (switchedThread && saved !== undefined) {
      // Thread switch: the saved position is authoritative. Re-derive follow
      // intent from where we land — a stale stick=true left by another thread
      // must not yank this one to its bottom on the next content change.
      const restore = () => {
        const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
        el.scrollTop = Math.min(saved, maxScrollTop);
        lastScrollTopRef.current = el.scrollTop; // programmatic: not user intent
        const near = el.scrollHeight - el.scrollTop - el.clientHeight < nearBottomPx(el);
        stickRef.current = near;
        setAtBottom(near);
      };

      restore();
      const frame = window.requestAnimationFrame(restore);
      return () => window.cancelAnimationFrame(frame);
    }

    if (switchedThread && saved === undefined && !firstRestore) {
      // First visit to this thread while the app is running: no saved view to
      // honor, so re-derive follow intent from wherever the reused container
      // currently sits instead of inheriting a stale stick from another thread.
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < nearBottomPx(el);
      stickRef.current = near;
      setAtBottom(near);
      lastScrollTopRef.current = el.scrollTop;
    }

    if (!switchedThread && saved !== undefined) {
      // Same-thread content growth: never write scrollTop while the user is
      // reading history — scroll events lag a frame, so a stale saved value
      // would yank an in-progress scroll-up back to the bottom. In follow
      // mode re-applying is harmless (also recovers a remounted container).
      if (stickRef.current) {
        const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
        el.scrollTop = Math.min(saved, maxScrollTop);
        lastScrollTopRef.current = el.scrollTop; // programmatic: not user intent
        setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < nearBottomPx(el));
      } else {
        scrollPositionsRef.current.set(activeThreadId, el.scrollTop);
        setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < nearBottomPx(el));
      }
    }
  }, [activeThreadId, count, streaming?.blocks?.length, thread?.loading]);

  useEffect(() => {
    if (!previewImage) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setPreviewImage(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [previewImage]);

  // Switching conversations resets the in-conversation search entirely.
  useEffect(() => {
    setChatSearchOpen(false);
    setChatSearchQuery("");
    setChatSearchIdx(0);
  }, [activeThreadId]);

  // The terminal view has no message anchors; never keep the bar open there.
  useEffect(() => {
    if (tuiMode) setChatSearchOpen(false);
  }, [tuiMode]);

  // Ctrl/Cmd+F opens (or refocuses) the in-conversation search, unless a
  // global modal/panel is on top or the thread is in TUI mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key.toLowerCase() !== "f") return;
      const st = useStore.getState();
      if (st.settingsOpen || st.searchOpen || st.pluginsOpen || st.automationOpen || st.messagingOpen) return;
      if (st.tuiThreads[st.activeThreadId ?? ""]) return;
      e.preventDefault();
      setChatSearchOpen(true);
      requestAnimationFrame(() => chatSearchInputRef.current?.focus());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    return () => {
      if (jumpHighlightTimerRef.current !== null) window.clearTimeout(jumpHighlightTimerRef.current);
      if (searchFlashTimerRef.current !== null) window.clearTimeout(searchFlashTimerRef.current);
    };
  }, []);

  if (!thread || !activeThreadId) return null;

  // Optimistic open: the pi process is still booting. Show the chrome plus a
  // spinner immediately instead of leaving the previous view frozen.
  if (thread.loading) {
    return (
      <section className="main">
        <div className="chat-head">
          <button className="iconbtn" title={language === "zh" ? "切换导航栏" : "Toggle sidebar"} onClick={toggleSidebar}>
            <Sidebar size={16} />
          </button>
          <div className="chat-head-titlewrap">
            <div className="chat-head-title">{language === "zh" ? "新会话" : "New Session"}</div>
          </div>
          <div className="spacer" />
        </div>
        <div className="chat-loading">
          <span className="spinner" />
          正在启动 pi 进程…
        </div>
      </section>
    );
  }

  const firstUserText = thread.messages.find((m) => m.role === "user")?.text || "";
  const isEmptyDraft = thread.messages.length === 0 && !thread.streaming;
  const titleFile = thread.sessionFile || activeThreadId;
  // Sidebar summary of the active session: source for its display title and
  // pin state (the header star toggles this).
  const activeSummary = activeThreadId
    ? projects
        .flatMap((project) => project.threads)
        .find((summary) => normalizeThreadFile(summary.file || summary.id) === normalizeThreadFile(titleFile))
    : undefined;
  const sidebarTitle = activeSummary?.title || "";
  const isPinned = !!activeSummary?.pinned;
  // A stale fresh-session flag must never hide the title of a real transcript.
  // Once this view has messages, derive the header from this thread itself;
  // only an actually empty draft uses the default label.
  const title = isEmptyDraft
    ? language === "zh" ? "新会话" : "New Session"
    : getDisplayThreadTitle(sidebarTitle || thread.sessionName, firstUserText, language).slice(0, 40) || (language === "zh" ? "新会话" : "New Session");

  // Group consecutive assistant messages into one visual turn: a single agent
  // round emits many assistant messages (think -> tool -> ... -> final reply)
  // separated only by tool results, which are not rendered as bubbles. They
  // share ONE avatar; a user message starts a new group. thread.messages keeps
  // a stable identity during token streaming, so this memo only recomputes when
  // a message finalizes.
  const groups = useMemo(() => groupMessages(thread.messages), [thread.messages]);
  const lastGroup = groups[groups.length - 1];
  const streamingExtends = !!streaming && !!lastGroup && lastGroup.role === "assistant";
  const headGroups = streamingExtends ? groups.slice(0, -1) : groups;
  const userGroups = useMemo(
    () => groups.filter((group) => group.items[0]?.role === "user"),
    [groups],
  );

  // In-conversation search state, derived from the finalized messages only
  // and driven by the debounced query (see above).
  const searchOccurrences = useMemo(
    () => findMessageOccurrences(thread.messages, debouncedChatQuery),
    [thread.messages, debouncedChatQuery],
  );
  const clampedSearchIdx = Math.min(chatSearchIdx, Math.max(0, searchOccurrences.length - 1));
  // Comma-joined signature (stable string) so MessageGroup's memo comparator
  // can compare it cheaply; rebuilt only when the match set actually changes.
  const searchHitSig = useMemo(
    () => [...new Set(searchOccurrences.map((o) => o.messageKey))].join(","),
    [searchOccurrences],
  );
  const searchingDim = chatSearchOpen && !tuiMode && searchOccurrences.length > 0;
  // Lowercased query passed to every message for inline <mark> highlighting
  // (browser find-in-page style); null when there is nothing to highlight.
  const searchMarkQuery = useMemo(
    () => (searchingDim ? debouncedChatQuery.trim().toLowerCase() : null),
    [searchingDim, debouncedChatQuery],
  );

  const jumpToUserMessage = (key: string) => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const target = Array.from(scroll.querySelectorAll<HTMLElement>("[data-user-message-key]"))
      .find((node) => node.dataset.userMessageKey === key);
    if (!target) return;

    const scrollRect = scroll.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const targetOffset = targetRect.top - scrollRect.top - (scroll.clientHeight - targetRect.height) / 2;
    const maxScrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    const nextScrollTop = Math.min(maxScrollTop, Math.max(0, scroll.scrollTop + targetOffset));
    scroll.scrollTo({
      top: nextScrollTop,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });

    highlightedUserMessageRef.current?.classList.remove("message-jump-target");
    target.classList.remove("message-jump-target");
    void target.offsetWidth;
    target.classList.add("message-jump-target");
    highlightedUserMessageRef.current = target;
    if (jumpHighlightTimerRef.current !== null) window.clearTimeout(jumpHighlightTimerRef.current);
    jumpHighlightTimerRef.current = window.setTimeout(() => {
      target.classList.remove("message-jump-target");
      if (highlightedUserMessageRef.current === target) highlightedUserMessageRef.current = null;
      jumpHighlightTimerRef.current = null;
    }, 900);
  };

  // Scroll a message anchor into the vertical center of the viewport and
  // flash it (same math as jumpToUserMessage, generalized to any message).
  const scrollToMessageKey = (key: string) => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const target = Array.from(scroll.querySelectorAll<HTMLElement>("[data-message-key]"))
      .find((node) => node.dataset.messageKey === key);
    if (!target) return;

    const scrollRect = scroll.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const targetOffset = targetRect.top - scrollRect.top - (scroll.clientHeight - targetRect.height) / 2;
    const maxScrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    const nextScrollTop = Math.min(maxScrollTop, Math.max(0, scroll.scrollTop + targetOffset));
    scroll.scrollTo({
      top: nextScrollTop,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });

    searchFlashElRef.current?.classList.remove("chat-search-flash");
    target.classList.remove("chat-search-flash");
    void target.offsetWidth;
    target.classList.add("chat-search-flash");
    searchFlashElRef.current = target;
    if (searchFlashTimerRef.current !== null) window.clearTimeout(searchFlashTimerRef.current);
    searchFlashTimerRef.current = window.setTimeout(() => {
      target.classList.remove("chat-search-flash");
      if (searchFlashElRef.current === target) searchFlashElRef.current = null;
      searchFlashTimerRef.current = null;
    }, 900);
  };

  const stepChatSearch = (dir: 1 | -1) => {
    if (searchOccurrences.length === 0) return;
    setChatSearchIdx((i) => {
      const cur = Math.min(i, searchOccurrences.length - 1);
      return (cur + dir + searchOccurrences.length) % searchOccurrences.length;
    });
  };

  // Keep the current occurrence visible: on open/first keystroke jump to the
  // first match; afterwards follow Enter / arrow navigation.
  useEffect(() => {
    if (!chatSearchOpen || tuiMode || searchOccurrences.length === 0) return;
    scrollToMessageKey(searchOccurrences[clampedSearchIdx].messageKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatSearchIdx, debouncedChatQuery, chatSearchOpen]);

  const onChatSearchInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      stepChatSearch(e.shiftKey ? -1 : 1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      stepChatSearch(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      stepChatSearch(-1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setChatSearchOpen(false);
    }
  };

  const startRename = () => {
    setEditValue(thread.sessionName || "");
    setEditing(true);
    requestAnimationFrame(() => editInputRef.current?.focus());
  };

  const commitRename = () => {
    setEditing(false);
    const v = editValue.trim();
    if (v) renameThread(activeThreadId, v);
  };

  const cancelRename = () => {
    setEditing(false);
  };

  // Shared search props for every MessageGroup (all primitives, so the memo
  // comparator stays cheap).
  const groupSearchProps = {
    searchHitKeys: searchingDim ? searchHitSig : null,
    searchCurrentKey: searchingDim && searchOccurrences.length > 0 ? searchOccurrences[clampedSearchIdx].messageKey : null,
    searchMarkQuery,
  };

  return (
    <section className="main">
      <div className="chat-head">
        <button className="iconbtn" title={language === "zh" ? "切换导航栏" : "Toggle sidebar"} onClick={toggleSidebar}>
          <Sidebar size={16} />
        </button>
        <div className="chat-head-titlewrap">
          {editing ? (
            <input
              ref={editInputRef}
              className="chat-head-input"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") cancelRename();
              }}
              onBlur={commitRename}
            />
          ) : (
            <>
              <div key={`${activeThreadId}:${title}`} className="chat-head-title" title={title} onDoubleClick={startRename}>
                {title}
              </div>
              {thread.cwd && (
                <button
                  className="chat-head-folder"
                  title={`在文件管理器中打开：${thread.cwd}`}
                  onClick={() => {
                    window.pi.settings.openPath(thread.cwd).catch(() => {});
                  }}
                >
                  <Folder size={11} />
                  <span className="chat-head-folder-path">{thread.cwd}</span>
                </button>
              )}
            </>
          )}
        </div>
        {!thread.connected && (
          <span className="chat-connecting" title="pi 进程连接中；历史已可浏览，发送消息会自动等待连接完成">
            <span className="spinner" /> 连接中
          </span>
        )}
        {/* All action buttons live on the right; the title keeps the middle. */}
        <div className="spacer" />
        <button
          className={`iconbtn ${chatSearchOpen ? "on" : ""}`}
          title="搜索本会话消息（Ctrl+F）"
          onClick={() => {
            if (chatSearchOpen) {
              setChatSearchOpen(false);
            } else {
              setChatSearchOpen(true);
              requestAnimationFrame(() => chatSearchInputRef.current?.focus());
            }
          }}
        >
          <Search size={14} />
        </button>
        {activeThreadId && (
          <button
            className={`iconbtn ${isPinned ? "on" : ""}`}
            title={isPinned ? "取消置顶会话" : "置顶会话"}
            onClick={() => activeSummary && void setThreadPinned(activeSummary.file, !isPinned)}
          >
            <Star size={14} />
          </button>
        )}
        <button className="iconbtn" title="重命名" onClick={startRename}>
          <Edit size={14} />
        </button>
        <button className="iconbtn" title="切换工作文件夹" onClick={() => switchThreadFolder(activeThreadId)}>
          <Folder size={15} />
        </button>
        <button className="iconbtn" title="新建会话" onClick={() => newSessionInThread(activeThreadId)}>
          <Refresh size={15} />
        </button>
        {activeThreadId && (
          <button
            className={`iconbtn ${tuiMode ? "on" : ""}`}
            disabled={!thread.sessionFile}
            title={
              !thread.sessionFile
                ? language === "zh"
                  ? "会话尚未建立，暂不可用"
                  : "Session not established yet"
                : tuiMode
                  ? language === "zh"
                    ? "切换到 Pi GUI（自定义界面）"
                    : "Switch to Pi GUI (custom interface)"
                  : language === "zh"
                    ? "切换到 Pi TUI 终端（交互式 pi）"
                    : "Switch to Pi TUI terminal (interactive pi)"
            }
            onClick={() => useStore.getState().toggleTui(activeThreadId)}
          >
            <Terminal size={16} />
          </button>
        )}
        <button className="iconbtn" title="切换预览" onClick={togglePreview}>
          <PanelRight size={16} />
        </button>
      </div>

      {chatSearchOpen && !tuiMode && (
        <div className="chat-search">
          <span className="chat-search-ico" aria-hidden="true">
            <Search size={13} />
          </span>
          <input
            ref={chatSearchInputRef}
            className="chat-search-input"
            value={chatSearchQuery}
            onChange={(e) => setChatSearchQuery(e.target.value)}
            onKeyDown={onChatSearchInputKey}
            placeholder="搜索本会话…"
            aria-label="会话内消息搜索"
            spellCheck={false}
          />
          {searchOccurrences.length > 0 ? (
            <span className="chat-search-count">
              {clampedSearchIdx + 1}/{searchOccurrences.length}
            </span>
          ) : chatSearchQuery.trim() ? (
            <span className="chat-search-count none">无匹配</span>
          ) : null}
          <button
            className="iconbtn"
            title="上一个匹配（Shift+Enter）"
            disabled={searchOccurrences.length === 0}
            onClick={() => stepChatSearch(-1)}
          >
            <ChevronUp size={14} />
          </button>
          <button
            className="iconbtn"
            title="下一个匹配（Enter）"
            disabled={searchOccurrences.length === 0}
            onClick={() => stepChatSearch(1)}
          >
            <ChevronDown size={14} />
          </button>
          <button className="iconbtn" title="关闭搜索（Esc）" onClick={() => setChatSearchOpen(false)}>
            <Close size={13} />
          </button>
        </div>
      )}

      {tuiMode ? (
        <TuiView threadId={activeThreadId} cwd={thread.cwd} sessionFile={thread.sessionFile} />
      ) : (
        <>
          <div className="chat-stage">
            <div className="chat-scroll" ref={scrollRef} onScroll={handleUserScroll} onWheel={handleWheelUp}>
          <div className={`messages${searchingDim ? " searching" : ""}`}>
            {headGroups.map((g) => (
              <MessageGroup
                key={g.key}
                threadId={activeThreadId}
                group={g}
                toolRuns={thread.toolRuns}
                locked={thread.isStreaming}
                onPreviewImage={setPreviewImage}
                {...groupSearchProps}
              />
            ))}
            {streaming && streamingExtends && lastGroup && (
              <MessageGroup
                key={lastGroup.key}
                threadId={activeThreadId}
                group={{ key: lastGroup.key, role: "assistant", items: [...lastGroup.items, streaming] }}
                toolRuns={thread.toolRuns}
                locked
                streaming
                onPreviewImage={setPreviewImage}
                {...groupSearchProps}
              />
            )}
            {streaming && !streamingExtends && (
              <MessageGroup
                key={streaming.key}
                threadId={activeThreadId}
                group={{ key: streaming.key, role: "assistant", items: [streaming] }}
                toolRuns={thread.toolRuns}
                locked
                streaming
                onPreviewImage={setPreviewImage}
                {...groupSearchProps}
              />
            )}
            {thread.error && (
              <div className="msg system">
                <div className="msg-body">⚠ {thread.error}</div>
              </div>
            )}
          </div>
        </div>
        {userGroups.length >= USER_MESSAGE_NAV_MIN_ITEMS && (
          <UserMessageNav groups={userGroups} language={language} onJump={jumpToUserMessage} />
        )}
        {!atBottom && count > 0 && (
          <button
            className="jump-latest"
            title={language === "zh" ? "跳转到最新消息" : "Jump to latest"}
            onClick={() => {
              const el = scrollRef.current;
              if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
            }}
          >
            <ChevronsDown size={18} />
          </button>
        )}
      </div>

      <div className="composer-confirmation-region" aria-live="assertive">
        <ExtUiPromptCard threadId={activeThreadId} />
      </div>
      {thread.bricked && (
        <div className="brick-banner" role="alert">
          <div className="brick-text">
            {language === "zh" ? (
              <>会话文件已损坏，后续每条消息都会失败（{thread.bricked.kind === "whitespace" ? "工具输出为空被 provider 拒绝" : "压缩记录位置异常导致 tool call 配对断裂"}）。可一键修复。</>
            ) : (
              <>Session file is bricked — every further message will fail ({thread.bricked.kind === "whitespace" ? "empty tool output rejected by the provider" : "a stale compaction entry breaks a tool-call pair"}). One-click repair available.</>
            )}
          </div>
          <button
            className="brick-fix"
            disabled={!!thread.repairing}
            onClick={() => void useStore.getState().repairSession(activeThreadId)}
          >
            {language === "zh" ? (thread.repairing ? "修复中…" : "一键修复并重新加载") : thread.repairing ? "Repairing…" : "Repair & reload"}
          </button>
        </div>
      )}
          <Composer threadId={activeThreadId} />
        </>
      )}
      {previewImage && (
        <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="图片预览" onMouseDown={() => setPreviewImage(null)}>
          <button className="image-lightbox-close" title="关闭" onClick={() => setPreviewImage(null)}>×</button>
          <img className="image-lightbox-img" src={previewImage} alt="图片预览" onMouseDown={(e) => e.stopPropagation()} />
        </div>
      )}
    </section>
  );
}

/** Tool-run ids a message actually renders — for targeted re-render checks. */
function referencedRunIds(m: ViewMessage): string[] {
  if (!m.blocks) return [];
  const ids: string[] = [];
  for (const b of m.blocks) if (b.type === "toolCall") ids.push(b.id);
  return ids;
}

/** A visual turn: one user message, or a run of consecutive assistant messages
 *  (a whole agent round) rendered under a single avatar. */
interface MsgGroup {
  key: string;
  role: "user" | "assistant" | "custom";
  items: ViewMessage[];
}

function groupMessages(messages: ViewMessage[]): MsgGroup[] {
  const groups: MsgGroup[] = [];
  for (const m of messages) {
    const last = groups[groups.length - 1];
    if (m.role === "assistant" && last && last.role === "assistant") {
      last.items.push(m);
    } else {
      groups.push({ key: m.key, role: m.role === "custom" ? "custom" : m.role === "assistant" ? "assistant" : "user", items: [m] });
    }
  }
  return groups;
}

function userMessagePreview(group: MsgGroup, language: string): string {
  const text = (group.items[0]?.text || "").replace(/\s+/g, " ").trim();
  if (!text) return language === "zh" ? "图片消息" : "Image message";
  const chars = Array.from(text);
  return chars.length > 20 ? `${chars.slice(0, 20).join("")}…` : text;
}

function UserMessageNav({
  groups,
  language,
  onJump,
}: {
  groups: MsgGroup[];
  language: string;
  onJump: (key: string) => void;
}) {
  const navRef = useRef<HTMLElement>(null);
  const [hovered, setHovered] = useState<{ text: string; top: number } | null>(null);

  if (groups.length < USER_MESSAGE_NAV_MIN_ITEMS) return null;

  return (
    <nav
      ref={navRef}
      className="user-message-nav"
      aria-label={language === "zh" ? "用户消息导航" : "User message navigation"}
    >
      <div className="user-message-nav-scroll">
        {groups.map((group, index) => {
          const preview = userMessagePreview(group, language);
          return (
            <button
              key={group.key}
              type="button"
              className="user-message-nav-dot"
              aria-label={language === "zh" ? `跳转到第 ${index + 1} 条用户消息：${preview}` : `Jump to user message ${index + 1}: ${preview}`}
              title={preview}
              onClick={() => onJump(group.key)}
              onMouseEnter={(event) => {
                const nav = navRef.current;
                if (!nav) return;
                const navRect = nav.getBoundingClientRect();
                const dotRect = event.currentTarget.getBoundingClientRect();
                setHovered({ text: preview, top: dotRect.top - navRect.top + dotRect.height / 2 });
              }}
              onMouseLeave={() => setHovered(null)}
              onFocus={(event) => {
                const nav = navRef.current;
                if (!nav) return;
                const navRect = nav.getBoundingClientRect();
                const dotRect = event.currentTarget.getBoundingClientRect();
                setHovered({ text: preview, top: dotRect.top - navRect.top + dotRect.height / 2 });
              }}
              onBlur={() => setHovered(null)}
            >
              <span aria-hidden="true" />
            </button>
          );
        })}
      </div>
      {hovered && <div className="user-message-nav-tooltip" style={{ top: hovered.top }}>{hovered.text}</div>}
    </nav>
  );
}

/**
 * Memoized on (group identity, streaming flag, and only the tool runs this
 * group references). Past groups are immutable in the store, so during
 * streaming only the live group re-renders — not the whole history.
 */
const MessageGroup = memo(MessageGroupInner, (prev, next) => {
  if (
    prev.group !== next.group ||
    prev.threadId !== next.threadId ||
    prev.locked !== next.locked ||
    !!prev.streaming !== !!next.streaming
    || prev.onPreviewImage !== next.onPreviewImage
    || prev.searchHitKeys !== next.searchHitKeys
    || prev.searchCurrentKey !== next.searchCurrentKey
    || prev.searchMarkQuery !== next.searchMarkQuery
  ) {
    return false;
  }
  for (const m of prev.group.items) {
    for (const id of referencedRunIds(m)) {
      if (prev.toolRuns[id] !== next.toolRuns[id]) return false;
    }
  }
  return true;
});

function MessageGroupInner({
  threadId,
  group,
  toolRuns,
  locked,
  streaming,
  onPreviewImage,
  searchHitKeys,
  searchCurrentKey,
  searchMarkQuery,
}: {
  threadId: string;
  group: MsgGroup;
  toolRuns: Record<string, ToolRun>;
  locked?: boolean;
  streaming?: boolean;
  onPreviewImage: (src: string) => void;
  /** Comma-joined message keys with ≥1 search occurrence; null = inactive. */
  searchHitKeys?: string | null;
  /** Message key of the currently displayed occurrence, if any. */
  searchCurrentKey?: string | null;
  /** Lowercased query for inline <mark> highlighting; null = off/no matches. */
  searchMarkQuery?: string | null;
}) {
  const hitSet = useMemo(() => (searchHitKeys ? new Set(searchHitKeys.split(",")) : null), [searchHitKeys]);
  // Class suffix for a message anchor: dimmed unless it matches, ringed when
  // it is the currently displayed occurrence.
  const searchClass = (key: string): string => {
    if (!hitSet) return "";
    let cls = hitSet.has(key) ? " search-hit" : "";
    if (searchCurrentKey === key) cls += " search-current";
    return cls;
  };
  // Inline <mark> highlighting for the custom-note branch (browser
  // find-in-page style; marks live in the DOM — see lib/search-mark).
  const firstItemText = group.items[0]?.text ?? "";
  const customMarkRef = useSearchMark(group.role === "custom" ? (searchMarkQuery ?? null) : null, firstItemText);
  const forkThread = useStore((s) => s.forkThread);
  const openPreview = useStore((s) => s.openPreview);
  const cwd = useStore((s) => s.threads[threadId]?.cwd || "");
  const language = useStore((s) => s.config?.language || "en");
  const userAvatar = useStore((s) => s.config?.userAvatar);
  const agentAvatar = useStore((s) => s.config?.agentAvatar);
  const [forking, setForking] = useState(false);
  const artifacts = useMemo(
    () => (group.role === "assistant" ? collectFileArtifacts(group.items, toolRuns, cwd) : []),
    [cwd, group.items, group.role, toolRuns],
  );
  const artifactCheckKey = useMemo(() => {
    const paths = artifacts.map((artifact) => artifact.path.toLowerCase()).join("|");
    const toolStates = group.items
      .flatMap((message) => (message.blocks || []).filter((block) => block.type === "toolCall"))
      .map((block) => {
        const run = toolRuns[block.id];
        return `${block.id}:${run?.running ? "running" : run?.completed ? "done" : "pending"}:${run?.isError ? "error" : "ok"}`;
      })
      .join("|");
    return `${paths}::${toolStates}`;
  }, [artifacts, group.items, toolRuns]);
  const [artifactExists, setArtifactExists] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    if (!artifacts.length) {
      setArtifactExists({});
      return () => {
        cancelled = true;
      };
    }
    void Promise.all(
      artifacts.map(async (artifact) => {
        const key = artifact.path.toLowerCase();
        try {
          const exists = await window.pi.app.fileExists(artifact.path);
          return [key, !!exists] as const;
        } catch {
          // Keep the historical artifact visible when an existence probe is
          // unavailable; the click handler will perform the same safe check.
          return [key, true] as const;
        }
      }),
    ).then((results) => {
      if (!cancelled) setArtifactExists(Object.fromEntries(results));
    });
    return () => {
      cancelled = true;
    };
  }, [artifactCheckKey]);

  const visibleArtifacts = artifacts.filter((artifact) => artifactExists[artifact.path.toLowerCase()] !== false);

  // Native pi fork: branch before the selected user message; its text is prefilled in the editor.
  const runUserFork = async (entryId?: string) => {
    if (locked || forking || !entryId) return;
    setForking(true);
    try {
      await forkThread(threadId, entryId);
    } finally {
      setForking(false);
    }
  };

  // Extension command output (/mem0-status, …): a quiet centered note.
  if (group.role === "custom") {
    const m = group.items[0];
    return (
      <div className={`msg custom${searchClass(m.key)}`} data-message-key={m.key}>
        <div className="msg-body">
          <Markdown text={m.text || ""} containerRef={customMarkRef} />
        </div>
      </div>
    );
  }

  if (group.role === "user") {
    const m = group.items[0];
    const parsedHtml = m.text ? parseHtmlReferenceText(m.text) : { text: "", references: [] };
    const skillBlock = parsedHtml.text ? parseSkillBlock(parsedHtml.text) : null;
    const openAttachment = async (attachment: NonNullable<ViewMessage["attachments"]>[number]) => {
      if (!attachment.path) return;
      try {
        const exists = await window.pi.app.fileExists(attachment.path);
        if (!exists) return;
      } catch {
        // Let the preview panel report the read error if the existence probe
        // is unavailable in the current environment.
      }
      await openPreview(attachment.path, cwd);
    };
    return (
      <div className={`msg user${searchClass(m.key)}`} data-user-message-key={group.key} data-message-key={m.key}>
        <div className="msg-user-stack">
          <div className="msg-body">
            {m.sendKind && (
              <div className={`msg-kind ${m.sendKind}`}>
                {m.sendKind === "steer" ? (language === "zh" ? "立即插入" : "steering") : language === "zh" ? "待处理后续" : "follow-up"}
              </div>
            )}
            {skillBlock ? (
              <>
                <SkillInvocation name={skillBlock.name} language={language} />
                {skillBlock.userMessage && (
                  <MarkedDiv className="msg-user-text msg-user-skill-request" query={searchMarkQuery}>
                    {skillBlock.userMessage}
                  </MarkedDiv>
                )}
              </>
            ) : (
              parsedHtml.text && (
                <MarkedDiv className="msg-user-text" query={searchMarkQuery}>
                  {parsedHtml.text}
                </MarkedDiv>
              )
            )}
            {parsedHtml.references.length > 0 && (
              <div className="msg-html-references" aria-label={language === "zh" ? "HTML 元素引用" : "HTML element references"}>
                {parsedHtml.references.map((reference) => (
                  <HtmlReferenceCard key={reference.id} reference={reference} language={language} />
                ))}
              </div>
            )}
            {m.images && m.images.length > 0 && (
              <div className="msg-user-imgs">
                {m.images.map((im, i) => (
                  <button key={i} className="msg-user-img-button" onClick={() => onPreviewImage(im.dataUrl)} title="图片预览">
                    <img className="msg-user-img" src={im.dataUrl} alt={language === "zh" ? "附件" : "attachment"} />
                  </button>
                ))}
              </div>
            )}
            {m.attachments && m.attachments.length > 0 && (
              <div className="msg-user-files" aria-label={language === "zh" ? "文件附件与引用" : "File attachments and quotes"}>
                {m.attachments.map((attachment, index) =>
                  attachment.kind === "quote" ? (
                    // Conversation quote (right-click → 引用): a non-clickable
                    // chip; the model-facing envelope carries its location.
                    <div key={`quote-${index}`} className="msg-user-quote" title={attachment.note || attachment.name}>
                      <span className="msg-user-quote-icon" aria-hidden="true">❝</span>
                      <span className="msg-user-quote-text">
                        {language === "zh" ? "引用：" : "quote: "}
                        {attachment.note || "…"}
                      </span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="msg-user-file"
                      key={`${attachment.name}-${index}`}
                      disabled={!attachment.path}
                      title={attachment.path ? language === "zh" ? "在 MPI 中查看附件" : "View attachment in MPI" : attachment.name}
                      aria-label={attachment.path ? `${language === "zh" ? "查看附件" : "View attachment"}: ${attachment.name}` : attachment.name}
                      onClick={() => void openAttachment(attachment)}
                    >
                      <span className="msg-user-file-icon" aria-hidden="true">
                        <Files size={15} />
                      </span>
                      <span className="msg-user-file-copy">
                        <span className="msg-user-file-name">{attachment.name}</span>
                        <span className={`msg-user-file-meta${attachment.error ? " error" : ""}`}>
                          {attachment.error
                            ? language === "zh" ? "附件读取失败" : "Attachment unavailable"
                            : language === "zh" ? "文件附件" : "File attachment"}
                        </span>
                      </span>
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
          <div className="msg-user-actions">
            <button
              disabled={!m.text}
              title="复制这条用户消息"
              onClick={() => m.text && navigator.clipboard?.writeText(m.text)}
            >
              <Copy size={11} /> 复制
            </button>
            <button
              disabled={locked || forking || !m.branchEntryId}
              title={m.branchEntryId
                ? language === "zh"
                  ? "从这条提问创建新分支（原提示词会填入输入框，可修改后发送）"
                  : "Fork a new session from this prompt (its text is prefilled in the editor)"
                : language === "zh" ? "连接并保存会话后可创建分支" : "Fork is available after the session connects and saves"}
              onClick={() => void runUserFork(m.branchEntryId)}
            >
              <Branch size={11} /> {forking ? (language === "zh" ? "创建中…" : "Forking…") : language === "zh" ? "分支" : "Fork"}
            </button>
          </div>
        </div>
        <div className="msg-avatar" aria-label="用户">
          {userAvatar ? (
            <img className="msg-avatar-img" src={userAvatar} alt="" />
          ) : (
            <img className="msg-avatar-img" src={nobitaAvatarUrl} alt="" />
          )}
        </div>
      </div>
    );
  }

  // Assistant round: ONE avatar shared by every assistant message in the group.
  const last = group.items[group.items.length - 1];
  const hasBlocks = group.items.some((m) => m.blocks && m.blocks.length > 0);
  const openArtifact = async (artifact: (typeof artifacts)[number]) => {
    try {
      const exists = await window.pi.app.fileExists(artifact.path);
      if (!exists) {
        setArtifactExists((current) => ({ ...current, [artifact.path.toLowerCase()]: false }));
        return;
      }
    } catch {
      // Fall through to the normal preview path if the probe is unavailable.
    }
    openPreview(artifact.path, cwd);
  };
  return (
    <div className="msg assistant">
      <div className="msg-avatar" aria-label={language === "zh" ? "MPI 智能体" : "MPI Agent"}>
        <img className="msg-avatar-img" src={agentAvatar || doraemonAvatarUrl} alt="" />
      </div>
      <div className="msg-body">
        {renderAssistantBlocks(
          group.items,
          toolRuns,
          language,
          threadId,
          searchClass,
          searchMarkQuery ?? null,
          // When this group carries the in-progress message it is always the
          // last item — its text changes every stream tick, so skip inline
          // marks for it (message-level ring/flash still applies).
          streaming ? group.items[group.items.length - 1]?.key ?? null : null,
        )}
        {streaming && !hasBlocks && <span className="muted">思考中</span>}
        {streaming && <span className="streaming-dot" />}
        {last.errorMessage && <div style={{ color: "#c0392b", marginTop: 6 }}>{last.errorMessage}</div>}
        {visibleArtifacts.length > 0 && (
          <section className="msg-artifacts" aria-label={language === "zh" ? "文件产物" : "File outputs"}>
            <div className="msg-artifacts-head">
              <Files size={13} />
              <span>{language === "zh" ? "文件产物" : "File outputs"}</span>
              <span className="msg-artifacts-count">{visibleArtifacts.length}</span>
            </div>
            <div className="msg-artifacts-list">
              {visibleArtifacts.map((artifact) => (
                <button
                  key={artifact.path.toLowerCase()}
                  className="msg-artifact"
                  title={`${language === "zh" ? "在 MPI 中查看" : "View in MPI"} · ${artifact.path}`}
                  onClick={() => void openArtifact(artifact)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void window.pi.app.showFileContextMenu(artifact.path);
                  }}
                >
                  <span className="msg-artifact-icon" aria-hidden="true">
                    {artifact.ext ? artifact.ext.slice(1, 5).toUpperCase() : <Files size={14} />}
                  </span>
                  <span className="msg-artifact-copy">
                    <span className="msg-artifact-name">{artifact.name}</span>
                    <span className="msg-artifact-path">{artifact.displayPath}</span>
                  </span>
                  <span className={`msg-artifact-action ${artifact.action}`}>
                    {language === "zh"
                      ? artifact.action === "created"
                        ? "已生成"
                        : "已更新"
                      : artifact.action === "created"
                        ? "Created"
                        : "Updated"}
                  </span>
                  <PanelRight size={14} className="msg-artifact-open" />
                </button>
              ))}
            </div>
          </section>
        )}
        {!streaming && (
          <div className="msg-footer">
            {last.model && <span>{last.model}</span>}
            {last.timestamp && <span>{formatClock(last.timestamp)}</span>}
            <span className="msg-actions">
              {speechTextOfGroup(group) && (
                <TtsButton messageId={last.key} text={speechTextOfGroup(group)} />
              )}
              <button title={language === "zh" ? "复制" : "Copy"} onClick={() => navigator.clipboard?.writeText(plainOfGroup(group))}>
                <Copy size={12} />
              </button>
            </span>
          </div>
        )}
        {!streaming && last.branchEntryId && <MessageFeedback entryId={last.branchEntryId} />}
      </div>
    </div>
  );
}

function plainOfGroup(g: MsgGroup): string {
  return g.items
    .map((m) =>
      (m.blocks || [])
        .map((b) => (b.type === "text" ? b.text : b.type === "thinking" ? b.thinking : ""))
        .filter(Boolean)
        .join("\n\n")
    )
    .filter(Boolean)
    .join("\n\n");
}

/** Text blocks only — thinking is never read aloud. */
function speechTextOfGroup(g: MsgGroup): string {
  return g.items
    .map((m) => (m.blocks || []).map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n\n"))
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Speaker button for an assistant group. Subscribes to the TTS state itself so
 * only this tiny component re-renders when playback starts/stops — never the
 * whole message (markdown re-rendering would be wasteful).
 */
function TtsButton({ messageId, text }: { messageId: string; text: string }) {
  const speaking = useSyncExternalStore(subscribeTts, () =>
    getTtsState().status === "speaking" && getTtsState().messageId === messageId ? "on" : "off",
  );
  const language = useStore((s) => s.config?.language || "en");
  const zh = language === "zh";

  const onClick = () => {
    if (speaking === "on") {
      stopTts();
      return;
    }
    const st = useStore.getState();
    const voiceCfg = st.config?.voice;
    void speakMessage(messageId, text, {
      voiceUri: voiceCfg?.ttsVoiceUri,
      rate: voiceCfg?.ttsRate,
      lang: zh ? "zh" : "en",
      backend: voiceCfg?.ttsBackend === "edge" ? "edge" : "system",
      edgeVoice: voiceCfg?.ttsEdgeVoice,
    }).then((res) => {
      if (res.fallback) {
        const d = res.detail ? (zh ? `（${res.detail}）` : ` (${res.detail})`) : "";
        st.pushToast("warning", zh ? `Edge 在线语音不可用，已回退系统语音${d}` : `Edge online voice unavailable — fell back to the system voice${d}`);
      }
      if (!res.ok && res.error === "unsupported") {
        st.pushToast("error", zh ? "当前系统不支持语音合成（未找到可用的 TTS 引擎）" : "Speech synthesis is not supported on this system (no TTS engine found)");
      } else if (!res.ok && res.error === "no-voice") {
        st.pushToast("error", zh ? "朗读失败：系统没有可用的语音，请安装 TTS 引擎或更换声音" : "Could not read aloud: no usable voice on this system — install a TTS engine or pick another voice");
      }
    });
  };

  return (
    <button
      className={`tts-btn${speaking === "on" ? " tts-speaking" : ""}`}
      title={speaking === "on" ? (zh ? "停止朗读" : "Stop reading") : zh ? "朗读这条回复" : "Read this reply aloud"}
      aria-label={speaking === "on" ? (zh ? "停止朗读" : "Stop reading") : zh ? "朗读这条回复" : "Read this reply aloud"}
      onClick={onClick}
    >
      {speaking === "on" ? <Stop size={12} /> : <Volume size={12} />}
      <span className="tts-label">{speaking === "on" ? (zh ? "停止" : "Stop") : zh ? "朗读" : "Read"}</span>
    </button>
  );
}

/**
 * 👍/👎 feedback for a finalized assistant reply (+ optional note). Keyed by
 * the stable pi session entry id (ULID) so ratings survive restarts; stored
 * as a sidecar in main and NEVER enters the model context. Re-clicking the
 * active rating retracts it (dsh parity); switching sides keeps the note.
 */
function MessageFeedback({ entryId }: { entryId: string }) {
  const fb = useStore((s) => s.feedback[entryId]);
  const rateMessage = useStore((s) => s.rateMessage);
  const language = useStore((s) => s.config?.language || "en");
  const zh = language === "zh";
  const [editing, setEditing] = useState(false);
  const [noteText, setNoteText] = useState("");

  const openEditor = () => {
    setNoteText(fb?.note ?? "");
    setEditing(true);
  };
  const saveNote = () => {
    // A note without a rating is dropped — the pencil only exists once rated.
    if (fb) void rateMessage(entryId, fb.rating, noteText);
    setEditing(false);
  };

  return (
    <div className={`msg-feedback${fb?.note || editing ? " has-note" : ""}${editing ? " editing" : ""}`}>
      <span className="msg-feedback-actions">
        <button
          className={fb?.rating === 1 ? "on" : ""}
          title={
            fb?.rating === 1
              ? zh ? "取消「有帮助」" : "Retract helpful rating"
              : zh ? "标记为有帮助" : "Mark as helpful"
          }
          onClick={() => void rateMessage(entryId, fb?.rating === 1 ? null : 1)}
        >
          <ThumbUp size={12} />
        </button>
        <button
          className={fb?.rating === -1 ? "on" : ""}
          title={
            fb?.rating === -1
              ? zh ? "取消「没帮助」" : "Retract not-helpful rating"
              : zh ? "标记为没帮助" : "Mark as not helpful"
          }
          onClick={() => void rateMessage(entryId, fb?.rating === -1 ? null : -1)}
        >
          <ThumbDown size={12} />
        </button>
        {fb && (
          <button
            title={editing ? (zh ? "取消备注" : "Cancel note") : zh ? "添加/修改备注" : "Add / edit note"}
            onClick={() => (editing ? setEditing(false) : openEditor())}
          >
            <Edit size={12} />
          </button>
        )}
      </span>
      {fb?.note && !editing && (
        <div className="msg-feedback-note" title={zh ? "点击修改备注" : "Click to edit the note"} onClick={openEditor}>
          {fb.note}
        </div>
      )}
      {editing && fb && (
        <div className="msg-feedback-editor">
          <input
            autoFocus
            value={noteText}
            maxLength={500}
            placeholder={zh ? "备注（可选，Enter 保存，Esc 取消）" : "Note (optional — Enter saves, Esc cancels)"}
            onChange={(e) => setNoteText(e.target.value)}
            onKeyDown={(e) => {
              // IME composition owns the keys (Chinese/Japanese input).
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter") {
                e.preventDefault();
                saveNote();
              } else if (e.key === "Escape") {
                setEditing(false);
              }
            }}
          />
          <button onClick={saveNote}>{zh ? "保存" : "Save"}</button>
          <button className="fb-cancel" onClick={() => setEditing(false)}>{zh ? "取消" : "Cancel"}</button>
        </div>
      )}
    </div>
  );
}

// Each assistant message is wrapped in a keyed .msg-item so in-conversation
// search can anchor, dim and flash individual messages inside one turn.
function renderAssistantBlocks(
  items: ViewMessage[],
  toolRuns: Record<string, ToolRun>,
  language: "en" | "zh",
  threadId: string,
  searchClass?: (key: string) => string,
  searchMarkQuery?: string | null,
  streamingKey?: string | null,
): ReactNode[] {
  const toolCount = items
    .flatMap((message) => message.blocks || [])
    .filter((block) => block.type === "toolCall")
    .length;
  let activityShown = false;
  return items.map((message) => {
    const blockNodes: ReactNode[] = [];
    (message.blocks || []).forEach((block, index) => {
      const key = `${message.key}:${index}`;
      if (block.type === "toolCall" && !activityShown) {
        activityShown = true;
        blockNodes.push(
          <div className="tool-activity-summary" key={`${key}:activity`}>
            <span className="tool-activity-label">{language === "zh" ? "工具活动" : "Tool activity"}</span>
            <span className="tool-activity-count">{toolCount} {language === "zh" ? "次调用" : toolCount === 1 ? "call" : "calls"}</span>
          </div>,
        );
      }
      const isStreaming = message.key === streamingKey;
      const blockQuery = isStreaming ? null : (searchMarkQuery ?? null);
      blockNodes.push(
        <BlockView
          key={key}
          block={block}
          toolRuns={toolRuns}
          language={language}
          searchQuery={blockQuery}
          threadId={threadId}
          messageKey={message.key}
          streaming={isStreaming}
          expandKey={key}
        />,
      );
    });
    if (blockNodes.length === 0) return null;
    return (
      <div className={`msg-item${searchClass ? searchClass(message.key) : ""}`} data-message-key={message.key} key={message.key}>
        {blockNodes}
      </div>
    );
  });
}

function BlockView({
  block,
  toolRuns,
  language,
  searchQuery,
  threadId,
  messageKey,
  streaming,
  expandKey,
}: {
  block: ContentBlock;
  toolRuns: Record<string, ToolRun>;
  language: "en" | "zh";
  /** Lowercased in-conversation search query to highlight inline; null = off. */
  searchQuery?: string | null;
  threadId: string;
  /** Key of the assistant ViewMessage carrying this block (choice-panel state). */
  messageKey: string;
  /** True while this message is still streaming — choice fences stay inert code blocks. */
  streaming: boolean;
  /** Stable "messageKey:index" key for cross-remount expand-state persistence. */
  expandKey?: string;
}) {
  // Marks are injected into the rendered .md DOM (see lib/search-mark); the
  // content key re-applies them once a streaming block finalizes.
  const markRef = useSearchMark(
    block.type === "text" ? (searchQuery ?? null) : null,
    block.type === "text" ? block.text : "",
  );
  // Inline multi-question choice blocks: split out ```choices fences once the
  // message has finalized (while streaming they render as inert code blocks).
  // Unconditional hook — guarded inside so non-text blocks cost one regex test.
  const blockText = block.type === "text" ? block.text : "";
  const choiceSegments = useMemo(
    () => (block.type === "text" && !streaming ? splitChoiceSegments(blockText) : null),
    [block.type, blockText, streaming],
  );
  if (block.type === "text") {
    const segments = choiceSegments;
    if (!segments || (segments.length === 1 && segments[0].kind === "md")) {
      return <Markdown text={block.text} containerRef={markRef} />;
    }
    // Multiple rendered units: the mark ref wraps them all so search
    // highlighting still covers every segment.
    return (
      <div ref={markRef}>
        {segments.map((seg, index) =>
          seg.kind === "choice" ? (
            <ChoicePanel key={`c${index}`} data={seg.data} threadId={threadId} messageKey={messageKey} panelIndex={index} />
          ) : seg.kind === "code" ? (
            // choices 围栏解析失败（JSON 非法 / 围栏写坏）→ 按普通代码块显示，
            // 并提示一行，便于一眼分清是模型格式问题而不是 MPI 没渲染。
            <div key={`m${index}`}>
              <Markdown text={seg.text} />
              <div className="choice-fence-warn">
                {language === "zh"
                  ? "这个 choices 块格式不合法，已按普通代码块显示（常见原因：闭合 ``` 没有独占一行，或 JSON 有语法错误）。"
                  : "This choices block is malformed and is shown as a plain code block (usually a closing ``` that is not on its own line, or invalid JSON)."}
              </div>
            </div>
          ) : (
            <Markdown key={`m${index}`} text={seg.text} />
          ),
        )}
      </div>
    );
  }
  if (block.type === "thinking") return <Thinking text={block.thinking} language={language} expandKey={expandKey} />;
  const run = toolRuns[block.id] || (block.contentIndex === undefined ? undefined : Object.values(toolRuns).find((candidate) => candidate.contentIndex === block.contentIndex));
  const name = effectiveToolName(block.name, run);
  // Plan-choice calls render as a compact option card instead of raw JSON.
  if (name === "mpi_ask_choice") return <ChoiceToolCard id={block.id} blockArgs={block.arguments} run={run} language={language} />;
  return <ToolCard id={block.id} name={name} blockArgs={block.arguments} run={run} language={language} expandKey={expandKey} />;
}

const SkillInvocation = memo(function SkillInvocation({ name, language }: { name: string; language: "en" | "zh" }) {
  return (
    <div className="skill-invocation" role="status" aria-label={`${language === "zh" ? "技能" : "skill"}: ${name}`}>
        <span className="skill-invocation-label">{language === "zh" ? "技能" : "skill"}: {name}</span>
    </div>
  );
});

const HtmlReferenceCard = memo(function HtmlReferenceCard({
  reference,
  language,
}: {
  reference: HtmlElementReference;
  language: "en" | "zh";
}) {
  const [expanded, setExpanded] = useState(false);
  const tag = reference.tagName ? `<${reference.tagName}>` : language === "zh" ? "HTML 元素" : "HTML element";
  const selector = reference.selector || (language === "zh" ? "未提供选择器" : "No selector provided");
  const detailLabel = language === "zh" ? "展开 HTML 元素详情" : "Expand HTML element details";

  return (
    <div className={`composer-html-reference msg-html-reference ${expanded ? "expanded" : ""}`}>
      <div className="composer-html-reference-row">
        <button
          type="button"
          className="composer-html-reference-toggle"
          aria-expanded={expanded}
          aria-label={`${detailLabel}: ${selector}`}
          onClick={() => setExpanded((current) => !current)}
        >
          <ChevronRight className={`composer-html-reference-chevron ${expanded ? "open" : ""}`} size={13} />
          <span className="composer-html-reference-badge">HTML</span>
          <span className="composer-html-reference-tag">{tag}</span>
          <code className="composer-html-reference-selector" title={selector}>{selector}</code>
        </button>
      </div>
      {expanded && (
        <pre className="composer-html-reference-code" aria-label={language === "zh" ? "HTML 元素引用详情" : "HTML element reference details"}>
          {reference.reference}
        </pre>
      )}
    </div>
  );
});

// 展开状态经 lib/expand-state 持久化（key = 消息 key:块序号）：dev HMR 替换本
// 模块会重挂整棵聊天树，已展开的块从 Map 恢复、不被折回。
const Thinking = memo(function Thinking({ text, language, expandKey }: { text: string; language: "en" | "zh"; expandKey?: string }) {
  // 展开状态存模块级 Map（lib/expand-state）：HMR/重挂载后恢复，不再被折叠回去。
  const [open, setOpen] = useState(() => (expandKey ? getExpandState(expandKey) : undefined) ?? false);
  const toggle = () => {
    setOpen((v) => {
      const next = !v;
      if (expandKey) setExpandState(expandKey, next);
      return next;
    });
  };
  const displayText = normalizeTranscriptText(text);
  return (
    <div className="thinking">
      <button className="thinking-toggle" onClick={toggle}>
        <span style={{ transform: open ? "rotate(90deg)" : "none", display: "inline-block", transition: "transform .12s" }}>›</span>
        {language === "zh" ? `思考过程 · ${displayText.length} 字` : `Reasoning · ${displayText.length} chars`}
      </button>
      {open && (
        <div className="thinking-body">
          <Markdown text={displayText} />
        </div>
      )}
    </div>
  );
});

function effectiveToolName(blockName: string, run?: ToolRun): string {
  const runtimeName = typeof run?.name === "string" ? run.name.trim() : "";
  if (runtimeName && runtimeName.toLowerCase() !== "tool") return runtimeName;
  const fallbackName = typeof blockName === "string" ? blockName.trim() : "";
  return fallbackName || runtimeName || "tool";
}

type ToolStatus = "queued" | "running" | "done" | "error";

function toolStatus(run?: ToolRun): ToolStatus {
  if (!run) return "queued";
  if (run.running) return "running";
  if (run.isError) return "error";
  if (run.completed === true) return "done";
  return "queued";
}

function toolStatusLabel(status: ToolStatus): string {
  return status === "queued" ? "排队中" : status === "running" ? "运行中" : status === "done" ? "已完成" : "出错";
}

function firstLine(value: unknown, maxLength = 120): string {
  const text = normalizeTranscriptText(value)
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) || "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function toolSummary(name: string, run: ToolRun | undefined, fallbackArgs: unknown, language: "en" | "zh"): string {
  const args = parseToolArgs(run, fallbackArgs);
  const command = toolArg(args, ["command", "cmd", "script"]);
  if (typeof command === "string" && command.trim()) return firstLine(command);

  const path = toolArg(args, ["path", "filePath", "file_path", "filename", "file"]);
  if (typeof path === "string" && path.trim()) return normalizeTranscriptText(path);

  const result = run?.resultText ?? run?.partialText;
  const resultLine = firstLine(result);
  if (resultLine) return resultLine;

  if (args && Object.keys(args).length > 0) {
    const count = Object.keys(args).length;
    return language === "zh" ? `${count} 个参数` : `${count} argument${count === 1 ? "" : "s"}`;
  }
  if (run?.argsStr) return firstLine(run.argsStr);
  return name === "tool" ? (language === "zh" ? "等待工具数据" : "Waiting for tool data") : "";
}

function toolDuration(run?: ToolRun): string {
  if (!run?.startedAt) return "";
  const end = run.endedAt || Date.now();
  const seconds = Math.max(0, (end - run.startedAt) / 1000);
  return seconds < 1 ? "<1s" : `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
}

// 同 Thinking：open 经 lib/expand-state 跨 HMR/重挂载保留；edit 卡自动展开
// 也写入记录，避免热重载后重新折叠。
const ToolCard = memo(function ToolCard({ id, name, blockArgs, run, language, expandKey }: { id: string; name: string; blockArgs?: unknown; run?: ToolRun; language: "en" | "zh"; expandKey?: string }) {
  // 展开状态存模块级 Map（lib/expand-state）：HMR/重挂载后恢复，不再被折叠回去。
  const [open, setOpen] = useState(() => (expandKey ? getExpandState(expandKey) : undefined) ?? false);
  const running = run?.running;
  const diffViewMode = useStore((s) => s.config?.diffViewMode || "unified");
  const argsView = renderToolArgs(name, run, blockArgs, language, diffViewMode);

  // Edit calls with recognizable before/after content open by default so the
  // unified diff is visible without hunting for it. Arguments may arrive late
  // while streaming, so auto-open once they are complete — but never override
  // a manual toggle. Very large edits stay collapsed to avoid flooding history.
  const editPairs = matchesTool(name, ["edit", "patch", "replace", "update"]) ? extractEditPairs(parseToolArgs(run, blockArgs)) : [];
  let autoExpand = false;
  if (editPairs.length) {
    let lines = 0;
    for (const p of editPairs) lines += p.old.split("\n").length + p.next.split("\n").length;
    autoExpand = lines <= 240;
  }
  const userToggled = useRef(false);
  // 自动展开只发生在「无用户意图记录」时；一旦自动打开过就写入 Map，
  // 重挂载后保持展开（否则每次 HMR 都会把 edit 卡折回去）。
  useEffect(() => {
    const recorded = expandKey ? getExpandState(expandKey) : undefined;
    if (autoExpand && !userToggled.current && recorded === undefined) {
      setOpen(true);
      if (expandKey) setExpandState(expandKey, true);
    }
  }, [autoExpand]);
  const result = run?.resultText ?? run?.partialText ?? "";
  const status = toolStatus(run);
  const summary = toolSummary(name, run, blockArgs, language);
  const duration = toolDuration(run);
  const detailsId = `tool-details-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const emptyMessage = !run
    ? language === "zh" ? "等待执行数据" : "Waiting for execution data"
    : running
      ? language === "zh" ? "工具运行时会显示输出" : "Output will appear here while the tool runs"
      : run.completed !== true && !run.isError
        ? language === "zh" ? "排队中，尚未开始执行" : "Queued — execution has not started"
        : language === "zh" ? "未返回输出" : "No output returned";
  return (
    <div className={`tool-card state-${status} ${open ? "is-open" : ""}`}>
      <button
        className="tool-head"
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => {
          userToggled.current = true;
          setOpen((v) => {
            const next = !v;
            if (expandKey) setExpandState(expandKey, next);
            return next;
          });
        }}
      >
        <span style={{ transform: open ? "rotate(90deg)" : "none", display: "inline-block", transition: "transform .12s" }}>›</span>
        <span className="tool-name">{name}</span>
        {summary && <span className="tool-summary" title={summary}>{summary}</span>}
        {!open && editPairs.length > 1 && (
          <span className="tool-edits-badge">{language === "zh" ? `${editPairs.length} 处替换` : `${editPairs.length} edits`}</span>
        )}
        <span className={`tool-status state-${status}`}>
          {running ? <span className="spinner" /> : language === "zh" ? toolStatusLabel(status) : status}
        </span>
        {duration && <span className="tool-duration">{duration}</span>}
      </button>
      {open && (
        <div className="tool-details" id={detailsId}>
          <section className="tool-section">
            <div className="tool-section-label">{language === "zh" ? "参数" : "Arguments"}</div>
            <div className="tool-args">{argsView || <div className="tool-empty compact">{language === "zh" ? "参数不可用" : "Arguments unavailable"}</div>}</div>
          </section>
          <section className="tool-section">
            <div className="tool-section-label">{language === "zh" ? "输出" : "Output"}</div>
            {result ? (
              <div className={`tool-result ${run?.isError ? "err" : ""}`}>
                <ToolCode text={normalizeTranscriptText(result)} language={languageForResult(name, run, blockArgs)} />
              </div>
            ) : (
              <div className="tool-empty compact">{emptyMessage}</div>
            )}
          </section>
        </div>
      )}
    </div>
  );
});

/**
 * History rendering for mpi_ask_choice (方案选择): a compact card showing the
 * question and every option, with the user's selection highlighted. The live,
 * clickable version is ExtUiPromptCard above the composer; this one is read-
 * only history. Errors or missing arguments fall back to the generic ToolCard.
 */
const ChoiceToolCard = memo(function ChoiceToolCard({ id, blockArgs, run, language }: { id: string; blockArgs?: unknown; run?: ToolRun; language: "en" | "zh" }) {
  const args = parseToolArgs(run, blockArgs);
  const question = typeof args?.question === "string" ? args.question.trim() : "";
  // Options may be plain strings or {label, detail} objects (mpi_ask_choice).
  const options = choiceOptions(args?.options);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  if (run?.isError || (!question && !options.length)) {
    return <ToolCard id={id} name="mpi_ask_choice" blockArgs={blockArgs} run={run} language={language} />;
  }
  const outcome = parseChoiceOutcome(run?.resultText ?? run?.partialText);
  const selectedValue = outcome?.kind === "selected" ? outcome.value : null;
  const cancelled = outcome?.kind === "cancelled";
  const status = toolStatus(run);
  const zh = language === "zh";
  let badge: ReactNode;
  if (run?.running) badge = <span className="spinner" />;
  else if (selectedValue) badge = zh ? `已选：${selectedValue}` : `Selected: ${selectedValue}`;
  else if (cancelled) badge = zh ? "未选择" : "No selection";
  else if (status === "done") badge = zh ? "已完成" : "Done";
  else badge = zh ? "等待选择…" : "Awaiting selection…";

  return (
    <div className={`choice-tool state-${status}`}>
      <div className="choice-head">
        <span className="choice-icon" aria-hidden="true"><Branch size={14} /></span>
        <span className="choice-question" title={question}>{question || (zh ? "方案选择" : "Plan choice")}</span>
        <span className={`tool-status state-${status}`} title={typeof badge === "string" ? badge : undefined}>{badge}</span>
      </div>
      {options.length > 0 && (
        <div className="choice-options">
          {options.map((opt, index) => {
            const selected = selectedValue !== null && opt.label === selectedValue;
            const isOpen = expanded.has(index);
            return (
              <div key={`${index}-${opt.label}`} className={`choice-option ${selected ? "selected" : ""}`}>
                <div className="co-row">
                  {selected && <Check size={13} />}
                  <span>{opt.label}</span>
                  {opt.detail && (
                    <button
                      className={`opt-detail-toggle ${isOpen ? "open" : ""}`}
                      title={isOpen ? (zh ? "收起细节" : "Collapse details") : zh ? "展开细节" : "Expand details"}
                      onClick={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(index)) next.delete(index);
                          else next.add(index);
                          return next;
                        })
                      }
                    >
                      {zh ? "细节" : "Detail"} <ChevronRight size={12} />
                    </button>
                  )}
                </div>
                {opt.detail && isOpen && <div className="opt-detail">{opt.detail}</div>}
              </div>
            );
          })}
          {/* A plan typed via the card's “其它/Other” input matches no option label. */}
          {selectedValue !== null && !options.some((o) => o.label === selectedValue) && (
            <div className="choice-option selected">
              <div className="co-row">
                <Check size={13} />
                <span>{selectedValue}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/**
 * Tool arguments arrive in two forms: a parsed object after toolcall_end, or
 * an escaped JSON fragment while the call is still streaming. Keep the
 * session data untouched and normalize only the visible representation.
 */
function parseToolArgs(run?: ToolRun, fallbackArgs?: unknown): Record<string, unknown> | null {
  const candidate = run?.args && hasToolArgumentObject(run.args) && Object.keys(run.args).length > 0 ? run.args : fallbackArgs ?? run?.args;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    if (Object.keys(candidate).length > 0 || !run?.argsStr) return candidate as Record<string, unknown>;
  }

  const raw = typeof candidate === "string" ? candidate : run?.argsStr;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function hasToolArgumentObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toolArg(args: Record<string, unknown> | null, names: string[]): unknown {
  if (!args) return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(args, name)) return args[name];
  }
  return undefined;
}

function matchesTool(name: string, names: string[]): boolean {
  const normalized = name.toLowerCase();
  return names.some((candidate) =>
    new RegExp(`(^|[-_:])${candidate}(?:$|[-_:])`, "i").test(normalized),
  );
}

function languageForPath(path: string): string | undefined {
  const ext = path.toLowerCase().split(/[./\\]/).pop() || "";
  const languages: Record<string, string> = {
    js: "javascript",
    jsx: "jsx",
    ts: "typescript",
    tsx: "tsx",
    json: "json",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    less: "less",
    py: "python",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    ps1: "powershell",
    psm1: "powershell",
    psd1: "powershell",
    md: "markdown",
    yml: "yaml",
    yaml: "yaml",
    xml: "xml",
    sql: "sql",
    java: "java",
    go: "go",
    rs: "rust",
  };
  return languages[ext];
}

function languageForTool(name: string): string | undefined {
  if (matchesTool(name, ["python"])) return "python";
  if (matchesTool(name, ["powershell", "pwsh"])) return "powershell";
  if (matchesTool(name, ["bash", "shell", "sh", "zsh"])) return "bash";
  return undefined;
}

function languageForResult(name: string, run?: ToolRun, fallbackArgs?: unknown): string | undefined {
  const toolLanguage = languageForTool(name);
  if (toolLanguage) return toolLanguage;
  const args = parseToolArgs(run, fallbackArgs);
  const path = toolArg(args, ["path", "filePath", "file_path", "filename", "file"]);
  return typeof path === "string" ? languageForPath(normalizeTranscriptText(path)) : undefined;
}

function codeFence(text: string, language?: string): string {
  const normalized = normalizeTranscriptText(text);
  const longest = Math.max(2, ...((normalized.match(/`+/g) || []).map((part) => part.length)));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language || ""}\n${normalized}${normalized.endsWith("\n") ? "" : "\n"}${fence}`;
}

function ToolCode({ text, language }: { text: string; language?: string }) {
  return <Markdown text={codeFence(text, language)} />;
}

/** Unified (single-column) diff for edit-tool results — git-style rows with
 * old/new line numbers. Falls back to plain before/after blocks when the
 * inputs are too large for the LCS table. */
const UnifiedDiffView = memo(function UnifiedDiffView({ oldText, newText, codeLang, uiLang }: { oldText: string; newText: string; codeLang?: string; uiLang: "en" | "zh" }) {
  const rows = useMemo(() => diffLines(oldText, newText), [oldText, newText]);
  if (!rows) {
    return (
      <>
        <div className="tool-code-section">
          <div className="tool-code-label removed">{uiLang === "zh" ? "原内容" : "Before"}</div>
          <ToolCode text={oldText} language={codeLang} />
        </div>
        <div className="tool-code-section">
          <div className="tool-code-label">{uiLang === "zh" ? "新内容" : "After"}</div>
          <ToolCode text={newText} language={codeLang} />
        </div>
      </>
    );
  }
  return (
    <div className="udiff">
      {rows.map((row, index) => (
        <div key={index} className={`udiff-row ${row.kind}`}>
          <span className="udiff-no">{row.kind !== "added" ? row.oldNo : ""}</span>
          <span className="udiff-no">{row.kind !== "removed" ? row.newNo : ""}</span>
          <span className="udiff-marker">{row.kind === "context" ? "\u00a0" : row.kind === "removed" ? "-" : "+"}</span>
          <span className="udiff-text">{row.text || "\u00a0"}</span>
        </div>
      ))}
    </div>
  );
});

function renderToolArgs(name: string, run: ToolRun | undefined, fallbackArgs: unknown, language: "en" | "zh", diffViewMode: "unified" | "blocks"): ReactNode {
  const args = parseToolArgs(run, fallbackArgs);
  const command = toolArg(args, ["command", "cmd", "script"]);
  if (matchesTool(name, ["bash", "shell", "sh", "zsh", "exec", "execute", "command", "run", "python"])) {
    const text = typeof command === "string" ? normalizeTranscriptText(command) : typeof run?.argsStr === "string" ? normalizeTranscriptText(run.argsStr) : "";
    return text ? <ToolCode text={text} language={languageForTool(name)} /> : null;
  }

  const isEdit = matchesTool(name, ["edit", "patch", "replace", "update"]);
  const isWrite = matchesTool(name, ["write", "create", "save", "export"]);
  const isRead = matchesTool(name, ["read", "cat", "file"]);
  if (isRead && args && Object.keys(args).length > 0) {
    const path = normalizeTranscriptText(toolArg(args, ["path", "filePath", "file_path", "filename", "file"]));
    let generic = "";
    try {
      generic = JSON.stringify(args, null, 2);
    } catch {
      generic = String(args);
    }
    return (
      <div className="tool-operation">
        <div className="tool-operation-title">{language === "zh" ? "读取" : "Read"}{path ? ` · ${path}` : ""}</div>
        <ToolCode text={generic} language="json" />
      </div>
    );
  }
  if (isEdit || isWrite) {
    const path = normalizeTranscriptText(toolArg(args, ["path", "filePath", "file_path", "filename", "file"]));
    const codeLang = languageForPath(path);

    // pi's edit tool passes an `edits` array of {oldText,newText} objects
    // (one entry per replacement); other agents may use flat top-level fields.
    const pairs = isEdit ? extractEditPairs(args) : [];

    // Edits with recognizable before/after content render as diffs — unified
    // single-column by default, before/after blocks via the Diff view setting.
    if (isEdit && pairs.length > 0) {
      return (
        <div className="tool-operation">
          <div className="tool-operation-title">{language === "zh" ? "编辑" : "Edit"}{path ? ` · ${path}` : ""}</div>
          {pairs.map((pair, index) => (
            <div className="tool-code-section" key={index}>
              {pairs.length > 1 && (
                <div className="udiff-hunk-label">
                  {language === "zh" ? `编辑 ${index + 1}/${pairs.length}` : `Edit ${index + 1} of ${pairs.length}`}
                </div>
              )}
              {diffViewMode === "unified" && pair.old && pair.next ? (
                <UnifiedDiffView oldText={pair.old} newText={pair.next} codeLang={codeLang} uiLang={language} />
              ) : (
                <>
                  {pair.old && (
                    <div className="tool-code-section">
                      <div className="tool-code-label removed">{language === "zh" ? "原内容" : "Before"}</div>
                      <ToolCode text={pair.old} language={codeLang} />
                    </div>
                  )}
                  {pair.next && (
                    <div className="tool-code-section">
                      <div className="tool-code-label">{language === "zh" ? "新内容" : "After"}</div>
                      <ToolCode text={pair.next} language={codeLang} />
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      );
    }

    // write (or an edit with unrecognized argument shape): plain content view.
    const patch = normalizeTranscriptText(toolArg(args, ["patch", "diff"]));
    const content = isEdit ? patch : normalizeTranscriptText(toolArg(args, ["content", "text", "data", "newText", "new_text"]));
    const sections: ReactNode[] = [];
    if (content) {
      sections.push(
        <div className="tool-code-section" key="new">
          <div className="tool-code-label">{isEdit ? (language === "zh" ? "补丁内容" : "Patch") : language === "zh" ? "写入内容" : "Written content"}</div>
          <ToolCode text={content} language={codeLang} />
        </div>,
      );
    }
    if (!sections.length && run?.argsStr) {
      return <ToolCode text={normalizeTranscriptText(run.argsStr)} language="json" />;
    }
    if (!sections.length && !path) return null;
    return (
      <div className="tool-operation">
        <div className="tool-operation-title">{isEdit ? "编辑" : "写入"}{path ? ` · ${path}` : ""}</div>
        {sections}
      </div>
    );
  }

  if (args && Object.keys(args).length > 0) {
    let generic = "";
    try {
      generic = JSON.stringify(args, null, 2);
    } catch {
      generic = String(args);
    }
    return <ToolCode text={generic} language="json" />;
  }

  return run?.argsStr ? <ToolCode text={normalizeTranscriptText(run.argsStr)} language="json" /> : null;
}
