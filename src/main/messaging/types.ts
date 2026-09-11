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

/**
 * Personal-WeChat (iLink bot) channel configuration, persisted in
 * AppConfig.wechatChannel. Credentials come from the QR onboarding flow and
 * are stored locally only; they never cross IPC back to the renderer.
 */
export interface WeChatChannelConfig {
  enabled: boolean;
  /** iLink bot token issued at QR confirmation. */
  botToken: string;
  /** ilink_bot_id — the bot account id (used for display/dedup). */
  botId: string;
  /** Bot API base URL returned at confirmation (IDC-specific). */
  baseUrl: string;
  /** ilink_user_id of the person who scanned the QR code. */
  userId: string;
  /** Project folder whose dedicated session receives channel messages. */
  projectCwd: string;
  /** Permission level applied to the dedicated session (mapped at the remote boundary). */
  permission: PermissionLevel;
  /** Last explicitly selected session (/new, /use); restored on restart when it still exists. */
  activeThreadId?: string;
  /** Long-poll cursor persisted across restarts so messages aren't re-delivered. */
  getUpdatesBuf?: string;
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

/** Renderer-facing WeChat channel state. Deliberately omits botToken. */
export interface WeChatMessagingState {
  status: MessagingStatus;
  lastError: string | null;
  configured: boolean;
  botIdMasked: string | null;
  projectCwd: string;
  permission: PermissionLevel;
}
