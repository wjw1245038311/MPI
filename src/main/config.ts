import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
// Type-only imports (erased at compile time) — no runtime cycles.
import type { FeishuChannelConfig, WeChatChannelConfig } from "./messaging/types";
import type { AutoPolicy, PoolEntry } from "./model-autopilot";
import { sanitizeWeChatConfig } from "./messaging/wechat-text";

/**
 * Persisted, app-level settings. Stored under Electron's userData dir so it is
 * independent from pi's own ~/.pi/agent config (which we intentionally share
 * with the terminal pi for models / extensions / auth).
 */
export interface ArchivedThread {
  /** Stable session file path used as the thread id. */
  file: string;
  /** Project folder that owns the session. */
  cwd: string;
  /** Title captured when the thread was archived, for the restore list. */
  title: string;
  /** Epoch ms when the thread was archived; absent on older entries. */
  archivedAt?: number;
}

/** Accent color presets; CSS blocks keyed on <html data-accent> in styles.css.
 * "default" is the app's original muted palette (no override block needed —
 * it matches the base :root / dark values). */
export const ACCENT_THEMES = [
  "default",
  "white",
  "lightgray",
  "darkgray",
  "green",
  "red",
  "blue",
] as const;
export type AccentTheme = (typeof ACCENT_THEMES)[number];

/**
 * Thread permission levels, from most to least restrictive:
 * - readonly: read-only operations run; every mutating operation is blocked outright.
 * - strict:   only read-only operations run automatically; everything else (including
 *             write/edit tools and low-risk project-local mutations) requires confirmation.
 * - sandbox:  read-only + verifiable low-risk project-local operations run automatically;
 *             medium/high risk require confirmation. The historical default.
 * - full:     no gating at all (pi's unrestricted mode).
 */
export const PERMISSION_LEVELS = ["readonly", "strict", "sandbox", "full"] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

/** 任务模式: a named preset bundling per-thread behaviour knobs (permission +
 * thinking level; model stays independent). Built-ins are the short task
 * defaults; users can add custom modes. The renderer normalizes this list
 * (src/renderer/src/lib/task-modes.ts) — main only persists it verbatim.
 *
 * `instructions` / `specFile` carry the mode's BEHAVIOUR: while a mode is
 * active on a thread, main writes them to <userData>/taskmodes/<uuid>.json and
 * the mpi-taskmode extension appends them to the system prompt every turn
 * (before_agent_start) — live switching, no process restart. */
export interface TaskModeDef {
  id: string;
  name?: string;
  builtin?: boolean;
  permission?: PermissionLevel;
  thinking?: string;
  /** Short behavioural instructions injected into the system prompt while this
   * mode is active (e.g. “先拆解任务再逐步执行”). Absent = no injection. */
  instructions?: string;
  /** Optional path to a markdown spec document (“设计说明书”, skill-like) whose
   * content is appended after `instructions`. External file: edits apply live.
   * Must be an absolute path; missing files are skipped at read time. */
  specFile?: string;
  /** Hard enforcement floor (renderer-normalized): while this mode is active the
   * thread is forced read-only in the pi process — the permission gate blocks
   * every mutation and write/edit tools are hidden, regardless of the
   * permission pill (including full). Built-in research/review carry it. */
  enforce?: "readonly";
}

export interface AppConfig {
  /**
   * Path to pi's cli.js, or empty string to auto-detect via `npm root -g`.
   * We deliberately do NOT accept a shell executable here: the bridge spawns
   * node + cli.js directly to avoid Windows .cmd / quoting pitfalls.
   */
  piCliPath: string;
  /** Projects the user explicitly pinned; shown at the top of the sidebar. */
  pinnedProjects: string[];
  /** Internal migration marker for the explicit project-pin behavior. */
  projectPinSchemaVersion: number;
  /** Individual sessions shown at the top of their project in the sidebar. */
  pinnedThreads: string[];
  /** Project folders hidden from normal navigation until restored in Settings. */
  archivedProjects: string[];
  /** Individual sessions hidden from normal navigation until restored in Settings. */
  archivedThreads: ArchivedThread[];
  /** Deleted sessions go to the app trash (restorable) instead of being
   * unlinked immediately; toggle in Settings → Conversation. Absent/corrupt = enabled,
   * because accidental deletion is exactly what this protects against. */
  trashEnabled: boolean;
  /** Custom directory for todo attachment copies (legacy, replaced by
   * todoDataDir). Still honored as a fallback lookup source when todoDataDir is
   * unset so attachments added before the upgrade keep resolving. */
  todoAttachmentDir?: string;
  /** Custom directory for session JSONL files (Settings → Data management).
   * When set, pi's settings.json gets a `sessionDir` key so terminal pi follows
   * along too; layout is flat (no per-project subdirs). Absent = default
   * <agentDir>/sessions with per-project subdirectories. */
  sessionStorageDir?: string;
  /** Custom folder holding ALL todo data: todos.json + todo-attachments/ +
   * todos-inbox/. Absent = built-in locations under userData. */
  todoDataDir?: string;
  /** Data-location migrations captured by Settings and applied on the NEXT
   * launch (running pi processes must not hold open files mid-move).
   * Consumed and cleared by runPendingDataMigrations() at startup. */
  pendingDataMigration?: PendingDataMigration;
  /** Last window geometry, restored on launch. */
  windowBounds?: { x?: number; y?: number; width: number; height: number; maximized?: boolean };
  /** "dark" | "light" | "system". */
  theme: "dark" | "light" | "system";
  /** Accent color preset applied on top of the theme (see data-accent CSS blocks). */
  accentTheme: AccentTheme;
  /** Window zoom percentage, 50–150; 100 is default. Applied via webContents zoom level. */
  zoomPercent: number;
  /** UI language. English is the default for new installations. */
  language: "en" | "zh";
  /** Play a short chime in the renderer when an agent turn completes. */
  soundOnComplete: boolean;
  /** How edit-tool results render in the transcript: unified single-column
   * diff (default) or before/after blocks. */
  diffViewMode: "unified" | "blocks";
  /** Permission level applied to brand-new conversations; existing threads keep their own level. */
  defaultPermission: PermissionLevel;
  /** Per-thread permission level, keyed by session file path. Defaults to defaultPermission when absent. */
  threadPermissions: Record<string, PermissionLevel>;
  /** User-managed task-mode presets (composer pill left of the permission one).
   * Absent = built-in task modes only; the renderer re-seeds and sanitizes on
   * read, so a hand-edited config can't break the UI. */
  taskModes?: TaskModeDef[];
  /** Which task mode new conversations start on ("balanced" by default; a
   * removed/unknown id falls back to balanced). Applied live on creation. */
  defaultTaskModeId?: string;
  /** Per-thread applied task-mode id, keyed by session UUID — the same key as
   * the <userData>/taskmodes/<uuid>.json state file. The injection itself is
   * driven by that state file; this map only lets the UI restore which mode a
   * thread was on after restart/reopen so the ⚡ pill stays in sync. */
  threadTaskModes?: Record<string, string>;
  /** Extension tools the user has persistently trusted (“始终允许该工具” on an
   * approval card, or added in Settings → Conversation): auto-approved by the
   * permission gate in sandbox/strict; still blocked under readonly / enforced
   * read-only. bash/write/edit can never be trusted — they always go through
   * their own classification. */
  trustedTools?: string[];
  /** Custom user avatar as a data URL (downscaled in the renderer); absent = built-in Nobita avatar. */
  userAvatar?: string;
  /** Custom agent avatar as a data URL; absent = built-in Doraemon avatar. */
  agentAvatar?: string;
  /** Free-form "user profile" text (Settings → User Profile) appended to every
   * session's system prompt via pi's --append-system-prompt.
   * Absent/empty = no injection. MPI-only: terminal pi is not affected. */
  userProfile?: string;
  /** "扩展自动选模" (Settings → Conversation). When an extension needs to pick a
   * model (e.g. the pi-web-access web-search summary) it uses this
   * conversation's current model without popping up, and web searches skip
   * the browser curation window entirely. Implemented by managing
   * workflow/summaryModel in ~/.pi/web-search.json (shared with terminal pi).
   * Absent = enabled — the per-search popup is exactly what this removes. */
  extAutoPickModel?: boolean;
  /** cwd of the most recently opened thread; seeds the warm spare's project. */
  lastThreadCwd?: string;
  /** User-defined scheduled automation tasks. */
  automationTasks: AutomationTask[];
  /** Public WSS endpoint used only for SDP/ICE signaling; no app data is sent there. */
  remoteSignalingUrl: string;
  /** Whether the user wants Signal enabled across application restarts. */
  remoteSignalingEnabled: boolean;
  /** Internal STUN endpoints used for direct WebRTC candidate discovery. TURN is intentionally unsupported. */
  remoteStunUrls: string[];
  /** Mobile cloud relay WSS endpoint (docs/MOBILE-DESIGN.md). Empty = not configured. */
  remoteRelayUrl: string;
  /** Whether the mobile relay uplink should stay connected across restarts. */
  remoteRelayEnabled: boolean;
  /** Feishu message channel (导航栏 → 消息接入). Absent = off. The app secret
   * stays local to this machine and is never part of backup imports. */
  feishuChannel?: FeishuChannelConfig;
  /** Personal-WeChat (iLink bot) message channel. Absent = off. The bot token
   * stays local to this machine, like the Feishu app secret. */
  wechatChannel?: WeChatChannelConfig;
  /** P1-12 auto model switching (Settings → Models & Providers). Absent = off.
   * Pool order is a tie-break preference; policy knobs default per AutoPolicy. */
  autoModels?: { pool: PoolEntry[]; policy?: Partial<AutoPolicy> };
  /** Per-thread auto-mode flag keyed by session file path (boot id until the
   * thread's real file name is known). Absent/false = manual model selection. */
  autoModelThreads?: Record<string, boolean>;
  /** Voice system (语音系统): STT for composer voice input + TTS for reading
   * agent replies aloud. Absent = unconfigured; the mic button then points to
   * Settings → Conversation → 语音系统. See src/main/voice.ts for STT backends and
   * src/renderer/src/lib/tts.ts for the speechSynthesis-based TTS engine. */
  voice?: VoiceConfig;
  /** Mobile (PWA) voice-input endpoint: raw-WAV POST target on this machine.
   * Defaults to the voice-stack gateway's localhost STT service
   * (http://127.0.0.1:8093/v1/audio/transcriptions). Override only if you run
   * the gateway elsewhere or want a different ASR backend. */
  sttUrl?: string;
}

/** Speech-to-text backend used by the composer mic button.
 * - "openai": any OpenAI-compatible /v1/audio/transcriptions endpoint (OpenAI,
 *   compatible gateways). Multipart upload, model defaults to whisper-1.
 * - "gemini": Gemini generateContent with inline base64 audio; only the API key
 *   from the referenced provider is used (endpoint is Google's fixed one).
 */
export type SttBackend = "openai" | "gemini";

/** Text-to-speech engine selected in Settings → Conversation → 语音系统.
 * - "system" (default): the renderer's Web Speech API (speechSynthesis), using
 *   the OS voices — fully offline.
 * - "edge": Microsoft Edge's free online neural voices, synthesized in the main
 *   process (see src/main/edge-tts.ts). No API key; falls back to "system" on
 *   failure.
 */
export type TtsBackend = "system" | "edge";

/** Sentinel sttProviderId meaning "use the manual baseUrl/apiKey fields below". */
export const STT_PROVIDER_MANUAL = "__manual__";

export interface VoiceConfig {
  /** STT backend; absent = voice input not configured yet. */
  sttBackend?: SttBackend;
  /** Provider id from ~/.pi/agent/models.json whose baseUrl/apiKey are read live
   * at transcription time (key rotation keeps working), or STT_PROVIDER_MANUAL.
   * Absent with a backend set = manual fields must be filled. */
  sttProviderId?: string;
  /** Manual / override base URL (OpenAI-compatible: the "/v1" root). Ignored for
   * gemini unless you really want to point at a proxy. */
  sttBaseUrl?: string;
  /** Manual API key; takes precedence over the referenced provider's key. */
  sttApiKey?: string;
  /** Model id sent to the backend (defaults: whisper-1 / gemini-2.5-flash). */
  sttModel?: string;
  /** TTS voice URI from speechSynthesis.getVoices(); absent = auto-pick by UI
   * language (zh → a zh voice, en → an en voice). Renderer-side only, but kept
   * here so the choice survives restarts and travels with config backups. */
  ttsVoiceUri?: string;
  /** TTS engine; absent = "system" (offline speechSynthesis). */
  ttsBackend?: TtsBackend;
  /** Edge TTS voice short name (e.g. "zh-CN-XiaoxiaoNeural"); absent = auto-pick
   * by UI language. Only used when ttsBackend === "edge". */
  ttsEdgeVoice?: string;
  /** Speech rate multiplier, clamped to 0.5–2; absent = 1. */
  ttsRate?: number;
  /** Auto-read the agent's reply aloud when a turn settles on the visible
   * thread. Absent/false = off (per-message speaker buttons always work). */
  ttsAutoRead?: boolean;
}

/** One pending data-location migration, applied on next launch. */
export interface PendingDataMigration {
  /** Move every session .jsonl from `fromDir` (subdirs + loose files) to
   * `toDir`; also remaps path-keyed references and updates pi's settings.json.
   * toDir === the default sessions dir means "restore default layout". */
  sessions?: { fromDir: string; toDir: string };
  /** Move todos.json + attachment files + inbox files into `toDir`'s standard
   * sub-layout (todos.json / todo-attachments/ / todos-inbox/). */
  todos?: {
    toDir: string;
    fromTodosFile: string;
    fromAttachmentDirs: string[];
    fromInbox: string;
  };
}

/** Legacy WebRTC signaling endpoint. Empty by default: the public endpoint from
 * the rename era (mpi-remote.scholarcn.com) was never deployed — mobile usage is
 * LAN-only with a self-hosted relay, so the legacy path stays disabled unless a
 * user explicitly configures their own ws(s):// URL (e.g. a local signaling server). */
export const DEFAULT_REMOTE_SIGNALING_URL = "";
/** The rename-era public endpoint that was never deployed; saved copies of it are
 * normalized to "" at load time so installs don't point at a dead URL. */
export const LEGACY_PUBLIC_SIGNALING_URL = "wss://mpi-remote.scholarcn.com/ws";

/** Fixed transport bootstrap endpoints. These are intentionally not user-editable. */
export const BUILT_IN_REMOTE_STUN_URLS = [
  "stun:stun.miwifi.com:3478",
  "stun:stun.chat.bilibili.com:3478",
  "stun:stun.cloudflare.com:3478",
] as const;

export type ScheduleFrequency = "hourly" | "daily" | "weekly";

export interface TaskSchedule {
  frequency: ScheduleFrequency;
  /** hourly: minute of the hour (0-59). */
  minute?: number;
  /** daily/weekly: "HH:MM" (24h). */
  time?: string;
  /** weekly: days of week, 0=Sun .. 6=Sat. */
  days?: number[];
}

export interface AutomationTask {
  id: string;
  name: string;
  cwd: string;
  prompt: string;
  schedule: TaskSchedule;
  enabled: boolean;
  /** Sandbox is the safe default; full must be selected explicitly. */
  permission: "sandbox" | "full";
  /** Optional explicit model for unattended runs (provider + modelId pair);
   * omitted/empty = pi's default model. Both halves are required together —
   * a lone value is dropped at load time and resolveTaskModel returns null. */
  provider?: string;
  modelId?: string;
  lastRunAt?: number;
  lastRunSlot?: string;
  lastStatus?: "ok" | "error";
  lastError?: string;
}

/** The task's explicit model choice, or null when it should follow pi's default. */
export function resolveTaskModel(task: { provider?: unknown; modelId?: unknown }): {
  provider: string;
  modelId: string;
} | null {
  const provider = typeof task.provider === "string" ? task.provider.trim() : "";
  const modelId = typeof task.modelId === "string" ? task.modelId.trim() : "";
  return provider && modelId ? { provider, modelId } : null;
}

const DEFAULTS: AppConfig = {
  piCliPath: "",
  pinnedProjects: [],
  projectPinSchemaVersion: 1,
  pinnedThreads: [],
  archivedProjects: [],
  archivedThreads: [],
  trashEnabled: true,
  theme: "light",
  accentTheme: "default",
  zoomPercent: 100,
  language: "en",
  soundOnComplete: true,
  diffViewMode: "unified",
  defaultPermission: "sandbox",
  threadPermissions: {},
  automationTasks: [],
  remoteSignalingUrl: DEFAULT_REMOTE_SIGNALING_URL,
  remoteSignalingEnabled: false,
  remoteStunUrls: [...BUILT_IN_REMOTE_STUN_URLS],
  remoteRelayUrl: "",
  remoteRelayEnabled: false,
};

let cached: AppConfig | null = null;
let cachedDir = "";

/** Coerces a persisted (or parsed) channel object into a safe shape. */
function sanitizeFeishuChannel(value: unknown): FeishuChannelConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const c = value as Record<string, unknown>;
  return {
    enabled: c.enabled === true,
    appId: typeof c.appId === "string" ? c.appId.trim().slice(0, 256) : "",
    appSecret: typeof c.appSecret === "string" ? c.appSecret.trim().slice(0, 512) : "",
    projectCwd: typeof c.projectCwd === "string" ? c.projectCwd.trim().slice(0, 4096) : "",
    permission: c.permission === "full" ? "full" : "sandbox",
  };
}

/** Coerces a persisted (or parsed) channel object into a safe shape. */
function sanitizeWeChatChannel(value: unknown): WeChatChannelConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return sanitizeWeChatConfig(value as Partial<WeChatChannelConfig>);
}

/** Coerces a persisted voice-system object into a safe shape; drop it entirely
 * when malformed so the mic button falls back to "not configured". */
function sanitizeVoice(value: unknown): VoiceConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const out: VoiceConfig = {};
  if (v.sttBackend === "openai" || v.sttBackend === "gemini") out.sttBackend = v.sttBackend;
  if (typeof v.sttProviderId === "string" && v.sttProviderId.trim()) {
    out.sttProviderId = v.sttProviderId.trim().slice(0, 256);
  }
  if (typeof v.sttBaseUrl === "string" && v.sttBaseUrl.trim()) {
    out.sttBaseUrl = v.sttBaseUrl.trim().replace(/\/+$/, "").slice(0, 1024);
  }
  if (typeof v.sttApiKey === "string" && v.sttApiKey.trim()) {
    out.sttApiKey = v.sttApiKey.trim().slice(0, 512);
  }
  if (typeof v.sttModel === "string" && v.sttModel.trim()) {
    out.sttModel = v.sttModel.trim().slice(0, 256);
  }
  if (typeof v.ttsVoiceUri === "string" && v.ttsVoiceUri.trim()) {
    out.ttsVoiceUri = v.ttsVoiceUri.trim().slice(0, 512);
  }
  if (v.ttsBackend === "system" || v.ttsBackend === "edge") out.ttsBackend = v.ttsBackend;
  if (typeof v.ttsEdgeVoice === "string" && v.ttsEdgeVoice.trim()) {
    out.ttsEdgeVoice = v.ttsEdgeVoice.trim().slice(0, 128);
  }
  if (typeof v.ttsRate === "number" && Number.isFinite(v.ttsRate)) {
    out.ttsRate = Math.min(2, Math.max(0.5, v.ttsRate));
  }
  if (typeof v.ttsAutoRead === "boolean") out.ttsAutoRead = v.ttsAutoRead;
  // Keep the object whenever ANY field survived — dropping it just because the
  // STT backend was cleared would silently wipe TTS settings too.
  return Object.keys(out).length > 0 ? out : undefined;
}

function configPath(dir: string): string {
  return join(dir, "config.json");
}

export function loadConfig(userDataDir: string): AppConfig {
  cachedDir = userDataDir;
  const file = configPath(userDataDir);
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<AppConfig>;
      // Older development builds silently added every opened folder to
      // pinnedProjects. Those entries are not distinguishable from a real
      // user pin, so discard them once when adopting explicit pin semantics;
      // users can re-pin the projects they actually want to keep at the top.
      const legacyProjectPins = parsed.projectPinSchemaVersion !== 1;
      // The rename-era public signaling endpoint was never deployed (mobile usage
      // is LAN-only) — treat saved copies of it as unset instead of a dead URL.
      const rawSignalingUrl = typeof parsed.remoteSignalingUrl === "string" ? parsed.remoteSignalingUrl.trim() : "";
      const signalingUrl = rawSignalingUrl === LEGACY_PUBLIC_SIGNALING_URL ? "" : rawSignalingUrl || DEFAULTS.remoteSignalingUrl;
      cached = {
        ...DEFAULTS,
        ...parsed,
        pinnedProjects: legacyProjectPins ? [] : (parsed.pinnedProjects || []),
        projectPinSchemaVersion: 1,
        remoteSignalingUrl: signalingUrl,
        remoteSignalingEnabled: typeof parsed.remoteSignalingEnabled === "boolean"
          ? parsed.remoteSignalingEnabled
          : DEFAULTS.remoteSignalingEnabled,
        remoteRelayUrl: typeof parsed.remoteRelayUrl === "string" ? parsed.remoteRelayUrl.trim() : DEFAULTS.remoteRelayUrl,
        remoteRelayEnabled: typeof parsed.remoteRelayEnabled === "boolean"
          ? parsed.remoteRelayEnabled
          : DEFAULTS.remoteRelayEnabled,
        diffViewMode: parsed.diffViewMode === "blocks" ? "blocks" : DEFAULTS.diffViewMode,
        trashEnabled: typeof parsed.trashEnabled === "boolean" ? parsed.trashEnabled : DEFAULTS.trashEnabled,
        todoAttachmentDir:
          typeof parsed.todoAttachmentDir === "string" && parsed.todoAttachmentDir.trim()
            ? parsed.todoAttachmentDir.trim()
            : undefined,
        sessionStorageDir:
          typeof parsed.sessionStorageDir === "string" && parsed.sessionStorageDir.trim()
            ? parsed.sessionStorageDir.trim()
            : undefined,
        todoDataDir:
          typeof parsed.todoDataDir === "string" && parsed.todoDataDir.trim()
            ? parsed.todoDataDir.trim()
            : undefined,
        pendingDataMigration: sanitizePendingDataMigration(parsed.pendingDataMigration),
        userProfile: typeof parsed.userProfile === "string" ? parsed.userProfile : undefined,
        extAutoPickModel:
          typeof parsed.extAutoPickModel === "boolean" ? parsed.extAutoPickModel : undefined,
        defaultPermission:
          typeof parsed.defaultPermission === "string" && (PERMISSION_LEVELS as readonly string[]).includes(parsed.defaultPermission)
            ? (parsed.defaultPermission as PermissionLevel)
            : DEFAULTS.defaultPermission,
        accentTheme:
          typeof parsed.accentTheme === "string" &&
          (ACCENT_THEMES as readonly string[]).includes(parsed.accentTheme)
            ? parsed.accentTheme
            : DEFAULTS.accentTheme,
        zoomPercent:
          typeof parsed.zoomPercent === "number" && Number.isFinite(parsed.zoomPercent)
            ? Math.min(150, Math.max(50, Math.round(parsed.zoomPercent)))
            : DEFAULTS.zoomPercent,
        // Older config files may contain a custom list. Always replace it with
        // the built-in list so this transport setting cannot be changed via
        // persisted data or a generic config update.
        remoteStunUrls: [...BUILT_IN_REMOTE_STUN_URLS],
        automationTasks: (parsed.automationTasks || []).map((raw) => {
          const task = { ...raw, permission: raw.permission === "full" ? ("full" as const) : ("sandbox" as const) };
          const model = resolveTaskModel(task);
          if (model) {
            task.provider = model.provider;
            task.modelId = model.modelId;
          } else {
            // A lone provider or modelId is meaningless — drop both.
            delete task.provider;
            delete task.modelId;
          }
          return task;
        }),
        feishuChannel: sanitizeFeishuChannel(parsed.feishuChannel),
        wechatChannel: sanitizeWeChatChannel(parsed.wechatChannel),
        voice: sanitizeVoice(parsed.voice),
      };
      return cached;
    } catch {
      // Corrupt file -> fall back to defaults but keep a copy so the user's
      // settings are recoverable (the next updateConfig would otherwise
      // silently overwrite them with defaults).
      try {
        copyFileSync(file, `${file}.bak`);
      } catch {
        /* best effort — the fallback below still applies */
      }
    }
  }
  // New (or unreadable) profile: inherit user-facing appearance settings from
  // the sibling MPI profile, if any. dev ("MPI Dev") and prod ("MPI") have
  // separate userData dirs; without this, first launch of a fresh profile
  // silently resets language/theme to defaults — the "重装后中文变英文" case.
  cached = { ...DEFAULTS, ...inheritFromSiblingProfile(userDataDir) };
  return cached;
}

/**
 * Look for a config.json in the other known MPI userData dir (%APPDATA%\MPI vs
 * %APPDATA%\MPI Dev) and inherit only language/theme from it. Everything else
 * (pins, threads, automation tasks, …) stays per-profile on purpose.
 */
function inheritFromSiblingProfile(currentDir: string): Partial<AppConfig> {
  const appDataRoot = dirname(currentDir);
  for (const name of ["MPI", "MPI Dev"]) {
    const dir = join(appDataRoot, name);
    if (dir === currentDir) continue;
    let parsed: Partial<AppConfig>;
    try {
      if (!existsSync(configPath(dir))) continue;
      parsed = JSON.parse(readFileSync(configPath(dir), "utf8")) as Partial<AppConfig>;
    } catch {
      continue; // missing/unreadable/corrupt sibling -> skip
    }
    const out: Partial<AppConfig> = {};
    if (parsed.language === "zh" || parsed.language === "en") out.language = parsed.language;
    if (parsed.theme === "dark" || parsed.theme === "light" || parsed.theme === "system") {
      out.theme = parsed.theme;
    }
    if (
      typeof parsed.accentTheme === "string" &&
      (ACCENT_THEMES as readonly string[]).includes(parsed.accentTheme)
    ) {
      out.accentTheme = parsed.accentTheme;
    }
    return out; // first readable sibling wins
  }
  return {};
}

export function getConfig(): AppConfig {
  if (!cached) throw new Error("config not loaded; call loadConfig() after app ready");
  return cached;
}

/** Re-read the persisted config so background services see changes made by another app process. */
export function reloadConfig(): AppConfig {
  if (!cachedDir) throw new Error("config not loaded; call loadConfig() after app ready");
  return loadConfig(cachedDir);
}

/** Coerce a persisted pending-migration record into a safe shape; drop it
 * entirely when malformed — a half-baked migration plan must never run. */
function sanitizePendingDataMigration(value: unknown): PendingDataMigration | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const out: PendingDataMigration = {};
  const s = v.sessions;
  if (s && typeof s === "object") {
    const so = s as Record<string, unknown>;
    if (typeof so.fromDir === "string" && so.fromDir.trim() && typeof so.toDir === "string" && so.toDir.trim()) {
      out.sessions = { fromDir: so.fromDir.trim(), toDir: so.toDir.trim() };
    }
  }
  const t = v.todos;
  if (t && typeof t === "object") {
    const to = t as Record<string, unknown>;
    if (
      typeof to.toDir === "string" &&
      to.toDir.trim() &&
      typeof to.fromTodosFile === "string" &&
      Array.isArray(to.fromAttachmentDirs) &&
      (to.fromAttachmentDirs as unknown[]).every((d) => typeof d === "string") &&
      typeof to.fromInbox === "string"
    ) {
      out.todos = {
        toDir: to.toDir.trim(),
        fromTodosFile: to.fromTodosFile,
        fromAttachmentDirs: (to.fromAttachmentDirs as string[]).filter((d) => d.trim()),
        fromInbox: to.fromInbox,
      };
    }
  }
  return out.sessions || out.todos ? out : undefined;
}

/** The userData directory that holds config.json (used for runtime assets like the gate extension). */
export function getConfigDir(): string {
  return cachedDir;
}

/**
 * Validate an externally supplied config object (Settings → 数据管理 import).
 * Returns ONLY the fields that are present AND well-formed, so importing a
 * stale or foreign backup never clobbers newer settings with defaults.
 * Machine-specific fields (piCliPath, windowBounds) and transport-locked
 * fields (remoteStunUrls) are intentionally excluded — they keep their current values.
 */
export function sanitizeImportedConfig(parsed: unknown): Partial<AppConfig> {
  const p = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const out: Partial<AppConfig> = {};
  const isStrArray = (v: unknown) => Array.isArray(v);
  const strList = (v: unknown): string[] | undefined =>
    isStrArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;

  const pinnedProjects = strList(p.pinnedProjects);
  if (pinnedProjects) out.pinnedProjects = pinnedProjects;
  const pinnedThreads = strList(p.pinnedThreads);
  if (pinnedThreads) out.pinnedThreads = pinnedThreads;
  const archivedProjects = strList(p.archivedProjects);
  if (archivedProjects) out.archivedProjects = archivedProjects;

  if (Array.isArray(p.archivedThreads)) {
    const threads: ArchivedThread[] = [];
    for (const t of p.archivedThreads as any[]) {
      if (!t || typeof t !== "object") continue;
      if (typeof t.file !== "string" || !t.file) continue;
      threads.push({
        file: t.file,
        cwd: typeof t.cwd === "string" ? t.cwd : "",
        title: typeof t.title === "string" ? t.title : "",
        ...(typeof t.archivedAt === "number" && Number.isFinite(t.archivedAt) ? { archivedAt: t.archivedAt } : {}),
      });
    }
    out.archivedThreads = threads;
  }

  if (typeof p.trashEnabled === "boolean") out.trashEnabled = p.trashEnabled;
  if (p.theme === "dark" || p.theme === "light" || p.theme === "system") out.theme = p.theme;
  if (typeof p.accentTheme === "string" && (ACCENT_THEMES as readonly string[]).includes(p.accentTheme)) {
    out.accentTheme = p.accentTheme as AccentTheme;
  }
  if (typeof p.zoomPercent === "number" && Number.isFinite(p.zoomPercent)) {
    out.zoomPercent = Math.min(150, Math.max(50, Math.round(p.zoomPercent)));
  }
  if (p.language === "en" || p.language === "zh") out.language = p.language;
  if (typeof p.soundOnComplete === "boolean") out.soundOnComplete = p.soundOnComplete;
  if (p.diffViewMode === "unified" || p.diffViewMode === "blocks") out.diffViewMode = p.diffViewMode;
  if (typeof p.defaultPermission === "string" && (PERMISSION_LEVELS as readonly string[]).includes(p.defaultPermission)) {
    out.defaultPermission = p.defaultPermission as PermissionLevel;
  }

  if (p.threadPermissions && typeof p.threadPermissions === "object" && !Array.isArray(p.threadPermissions)) {
    const perms: Record<string, PermissionLevel> = {};
    for (const [key, value] of Object.entries(p.threadPermissions as Record<string, unknown>)) {
      if (typeof value === "string" && (PERMISSION_LEVELS as readonly string[]).includes(value)) {
        perms[key] = value as PermissionLevel;
      }
    }
    out.threadPermissions = perms;
  }

  // NOTE: taskModes / defaultTaskModeId are intentionally NOT imported — specFile
  // entries hold machine-specific absolute paths that would dangle on another
  // machine. Custom modes can be re-created in the management dialog, or copied
  // over manually from a backup of config.json.

  // Avatars are data URLs produced by the renderer; require the prefix so a
  // corrupted/foreign file cannot inject arbitrary strings into <img src>.
  if (typeof p.userAvatar === "string" && p.userAvatar.startsWith("data:image/")) out.userAvatar = p.userAvatar;
  if (typeof p.agentAvatar === "string" && p.agentAvatar.startsWith("data:image/")) out.agentAvatar = p.agentAvatar;
  if (typeof p.userProfile === "string") out.userProfile = p.userProfile;
  if (typeof p.extAutoPickModel === "boolean") out.extAutoPickModel = p.extAutoPickModel;
  if (typeof p.lastThreadCwd === "string" && p.lastThreadCwd) out.lastThreadCwd = p.lastThreadCwd;

  if (Array.isArray(p.automationTasks)) {
    const tasks: AutomationTask[] = [];
    for (const t of p.automationTasks as any[]) {
      if (!t || typeof t !== "object") continue;
      if (typeof t.id !== "string" || !t.id) continue;
      if (typeof t.name !== "string" || typeof t.cwd !== "string" || typeof t.prompt !== "string") continue;
      const schedule = t.schedule;
      if (!schedule || typeof schedule !== "object") continue;
      if (schedule.frequency !== "hourly" && schedule.frequency !== "daily" && schedule.frequency !== "weekly") continue;
      tasks.push({
        id: t.id,
        name: t.name,
        cwd: t.cwd,
        prompt: t.prompt,
        schedule: {
          frequency: schedule.frequency,
          ...(typeof schedule.minute === "number" ? { minute: schedule.minute } : {}),
          ...(typeof schedule.time === "string" ? { time: schedule.time } : {}),
          ...(Array.isArray(schedule.days) && schedule.days.every((d: unknown) => typeof d === "number")
            ? { days: schedule.days as number[] }
            : {}),
        },
        enabled: typeof t.enabled === "boolean" ? t.enabled : true,
        permission: t.permission === "full" ? "full" : "sandbox",
      });
    }
    out.automationTasks = tasks;
  }

  if (typeof p.remoteSignalingUrl === "string" && p.remoteSignalingUrl.trim()) {
    out.remoteSignalingUrl = p.remoteSignalingUrl.trim();
  }
  if (typeof p.remoteSignalingEnabled === "boolean") out.remoteSignalingEnabled = p.remoteSignalingEnabled;
  if (typeof p.remoteRelayUrl === "string") out.remoteRelayUrl = p.remoteRelayUrl.trim();
  if (typeof p.remoteRelayEnabled === "boolean") out.remoteRelayEnabled = p.remoteRelayEnabled;

  // Voice settings are portable (no machine-specific paths); the API key is a
  // user credential like any other and travels with config backups on purpose.
  const voice = sanitizeVoice(p.voice);
  if (voice) out.voice = voice;

  return out;
}

export function updateConfig(patch: Partial<AppConfig>): AppConfig {
  if (!cached) throw new Error("config not loaded");
  cached = {
    ...cached,
    ...patch,
    remoteStunUrls: [...BUILT_IN_REMOTE_STUN_URLS],
  };
  if (!existsSync(cachedDir)) mkdirSync(cachedDir, { recursive: true });
  writeFileSync(configPath(cachedDir), JSON.stringify(cached, null, 2), "utf8");
  return cached;
}
