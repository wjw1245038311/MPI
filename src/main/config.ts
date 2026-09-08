import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
   * unlinked immediately; toggle in Settings → General. Absent/corrupt = enabled,
   * because accidental deletion is exactly what this protects against. */
  trashEnabled: boolean;
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
  /** Custom user avatar as a data URL (downscaled in the renderer); absent = built-in Nobita avatar. */
  userAvatar?: string;
  /** Custom agent avatar as a data URL; absent = built-in Doraemon avatar. */
  agentAvatar?: string;
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
}

export const DEFAULT_REMOTE_SIGNALING_URL = "wss://mpi-remote.scholarcn.com/ws";

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
  lastRunAt?: number;
  lastRunSlot?: string;
  lastStatus?: "ok" | "error";
  lastError?: string;
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
};

let cached: AppConfig | null = null;
let cachedDir = "";

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
      cached = {
        ...DEFAULTS,
        ...parsed,
        pinnedProjects: legacyProjectPins ? [] : (parsed.pinnedProjects || []),
        projectPinSchemaVersion: 1,
        remoteSignalingUrl: typeof parsed.remoteSignalingUrl === "string" && parsed.remoteSignalingUrl.trim()
          ? parsed.remoteSignalingUrl.trim()
          : DEFAULTS.remoteSignalingUrl,
        remoteSignalingEnabled: typeof parsed.remoteSignalingEnabled === "boolean"
          ? parsed.remoteSignalingEnabled
          : DEFAULTS.remoteSignalingEnabled,
        diffViewMode: parsed.diffViewMode === "blocks" ? "blocks" : DEFAULTS.diffViewMode,
        trashEnabled: typeof parsed.trashEnabled === "boolean" ? parsed.trashEnabled : DEFAULTS.trashEnabled,
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
        automationTasks: (parsed.automationTasks || []).map((task) => ({
          ...task,
          permission: task.permission === "full" ? "full" : "sandbox",
        })),
      };
      return cached;
    } catch {
      // corrupt file -> fall back to defaults but keep a copy
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

/** The userData directory that holds config.json (used for runtime assets like the gate extension). */
export function getConfigDir(): string {
  return cachedDir;
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
