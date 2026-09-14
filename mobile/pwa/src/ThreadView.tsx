/**
 * Conversation view (S5, docs/MOBILE-DESIGN.md §6.2 item 3).
 * Renders a ThreadSession snapshot: message blocks (text / thinking / tool / image),
 * the in-flight streaming tail, error banner, auto-scroll with "back to bottom".
 */
import { useEffect, useRef, useState } from "react";
import type { RemoteThreadState } from "../../shared/protocol";
import type { ThreadView as ThreadViewState, ViewBlock, ViewMessage } from "./lib/thread-session";

const STATE_LABELS: Record<RemoteThreadState, string> = {
  draft: "草稿",
  idle: "空闲",
  running: "运行中",
  error: "出错",
  disconnected: "已断开",
};

function Block({ block }: { block: ViewBlock }) {
  if (block.type === "thinking") {
    return (
      <details className="msg-thinking">
        <summary>思考过程</summary>
        <pre>{block.text}</pre>
      </details>
    );
  }
  if (block.type === "tool") {
    return (
      <div className={`msg-tool ${block.running ? "running" : ""} ${block.isError ? "error" : ""}`}>
        <div className="msg-tool-head">
          <span className="msg-tool-name">{block.name || "tool"}</span>
          {block.argsText && <code className="msg-tool-args">{block.argsText}</code>}
          {block.running && <span className="spinner" aria-label="运行中" />}
        </div>
        {block.text ? (
          <details open={block.isError}>
            <summary>结果</summary>
            <pre>{block.text}</pre>
          </details>
        ) : null}
      </div>
    );
  }
  if (block.type === "image") {
    return block.data ? <img className="msg-image" src={block.data} alt={block.mimeType || "image"} /> : null;
  }
  return <p className="msg-text">{block.text}</p>;
}

function Message({ message }: { message: ViewMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`message ${isUser ? "user" : "assistant"}`}>
      {!isUser && message.blocks.length > 0 && (
        <div className="msg-role">
          MPI{message.stopReason === "error" ? " · 出错" : ""}
        </div>
      )}
      {message.blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
      {!isUser && message.artifacts && message.artifacts.length > 0 && (
        <div className="msg-artifacts">
          {message.artifacts.map((a) => (
            <span key={a.path} className={`artifact ${a.action}`}>
              {a.action === "created" ? "+" : "~"} {a.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ThreadView({ view, onBack }: { view: ThreadViewState; onBack: () => void }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  // Auto-scroll while the user is pinned to the bottom.
  useEffect(() => {
    if (!atBottom) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view.messages, view.streaming, atBottom]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  };

  return (
    <div className="card thread-view">
      <div className="thread-head">
        <button type="button" className="back-btn" onClick={onBack} aria-label="返回项目列表">←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="thread-title">{view.summary?.title || "会话"}</div>
          {view.summary && (
            <span className={`badge badge-${view.summary.state}`}>{STATE_LABELS[view.summary.state]}</span>
          )}
        </div>
      </div>

      {view.errorBanner && <p className="hint error-text">{view.errorBanner}</p>}

      {!view.ready ? (
        <p className="hint">加载会话…</p>
      ) : (
        <>
          <div className="thread-scroll" ref={scrollRef} onScroll={handleScroll}>
            {view.messages.map((message) => (
              <Message key={message.id} message={message} />
            ))}
            {view.streaming && <Message message={view.streaming} />}
            {view.running && !view.streaming && <p className="hint">正在工作…</p>}
          </div>
          {!atBottom && (
            <button type="button" className="to-bottom" onClick={scrollToBottom}>↓ 最新消息</button>
          )}
        </>
      )}
    </div>
  );
}
