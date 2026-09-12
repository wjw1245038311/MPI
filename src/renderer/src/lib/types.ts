/** Shared renderer-side types. Pi message shapes are kept loose (`any`) because
 *  the renderer intentionally has no dependency on the pi packages. */

export interface ThreadSummary {
  file: string;
  id: string;
  title: string;
  preview: string;
  updatedAt: number;
  messageCount: number;
  pinned?: boolean;
}

export interface ProjectSummary {
  cwd: string;
  name: string;
  threads: ThreadSummary[];
  pinned?: boolean;
  /** Set only for projects opened during the current desktop session. */
  openedAt?: number;
}

export interface ArchivedThread {
  file: string;
  cwd: string;
  title: string;
  /** Epoch ms when the thread was archived; absent on older entries. */
  archivedAt?: number;
}

/** A full-text search hit across session transcripts. */
export interface ThreadSearchHit {
  file: string;
  cwd: string;
  title: string;
  projectName: string;
  updatedAt: number;
  messageCount: number;
  snippet: string;
  matchCount: number;
  /** Set only when searching with archived/trashed sessions included:
   * "project-archived" = whole project folder is archived,
   * "thread-archived" = single session archived, "trashed" = in the trash bin.
   * Absent for live sessions. */
  state?: "project-archived" | "thread-archived" | "trashed";
}

/** Thread permission level.
 * - readonly: read-only operations run; every mutating operation is blocked outright.
 * - strict: only read-only operations auto-run; everything else requires confirmation.
 * - sandbox: low-risk explicit operations also auto-run (the historical default).
 * - full: unrestricted. */
export type PermissionLevel = "readonly" | "strict" | "sandbox" | "full";

/** An installed pi package (from settings.json `packages`). */
export interface PluginPackage {
  /** Raw source spec, e.g. "npm:foo", "git:host/repo@ref", or a local path. */
  source: string;
  /** Display name derived from the source. */
  name: string;
  kind: "npm" | "git" | "local";
  /** True when the package loads its resources; false when disabled via autoload=false. */
  enabled: boolean;
}

/** Installed-manifest details for one package, for the detail pane. */
export interface PackageInfo {
  source: string;
  name: string;
  kind: "npm" | "git" | "local";
  enabled: boolean;
  /** Resolved install directory, when it could be located. */
  dir?: string;
  version?: string;
  description?: string;
}

/** A standalone skill discovered in a skills directory. */
export interface SkillInfo {
  name: string;
  path: string;
  /** The root directory it was discovered under. */
  root: string;
  enabled: boolean;
  /** The description exposed by Pi for `/skill:<name>`. */
  description?: string;
}

/** Raw content of a managed skill's entry file, for the detail pane. */
export interface SkillContent {
  name: string;
  path: string;
  markdown: string;
}

/** An MCP server entry from <agentDir>/mcp.json (managed by pi-mcp-adapter). */
export interface McpServerInfo {
  name: string;
  /** "stdio" when launched via command, "remote" when using a url. */
  transport: "stdio" | "remote";
  /** Full stdio command line for display (command + args). */
  command?: string;
  url?: string;
  /** Per-server disable flag (`disabled: true` in mcp.json). */
  disabled: boolean;
}

/** One entry from the mcpmarket.cn directory (list view). */
export interface McpMarketItem {
  id: string;
  name: string;
  by?: string;
  description?: string;
  stars?: number;
  /** Source link (usually GitHub). */
  url?: string;
  /** Absolute URL or site-relative path. */
  logo?: string;
  featured?: boolean;
}

/** Localized overview sections returned by the mcpmarket.cn detail API. */
export interface McpMarketOverview {
  what_is?: string;
  key_features?: string;
  how_to_use?: string;
  use_cases?: string;
  where_to_use?: string;
}

/** Full detail for one mcpmarket.cn entry. */
export interface McpMarketDetail extends McpMarketItem {
  categories?: string[];
  mcpType?: string[];
  descriptionEn?: string;
  descriptionZh?: string;
  overviewEn?: McpMarketOverview;
  overviewZh?: McpMarketOverview;
}

/** One page of mcpmarket.cn search results. */
export interface McpMarketPage {
  items: McpMarketItem[];
  total: number;
  pages: number;
  page: number;
}

/** A public skill returned by the skills.sh directory. */
export interface SkillHubSkill {
  /** Stable directory id, e.g. `vercel-labs/skills/find-skills`. */
  id: string;
  skillId: string;
  name: string;
  /** Repository or well-known source understood by the skills CLI. */
  source: string;
  installs: number;
  url: string;
}

/** Detail payload for one public skill. */
export interface SkillHubDetail extends SkillHubSkill {
  description: string;
  files: { path: string; contents?: string }[];
  hash: string | null;
  installCommand: string;
  markdown?: string;
}

/** A package returned by the npm registry search (extension package market). */
export interface NpmPackage {
  /** Full name including scope, e.g. `@plannotator/pi-extension`. */
  name: string;
  version: string;
  description: string;
  keywords: string[];
  license?: string;
  /** Last publish date (ISO). */
  date: string;
  downloadsWeekly: number;
  npmUrl: string;
  repository?: string;
}

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
  permission: PermissionLevel;
  lastRunAt?: number;
  lastRunSlot?: string;
  lastStatus?: "ok" | "error";
  lastError?: string;
}

export interface ModelInfo {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: string[];
  /** Maps the UI effort level to the provider-specific effort value. */
  thinkingLevelMap?: Record<string, string | null>;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: any; contentIndex?: number };

/** A local file carried by a user message. The path is retained for matching
 * and future actions, but the chat bubble only needs to show the file name. */
export interface ViewAttachment {
  name: string;
  path?: string;
  note?: string;
  error?: string;
}

export interface ViewMessage {
  /** stable key */
  key: string;
  /** Stable Pi session entry id used by message-level branching. */
  branchEntryId?: string;
  role: "user" | "assistant" | "system" | "custom";
  /** Extension command output (pi.sendMessage with display:true), e.g. /mem0-status. */
  customType?: string;
  timestamp?: number;
  /** user/system plain text (may include image blocks for user) */
  text?: string;
  images?: { dataUrl: string; mimeType: string }[];
  attachments?: ViewAttachment[];
  /** assistant structured blocks */
  blocks?: ContentBlock[];
  /** how a user message was submitted while the agent was working */
  sendKind?: "steer" | "followUp";
  /** provider/model for assistant footer */
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

/** In-flight transfer reported by the main process for the long-task monitor
 * (bottom-right floating card). Labels are Chinese; translated in renderer. */
export interface TransferInfo {
  id: string;
  kind: "download" | "upload";
  label: string;
  startedAt: number;
  totalBytes?: number;
  doneBytes?: number;
  speedBps?: number;
  /** Last meaningful output line, for diagnostics. */
  detail?: string;
  cancellable: boolean;
}

export interface ToolRun {
  id: string;
  name: string;
  args: any;
  running: boolean;
  /** Assistant content index used to reconcile provider calls before an ID exists. */
  contentIndex?: number;
  /** True after Pi emits a tool result, including an empty successful result. */
  completed?: boolean;
  isError?: boolean;
  resultText?: string;
  partialText?: string;
  argsStr?: string;
  startedAt?: number;
  endedAt?: number;
}

/** A follow-up the user queued (Enter) while the agent is streaming. Held in
 * the renderer so it can be re-edited or promoted to steering before delivery. */
export interface PendingFollowUp {
  text: string;
  images: PendingImage[];
  files: PendingFile[];
  htmlReferences?: HtmlElementReference[];
}

/** Unsent composer content, persisted per thread so a restart/crash does not
 * lose in-progress input. Persisted by the main process with LRU eviction. */
export interface ComposerDraft {
  text: string;
  images: PendingImage[];
  files: PendingFile[];
  htmlReferences?: HtmlElementReference[];
}

/** A session moved to the app trash (restorable until purged). */
export interface TrashEntry {
  id: string;
  originalFile: string;
  title: string;
  cwd: string;
  deletedAt: number;
  sizeBytes: number;
}

/** A file attached to a todo (screenshot, document, ...). The binary lives in
 * <userData>/todo-attachments/<file>; only this metadata is stored in todos.json.
 * Images render as thumbnails; other files open with the system app. */
export interface TodoAttachment {
  id: string;
  name: string; // original file name (display)
  mime: string; // e.g. "image/png" — images preview inline
  size: number; // bytes on disk
  file: string; // file name inside todo-attachments/ (uuid + sanitized ext)
}

/** A personal todo item in the Feishu-style 待办任务 panel.
 * Scoped per project (cwd); dueDate is a local "YYYY-MM-DD" (null = undated),
 * dueTime an optional local "HH:mm" (24h) refining it to the minute — absent
 * means all-day. source="agent" marks items added by the pi extension during a
 * conversation (sessionFile points at the originating session for the AI badge). */
export interface TodoItem {
  id: string;
  title: string;
  note?: string;
  cwd: string;
  dueDate: string | null;
  dueTime?: string | null; // "HH:mm" or null (all-day)
  attachments?: TodoAttachment[];
  done: boolean;
  createdAt: number;
  completedAt: number | null;
  source?: "user" | "agent";
  sessionFile?: string;
}

export interface ThreadState {
  cwd: string;
  sessionFile: string | null;
  sessionName: string | null;
  /** True while this view represents a fresh unnamed session. */
  isNewSession?: boolean;
  /** True while the new-session RPC is replacing the previous conversation. */
  creatingSession?: boolean;
  model: ModelInfo | null;
  models: ModelInfo[];
  /** P1-12: this thread is in auto mode (model pill shows the Auto item active). */
  autoEnabled?: boolean;
  /** P1-12: last autopilot notification state for the health dot. */
  autoStatus?: "ok" | "warn" | null;
  thinking: string;
  levels: string[];
  commands: any[];
  /** True while the backing pi process is still booting (optimistic open). */
  loading?: boolean;
  /** True once a live pi process backs this thread. A thread can show its full
   *  transcript (read from disk) while still disconnected; interaction connects. */
  connected?: boolean;
  isStreaming: boolean;
  /** Wall-clock time of the most recent agent_start; used to tell real LLM turns apart from extension commands that never start one. */
  lastAgentStart?: number;
  /** True while a manual compaction run (pi /compact) is in flight. */
  compacting?: boolean;
  /** Post-compaction token estimate from the last successful compaction_end; pi reports context tokens as null until the next LLM response, so this keeps the usage popover meaningful in between. */
  contextEstimate?: number | null;
  /** Last failed compaction (compaction_end with errorMessage); cleared on success or when a new attempt starts. */
  compactionFailure?: { message: string; aborted: boolean } | null;
  /** Permanently bricked session detected from a provider 400 (upstream #8720/#8667):
   * every further turn fails identically until the session file is repaired. */
  bricked?: { kind: "whitespace" | "stale-compaction"; message: string } | null;
  /** True while repairSession() runs for this thread. */
  repairing?: boolean;
  messages: ViewMessage[];
  streaming: ViewMessage | null;
  toolRuns: Record<string, ToolRun>;
  error?: string;
  /** Permission level the thread's pi process runs under. */
  permission: PermissionLevel;
  /** Last task-mode preset applied to this thread (display only; the
   * individual pills remain the source of truth). Absent = default mode. */
  taskMode?: string;
  /** text injected by an extension via set_editor_text */
  pendingEditorText?: string;
  /** Follow-up queued via Enter while streaming; delivered when the agent settles. */
  pendingFollowUp?: PendingFollowUp | null;
}

export interface PreviewPayload {
  name: string;
  ext: string;
  size: number;
  kind: "text" | "markdown" | "html" | "image" | "docx" | "xlsx" | "pptx" | "unsupported" | "toobig" | "missing";
  mime?: string;
  text?: string;
  base64?: string;
  lang?: string;
  truncated?: boolean;
  message?: string;
  /** Isolated pi-preview:// URL used for HTML plus its local CSS/JS/assets. */
  previewUrl?: string;
}

/** One open tab in the browser-style preview panel; array order = display order. */
export interface PreviewTab {
  id: string;
  path: string;
  root: string | null;
  payload: PreviewPayload | null;
  loading: boolean;
}

export interface ExtUiRequest {
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text" | string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: "info" | "warning" | "error";
  text?: string;
  timeout?: number;
  [key: string]: unknown;
}

export interface Toast {
  id: string;
  kind: "info" | "success" | "warning" | "error";
  text: string;
}

/** 任务模式 (task mode): a named preset bundling per-thread behaviour knobs —
 * permission level + thinking level. Model stays independent (own pill).
 * Built-ins are the seeded presets; users can add custom modes.
 * Mirrors src/main/config.ts TaskModeDef (main only persists it verbatim). */
export interface TaskModeDef {
  /** Stable built-in slug (balanced/iterate/research/review) or a uuid for user modes. */
  id: string;
  /** Display name — required for custom modes; ignored for built-ins. */
  name?: string;
  /** Built-in modes cannot be deleted (params stay editable). */
  builtin?: boolean;
  /** Permission applied when the mode is used. Omitted = leave unchanged. */
  permission?: PermissionLevel;
  /** Thinking level applied when the mode is used. Omitted = leave unchanged. */
  thinking?: string;
  /** Short behavioural instructions injected into the system prompt while this
   * mode is active (live, per turn via the mpi-taskmode extension). Absent = none. */
  instructions?: string;
  /** Optional absolute path (or `@agent/…` token resolved against pi's agent dir)
   * to a markdown spec document (“设计说明书”, skill-like)
   * appended after `instructions`. External file → edits apply live without re-saving. */
  specFile?: string;
  /** Hard enforcement floor: while this mode is active the thread is forced
   * read-only in the pi process (gate blocks every mutation, write/edit tools
   * are hidden) — regardless of the permission pill, including full access.
   * Built-in research/review modes carry it. */
  enforce?: "readonly";
}

export interface AppConfig {
  piCliPath: string;
  pinnedProjects: string[];
  pinnedThreads: string[];
  archivedProjects: string[];
  archivedThreads: ArchivedThread[];
  /** Deleted sessions go to the app trash (restorable) instead of being unlinked
   * immediately. Absent = enabled (safe default, see main/config.ts). */
  trashEnabled?: boolean;
  /** Custom directory for todo attachment copies (legacy; replaced by
   * todoDataDir). Kept so old configs keep resolving attachments. */
  todoAttachmentDir?: string;
  /** Custom directory for session JSONL files (Settings → Data management);
   * absent = default <agentDir>/sessions. Applies on next launch. */
  sessionStorageDir?: string;
  /** Custom folder holding all todo data (todos.json + attachments + inbox);
   * absent = built-in locations under userData. Applies on next launch. */
  todoDataDir?: string;
  windowBounds?: { x?: number; y?: number; width: number; height: number; maximized?: boolean };
  theme: "dark" | "light" | "system";
  /** Accent color preset applied on top of the theme (see data-accent CSS blocks). */
  accentTheme?: "default" | "white" | "lightgray" | "darkgray" | "green" | "red" | "blue";
  /** Window zoom percentage, 50–150; 100 is default. */
  zoomPercent?: number;
  language: "en" | "zh";
  /** Play a short chime when an agent turn completes. */
  soundOnComplete?: boolean;
  /** Edit-tool result rendering: unified single-column diff or before/after blocks. */
  diffViewMode?: "unified" | "blocks";
  /** Permission level applied to brand-new conversations; existing threads keep their own level. */
  defaultPermission?: PermissionLevel;
  /** User-managed task-mode presets (composer pill left of the permission one).
   * Absent = built-in short task modes only. */
  taskModes?: TaskModeDef[];
  /** Extension tools the user has persistently trusted (“始终允许该工具” on an
   * approval card, or added in Settings): auto-approved in sandbox/strict,
   * still blocked under readonly/enforced read-only. bash/write/edit can never
   * be trusted — they always go through their own classification. */
  trustedTools?: string[];
  /** Which task mode new conversations start on ("balanced" by default). */
  defaultTaskModeId?: string;
  /** Custom user avatar as a data URL; absent = built-in Nobita avatar. */
  userAvatar?: string;
  /** Custom agent avatar as a data URL; absent = built-in Doraemon avatar. */
  agentAvatar?: string;
  /** Free-form user profile text appended to every session's system prompt
   * (Settings → User Profile); absent/empty = no injection. */
  userProfile?: string;
  /** "扩展自动选模" (Settings → Conversation): extensions that need a model use the
   * current conversation's model without popping up; web searches skip the
   * browser curation window. Absent = enabled. */
  extAutoPickModel?: boolean;
  remoteSignalingUrl: string;
  remoteSignalingEnabled: boolean;
  remoteStunUrls: string[];
  /** Feishu message channel (导航栏 → 消息接入); absent = off. */
  feishuChannel?: {
    enabled: boolean;
    appId: string;
    appSecret: string;
    projectCwd: string;
    permission: "sandbox" | "full";
  };
  /** Personal-WeChat (iLink bot) channel; absent = off. */
  wechatChannel?: {
    enabled: boolean;
    botId: string;
    userId: string;
    projectCwd: string;
    permission: "sandbox" | "full";
  };
  /** P1-12 auto model switching (Settings → Auto Model); absent = empty pool.
   * Pool order is only a tie-breaker within equal rank; quality comes from the
   * tier inference + per-entry override. `paid` defaults to false (free). */
  autoModels?: {
    pool: Array<{ provider: string; modelId: string; paid?: boolean; tierOverride?: "high" | "mid" | "low" }>;
    policy?: {
      softDegradeFactor?: number;
      softDegradeMinMs?: number;
      softDegradeStreak?: number;
      recoveryIntervalMin?: number;
      cooldownMin?: number;
      strictNoDowngrade?: boolean;
      notify?: boolean;
    };
  };
  /** P1-12 per-thread auto mode (threadId → enabled). */
  autoModelThreads?: Record<string, boolean>;
  /** Voice system (语音系统): STT for the composer mic button + TTS for reading
   * replies aloud. Absent = unconfigured; see main/config.ts for semantics. */
  voice?: {
    sttBackend?: "openai" | "gemini";
    /** Provider id from models.json, or "__manual__" for the fields below. */
    sttProviderId?: string;
    sttBaseUrl?: string;
    sttApiKey?: string;
    sttModel?: string;
    /** speechSynthesis voice URI; absent = auto-pick by UI language. */
    ttsVoiceUri?: string;
    /** TTS engine; absent = "system" (offline speechSynthesis). */
    ttsBackend?: "system" | "edge";
    /** Edge TTS voice short name; absent = auto-pick by UI language. */
    ttsEdgeVoice?: string;
    /** Speech rate 0.5–2; absent = 1. */
    ttsRate?: number;
    /** Auto-read the reply when a turn settles on the visible thread. */
    ttsAutoRead?: boolean;
  };
}

export type MessagingStatus = "off" | "connecting" | "connected" | "reconnecting" | "error";

/** Renderer-facing Feishu channel state (main process never sends the secret). */
export interface MessagingState {
  status: MessagingStatus;
  lastError: string | null;
  configured: boolean;
  appIdMasked: string | null;
  projectCwd: string;
  permission: PermissionLevel;
}

/** Renderer-facing WeChat channel state (main process never sends the bot token). */
export interface WeChatMessagingState {
  status: MessagingStatus;
  lastError: string | null;
  configured: boolean;
  botIdMasked: string | null;
  projectCwd: string;
  permission: PermissionLevel;
}

export interface AppRuntime {
  ok: boolean;
  node?: string;
  cli?: string;
  error?: string;
}

/** Read-only snapshot of the pi runtime + config locations, for the Settings panel. */
export interface Diagnostics {
  node: string | null;
  cli: string | null;
  nodeVersion: string | null;
  piVersion: string | null;
  agentDir: string;
  sessionsDir: string;
  settingsPath: string;
  authPath: string;
  modelsPath: string;
  settingsExists: boolean;
  authExists: boolean;
  modelsExists: boolean;
  /** Where the active pi runtime came from. */
  runtimeKind: "override" | "userData" | "bundled" | "system" | "unknown";
  /** True when the runtime is managed by the app (bundled or app-updated). */
  bundled: boolean;
  error: string | null;
}

export type ApiType = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

/** A single model entry inside a provider's `models` array (models.json). */
export interface ModelDef {
  id: string;
  name?: string;
  api?: ApiType;
  /** Optional per-model endpoint override. The Settings UI displays it with `/v1`. */
  baseUrl?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  /** P1-11: resolve automatically on save when the field is empty. */
  contextWindowAuto?: boolean;
  /** Where a resolved value came from: catalog lookup / API probe / not found. */
  contextWindowSource?: "catalog" | "api" | "none";
  /** Probe origin detail for the badge tooltip (e.g. endpoint host). */
  contextWindowDetail?: string;
  maxTokens?: number;
  cost?: Record<string, unknown>;
  compat?: Record<string, unknown>;
  thinkingLevelMap?: Record<string, string | null>;
  /** preserve any unknown fields verbatim on round-trip */
  [key: string]: unknown;
}

/** A provider entry in models.json. */
export interface ProviderDef {
  baseUrl?: string;
  api?: ApiType;
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  compat?: Record<string, unknown>;
  models?: ModelDef[];
  modelOverrides?: Record<string, unknown>;
  oauth?: unknown;
  [key: string]: unknown;
}

/** Top-level shape of ~/.pi/agent/models.json. */
export interface ModelsFile {
  providers: Record<string, ProviderDef>;
  [key: string]: unknown;
}

/** The thinking-related slice of settings.json that the GUI edits. */
export interface ThinkingDefaults {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  hideThinkingBlock?: boolean;
}

export interface FileNode {
  name: string;
  rel: string;
  abs: string;
  isDir: boolean;
  ext: string;
  size: number;
}

/** A pasted/dropped image held in the composer before sending (base64). */
export interface PendingImage {
  id: string;
  dataUrl: string;
  base64: string;
  mimeType: string;
}

/** A local file attached in the composer (absolute path resolved by main). */
export interface PendingFile {
  abs: string;
  name: string;
}

/** A selected HTML element kept as a structured composer reference. */
export interface HtmlElementReference {
  id: string;
  reference: string;
  selector?: string;
  tagName?: string;
  text?: string;
  outerHTML?: string;
  styles?: Record<string, string | number>;
}

/* ------------------------------------------------------------------ *
 * 功能测试注册表（dev-only「自动化测试」面板）
 * 数据源：tests/registry/*.json；主进程侧解析器见 src/main/test-registry.ts
 * ------------------------------------------------------------------ */
export type TestCaseKind = "logic" | "scenario";

export interface TestRegistryCase {
  id: string;
  title: string;
  feature: string;
  kind: TestCaseKind;
  /** 来源（changelog 条目 / 设计文档），用于追溯 */
  source: string;
  description?: string;
  /** kind=logic：run-all-tests 过滤词（npm test -- <logicTest>） */
  logicTest?: string;
  /** kind=scenario：scripts/e2e/harness.mjs 的用例 id */
  harnessCaseId?: string;
  /** kind=scenario：人读的场景提示词 */
  preprompt?: string;
  /** 人读的断言点（来自 changelog「验证方式：」） */
  assertions?: string[];
  passCriteria: string;
  /** 期望重复次数（安全边界类 N-of-M），默认 1 */
  repeat?: number;
}

export interface RegistryParseError {
  file: string;
  errors: string[];
}

export interface RegistryScan {
  cases: TestRegistryCase[];
  errors: RegistryParseError[];
}

/** 流式测试日志（pi:testLog），按用例 id 关联 */
export interface TestRunLogLine {
  caseId: string;
  line: string;
}

/** logic 用例运行结果 */
export interface LogicRunResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
}

/** harness 产出的 result.json（字段随 harness 演进，故保留索引签名） */
export interface ScenarioResultFile {
  case: string;
  provider?: string;
  modelId?: string;
  startedAt?: string;
  finishedAt?: string;
  status?: string;
  checks?: Record<string, boolean | number | null>;
  errors?: string[];
  filesCreated?: string[];
  blockedEvidence?: unknown[];
  modeSwitchRequests?: unknown[];
  [key: string]: unknown;
}

/** scenario 用例运行结果（含模拟对话转录） */
export interface ScenarioRunResult {
  ok: boolean;
  status: "pass" | "fail" | "timeout" | "error" | "no-result";
  exitCode: number | null;
  result: ScenarioResultFile | null;
  transcript: string | null;
  error?: string;
}

/** harness results-summary.json 的一条汇总记录 */
export interface ScenarioHistoryEntry {
  case: string;
  model?: string;
  status?: string;
  txtFile?: string;
  filesCreated?: number;
  modeSwitchRequests?: number;
  approvalCards?: number;
  blockedEvidence?: number;
  [key: string]: unknown;
}
