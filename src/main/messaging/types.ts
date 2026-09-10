import type { PermissionLevel } from "../config";

/**
 * Feishu (Lark) channel configuration, persisted in AppConfig.feishuChannel.
 * The app secret is stored locally like other provider credentials; it never
 * crosses the IPC boundary back to the renderer (getState masks it).
 */
export interface FeishuChannelConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  /** Project folder whose dedicated session receives channel messages. */
  projectCwd: string;
  /** Permission level applied to the dedicated session (mapped at the remote boundary). */
  permission: PermissionLevel;
  /** Last explicitly selected session (/new, /use); restored on restart when it still exists. */
  activeThreadId?: string;
}

export type MessagingStatus = "off" | "connecting" | "connected" | "reconnecting" | "error";

/** Renderer-facing state. Deliberately omits appSecret. */
export interface MessagingState {
  status: MessagingStatus;
  lastError: string | null;
  configured: boolean;
  appIdMasked: string | null;
  projectCwd: string;
  permission: PermissionLevel;
}
