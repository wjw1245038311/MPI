import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { PendingQuote } from "../lib/types";
import { Branch, CheckSquare, MessageSquare } from "./icons";

/**
 * Chat-area right-click menu.
 *
 * 两种触发形态：
 *   ① 选中了聊天文字（原有行为）→ 「引用到输入框」/「添加为待办」；
 *   ② **没有选中文字、但右键落在对话区域（`.chat-scroll`）** → 「交接到新会话」。
 * 为什么要 ②：交接是“对这个对话”的操作，不应该要求先把鼠标划出一段文字才能用
 *   （用户 2026-10-13 指出：入口应该在对话区，而不是侧栏会话列表）。
 * 右键在对话区以外（输入框、侧栏…）时不接管，保留各处原有行为。
 *
 * The quote carries its location inside this conversation (session entry id +
 * transcript path), not just the pasted text — see buildQuoteEnvelope().
 */
export function MessageQuoteMenu() {
  // quote === null 表示“没选中文字、只对该对话操作”的那一形态
  const [state, setState] = useState<{ x: number; y: number; quote: PendingQuote | null } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const pushToast = useStore((s) => s.pushToast);
  const language = useStore((s) => s.config?.language || "en");
  const zh = language === "zh";

  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      const st = useStore.getState();
      const threadId = st.activeThreadId;
      const t = threadId ? st.threads[threadId] : undefined;
      const sel = window.getSelection();
      const text = sel && !sel.isCollapsed ? sel.toString().trim() : "";
      let quote: PendingQuote | null = null;
      if (text && sel) {
        // The selection may span several messages; attribute the quote to the
        // message where it STARTS (anchor), falling back to its other end.
        const anchorNode = sel.anchorNode;
        const anchorEl = anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement ?? null;
        const focusNode = sel.focusNode;
        const focusEl = focusNode instanceof Element ? focusNode : focusNode?.parentElement ?? null;
        const msgEl = anchorEl?.closest("[data-message-key]") || focusEl?.closest("[data-message-key]");
        if (!msgEl) return; // selection lives outside the chat (composer, sidebar…)
        if (!t) return;
        const key = msgEl.getAttribute("data-message-key");
        const m = (t.messages || []).find((x) => x.key === key);
        quote = {
          id: "", // the composer assigns its own stable chip id
          text,
          entryId: m?.branchEntryId,
          role: m && (m.role === "user" || m.role === "assistant") ? m.role : undefined,
          sessionFile: t.sessionFile ?? undefined,
        };
      } else {
        // 没选中文字：只在对话区域内响应（右键别处保持原有行为）。
        const inChat = e.target instanceof Element && e.target.closest(".chat-scroll");
        if (!inChat || !t) return;
      }
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
    if (!state || !state.quote) return;
    const quote = state.quote;
    setState(null);
    // The active thread's composer listens and adds the chip to its draft.
    window.dispatchEvent(new CustomEvent("mpi-quote-to-composer", { detail: { quote } }));
  };

  /**
   * 交接到新会话：同目录开一个空会话，继承本会话的模型 / 思考等级 / 权限 / 任务模式。
   * 实现细节与继承范围见 store.handoffToNewSession。
   */
  const doHandoff = () => {
    setState(null);
    const st = useStore.getState();
    const t = st.activeThreadId ? st.threads[st.activeThreadId] : undefined;
    if (!t) return;
    void st.handoffToNewSession(t.cwd, t.sessionFile);
  };

  const doTodo = async () => {
    if (!state || !state.quote) return;
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
  const H = state.quote ? 130 : 46;
  const x = Math.max(8, Math.min(state.x, window.innerWidth - W - 8));
  const y = Math.max(8, Math.min(state.y, window.innerHeight - H - 8));
  return (
    <div
      ref={menuRef}
      className="project-context-menu msg-quote-menu"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {state.quote && (
        <button type="button" onClick={() => doQuote()}>
          <span>
            <MessageSquare size={13} /> {zh ? "引用到输入框" : "Quote to composer"}
          </span>
        </button>
      )}
      {state.quote && (
        <button type="button" onClick={() => void doTodo()}>
          <span>
            <CheckSquare size={13} /> {zh ? "添加为待办" : "Add as todo"}
          </span>
        </button>
      )}
      <button type="button" onClick={doHandoff}>
        <span>
          <Branch size={13} /> {zh ? "交接到新会话" : "Hand off to new session"}
        </span>
      </button>
    </div>
  );
}
