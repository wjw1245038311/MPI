import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { PendingQuote } from "../lib/types";
import { Branch, CheckSquare, MessageSquare } from "./icons";

/**
 * Chat-area right-click menu.
 *
 * 只在**选中了聊天文字**时接管右键（对话区之外、没选文字时不接管，保留各处原有行为）。
 * 三个动作都以这段选中文字为输入：
 *   「引用到输入框」→ 作为引用块进输入框；「添加为待办」→ 记成待办；
 *   「交接到新会话」→ **把这段文字当成新会话的提示词直接发出去**（用户 2026-10-13 定稿语义）。
 *
 * The quote carries its location inside this conversation (session entry id +
 * transcript path), not just the pasted text — see buildQuoteEnvelope().
 */
export function MessageQuoteMenu() {
  // 菜单永远由「一段选中的文字」触发：没有选中文字就没有菜单（交接需要提示词，空手交接没有意义）。
  const [state, setState] = useState<{ x: number; y: number; quote: PendingQuote } | null>(null);
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
      if (!text || !sel) return; // 没选中文字：不接管右键（输入框/侧栏保持各自原有菜单）
      // The selection may span several messages; attribute the quote to the
      // message where it STARTS (anchor), falling back to its other end.
      let quote: PendingQuote;
      {
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
    if (!state) return;
    const quote = state.quote;
    setState(null);
    // The active thread's composer listens and adds the chip to its draft.
    window.dispatchEvent(new CustomEvent("mpi-quote-to-composer", { detail: { quote } }));
  };

  /**
   * 交接到新会话：同目录开一个空会话、继承本会话的模型 / 思考等级 / 权限 / 任务模式，
   * 并**把选中的这段文字当作新会话的提示词直接发出**（新会话立刻开始跑）。
   * 实现细节与继承范围见 store.handoffToNewSession。
   */
  const doHandoff = () => {
    if (!state) return;
    const { quote } = state;
    setState(null);
    const st = useStore.getState();
    const t = st.activeThreadId ? st.threads[st.activeThreadId] : undefined;
    if (!t) return;
    void st.handoffToNewSession(t.cwd, t.sessionFile, quote.text);
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
  const H = 160; // 三个菜单项
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
      <button type="button" onClick={doHandoff}>
        <span>
          <Branch size={13} /> {zh ? "交接到新会话" : "Hand off to new session"}
        </span>
      </button>
    </div>
  );
}
