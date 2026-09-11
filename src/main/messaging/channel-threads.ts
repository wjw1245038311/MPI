import { basename } from "node:path";

/**
 * Registry of threads owned by messaging channels (Feishu / WeChat).
 *
 * Chat-driven sessions cannot wait for a human at the desktop: when a sandbox
 * approval prompt appears on one of these threads, ipc.ts notifies the user
 * through the channel and auto-cancels the dialog after APPROVAL_GRACE_MS so
 * the agent turn continues (the gate extension treats a cancelled select as a
 * denial) instead of hanging until the 30-minute job watchdog.
 *
 * Registry keys are session-file UUIDs — the only id both sides can compute:
 * remote thread ids are opaque HMACs unknown to the pi-side extension, which
 * derives its own id from the MPI_CHANNEL_SESSION_FILE name (see
 * channel-command-ext.ts).
 */

/** Actions the agent can request via the mpi_channel_* tools. */
export type ChannelCommandAction = "list" | "switch" | "new";

/** Result of a channel command, returned to the agent as tool output. */
export interface ChannelCommandResult {
  ok: boolean;
  /** Machine-readable error code (e.g. "not_channel_session") or message. */
  error?: string;
  /** For action=list: recent sessions with their /list indexes. */
  sessions?: Array<{ index: number; title: string; current: boolean }>;
  /** For switch/new: the title of the session now active (or a label). */
  switchedTo?: string;
}

export interface ChannelThreadEntry {
  /** Which channel owns this thread — routes commands to the right service. */
  channel: "feishu" | "wechat";
  /** Sends an ad-hoc notification to the channel's user (best-effort). */
  notifyApproval: (text: string) => Promise<void> | void;
  /** Executes agent-requested session commands (mpi_channel_* tools). */
  handleCommand?: (
    action: ChannelCommandAction,
    target: string | null,
  ) => Promise<ChannelCommandResult>;
}

/** Grace period for a human at the desktop to approve before auto-deny. */
export const APPROVAL_GRACE_MS = 60_000;

const registry = new Map<string, ChannelThreadEntry>();

export function registerChannelThread(threadId: string, entry: ChannelThreadEntry): void {
  registry.set(threadId, entry);
}

export function unregisterChannelThread(threadId: string): void {
  registry.delete(threadId);
}

export function getChannelThread(threadId: string): ChannelThreadEntry | undefined {
  return registry.get(threadId);
}

/** Extracts the thread UUID from a session file path ("<timestamp>_<uuid>.jsonl"). */
export function threadUuidFromSessionFile(sessionFile: string): string | null {
  const m = /_(.+)\.jsonl$/.exec(basename(sessionFile));
  return m ? m[1] : null;
}

/** True when the session file's thread is currently owned by a chat channel.
 * Used to gate the mpi_channel_* extension at bridge spawn time (ipc.ts) so
 * desktop/automation sessions never carry it. */
export function isChannelOwnedSession(sessionFile: string | undefined): boolean {
  const uuid = sessionFile ? threadUuidFromSessionFile(sessionFile) : null;
  return uuid !== null && getChannelThread(uuid) !== undefined;
}
