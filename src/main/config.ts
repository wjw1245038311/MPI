import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonAtomic } from "./json-store";
// Type-only imports (erased at compile time) — no runtime cycles.
import type { FeishuChannelConfig, WeChatChannelConfig } from "./messaging/types";
import type { AutoPolicy, PoolEntry } from "./model-autopilot";
import type { RelayChannel, RelayMode } from "./remote/relay-channels";
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
  /**
   * tailscale CLI 的绝对路径（可选）。
   *
   * 用于**附件直连**：主机读 `tailscale status --json` 拿到自己的 tailnet 主机名，
   * 才能拼出客户端可访问的 URL（见 ipc.ts 的 resolveAttachmentBaseUrl）。
   * 没装进 PATH 时填这里（Windows 默认不装进 PATH）；留空则用 PATH 上的 `tailscale`，
   * 两者都不可用 → 直连关闭（客户端回落内联/中继分片，功能不坏）。
   */
  tailscaleBin?: string;
  /**
   * 附件直连的**基地址覆盖**（可选）。
   *
   * 默认是自动检测：读 `tailscale status --json` 的主机名拼 `https://<名字>:<对外端口>`。
   * 但若要经**已有的反向代理**暴露（例如 Seafile 的 Caddy 在 443 上转发 `/att/*`），
   * 就把这里填成那个基地址（如 `https://workstation.tail38d5a.ts.net`）——服务仍只绑本机
   * 127.0.0.1，对外由代理转发。环境变量 `MPI_ATTACHMENT_BASE_URL` 优先级更高（临时覆盖用）。
   */
  attachmentBaseUrl?: string;
  /**
   * 配对时**告诉手机的中继地址**（可选）。留空 = 用主机自己那条（tailnet wss）。
   *
   * 手机不装 Tailscale 时填公网明文那条，例如 `ws://47.97.28.110:10445/ws`
   * （用 IP 而不是域名：阿里云会按 Host 头里的未备案域名返回备案拦截页）。
   */
  mobileRelayUrl?: string;
  /**
   * 附件服务的 TLS 证书与私钥（可选，PEM 路径）。
   *
   * 两个都给，主机才会额外起一个 **https 监听**（默认 127.0.0.1:8898）：
   * 经公网反向隧道（如 `ssh -R <公网端口>:127.0.0.1:8898`）暴露附件服务时，
   * 客户端要求受信证书，而且这条路上没有 tailscale serve / 反向代理帮我们终结 TLS。
   */
  attachmentCertFile?: string;
  attachmentKeyFile?: string;
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
  /** Per-thread **intended** thinking level, keyed by the same session UUID as
   * `threadTaskModes`. The live value always comes from pi (`get_state`); this
   * only records what the user actually picked, so switching models — where pi
   * clamps to the new model's `thinkingLevelMap` and never restores — can put it
   * back when the target model supports it (see src/shared/thinking-levels.ts). */
  threadThinking?: Record<string, string>;
  /** Per-thread **selected model**, keyed by the same session UUID as
   * `threadTaskModes`/`threadThinking`. pi 进程重生（关掉再打开、重启应用）时会回到
   * settings.json 的全局 defaultProvider/defaultModel，所以不记这一层就会出现
   * 「明明选了 4.1，切回来/重开后 pill 显示别的模型」。 */
  threadModels?: Record<string, { provider: string; id: string }>;
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
  /** “问答方式” (Settings → Conversation). "inline" (default): multiple-choice
   * questions are emitted as ```choices fences that MPI renders as a clickable
   * inline panel; selections come back as one user message. "manual": the agent
   * asks numbered plain-text questions and the user types answers. Injected into
   * every session's system prompt at spawn time (see append-prompt.ts). */
  qaMode?: "inline" | "manual";
  /** 空闲会话回收阈值（分钟）：超过这么久没有任何活动的会话进程会被停掉以释放内存；
   * 0 = 关闭。默认 120（见 main/ipc.ts 的 sweepIdleBridges）。 */
  idleReclaimMinutes?: number;
  /** 知芽母版根目录（AgentSetting 仓）。母版是 git 真相源，`~/.pi/agent/zhiya/`
   * 只是它的单向同步副本。留空 = 首次启动自动探测
   * （<MyWorkspace>/Agent/AgentSetting，从 lastThreadCwd 向上找）并写回。
   * 探测不到时知芽只用本机副本工作，且面板会显式提示——不静默假装已同步。 */
  zhiyaMasterDir?: string;
  /** 知芽知识库目录（可选）：设置了就用它（目录里放 md 文件，可跨项目共享），
   * 留空 = 每项目的 `<项目根>/.alexandria/knowledge`。机器本地路径，不随备份导入。 */
  knowledgeDir?: string;
  /**
   * 巩固（dream）是否自动跑。
   * 默认 false：累计重要性到 150 只**记账并提示**，不自动花几分钟跑本地模型——
   * 自动消耗算力这件事要用户明确点头（改为 true 即开启）。
   */
  zhiyaDreamAuto?: boolean;
  /**
   * dream 的六题判定是否调模型。
   * 默认 false —— 实测本机思考型模型在该任务上思考停不下来（content 恒空），
   * 改用确定性启发式规则；换了非思考型模型再开。
   */
  zhiyaDreamLlmClassify?: boolean;
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
  /**
   * 中继准入 token（P1，见 docs/RELAY-SHARING.md §3.1）：中继侧配了 RELAY_HOST_TOKENS 时，
   * 主机注册必须带上它。**只用于 host→relay 注册**，绝不进配对票（否则设备也拿到主机凭证）。
   * 空 = 中继未启用准入（自用/局域网内嵌中继）。
   */
  remoteRelayToken: string;
  /**
   * 配对时是否用「同名且离线」的旧记录替换新设备（默认 true）。
   *
   * 网页端每换一个域名/地址就是另一套 IndexedDB → 全新的设备身份，主机侧会多一条绑定；
   * 打开它就能把同名旧记录收敛掉（只换最久没露面的那条）。关掉则一律新增，保留所有绑定。
   */
  remoteReplaceSameNameOffline: boolean;
  /**
   * 备用中继通道（阶段 ②「主机双中继上行」，见实施计划-C档多通道.md）：
   * 启用后主机**额外**挂在「本机中继」上（地址推导为 `ws://127.0.0.1:<lanModePort>/ws`），
   * 使得 ECS 挂掉时手机扫备用票仍能找到主机。默认开（本地一条 WS，代价极小）。
   */
  remoteRelayFallbackEnabled: boolean;
  /**
   * **已弃用**（2026-10-16，用户决定去掉 CF：公网绕一圈、延迟太高）：链路只保留
   * 「中继服务器（内置/自定义）+ 局域网」。字段仍读取（老配置不报错），但**不再进配对票、
   * 也不再当页面入口**。（CF 隧道本身仍可作网页入口手工使用，只是不再由客户端自动选它。）
   */
  mobileRelayFallbackUrl: string;
  /**
   * 中继通道列表（实施计划-C档多通道.md §三）。
   * **缺省 = 从旧字段合成**（`remoteRelayUrl` / `mobileRelayUrl` / `remoteRelayFallback*`，只读不写）；
   * 用户在界面首次保存通道列表时才落盘，并写 `relayChannelsVersion`。
   */
  relayChannels?: RelayChannel[];
  /** 选路模式：manual = 手动选通道（默认，与改造前行为一致）；auto = 每条启用通道都挂上，设备端选路。 */
  relayMode: RelayMode;
  /** 手动模式下选中的通道 id（空 = 取首条启用通道）。 */
  activeChannelId?: string;
  /** 通道配置结构版本（首次保存通道列表时写入；用于迁移与回滚）。 */
  relayChannelsVersion?: number;
  /**
   * **自定义中继**（设置 →「转发设置」，2026-10-16 定稿）：用户填了自己的地址就用自己的。
   *
   * 留空 = 用**内置服务器**（我的 ECS，需激活码）；填了就完全走它（应用更新则回到 GitHub，
   * 因为自定义中继不镜像安装包）。一条地址同时当主机上行与手机地址——自建中继的实际用法
   * 就是这样（`wss://relay.example.com/ws`）；需要分开填属于「高级」，暂不做。
   * 内置服务器的地址不在配置里（以混淆形式内置在 `shared/builtin-server.ts`）。
   */
  customRelayUrl?: string;
  /** 自定义中继的准入令牌（那个中继自己要求的准入）。 */
  customRelayToken?: string;
  /**
   * **授权码**：内置服务器的唯一凭证（同时用于中继注册与镜像下载）。
   * 与通道的准入 token 无关（那条服务于自定义服务器）。**不返回给渲染层**。
   */
  serverAuthCode?: string;
  /**
   * 旧配置迁移的**一次性**标记（2026-10-19）。
   *
   * 那段迁移会把 `remoteRelayUrl` / 老通道列表里的地址还原成 `customRelayUrl`；
   * 只要用户清空自定义中继，下次启动就会再被还原一次（"设置没保存"的真凶）。
   * 迁移跑完写 2，此后永不再跑。
   */
  serverMigration?: number;
  /**
   * 局域网直连模式（P2，见 docs/RELAY-SHARING.md §3.2）：桌面端自己起一个只绑局域网的中继，
   * 手机连内网地址 → 不依赖 Tailscale/公网，附件也走内网。**代价是没有推送通道**。
   *
   * 注（S0 起）：中继进程现已**常驻**，本开关只决定「绑定地址」与「是否把内网地址广告进配对票」。
   */
  lanModeEnabled: boolean;
  /** 局域网中继端口（默认 9001）。 */
  lanModePort: number;
  /**
   * **局域网 TLS**（2026-10-16）：本机中继的证书与私钥（PEM 路径）。
   * 两者都填且文件存在 → 在 `localRelayTlsPort`（默认 9443）上开 wss，明文监听继续留在
   * `lanModePort`（主机上行 / CF 隧道 / tailscale serve 都指着它）。为什么需要：PWA 的 E2E
   * 依赖 `crypto.subtle`（只在 https 安全上下文可用），而 https 页面又禁止连 `ws://`——
   * 没有 wss 入口，局域网直连就服务不了 https 页面。证书由自签 CA 签发，**设备需装一次根证书**。
   */
  localRelayCertFile?: string;
  localRelayKeyFile?: string;
  /** 局域网 TLS 监听端口（默认 9443）。 */
  localRelayTlsPort?: number;
  /**
   * 本机中继的静态目录（托管网页 PWA / 下载页）。空 = 不托管。
   * 设为目录后，经 CF 隧道的 `https://relay.<域名>/` 就是 PWA 界面，同域名 `/ws` 是数据通道。
   */
  localRelayStaticDir: string;
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
  /** Smart compaction (mpi-smart-compact extension; Settings → Models & Providers).
   * `model` = "provider/modelId" preferred for summarization; absent = follow the
   * session's main model. `enabled=false` disables the whole extension (pi default). */
  smartCompact?: { enabled?: boolean; model?: string };
  /**
   * 记忆模型（设置 → 模型与提供商 → 记忆模型）——三模式：
   *   none（默认/未设置）：**完全不调模型**，只用基础记忆读写改（= mem0 的 infer:false 形态）
   *   session：跟随主模型（扩展用当前会话主模型；主进程 dream 用配置里的默认模型）
   *   model：指定供应商 + 模型
   */
  memoryModel?: { mode?: "none" | "session" | "model"; provider?: string; model?: string };
  /** Voice system (语音系统): STT for composer voice input + TTS for reading
   * agent replies aloud. Absent = unconfigured; the mic button then points to
   * Settings → Conversation → 语音系统. See src/main/voice.ts for STT backends and
   * src/renderer/src/lib/tts.ts for the speechSynthesis-based TTS engine. */
  voice?: VoiceConfig;
  /** Mobile (PWA) voice-input override: OpenAI-compatible /v1 base URL.
   * Absent = follow the desktop voice config (Settings → Conversation → 语音系统,
   * typically the local-voice app's http://127.0.0.1:8800/v1), with the
   * voice-stack gateway's raw-WAV endpoint as last-resort fallback. */
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
  remoteRelayToken: "",
  remoteReplaceSameNameOffline: true,
  remoteRelayFallbackEnabled: true,
  mobileRelayFallbackUrl: "",
  relayMode: "manual",
  lanModeEnabled: false,
  lanModePort: 9001,
  localRelayStaticDir: "",
};

let cached: AppConfig | null = null;
let cachedDir = "";

/** Coerces a persisted (or parsed) channel object into a safe shape. */
/**
 * 中继通道列表清洗（S2）。结构不对的条目一律丢弃，不猜内容。
 * `kind` 决定主机上行怎么推导（见 remote/relay-channels.ts）。
 */
function sanitizeRelayChannels(value: unknown): RelayChannel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: RelayChannel[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim().replace(/[^a-zA-Z0-9_-]/g, "") : "";
    if (!id) continue;
    const kind = r.kind === "local" || r.kind === "lan" ? r.kind : "remote";
    out.push({
      id,
      label: typeof r.label === "string" && r.label.trim() ? r.label.trim().slice(0, 40) : id,
      phoneUrl: typeof r.phoneUrl === "string" ? r.phoneUrl.trim() : "",
      ...(typeof r.hostUrl === "string" && r.hostUrl.trim() ? { hostUrl: r.hostUrl.trim() } : {}),
      ...(typeof r.token === "string" && r.token.trim() ? { token: r.token.trim() } : {}),
      enabled: r.enabled !== false,
      kind,
    });
  }
  // 同 id 去重（保留首个）——id 是持久化键与实例键，重复会导致上行互相顶掉
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

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

/** Sanitize the optional smartCompact section (hand-edited config can't break the ext). */
function sanitizeSmartCompact(v: unknown): { enabled?: boolean; model?: string } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const out: { enabled?: boolean; model?: string } = {};
  if (typeof o.enabled === "boolean") out.enabled = o.enabled;
  if (typeof o.model === "string" && o.model.trim()) out.model = o.model.trim();
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 记忆模型消毒：只留非空字符串（手改 config.json 不该把记忆功能搞哑）。 */
function sanitizeMemoryModel(
  v: unknown,
): { mode?: "none" | "session" | "model"; provider?: string; model?: string } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const out: { mode?: "none" | "session" | "model"; provider?: string; model?: string } = {};
  if (o.mode === "none" || o.mode === "session" || o.mode === "model") out.mode = o.mode;
  if (typeof o.provider === "string" && o.provider.trim()) out.provider = o.provider.trim();
  if (typeof o.model === "string" && o.model.trim()) out.model = o.model.trim();
  // session / none 模式不需要 provider+model；model 模式必须要
  if (out.mode === "session" || out.mode === "none") return { mode: out.mode };
  return out.provider && out.model ? out : undefined;
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
        remoteRelayToken: typeof parsed.remoteRelayToken === "string" ? parsed.remoteRelayToken.trim() : DEFAULTS.remoteRelayToken,
        remoteReplaceSameNameOffline:
          typeof parsed.remoteReplaceSameNameOffline === "boolean"
            ? parsed.remoteReplaceSameNameOffline
            : DEFAULTS.remoteReplaceSameNameOffline,
        remoteRelayFallbackEnabled:
          typeof parsed.remoteRelayFallbackEnabled === "boolean"
            ? parsed.remoteRelayFallbackEnabled
            : DEFAULTS.remoteRelayFallbackEnabled,
        mobileRelayFallbackUrl:
          typeof parsed.mobileRelayFallbackUrl === "string" ? parsed.mobileRelayFallbackUrl.trim() : DEFAULTS.mobileRelayFallbackUrl,
        lanModeEnabled: typeof parsed.lanModeEnabled === "boolean" ? parsed.lanModeEnabled : DEFAULTS.lanModeEnabled,
        lanModePort:
          typeof parsed.lanModePort === "number" && parsed.lanModePort > 0 && parsed.lanModePort < 65536
            ? Math.floor(parsed.lanModePort)
            : DEFAULTS.lanModePort,
        localRelayStaticDir:
          typeof parsed.localRelayStaticDir === "string" ? parsed.localRelayStaticDir.trim() : DEFAULTS.localRelayStaticDir,
        ...(typeof parsed.localRelayCertFile === "string" && parsed.localRelayCertFile.trim()
          ? { localRelayCertFile: parsed.localRelayCertFile.trim() }
          : {}),
        ...(typeof parsed.localRelayKeyFile === "string" && parsed.localRelayKeyFile.trim()
          ? { localRelayKeyFile: parsed.localRelayKeyFile.trim() }
          : {}),
        ...(typeof parsed.localRelayTlsPort === "number" && parsed.localRelayTlsPort > 0 && parsed.localRelayTlsPort < 65536
          ? { localRelayTlsPort: Math.floor(parsed.localRelayTlsPort) }
          : {}),
        relayChannels: sanitizeRelayChannels(parsed.relayChannels),
        ...(typeof parsed.serverMigration === "number" ? { serverMigration: Math.floor(parsed.serverMigration) } : {}),
        ...(typeof parsed.customRelayUrl === "string" && parsed.customRelayUrl.trim()
          ? { customRelayUrl: parsed.customRelayUrl.trim() }
          : {}),
        ...(typeof parsed.customRelayToken === "string" && parsed.customRelayToken.trim()
          ? { customRelayToken: parsed.customRelayToken.trim() }
          : {}),
        ...(typeof parsed.serverAuthCode === "string" && parsed.serverAuthCode.trim()
          ? { serverAuthCode: parsed.serverAuthCode.trim() }
          : {}),
        relayMode: parsed.relayMode === "auto" ? "auto" : "manual",
        ...(typeof parsed.activeChannelId === "string" && parsed.activeChannelId.trim()
          ? { activeChannelId: parsed.activeChannelId.trim() }
          : {}),
        ...(typeof parsed.relayChannelsVersion === "number" ? { relayChannelsVersion: Math.floor(parsed.relayChannelsVersion) } : {}),
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
        qaMode: parsed.qaMode === "inline" || parsed.qaMode === "manual" ? parsed.qaMode : undefined,
        idleReclaimMinutes:
          typeof parsed.idleReclaimMinutes === "number" && parsed.idleReclaimMinutes >= 0
            ? Math.min(1440, Math.floor(parsed.idleReclaimMinutes))
            : undefined,
        zhiyaMasterDir: typeof parsed.zhiyaMasterDir === "string" ? parsed.zhiyaMasterDir : undefined,
        knowledgeDir: typeof parsed.knowledgeDir === "string" ? parsed.knowledgeDir : undefined,
        zhiyaDreamAuto: typeof parsed.zhiyaDreamAuto === "boolean" ? parsed.zhiyaDreamAuto : undefined,
        zhiyaDreamLlmClassify:
          typeof parsed.zhiyaDreamLlmClassify === "boolean" ? parsed.zhiyaDreamLlmClassify : undefined,
        smartCompact: sanitizeSmartCompact(parsed.smartCompact),
        memoryModel: sanitizeMemoryModel(parsed.memoryModel),
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
      // 迁移（2026-10-16 二版）：旧的「更新源三件套 / 通道列表 / serverSource」→ 新模型。
      // 规则（只在 customRelayUrl 还没值时跑一次）：
      //   · 有自定义中继（旧通道列表里第一条启用的公网通道，或旧 remoteRelayUrl）→ 写进 customRelay；
      //   · 否则什么都不配 → 只用内置服务器（等激活码）。
      // 旧字段一律删掉（多通道能力按用户决定砍掉），避免两套概念共存。
      const legacy = parsed as unknown as Record<string, unknown>;
      const cachedRecord = cached as unknown as Record<string, unknown>;
      const legacyToken = typeof legacy.appUpdateEcsToken === "string" ? legacy.appUpdateEcsToken.trim() : "";
      // 兼容上一版的「更新源」字段：当时选了 ecs 的机器，把令牌当激活码带走，别丢授权。
      if (!cached.serverAuthCode && legacyToken) cached.serverAuthCode = legacyToken;
      // 一次性：跑过就标记，避免用户清空自定义中继后又被旧字段还原（2026-10-19 真机）。
      if ((cached.serverMigration ?? 0) < 2) {
      if (!cached.customRelayUrl) {
        const stored = cached.relayChannels;
        const remoteChannel = Array.isArray(stored)
          ? stored.find((channel) => channel.enabled && channel.kind === "remote")
          : undefined;
        const url = ((remoteChannel ? remoteChannel.hostUrl || remoteChannel.phoneUrl : "") || cached.remoteRelayUrl || "").trim();
        // 只接受 ws(s):// 且**不是本机回环**的地址：旧配置里总有 `ws://127.0.0.1:9001/ws`
        // （那是常驻的本机中继，不等于「用户有自己的中继」）。
        if (url && /^wss?:\/\//i.test(url) && !/^wss?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/i.test(url)) {
          cached.customRelayUrl = url;
          const token = (remoteChannel?.token || cached.remoteRelayToken || "").trim();
          if (token) cached.customRelayToken = token;
        }
      }
      for (const key of [
        "appUpdateSource",
        "appUpdateEcsUrl",
        "appUpdateEcsToken",
        "serverSource",
        "relayChannels",
        "relayChannelsVersion",
        "relayMode",
        "activeChannelId",
      ]) {
        delete cachedRecord[key];
      }
      cached.serverMigration = 2;
      // 立刻落盘：本轮里用户可能再也不点保存，不写就会在下次启动重跑一遍迁移。
      try {
        writeJsonAtomic(file, cached, { pretty: true });
      } catch {
        /* 写失败不影响本次启动 */
      }
      }
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
  const attachmentBaseUrl = typeof p.attachmentBaseUrl === "string" ? p.attachmentBaseUrl.trim() : "";
  if (attachmentBaseUrl) out.attachmentBaseUrl = attachmentBaseUrl;
  const mobileRelayUrl = typeof p.mobileRelayUrl === "string" ? p.mobileRelayUrl.trim() : "";
  if (mobileRelayUrl) out.mobileRelayUrl = mobileRelayUrl;
  for (const key of ["attachmentCertFile", "attachmentKeyFile"] as const) {
    const value = typeof p[key] === "string" ? (p[key] as string).trim() : "";
    if (value) out[key] = value;
  }
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
  // NOTE: zhiyaMasterDir / knowledgeDir are intentionally NOT imported — they are
  // machine-local paths (checkouts / vault dirs) that would dangle on the target
  // machine. Each machine re-detects or re-sets them on first launch.
  if (typeof p.extAutoPickModel === "boolean") out.extAutoPickModel = p.extAutoPickModel;
  if (p.qaMode === "inline" || p.qaMode === "manual") out.qaMode = p.qaMode;
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
  if (typeof p.remoteRelayToken === "string") out.remoteRelayToken = p.remoteRelayToken.trim();
  if (typeof p.remoteReplaceSameNameOffline === "boolean") out.remoteReplaceSameNameOffline = p.remoteReplaceSameNameOffline;
  if (typeof p.remoteRelayFallbackEnabled === "boolean") out.remoteRelayFallbackEnabled = p.remoteRelayFallbackEnabled;
  if (typeof p.mobileRelayFallbackUrl === "string") out.mobileRelayFallbackUrl = p.mobileRelayFallbackUrl.trim();
  if (typeof p.lanModeEnabled === "boolean") out.lanModeEnabled = p.lanModeEnabled;
  if (typeof p.localRelayStaticDir === "string") out.localRelayStaticDir = p.localRelayStaticDir.trim();
  if (typeof p.localRelayCertFile === "string") out.localRelayCertFile = p.localRelayCertFile.trim();
  if (typeof p.localRelayKeyFile === "string") out.localRelayKeyFile = p.localRelayKeyFile.trim();
  if (typeof p.localRelayTlsPort === "number" && p.localRelayTlsPort > 0 && p.localRelayTlsPort < 65536) {
    out.localRelayTlsPort = Math.floor(p.localRelayTlsPort);
  }
  if (Array.isArray(p.relayChannels)) {
    out.relayChannels = sanitizeRelayChannels(p.relayChannels) ?? [];
    out.relayChannelsVersion = 1;
  }
  // 服务器来源 / 授权码：跟 voice 的 API key 一样属于「用户凭证」，备份与恢复时一并带上。
  if (typeof p.serverAuthCode === "string") out.serverAuthCode = p.serverAuthCode.trim();
  if (typeof p.serverMigration === "number") out.serverMigration = Math.floor(p.serverMigration);
  if (typeof p.customRelayUrl === "string") out.customRelayUrl = p.customRelayUrl.trim();
  if (typeof p.customRelayToken === "string") out.customRelayToken = p.customRelayToken.trim();
  if (p.relayMode === "manual" || p.relayMode === "auto") out.relayMode = p.relayMode;
  if (typeof p.activeChannelId === "string") out.activeChannelId = p.activeChannelId.trim();
  if (typeof p.lanModePort === "number" && p.lanModePort > 0 && p.lanModePort < 65536) out.lanModePort = Math.floor(p.lanModePort);
  // 注：`remoteRelayEnabled` 已于 2026-10-18 删除（上行为总是挂）。旧配置/旧脚本里残留的值一律忽略。

  // Voice settings are portable (no machine-specific paths); the API key is a
  // user credential like any other and travels with config backups on purpose.
  const voice = sanitizeVoice(p.voice);
  if (voice) out.voice = voice;

  return out;
}

export function updateConfig(patch: Partial<AppConfig>): AppConfig {
  if (!cached) throw new Error("config not loaded");
  const next: Partial<AppConfig> = { ...patch };
  cached = {
    ...cached,
    ...next,
    remoteStunUrls: [...BUILT_IN_REMOTE_STUN_URLS],
  };
  // 原子写：写一半崩了也不会把 config.json 留成半截 JSON（那会被下次启动当成空配置）。
  writeJsonAtomic(configPath(cachedDir), cached, { pretty: true });
  return cached;
}
