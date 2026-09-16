import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { PendingQuote } from "../lib/types";
import { CheckSquare, MessageSquare } from "./icons";

/**
 * Global right-click menu for selected chat text (引用到输入框 / 添加为待办).
 * One document-level contextmenu listener covers every message body — user
 * bubbles and assistant markdown alike — without touching the memoized
 * MessageGroup render. It only fires on a non-collapsed selection anchored in
 * a message, so right-clicks elsewhere keep their existing behavior.
 *
 * The quote carries its location inside this conversation (session entry id +
 * transcript path), not just the pasted text — see buildQuoteEnvelope().
 */
export function MessageQuoteMenu() {
  const [state, setState] = useState<{ x: number; y: number; quote: PendingQuote } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const pushToast = useStore((s) => s.pushToast);
  const language = useStore((s) => s.config?.language || "en");
  const zh = language === "zh";

  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const text = sel.toString().trim();
      if (!text) return;
      // The selection may span several messages; attribute the quote to the
      // message where it STARTS (anchor), falling back to its other end.
      const anchorNode = sel.anchorNode;
      const anchorEl = anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement ?? null;
      const focusNode = sel.focusNode;
      const focusEl = focusNode instanceof Element ? focusNode : focusNode?.parentElement ?? null;
      const msgEl = anchorEl?.closest("[data-message-key]") || focusEl?.closest("[data-message-key]");
      if (!msgEl) return; // selection lives outside the chat (composer, sidebar…)

      const st = useStore.getState();
      const threadId = st.activeThreadId;
      if (!threadId) return;
      const t = st.threads[threadId];
      if (!t) return;
      const key = msgEl.getAttribute("data-message-key");
      const m = (t.messages || []).find((x) => x.key === key);
      const quote: PendingQuote = {
        id: "", // the composer assigns its own stable chip id
        text,
        entryId: m?.branchEntryId,
        role: m && (m.role === "user" || m.role === "assistant") ? m.role : undefined,
        sessionFile: t.sessionFile ?? undefined,
      };
      e.preventDefault();
      setState({ x: e.clientX, y: e.clientY, quote });
    };
    document.addEventListener("contextmenu", onContext);
    return () => document.removeEventListener("contextmenu", onContext);
  }, []);

  // Close on outside mousedown / Escape (same pattern as ImageCopyMenu).
  useEffect(() => {
    if (!state) return;
    const close = (e: MouseEvent) => {
      // Interactions inside the menu must not dismiss it.
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      setState(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setState(null);
    };
    window.addEventListener("mousedown", close, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", close, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [state]);

  const doQuote = () => {
    if (!state) return;
    const quote = state.quote;
    setState(null);
    // The active thread's composer listens and adds the chip to its draft.
    window.dispatchEvent(new CustomEvent("mpi-quote-to-composer", { detail: { quote } }));
  };

  const doTodo = async () => {
    if (!state) return;
    const { quote } = state;
    setState(null);
    const st = useStore.getState();
    const threadId = st.activeThreadId;
    const t = threadId ? st.threads[threadId] : undefined;
    const title = quote.text.replace(/\s+/g, " ").slice(0, 80);
    const source = [
      zh ? `引自会话「${t?.sessionName || "未命名会话"}」` : `Quoted from session "${t?.sessionName || "untitled"}"`,
      quote.role === "assistant"
        ? zh ? "助手回复" : "agent reply"
        : quote.role === "user"
          ? zh ? "用户消息" : "user message"
          : null,
      quote.entryId ? `#${quote.entryId.slice(0, 8)}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const item = await st.addTodo({ cwd: t?.cwd || "", title, note: `${source}\n\n${quote.text}` });
    if (item) pushToast("success", zh ? `已添加待办：${title}` : `Added todo: ${title}`);
  };

  if (!state) return null;
  // Clamp so the menu never opens off-screen at a window edge.
  const W = 210;
  const H = 86;
  const x = Math.max(8, Math.min(state.x, window.innerWidth - W - 8));
  const y = Math.max(8, Math.min(state.y, window.innerHeight - H - 8));
  return (
    <div
      ref={menuRef}
      className="project-context-menu msg-quote-menu"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button type="button" onClick={() => doQuote()}>
        <span>
          <MessageSquare size={13} /> {zh ? "引用到输入框" : "Quote to composer"}
        </span>
      </button>
      <button type="button" onClick={() => void doTodo()}>
        <span>
          <CheckSquare size={13} /> {zh ? "添加为待办" : "Add as todo"}
        </span>
      </button>
    </div>
  );
}
