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
 *   - detects seq gaps and socket drops → thread.resync (live snapshot);
 *   - **重连后重新注册订阅**：主机按 connectionId 记订阅，断线即清，而 thread.resync
 *     只拉快照不注册——只 resync 会让之后所有实时事件被主机静默丢弃（见
 *     ensureSubscribedLocked 的注释）。
 * Pure logic — node-testable against a real relay + fake host service.
 */
import type {
  RemoteContextUsage, RemoteFileArtifact, RemoteMessage, RemoteModelOption, RemotePermission, RemoteTaskModeOption, RemoteThreadEventPayload, RemoteThreadSnapshot, RemoteThreadSummary, RemoteUiRequest } from "../../../shared/protocol";
import type { RelayClient } from "./relay-client";
import { Requester } from "./requester";

/** Snapshot responses can be multi-MB (large session history); give them a long
 * transfer window instead of the default 10s request timeout. */
const SNAPSHOT_TIMEOUT_MS = 60_000;

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
  /** 乐观回显：本机刚发、主机还没回执的本地占位消息（见 echoUser）。 */
  pending?: boolean;
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
  /** Active model of this thread (display only — host owns the real setting). */
  model: { provider: string; id: string } | null;
  /** Models the host will accept in thread.setModel (display metadata only). */
  availableModels: RemoteModelOption[];
  /** Applied task-mode id (null = baseline). */
  taskMode: string | null;
  /** Task-mode presets the host accepts in thread.setMode. */
  availableModes: RemoteTaskModeOption[];
  /** 上下文用量（与桌面端 ring 同源：主机 get_session_stats） */
  contextUsage: RemoteContextUsage | null;
  /** 压缩进行中（compaction_start…end）。手机端压缩按钮据此转圈。 */
  compacting: boolean;
  /** 本地缓存的快照时间戳（毫秒）；null = 当前内容来自主机实时快照。
   *  对齐原生端 ThreadSession.cachedAt / isCached。 */
  cachedAt: number | null;
  /** S6.3: pending ui.request (approval card). Survives resync — the host keeps
   * the dialog open while the agent is paused, so a reconnect must re-show it. */
  pendingUi: RemoteUiRequest | null;
}

export interface ThreadSessionOptions {
  requestTimeoutMs?: number;
  onStaleConnection?: () => void;
  /**
   * 每次成功应用一份**实时**快照（thread.subscribe / thread.resync）时回调，
   * 用于把它写进本地缓存（Tier 1 内存 / Tier 2 IndexedDB）。
   *
   * **只对实时快照回调**：由缓存播种（applyCachedSnapshot）不会回调，否则会把
   * 缓存自己又写回去、并刷掉真实的 savedAt。
   */
  onSnapshot?: (snapshot: RemoteThreadSnapshot) => void;
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
      // 工具块的正文是 result（曾经写成 b.text → 展开后什么都没有），
      // 其余块用 text。
      text: b.type === "tool" ? b.result : b.text,
      name: b.name,
      running: b.running,
      argsText: b.args,
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
  private readonly client: RelayClient;
  private readonly requester: Requester;
  private readonly listeners = new Set<Listener>();
  /** Events that arrived before the (re)sync snapshot response — flushed after apply. */
  private pendingEvents: Array<{ seq: number; payload: RemoteThreadEventPayload }> = [];
  /** Next expected event seq; null until the first post-snapshot event arms it. */
  private expectNext: number | null = null;
  /** ui.request ids already answered — duplicate pushes must not re-pop the card. */
  private readonly respondedUiIds = new Set<string>();
  private openCount = 0;
  /** open() 是否已完成首次订阅。之前的“重连”判定靠 openCount>1，但 session 可能是
   * 在 client 已经 open 之后才创建的（配对完成后才 new ThreadSession），那时**第一个
   * 观测到的 open 已经是重连**，会被 openCount<=1 误当成首次而跳过失效——真实事故就是
   * 这么漏的。改用这个标志：open() 前不插手，open() 后每一次 open 都是重连。 */
  private opened = false;
  /** 当前连接在主机侧是否已注册订阅。断线后主机按 connectionId 清掉它 → 必须置 false。 */
  private subscribed = false;
  /** 进行中的订阅补齐 / 重同步：重连回调会连着来好几次，复用同一次，避免重复拉全量快照。 */
  private syncInFlight: Promise<void> | null = null;
  private closing = false;
  /** 乐观回显计数（local-<n>）。 */
  private echoSeq = 0;
  private readonly detachFrame: () => void;
  private readonly detachState: () => void;
  /** 实时快照的落地回调（写本地缓存用），见 ThreadSessionOptions.onSnapshot。 */
  private readonly onSnapshot?: (snapshot: RemoteThreadSnapshot) => void;

  constructor(
    client: RelayClient,
    threadId: string,
    options: ThreadSessionOptions = {},
  ) {
    this.view = { threadId, ready: false, summary: null, messages: [], streaming: null, running: false, errorBanner: null, model: null, availableModels: [], taskMode: null, availableModes: [], contextUsage: null, compacting: false, cachedAt: null, pendingUi: null };
    this.client = client;
    this.onSnapshot = options.onSnapshot;
    // threadId goes on the ENVELOPE (host's requiredThread reads it there); the
    // payload copy below is kept for compatibility with simpler test fakes.
    this.requester = new Requester(client, { requestTimeoutMs: options.requestTimeoutMs, onStaleConnection: options.onStaleConnection, threadId });

    // Subscribe before any traffic can flow (RelayClient does not buffer frames).
    this.detachFrame = client.onFrame((frame) => this.handleFrame(frame));
    this.detachState = client.onState((state) => {
      if (state !== "open" || this.closing) return;
      this.openCount += 1;
      // open() 完成前的 open 由 open() 自己负责（它 await whenReady 后订阅），不插手，
      // 否则会和首次订阅撞车。
      if (!this.opened) return;
      // 每次“变为 open”都当作一次重连：主机按 connectionId 记订阅，任何重连后旧订阅
      // 都已失效，**必须重注册**。否则 resync 只拿回快照、订阅始终是空的，之后所有
      // 实时事件都被主机静默丢弃（diag 里就是 `remote-pub … subs=0`），真机症状是
      // 气泡卡在「发送中」、整条回复连同提问一起晚到。resync 内部会在未订阅时自动
      // 走 thread.subscribe。
      this.invalidateSubscription();
      void this.resync().catch(() => { /* surfaced via UI error state */ });
    });
  }

  getSnapshot(): ThreadView {
    return this.view;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Subscribe to the thread; resolves once the initial snapshot is applied.
   * Large sessions (multi-MB history) need a long timeout for the snapshot
   * transfer — the default 10s would kill perfectly healthy loads. */
  async open(): Promise<void> {
    // Deep links land on a fresh page load: wait for the hello/challenge E2E
    // handshake to finish, otherwise the first subscribe dies with
    // "connection not ready" and there is no retry (S8 acceptance ③).
    await this.client.whenReady();
    await this.ensureSubscribedLocked();
    this.opened = true;
  }

  /**
   * 保证当前连接已在主机侧注册订阅（幂等；已订阅时零往返）。
   *
   * 主机按 **connectionId** 记订阅，连接断开时会被清掉（service.ts 的 disconnect()），
   * 而 `thread.resync` **只拉快照、不注册订阅**。所以重连后只 resync 的话，之后所有
   * 实时事件都会被主机静默丢弃——diag 里的指纹是 `remote-pub … subs=0`，真机症状是
   * 「气泡卡发送中 / 整条消息包括回复一起晚到 / 看着像一直在加载」。
   *
   * 用 `thread.subscribe` 补而不是另发一个请求：它的响应**本身就带回最新快照**，
   * 既注册又拿数据，省一次往返（与原生端 ThreadSession.kt 的同一取舍）。
   */
  private async ensureSubscribedLocked(): Promise<void> {
    if (this.subscribed) return;
    const payload = await this.requester.request<{ snapshot?: RemoteThreadSnapshot }>("thread.subscribe", { threadId: this.view.threadId }, "subscribe", SNAPSHOT_TIMEOUT_MS);
    if (!payload?.snapshot) throw new Error("thread.subscribe returned no snapshot");
    // 先置位再应用快照：applySnapshot 会 flush 缓冲事件，那一刻起已算已订阅。
    this.subscribed = true;
    this.applySnapshot(payload.snapshot);
  }

  /** 重连后调用：新连接在主机侧没有订阅，标记失效，让下一次 [resync] /
   * [ensureSubscribed] 重新注册（原生端 invalidateSubscription 的等价物）。 */
  invalidateSubscription(): void {
    this.subscribed = false;
  }

  /** 发送路径的兜底：正在对话时保证订阅在（已订阅时是纯本地判断，零往返）。
   * 失败**不抛出**——订阅丢了不该让用户发不出消息，真实错误由发送本身暴露。 */
  async ensureSubscribed(): Promise<void> {
    if (this.closing) return;
    try {
      await this.ensureSubscribedLocked();
    } catch { /* 兜底失败不阻断发送 */ }
  }

  /** Re-fetch the live snapshot (gap detected or socket recovered).
   * 并发调用复用同一次同步：重连回调会连着来好几次。 */
  async resync(): Promise<void> {
    if (this.syncInFlight) return this.syncInFlight;
    this.syncInFlight = (async () => {
      try {
        await this.runSync();
      } finally {
        this.syncInFlight = null;
      }
    })();
    return this.syncInFlight;
  }

  private async runSync(): Promise<void> {
    // 未订阅（重连后的新连接）：直接走订阅——它带回的快照就是最新的，既不漏注册
    // 又省一次往返。此时**不动 ready**，避免消息区无谓地闪一下「加载中」。
    if (!this.subscribed) {
      try {
        await this.ensureSubscribedLocked();
        return;
      } catch (error) {
        this.patch({ ready: true, errorBanner: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }
    // Buffer incoming events until the fresh snapshot lands.
    this.patch({ ready: false });
    try {
      const payload = await this.requester.request<{ snapshot?: RemoteThreadSnapshot }>("thread.resync", { threadId: this.view.threadId }, "resync", SNAPSHOT_TIMEOUT_MS);
      if (!payload?.snapshot) throw new Error("thread.resync returned no snapshot");
      this.applySnapshot(payload.snapshot);
    } catch (error) {
      // Keep the stale view visible instead of a blank screen; the next
      // reconnect/reauth cycle retries.
      this.patch({ ready: true, errorBanner: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * 回合收口：结束视图级 running，并把**还标着「运行中」的工具块**一并关掉。
   *
   * 为什么需要：工具启动后若回合被**中断**（用户点停止）或进程退出，`tool_execution_end`
   * 可能永远不来 → 那一行工具永远转圈（「一直在执行中」）。`agent_settled` 是「本回合彻底
   * 结束」的权威信号，此后不可能还有工具在跑，所以在这里收口是安全的。
   *
   * ⚠️ 不能用 `message_end`：assistant 消息结束时工具**尚未执行**（`tool_execution_*`
   * 在其后发生），在那里清会把正在跑的工具误标成完成。
   */
  private settleTurn(extra: Partial<ThreadView> = {}): void {
    const close = (message: ViewMessage): ViewMessage => {
      if (!message.blocks.some((b) => b.type === "tool" && b.running)) return message;
      return { ...message, blocks: message.blocks.map((b) => (b.type === "tool" && b.running ? { ...b, running: false } : b)) };
    };
    this.patch({
      ...extra,
      running: false,
      messages: this.view.messages.map(close),
      streaming: this.view.streaming ? close(this.view.streaming) : null,
    });
  }

  /** Call after ui.respond succeeds — dedupes re-pushes and clears the card. */
  markUiResponded(requestId: string): void {
    this.respondedUiIds.add(requestId);
    if (this.view.pendingUi?.id === requestId) this.patch({ pendingUi: null });
  }

  detach(): void {
    // S8.7: capture WHO detaches a thread session (real-device hang diagnosis).
    try {
      const hooks = (globalThis as unknown as { __mpi_dbg?: { dbg?: (e: Record<string, unknown>) => void } }).__mpi_dbg;
      hooks?.dbg?.({
        kind: "removed",
        label: `thread:${this.view.threadId.slice(0, 8)}`,
        requestId: "*",
        reason: `ts-detach stack=${new Error("ts-detach").stack?.split("\n").slice(2, 5).join(" <- ") ?? "?"}`,
      });
    } catch { /* diagnostics must never break the app */ }
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

  /** 实时快照（thread.subscribe / thread.resync）：先落地再回调缓存写入，
   *  并把「显示的是缓存」标记清空。 */
  private applySnapshot(snapshot: RemoteThreadSnapshot): void {
    this.applySnapshotCore(snapshot, null);
    try {
      this.onSnapshot?.(snapshot);
    } catch { /* 缓存写入失败绝不能影响主流程 */ }
  }

  /**
   * 用本地缓存的快照先撑起界面（Tier 1 内存 / Tier 2 IndexedDB），随后由 open()
   * 的实时快照替换（成功即 cachedAt 清空）。
   *
   * 与原生端 ThreadSession.applyCached 同一取舍：缓存里的 seq 基线已过时，
   * applySnapshotCore 会把 expectNext 置 null，让首个实时事件重建基线。
   * 不触发 onSnapshot —— 否则会把缓存自己又写回去、并刷掉真实的 savedAt。
   */
  applyCachedSnapshot(snapshot: RemoteThreadSnapshot, savedAt: number): void {
    this.applySnapshotCore(snapshot, savedAt);
  }

  private applySnapshotCore(snapshot: RemoteThreadSnapshot, cachedAt: number | null): void {
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
    // S8.7 fix: MUST notify listeners — a direct view assignment leaves React's
    // mirrored state stale (UI stuck on "loading") whenever no buffered/live
    // event follows to trigger patch(). Idle threads never emit events, so the
    // snapshot itself has to be the notification.
    this.patch({
      ready: true,
      summary,
      // 快照是权威历史：残余的乐观占位一律丢弃（主机此时一定已经有了这条消息）。
      messages: snapshot.messages.map(mapRemoteMessage),
      streaming: null,
      running: snapshot.state === "running",
      errorBanner: null,
      model: snapshot.model ?? null,
      availableModels: snapshot.availableModels ?? [],
      taskMode: snapshot.taskMode ?? null,
      availableModes: snapshot.availableModes ?? [],
      contextUsage: snapshot.contextUsage ?? null,
      // 快照到达即认为压缩不在进行中：真在压缩的话后续 compaction_end 会再纠正，
      // 而漏掉一个 end 事件会让按钮永远转圈。
      compacting: false,
      cachedAt,
      pendingUi: this.view.pendingUi, // a pending approval survives the resync
    });
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
          if (text) {
            // 本地乐观回显先转正（否则同一条消息会上屏两次）。
            const echo = [...this.view.messages].reverse().find((message) => message.pending && message.role === "user" && message.blocks.some((b) => b.type === "text" && b.text === text));
            if (echo) {
              this.patch({ messages: this.view.messages.map((message) => (message.id === echo.id ? { ...message, pending: false } : message)) });
            } else {
              this.pushMessage({ id: `u-${seq}-${this.view.messages.length}`, role: "user", blocks: [{ type: "text", text }] });
            }
          }
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
        if (id) this.markTool(id, { running: true }, pickString(ev.toolName));
        break;
      }
      case "tool_execution_end": {
        const id = typeof ev.toolCallId === "string" ? ev.toolCallId : "";
        if (!id) break;
        this.markTool(
          id,
          { running: false, text: textOfContent(ev.result?.content), isError: !!ev.isError },
          pickString(ev.toolName),
        );
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
        this.settleTurn();
        break;
      case "thread.error": {
        const message = typeof payload.data?.message === "string" ? (payload.data.message as string) : "remote error";
        this.settleTurn({ errorBanner: message });
        break;
      }
      case "thread.exit": {
        const code = payload.data?.code;
        this.settleTurn({ errorBanner: `process exited${typeof code === "number" ? ` (code ${code})` : ""}` });
        break;
      }
      case "permission_changed": {
        // 桌面端改了权限（或远程 setPermission）——头部徽标实时同步。二值协议：sandbox|full。
        const perm = payload.data?.permission;
        if (this.view.summary && (perm === "sandbox" || perm === "full")) {
          this.patch({ summary: { ...this.view.summary, permission: perm } });
        }
        break;
      }
      case "context_usage": {
        // 主机在回合结束/压缩结束推送的最新用量（与桌面 ring 同一份数据），
        // 以及桥就绪后的当前模型补推——新会话 JSONL 没有 model_change 条目，
        // history.model 恒为 null，不应用这条 chip 会一直停在「默认模型」。
        const data = (payload.data || {}) as Partial<RemoteContextUsage> & {
          model?: { provider: string; id: string } | null;
        };
        if (typeof data.contextWindow === "number") {
          this.patch({
            contextUsage: {
              tokens: typeof data.tokens === "number" ? data.tokens : null,
              contextWindow: data.contextWindow,
              percent: typeof data.percent === "number" ? data.percent : null,
              estimatedTokens: typeof data.estimatedTokens === "number" ? data.estimatedTokens : null,
            },
          });
        }
        if (data.model && typeof data.model.id === "string") {
          this.patch({ model: { provider: String(data.model.provider ?? ""), id: data.model.id } });
        }
        break;
      }
      case "compaction_start":
        this.patch({ compacting: true });
        break;
      case "compaction_end":
        this.patch({ compacting: false });
        break;
      case "config_changed": {
        // 会话配置同步（main 广播）：桌面端/agent 改的权限、模型、任务模式、思考
        // 等级都要反映到手机上，否则 chip 会停在旧值到下次 resync。
        const data = (payload.data || {}) as {
          permission?: RemotePermission;
          model?: { provider: string; id: string } | null;
          taskMode?: string | null;
          thinkingLevel?: string;
          origin?: string;
        };
        const patch: Partial<ThreadView> = {};
        if (data.permission && this.view.summary && this.view.summary.permission !== data.permission) {
          patch.summary = { ...this.view.summary, permission: data.permission };
        }
        if (data.model !== undefined) patch.model = data.model ?? null;
        if (data.taskMode !== undefined) patch.taskMode = data.taskMode ?? null;
        if (Object.keys(patch).length) this.patch(patch);
        break;
      }
      case "ui.request": {
        const request = payload.data?.request as RemoteUiRequest | undefined;
        // Duplicate pushes must not re-pop the card — neither for an id that is
        // already on screen nor for one that was answered.
        if (
          request &&
          typeof request.id === "string" &&
          !this.respondedUiIds.has(request.id) &&
          this.view.pendingUi?.id !== request.id
        ) {
          this.patch({ pendingUi: request });
        }
        break;
      }
      default:
        // Other kinds are ignored by the simplified reducer.
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
      const contentIndex = typeof ame.contentIndex === "number" ? ame.contentIndex : undefined;
      // pi 的 `toolcall_start` **只带 `partial.content[contentIndex]`，不带 `toolCall`**
      // （见 pi-ai 的 AssistantMessageEvent 定义）；`toolcall_end` 才给权威 `toolCall`。
      // 两边都要看，否则开始时只能拿占位 id + 名字写成字面量 "tool"——而 `toolcall_end`
      // 换来真 id 后会被当成另一个块，留下一个永远转圈的幽灵
      // （2026-09-25 真机截图：一行「tool」在转、紧接着一行「bash ✓」）。
      const fromEvent = (ame.toolCall || undefined) as Record<string, any> | undefined;
      const partialContent = (ame.partial as Record<string, any> | undefined)?.content;
      const fromPartial =
        contentIndex !== undefined && Array.isArray(partialContent)
          ? (partialContent[contentIndex] as Record<string, any> | undefined)
          : undefined;
      const realId = pickString(fromEvent?.id) ?? pickString(fromPartial?.id);
      const placeholder = contentIndex === undefined ? undefined : `${TOOL_PLACEHOLDER_PREFIX}${contentIndex}`;
      const id = realId ?? placeholder;
      if (!id) return;
      const name = pickString(fromEvent?.name) ?? pickString(fromPartial?.name) ?? "tool";
      const argsText = summarizeArgs(fromEvent?.arguments ?? fromPartial?.arguments);
      // 真 id 与本 contentIndex 的占位块不同 → 改名合并，而不是新建
      const renameFrom = realId && placeholder && placeholder !== realId ? placeholder : undefined;
      blocks = upsertToolBlock(
        blocks,
        id,
        {
          name,
          ...(argsText ? { argsText } : {}),
          // `toolcall_end` 不主动清 running：收口交给 `tool_execution_end`（与原生端一致）
          ...(ame.type === "toolcall_start" ? { running: true } : {}),
        },
        renameFrom,
      );
    } else {
      return; // toolcall_delta and others — v1 keeps the last known state
    }

    if (blocks !== s.blocks) this.patch({ streaming: { ...s, blocks } });
  }

  /**
   * 更新工具块状态。**双路径匹配**（与原生 ThreadSession.markTool 同一套）：
   *   ① 按 `toolCallId`（正常路径，contentIndex 合并已经把 id 对齐）；
   *   ② 退回「**同名**且在跑且 id 还停在占位值」的块，把它**认领**到真 id。
   *      覆盖流中断导致 `toolcall_end` 没来、块 id 一直停在 `tc-` 的情况——
   *      没有这层，那一行会永远转圈（真机反馈的「一直在执行中」）。
   */
  private markTool(id: string, patch: Partial<ViewBlock>, toolName?: string): void {
    const apply = (message: ViewMessage): ViewMessage => {
      let claimed = false;
      const blocks = message.blocks.map((b) => {
        if (b.type !== "tool") return b;
        if (b.id === id) {
          claimed = true;
          return { ...b, ...patch };
        }
        if (
          !claimed &&
          toolName !== undefined &&
          b.name === toolName &&
          b.running &&
          typeof b.id === "string" &&
          b.id.startsWith(TOOL_PLACEHOLDER_PREFIX)
        ) {
          claimed = true; // 占位块认领到真 id，后续事件才能命中
          return { ...b, ...patch, id };
        }
        return b;
      });
      return { ...message, blocks };
    };
    this.patch({
      messages: this.view.messages.map(apply),
      streaming: this.view.streaming ? apply(this.view.streaming) : null,
    });
  }

  /**
   * 乐观回显：点发送后立刻把用户消息上屏，**不等主机回执**。
   *
   * 真机反馈「点发送要卡五六秒才发出去」：原实现是 `await send()` 成功后才清空输入框，
   * 而这条往返里包含主机建桥/冷启动 pi 的时间。现在本地先上屏（pending），
   * 主机真正收到后 message_start(user) 会把它「转正」，snapshot 到达时清掉残余占位。
   */
  echoUser(input: { text: string; images?: { data: string; mimeType: string }[]; fileCount?: number }): string {
    const id = `local-${++this.echoSeq}`;
    const blocks: ViewBlock[] = [
      ...(input.images || []).map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
      ...(input.text ? [{ type: "text" as const, text: input.text }] : []),
      ...(input.fileCount ? [{ type: "text" as const, text: `📎 ${input.fileCount} 个文件` }] : []),
    ];
    this.pushMessage({ id, role: "user", blocks, pending: true });
    return id;
  }

  /** 发送失败（主机没接住）——撤掉占位气泡，避免留下幽灵消息。 */
  dropEcho(id: string): void {
    this.patch({ messages: this.view.messages.filter((message) => message.id !== id) });
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

/** 取非空字符串字段：pi 事件的字段经常缺省或为空串（id/name 都靠它区分「有值」与「空壳」）。 */
function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** `toolcall_start` 没拿到真 id 时给工具块用的占位 id 前缀（与原生 ThreadSession 一致）。 */
const TOOL_PLACEHOLDER_PREFIX = "tc-";

/**
 * 插入或更新一个工具块。
 *
 * `renameFrom`：**占位 id → 真 id 的合并**。pi 的 `toolcall_start` 只带
 * `partial.content[contentIndex]`（**没有 `toolCall` 字段**），拿不到真 id 时只能用
 * `tc-<contentIndex>` 占位；`toolcall_end` 才带来权威 `toolCall`。不做这一步合并，
 * 真 id 到达时会被当成**另一个块**，留下一个 id 停在占位值、永远转圈的幽灵（真机反馈）。
 */
function upsertToolBlock(blocks: ViewBlock[], id: string, patch: Partial<ViewBlock>, renameFrom?: string): ViewBlock[] {
  let index = blocks.findIndex((b) => b.type === "tool" && b.id === id);
  if (index < 0 && renameFrom) index = blocks.findIndex((b) => b.type === "tool" && b.id === renameFrom);
  if (index >= 0) {
    // 合并：认领后统一用真 id（后续 tool_execution_* 才能命中）
    return [...blocks.slice(0, index), { ...blocks[index], ...patch, id }, ...blocks.slice(index + 1)];
  }
  return [...blocks, { type: "tool", id, running: true, ...patch }];
}
