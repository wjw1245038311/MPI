/**
 * Shared logic for chat channels (Feishu / WeChat). Both services route
 * messages from a bound user into one dedicated pi session in the bound
 * project folder and support the same session commands (/new, /list, /use <n>,
 * "上一个", plus the mpi_channel_* agent tools). Everything that is identical
 * across channels lives here; subclasses keep only the transport specifics —
 * how messages arrive (WebSocket vs iLink long-poll) and how replies are
 * delivered (in-place message update vs fresh message + typing indicator).
 */
import type { PermissionLevel } from "../config";
import type { RemoteBackend } from "../remote/service";
import { parseChatCommand, resolveThreadTarget } from "./command-parse";
import { truncateForChat, type ChannelTexts } from "./channel-text";
import {
  registerChannelThread,
  unregisterChannelThread,
  type ChannelCommandAction,
  type ChannelCommandResult,
} from "./channel-threads";
import type { MessagingStatus } from "./types";

/** Hard cap for one agent turn driven from chat (watchdog). */
export const JOB_TIMEOUT_MS = 30 * 60 * 1000;
/** Max chars delivered to chat in a single message. */
export const MAX_REPLY_CHARS = 4000;
const DEDUP_CAP = 1000;

export interface JobRef {
  cancelled: boolean;
  /** Resolves the in-flight job's settle promise immediately (used by stop()). */
  settleNow?: () => void;
}

/** Options shared by all chat channels. S is the channel's renderer state type. */
export interface ChannelServiceOptions<S> {
  backend: RemoteBackend;
  /** Maps a project cwd to the opaque remote project id (see ipc.ts). */
  resolveProjectId: (cwd: string) => string;
  /** Resolves an opaque/draft thread id to its session-file UUID — the key
   * both this registry and the pi-side channel extension can compute. */
  resolveSessionUuid?: (threadId: string) => Promise<string | null>;
  language: () => "en" | "zh";
  onStateChange: (state: S) => void;
}

/** The sanitized-config fields the shared logic needs (both channel configs
 * satisfy this structurally). */
export interface ChannelConfigView {
  projectCwd: string;
  permission: PermissionLevel;
  activeThreadId?: string;
}

type ReplyFn = (text: string) => Promise<void>;

/** Params for one agent turn — the channel-specific delivery hooks. */
export interface AgentTurnParams {
  /** Send the initial "thinking" ack so the user always gets feedback. */
  ack: () => Promise<void>;
  /** Prompt text for the agent turn. */
  text: string;
  /** Optional streaming hook — called with the accumulated buffer on every
   * delta (Feishu uses it to update its ack message in place). */
  onSnapshot?: (buffer: string) => void;
  /** Deliver a one-shot text to the user (ensureThread errors + final result,
   * already truncated by runAgentTurn). */
  deliver: (text: string) => Promise<void>;
}

export abstract class ChannelBase<S> {
  protected status: MessagingStatus = "off";
  protected lastError: string | null = null;
  /** message_id dedup (the server may re-push/re-deliver); insertion-ordered. */
  protected readonly seen = new Map<string, true>();
  protected currentThreadId: string | null = null;
  /** Session-file UUID of the currently registered channel thread (registry key). */
  protected currentSessionUuid: string | null = null;
  /** Serializes async registry mutations so rapid switches can't interleave. */
  protected registryChain: Promise<void> = Promise.resolve();
  /** Previously active session, so "上一个" can ping-pong between two sessions (in-memory only). */
  protected previousThreadId: string | null = null;
  protected job: JobRef | null = null;

  constructor(
    protected readonly options: ChannelServiceOptions<S>,
    private readonly texts: { zh: ChannelTexts; en: ChannelTexts },
  ) {}

  // ---- abstract: transport + config specifics ------------------------------

  /** Log prefix, e.g. "[messaging]" or "[wechat]". */
  protected abstract get logTag(): string;
  /** Sanitized channel config from the app config (fresh read each call). */
  protected abstract loadConfig(): ChannelConfigView;
  /** Merge a patch into this channel's persisted config section. */
  protected abstract mergeChannelConfig(patch: Record<string, unknown>): void;
  /** Dedicated session title for this channel — both language variants matter
   * (ensureThread matches either so a UI-language switch doesn't fork). */
  protected abstract sessionName(language: "en" | "zh"): string;
  /** Registry label so commands route back to the right service. */
  protected abstract get channelKind(): "feishu" | "wechat";
  /** Renderer-facing state (credentials masked). */
  abstract getState(): S;
  /** Ad-hoc message to the bound user (approval notices). Best-effort. */
  protected abstract notifyUser(text: string): Promise<void>;

  // ---- shared bookkeeping ---------------------------------------------------

  /** Emits the new state to the renderer. Called after every status or
   * lastError transition; the payload is cheap, so no dedup needed. */
  protected setStatus(status: MessagingStatus): void {
    this.status = status;
    try {
      this.options.onStateChange(this.getState());
    } catch (err) {
      console.error(`${this.logTag} onStateChange failed:`, err);
    }
  }

  protected rememberSeen(messageId: string): void {
    this.seen.set(messageId, true);
    if (this.seen.size > DEDUP_CAP) {
      const keys = this.seen.keys();
      for (let i = 0; i < DEDUP_CAP / 2; i++) {
        const next = keys.next();
        if (next.done) break;
        this.seen.delete(next.value);
      }
    }
  }

  // ---- session commands ------------------------------------------------------

  /** Handles /help and parsed chat commands (/new, /list, /use <n>, "上一个"…).
   * Returns true when the text was consumed as a command — commands work even
   * while busy. Phrasings parseChatCommand doesn't know reach the agent, which
   * can act on them via the mpi_channel_* tools (channel-command-ext). */
  protected async dispatchCommand(text: string, reply: ReplyFn): Promise<boolean> {
    const lang = this.texts[this.options.language()];
    const cmd = text.trim().toLowerCase();
    if (cmd === "/help" || cmd === "帮助") {
      await reply(lang.help);
      return true;
    }
    const parsed = parseChatCommand(cmd);
    if (!parsed) return false;
    switch (parsed.kind) {
      case "new":
        await this.handleNewCommand(reply);
        break;
      case "list":
        void this.handleListCommand(reply).catch((err) => console.error(`${this.logTag} /list failed:`, err));
        break;
      case "use":
        void this.handleUseCommand(parsed.arg, reply).catch((err) => console.error(`${this.logTag} /use failed:`, err));
        break;
      case "back":
        void this.handleBackCommand(reply).catch((err) => console.error(`${this.logTag} back failed:`, err));
        break;
    }
    return true;
  }

  protected async handleNewCommand(reply: ReplyFn): Promise<void> {
    try {
      // Capture BEFORE createThread — it already switches the active thread.
      const prev = this.currentThreadId;
      const id = await this.createThread();
      if (prev && prev !== id) this.previousThreadId = prev;
      this.persistActiveThreadId(id);
      await reply(this.texts[this.options.language()].newDone);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${this.logTag} /new failed:`, message);
      await reply(`${this.texts[this.options.language()].errorPrefix}${message.slice(0, 300)}`);
    }
  }

  /** Recent sessions in the bound project, newest first (backing for /list and /use). */
  protected async recentThreads(limit?: number): Promise<Array<{ id: string; title: string }>> {
    const cfg = this.loadConfig();
    const projectId = this.options.resolveProjectId(cfg.projectCwd);
    const raw = await this.options.backend.listThreads(projectId);
    const items = (Array.isArray(raw) ? raw : [])
      .filter((t: any) => t && typeof t.id === "string")
      .map((t: any) => ({
        id: String(t.id),
        title: typeof t.title === "string" && t.title.trim() ? t.title.trim() : "(untitled)",
        updatedAt: Number(t.updatedAt ?? 0) || 0,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return (limit !== undefined ? items.slice(0, limit) : items).map(({ id, title }) => ({ id, title }));
  }

  protected async handleListCommand(reply: ReplyFn): Promise<void> {
    const lang = this.texts[this.options.language()];
    try {
      const list = await this.recentThreads(10);
      if (!list.length) {
        await reply(lang.noSessions);
        return;
      }
      const lines = list.map((t, i) => `${i + 1}. ${t.id === this.currentThreadId ? "➜ " : ""}${t.title}`);
      await reply([lang.listHeader, ...lines, lang.useHint].join("\n"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${this.logTag} /list failed:`, message);
      await reply(`${lang.errorPrefix}${message.slice(0, 300)}`);
    }
  }

  protected async handleUseCommand(arg: string, reply: ReplyFn): Promise<void> {
    const lang = this.texts[this.options.language()];
    try {
      const resolved = await this.resolveSwitchTarget(arg);
      if ("notFound" in resolved) {
        await reply(lang.useNotFound);
        return;
      }
      if ("candidates" in resolved) {
        // Ambiguous — show the matches with their /list indexes.
        const list = await this.recentThreads(10);
        const lines = resolved.candidates.map((t) => `${list.findIndex((x) => x.id === t.id) + 1}. ${t.title}`);
        await reply([lang.useAmbiguous, ...lines].join("\n"));
        return;
      }
      this.applySwitch(resolved.target.id);
      await reply(`${lang.useDone}${resolved.target.title}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${this.logTag} /use failed:`, message);
      await reply(`${lang.errorPrefix}${message.slice(0, 300)}`);
    }
  }

  /** "上一个" — go back to the previously active session (ping-pong). */
  protected async handleBackCommand(reply: ReplyFn): Promise<void> {
    const lang = this.texts[this.options.language()];
    try {
      if (!this.previousThreadId || this.previousThreadId === this.currentThreadId) {
        await reply(lang.backNone);
        return;
      }
      const prev = (await this.recentThreads()).find((t) => t.id === this.previousThreadId);
      if (!prev) {
        await reply(lang.backNone);
        return;
      }
      // Swap so the next "上一个" goes forward again.
      this.previousThreadId = this.currentThreadId;
      this.setActiveThread(prev.id);
      this.persistActiveThreadId(prev.id);
      await reply(`${lang.useDone}${prev.title}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${this.logTag} back failed:`, message);
      await reply(`${lang.errorPrefix}${message.slice(0, 300)}`);
    }
  }

  /** Resolves a switch target (number / id / title keyword) against recent threads. */
  protected async resolveSwitchTarget(
    arg: string,
  ): Promise<
    | { target: { id: string; title: string } }
    | { notFound: true }
    | { candidates: Array<{ id: string; title: string }> }
  > {
    if (/^\d+$/.test(arg)) {
      // Indexes into the same top-10 list that /list shows.
      const n = Number.parseInt(arg, 10);
      const target = (await this.recentThreads(10))[n - 1];
      return target ? { target } : { notFound: true };
    }
    // Exact id first, then case-insensitive title substring (natural language).
    const list = await this.recentThreads(10);
    const resolved = resolveThreadTarget(list, arg);
    if (!resolved) return { notFound: true };
    if ("candidates" in resolved) return { candidates: resolved.candidates };
    return { target: resolved.target };
  }

  /** Applies a switch: remembers the old thread for "上一个", persists, activates. */
  protected applySwitch(targetId: string): void {
    if (this.currentThreadId && this.currentThreadId !== targetId) {
      this.previousThreadId = this.currentThreadId;
    }
    this.setActiveThread(targetId);
    this.persistActiveThreadId(targetId);
  }

  /** Executes agent-requested session commands (mpi_channel_* tools). */
  protected async handleChannelCommand(
    action: ChannelCommandAction,
    target: string | null,
  ): Promise<ChannelCommandResult> {
    if (action === "list") {
      const list = await this.recentThreads(10);
      return { ok: true, sessions: list.map((t, i) => ({ index: i + 1, title: t.title, current: t.id === this.currentThreadId })) };
    }
    if (action === "new") {
      // Capture BEFORE createThread — it already switches the active thread.
      const prev = this.currentThreadId;
      const id = await this.createThread();
      if (prev && prev !== id) this.previousThreadId = prev;
      return { ok: true, switchedTo: "(new session)" };
    }
    // switch
    if (!target) return { ok: false, error: "missing_target" };
    const resolved = await this.resolveSwitchTarget(target);
    if ("notFound" in resolved) return { ok: false, error: `session_not_found:${target}` };
    if ("candidates" in resolved) {
      // Ambiguous — hand the candidates back so the agent can ask the user.
      const list = await this.recentThreads(10);
      return {
        ok: false,
        error: "ambiguous",
        sessions: resolved.candidates.map((t) => ({
          index: list.findIndex((x) => x.id === t.id) + 1,
          title: t.title,
          current: t.id === this.currentThreadId,
        })),
      };
    }
    this.applySwitch(resolved.target.id);
    return { ok: true, switchedTo: resolved.target.title };
  }

  /** Remembers the active session so restarts keep routing to it (if it still exists). */
  protected persistActiveThreadId(threadId: string): void {
    try {
      this.mergeChannelConfig({ activeThreadId: threadId });
    } catch (err) {
      console.error(`${this.logTag} persist activeThreadId failed:`, err);
    }
  }

  // ---- thread resolution -----------------------------------------------------

  /** Reuses the channel's dedicated session (matched by title) or creates it. */
  protected async ensureThread(): Promise<string> {
    const cfg = this.loadConfig();
    // Restore the last explicitly selected session (/new, /use) when it still exists.
    if (cfg.activeThreadId) {
      try {
        const found = (await this.recentThreads()).find((t) => t.id === cfg.activeThreadId);
        if (found) {
          this.setActiveThread(found.id);
          return found.id;
        }
      } catch (err) {
        console.error(`${this.logTag} restore active thread failed:`, err);
      }
    }
    const projectId = this.options.resolveProjectId(cfg.projectCwd);
    try {
      const threads = await this.options.backend.listThreads(projectId);
      // Match either language variant so a UI-language switch doesn't fork a second session.
      const names = [this.sessionName("zh"), this.sessionName("en")];
      const found = (Array.isArray(threads) ? threads : []).find((t: any) => names.includes(t?.title) || names.includes(t?.name));
      if (found && typeof found.id === "string") {
        this.setActiveThread(found.id);
        return found.id;
      }
    } catch (err) {
      console.error(`${this.logTag} listThreads failed:`, err);
    }
    return this.createThread();
  }

  protected async createThread(): Promise<string> {
    const cfg = this.loadConfig();
    const projectId = this.options.resolveProjectId(cfg.projectCwd);
    const snapshot: any = await this.options.backend.createThread(
      projectId,
      this.sessionName(this.options.language()),
      cfg.permission === "full" ? "full" : "sandbox",
    );
    if (!snapshot || typeof snapshot.id !== "string") throw new Error("Failed to create the channel session");
    this.setActiveThread(snapshot.id);
    return snapshot.id;
  }

  /** Sets the active session and keeps the channel-thread registry in sync so
   * sandbox approvals on it get a channel notice + auto-deny (channel-threads).
   * The registry is keyed by session-file UUID (the only id the pi-side
   * extension can compute), which must be resolved asynchronously — hence the
   * serialized chain; a superseded call never touches the registry. */
  protected setActiveThread(threadId: string | null): void {
    this.currentThreadId = threadId;
    const target = threadId;
    this.registryChain = this.registryChain.then(async () => {
      if (target !== this.currentThreadId) return; // superseded — the newer call owns the registry
      let uuid: string | null = null;
      if (target && this.options.resolveSessionUuid) {
        try {
          uuid = await this.options.resolveSessionUuid(target);
        } catch {
          /* thread gone meanwhile — leave unregistered */
        }
      }
      if (this.currentSessionUuid && this.currentSessionUuid !== uuid) unregisterChannelThread(this.currentSessionUuid);
      if (uuid) {
        registerChannelThread(uuid, {
          channel: this.channelKind,
          notifyApproval: (text) => this.notifyUser(text),
          handleCommand: (action, targetId) => this.handleChannelCommand(action, targetId),
        });
      }
      this.currentSessionUuid = uuid;
    });
  }

  // ---- job execution ---------------------------------------------------------

  /** Runs one agent turn driven from chat: ack → resolve thread → subscribe →
   * prompt → wait for settle (with watchdog) → deliver the final result. The
   * channel-specific parts (ack shape, streaming updates, delivery primitive)
   * are injected so Feishu's in-place message update and WeChat's fresh-message
   * + typing indicator share one implementation. */
  protected async runAgentTurn(params: AgentTurnParams): Promise<void> {
    const lang = this.texts[this.options.language()];
    const ref: JobRef = { cancelled: false };
    this.job = ref;

    let buffer = "";
    let settledResolve: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settledResolve = resolve;
    });
    ref.settleNow = settledResolve;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    let failureText: string | null = null;

    try {
      // Ack first so the user always gets feedback — even if thread resolution
      // or prompting fails below. Never fail silently.
      await params.ack();

      let threadId: string;
      try {
        threadId = this.currentThreadId || (await this.ensureThread());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`${this.logTag} ensureThread failed:`, message);
        await params.deliver(`${lang.errorPrefix}${message.slice(0, 300)}`);
        return; // finally still clears the job
      }

      // Subscribe before prompting so no delta is missed.
      // NOTE: remotePublish sets event.kind to pi's own event type
      // ("message_update", "agent_settled", …) — not a constant wrapper kind.
      unsubscribe = this.options.backend.subscribeThread(threadId, (event) => {
        if (ref.cancelled) return;
        const ev: any = event.data?.event || {};
        if (event.kind === "message_update") {
          const ame = ev.assistantMessageEvent;
          if (ame?.type === "text_delta" && typeof ame.delta === "string") {
            buffer += ame.delta;
            params.onSnapshot?.(buffer);
          }
        } else if (event.kind === "message_end") {
          // agent_settled fires even when the turn errored (pi's finally block) —
          // annotate the buffer with the failure reason when there is one.
          const m = ev.message;
          if (m?.role === "assistant" && m.stopReason === "error") {
            const detail = typeof m.errorMessage === "string" ? ` ${m.errorMessage}` : "";
            buffer += `\n${lang.errorPrefix}${detail.trim()}`;
          }
        } else if (event.kind === "agent_settled") {
          settledResolve();
        } else if (event.kind === "thread.error" || event.kind === "thread.exit") {
          const detail = typeof event.data?.message === "string" ? ` ${event.data.message}` : "";
          buffer += `\n${lang.errorPrefix}${detail.trim()}`;
          settledResolve();
        }
      });

      watchdog = setTimeout(() => {
        if (!ref.cancelled) buffer += `\n${lang.timeoutNote}`;
        settledResolve();
      }, JOB_TIMEOUT_MS);

      try {
        await this.options.backend.prompt(threadId, params.text);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(message);
      }

      await settled;
    } catch (err) {
      // prompt() rejected or something unexpected — report it in the final write
      // instead of leaving the ack stuck on "working on it".
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${this.logTag} runJob failed:`, message);
      failureText = `${lang.errorPrefix}${message.slice(0, 300)}`;
    } finally {
      // NOTE: do NOT set ref.cancelled here — it must stay false on normal
      // completion so the final delivery below actually runs. Only stop() sets it
      // (external cancel). Setting it in finally made the final delivery dead code.
      if (watchdog) clearTimeout(watchdog);
      unsubscribe?.();
      this.job = null;
    }

    // Final content: complete result, or the failure reason when the turn errored.
    const finalText = failureText ?? (buffer.trim() || lang.noOutput);
    if (!ref.cancelled) {
      await params.deliver(truncateForChat(finalText, MAX_REPLY_CHARS, lang.truncatedNote));
    }
  }
}
