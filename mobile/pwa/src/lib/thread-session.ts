/**
 * Thread session for the PWA conversation view (S5, docs/MOBILE-DESIGN.md §6.2 item 3).
 *
 * thread.subscribe returns the snapshot in its response and then streams
 * "thread.event" envelopes ({payload:{kind,data}, threadId, seq} — seq is a
 * per-thread counter on the host, monotonic across subscribers). This class:
 *   - buffers events that arrive before the snapshot response (the host registers
 *     the listener BEFORE fetching the snapshot, so those frames are lossless);
 *   - applies a simplified streaming reducer (text/thinking deltas, tool blocks,
 *     message_end finalization) — history rendering comes from snapshot blocks;
 *   - detects seq gaps and socket drops → thread.resync (live snapshot).
 * Pure logic — node-testable against a real relay + fake host service.
 */
import type { RemoteFileArtifact, RemoteMessage, RemoteThreadEventPayload, RemoteThreadSnapshot, RemoteThreadSummary } from "../../../shared/protocol";
import type { RelayClient } from "./relay-client";
import { Requester } from "./requester";

export interface ViewBlock {
  id?: string; // tool block identity (toolCallId)
  type: "text" | "thinking" | "tool" | "image";
  text?: string; // text/thinking content, or tool result preview
  name?: string; // tool name
  argsText?: string; // compact argument summary for tools
  running?: boolean; // tool in flight
  isError?: boolean;
  data?: string; // image payload (data URL)
  mimeType?: string;
}

export interface ViewMessage {
  id: string;
  role: "user" | "assistant";
  blocks: ViewBlock[];
  artifacts?: RemoteFileArtifact[];
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
}

export interface ThreadView {
  threadId: string;
  /** Snapshot applied at least once — UI can render. */
  ready: boolean;
  summary: RemoteThreadSummary | null;
  messages: ViewMessage[]; // finalized history + completed turns
  streaming: ViewMessage | null; // in-flight assistant message
  running: boolean; // agent turn active (agent_start … settled)
  errorBanner: string | null;
}

export interface ThreadSessionOptions {
  requestTimeoutMs?: number;
  onStaleConnection?: () => void;
}

type Listener = (view: ThreadView) => void;

/** Extract display text from pi content shapes (string | content blocks). */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string") {
      parts.push((item as Record<string, unknown>).text as string);
    }
  }
  return parts.join("");
}

function summarizeArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  try {
    const text = JSON.stringify(args);
    return text.length > 160 ? `${text.slice(0, 157)}…` : text;
  } catch {
    return undefined;
  }
}

function mapRemoteMessage(m: RemoteMessage): ViewMessage {
  return {
    id: m.id,
    role: m.role === "user" ? "user" : "assistant",
    blocks: (m.blocks || []).map((b) => ({
      type: b.type === "image" ? ("image" as const) : b.type === "tool" ? ("tool" as const) : b.type === "thinking" ? ("thinking" as const) : ("text" as const),
      text: b.text,
      name: b.name,
      running: b.running,
      argsText: undefined,
      data: b.data,
      mimeType: b.mimeType,
    })),
    artifacts: m.artifacts,
    stopReason: m.stopReason,
    timestamp: m.timestamp,
  };
}

export class ThreadSession {
  private view: ThreadView;
  private readonly requester: Requester;
  private readonly listeners = new Set<Listener>();
  /** Events that arrived before the (re)sync snapshot response — flushed after apply. */
  private pendingEvents: Array<{ seq: number; payload: RemoteThreadEventPayload }> = [];
  /** Next expected event seq; null until the first post-snapshot event arms it. */
  private expectNext: number | null = null;
  private openCount = 0;
  private closing = false;
  private readonly detachFrame: () => void;
  private readonly detachState: () => void;

  constructor(
    client: RelayClient,
    threadId: string,
    options: ThreadSessionOptions = {},
  ) {
    this.view = { threadId, ready: false, summary: null, messages: [], streaming: null, running: false, errorBanner: null };
    this.requester = new Requester(client, { requestTimeoutMs: options.requestTimeoutMs, onStaleConnection: options.onStaleConnection });

    // Subscribe before any traffic can flow (RelayClient does not buffer frames).
    this.detachFrame = client.onFrame((frame) => this.handleFrame(frame));
    this.detachState = client.onState((state) => {
      if (state !== "open" || this.closing) return;
      this.openCount += 1;
      // The first open is covered by the explicit open(); later opens mean a
      // reconnect — events were lost, so resync from the live snapshot.
      if (this.openCount > 1 && this.view.ready) void this.resync().catch(() => { /* surfaced via UI error state */ });
    });
  }

  getSnapshot(): ThreadView {
    return this.view;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Subscribe to the thread; resolves once the initial snapshot is applied. */
  async open(): Promise<void> {
    const payload = await this.requester.request<{ snapshot?: RemoteThreadSnapshot }>("thread.subscribe", { threadId: this.view.threadId }, "subscribe");
    if (!payload?.snapshot) throw new Error("thread.subscribe returned no snapshot");
    this.applySnapshot(payload.snapshot);
  }

  /** Re-fetch the live snapshot (gap detected or socket recovered). */
  async resync(): Promise<void> {
    // Buffer incoming events until the fresh snapshot lands.
    this.patch({ ready: false });
    try {
      const payload = await this.requester.request<{ snapshot?: RemoteThreadSnapshot }>("thread.resync", { threadId: this.view.threadId }, "resync");
      if (!payload?.snapshot) throw new Error("thread.resync returned no snapshot");
      this.applySnapshot(payload.snapshot);
    } catch (error) {
      // Keep the stale view visible instead of a blank screen; the next
      // reconnect/reauth cycle retries.
      this.patch({ ready: true, errorBanner: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  detach(): void {
    this.closing = true;
    this.requester.detach();
    this.detachFrame();
    this.detachState();
    this.listeners.clear();
  }

  // --- internals -----------------------------------------------------------------

  private handleFrame(frame: Record<string, unknown>): void {
    if (frame.type !== "thread.event") return;
    if (typeof frame.threadId === "string" && frame.threadId !== this.view.threadId) return;
    const seq = typeof frame.seq === "number" ? frame.seq : 0;
    const payload = ((frame.payload || {}) as RemoteThreadEventPayload);

    // Before the snapshot lands, buffer — the host registered our listener before
    // fetching the snapshot, so these frames are lossless and ordered.
    if (!this.view.ready) {
      this.pendingEvents.push({ seq, payload });
      return;
    }
    if (seq > 0 && this.expectNext !== null) {
      if (seq < this.expectNext) return; // duplicate/stale — ignore
      if (seq > this.expectNext) {
        void this.resync().catch(() => { /* surfaced via UI error state */ });
        return; // missed events — recover from the live snapshot
      }
    }
    this.applyEvent(payload, seq);
  }

  private applySnapshot(snapshot: RemoteThreadSnapshot): void {
    const summary: RemoteThreadSummary = {
      id: snapshot.id,
      projectId: snapshot.projectId,
      title: snapshot.title,
      preview: snapshot.preview,
      updatedAt: snapshot.updatedAt,
      messageCount: snapshot.messageCount,
      state: snapshot.state,
      permission: snapshot.permission,
    };
    this.view = {
      threadId: this.view.threadId,
      ready: true,
      summary,
      messages: snapshot.messages.map(mapRemoteMessage),
      streaming: null,
      running: snapshot.state === "running",
      errorBanner: null,
    };
    // Re-arm seq tracking: the fresh snapshot makes subsequent events lossless on
    // this socket, so the first live event after it sets the baseline.
    this.expectNext = null;
    // Flush buffered events in arrival order (they postdate the listener registration).
    const buffered = this.pendingEvents;
    this.pendingEvents = [];
    for (const { seq, payload } of buffered) this.applyEvent(payload, seq);
  }

  private applyEvent(payload: RemoteThreadEventPayload, seq: number): void {
    const ev = ((payload.data?.event || {}) as Record<string, any>);
    switch (payload.kind) {
      case "agent_start":
        this.patch({ running: true });
        break;
      case "message_start": {
        const m = ev.message;
        if (!m) break;
        if (m.role === "user") {
          const text = textOfContent(m.content);
          if (text) this.pushMessage({ id: `u-${seq}-${this.view.messages.length}`, role: "user", blocks: [{ type: "text", text }] });
        } else if (!this.view.streaming) {
          this.patch({ streaming: { id: `a-${seq}`, role: "assistant", blocks: [] } });
        }
        break;
      }
      case "message_update": {
        const ame = ev.assistantMessageEvent as Record<string, any> | undefined;
        if (!ame) break;
        this.applyAssistantDelta(ame);
        break;
      }
      case "tool_execution_start": {
        const id = typeof ev.toolCallId === "string" ? ev.toolCallId : "";
        if (id) this.markTool(id, { running: true });
        break;
      }
      case "tool_execution_end": {
        const id = typeof ev.toolCallId === "string" ? ev.toolCallId : "";
        if (!id) break;
        this.markTool(id, { running: false, text: textOfContent(ev.result?.content), isError: !!ev.isError });
        break;
      }
      case "message_end": {
        const m = ev.message;
        if (m?.role === "assistant" && this.view.streaming) {
          const finalMessage: ViewMessage = { ...this.view.streaming, stopReason: m.stopReason, errorMessage: m.errorMessage };
          this.pushMessage(finalMessage);
          this.patch({
            streaming: null,
            errorBanner: m.stopReason === "error" ? (typeof m.errorMessage === "string" && m.errorMessage) || "turn ended with an error" : this.view.errorBanner,
          });
        }
        break;
      }
      case "agent_settled":
        this.patch({ running: false });
        break;
      case "thread.error": {
        const message = typeof payload.data?.message === "string" ? (payload.data.message as string) : "remote error";
        this.patch({ errorBanner: message, running: false });
        break;
      }
      case "thread.exit": {
        const code = payload.data?.code;
        this.patch({ errorBanner: `process exited${typeof code === "number" ? ` (code ${code})` : ""}`, running: false });
        break;
      }
      default:
        // ui.request and friends are handled by the approval layer (S6).
        break;
    }
    if (seq > 0) this.expectNext = seq + 1;
  }

  /** Simplified streaming reducer — see module doc for scope. */
  private applyAssistantDelta(ame: Record<string, any>): void {
    const s = this.view.streaming || { id: `a-${Date.now()}`, role: "assistant" as const, blocks: [] };
    let blocks = s.blocks;

    if (ame.type === "text_delta" && typeof ame.delta === "string") {
      blocks = appendToLast(blocks, "text", ame.delta);
    } else if (ame.type === "thinking_delta" && typeof ame.delta === "string") {
      blocks = appendToLast(blocks, "thinking", ame.delta);
    } else if (ame.type === "toolcall_start" || ame.type === "toolcall_end") {
      const id = (typeof ame.toolCall?.id === "string" && ame.toolCall.id) || (typeof ame.contentIndex === "number" ? `tc-${ame.contentIndex}` : undefined);
      if (!id) return;
      const name = typeof ame.toolCall?.name === "string" && ame.toolCall.name ? ame.toolCall.name : "tool";
      const argsText = summarizeArgs(ame.toolCall?.arguments);
      blocks = upsertToolBlock(blocks, id, { name, ...(argsText ? { argsText } : {}), ...(ame.type === "toolcall_start" ? { running: true } : {}) });
    } else {
      return; // toolcall_delta and others — v1 keeps the last known state
    }

    if (blocks !== s.blocks) this.patch({ streaming: { ...s, blocks } });
  }

  private markTool(id: string, patch: Partial<ViewBlock>): void {
    const apply = (message: ViewMessage): ViewMessage => ({
      ...message,
      blocks: message.blocks.map((b) => (b.type === "tool" && b.id === id ? { ...b, ...patch } : b)),
    });
    this.patch({
      messages: this.view.messages.map(apply),
      streaming: this.view.streaming ? apply(this.view.streaming) : null,
    });
  }

  private pushMessage(message: ViewMessage): void {
    this.patch({ messages: [...this.view.messages, message] });
  }

  private patch(patch: Partial<ThreadView>): void {
    this.view = { ...this.view, ...patch };
    for (const listener of [...this.listeners]) {
      try {
        listener(this.view);
      } catch { /* listeners must never break the session */ }
    }
  }
}

function appendToLast(blocks: ViewBlock[], type: "text" | "thinking", delta: string): ViewBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.type === type) return [...blocks.slice(0, -1), { ...last, text: `${last.text || ""}${delta}` }];
  return [...blocks, { type, text: delta }];
}

function upsertToolBlock(blocks: ViewBlock[], id: string, patch: Partial<ViewBlock>): ViewBlock[] {
  const index = blocks.findIndex((b) => b.type === "tool" && b.id === id);
  if (index >= 0) return [...blocks.slice(0, index), { ...blocks[index], ...patch }, ...blocks.slice(index + 1)];
  return [...blocks, { type: "tool", id, running: true, ...patch }];
}
