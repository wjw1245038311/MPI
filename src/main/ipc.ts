import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { checkForAppUpdate, downloadAppUpdate, installAppUpdate } from "./app-updater";
import { checkForCoreUpdate, installCoreUpdate } from "./core-updater";
import { cancelDevRelease, getDevReleaseLogBuffer, getDevReleaseStatus, getReleaseReview, startDevRelease } from "./dev-release";
import { listTests, readScenarioHistory, readScenarioResult, runLogicTest, runScenarioCase } from "./test-runner";
import { getDevReleaseLogWindow, openChangelogWindow, openDevReleaseLogWindow } from "./standalone-windows";
import {
  BUILT_IN_REMOTE_STUN_URLS,
  DEFAULT_REMOTE_SIGNALING_URL,
  PERMISSION_LEVELS,
  getConfig,
  getConfigDir,
  reloadConfig,
  sanitizeImportedConfig,
  updateConfig,
  type AutomationTask,
  type PermissionLevel,
} from "./config";
import {
  buildConfigBackup,
  exportSessionsZip,
  importSessionZip,
  inspectSessionBackup,
  listBackupProjects,
  parseConfigBackup,
} from "./backup";
import { deleteDraft, getAllDrafts, setDraft as persistDraft } from "./draft-store";
import {
  addAttachments,
  addTodo,
  clearCompletedTodos,
  deleteTodo,
  ensureInboxDir,
  ingestInbox,
  listTodos,
  removeAttachment,
  resolveAttachmentFile,
  toggleTodo,
  todosFilePath,
  updateTodo,
  type TodoPatch,
} from "./todo-store";
import {
  getDataMigrationStatus,
  previewMigration,
  setSessionsDir,
  setTodosDir,
} from "./data-migration";
import { cancelTransfer as cancelActiveTransfer, getTransfers, setTransferBroadcaster } from "./transfer-monitor";
import { mimeForName } from "./todo-attachment-protocol";
import type { ComposerDraft } from "../renderer/src/lib/types";
import { listDir } from "./fs-service";
import { createHtmlPreviewUrl } from "./html-preview-protocol";
import {
  getAuthPath,
  getDiagnostics,
  getModelsPath,
  getSettingsPath,
  readModelsFile,
  readThinking,
  testModelAvailability,
  writeModelsProviders,
  writeThinking,
} from "./models-service";
import { autoResolveContextWindows, resolveModelContext } from "./model-context";
import { testStt, transcribeAudio } from "./voice";
import {
  getAppConfig,
  getAppExtensionPaths,
  getAppLogs,
  installAppFromDir,
  installAppFromZip,
  listApps,
  restartAppService,
  saveAppConfig,
  setAppEnabled,
  testAppVoice,
  uninstallApp,
} from "./app-store";
import { synthesizeEdge } from "./edge-tts";
import { DEFAULT_POLICY, ModelAutopilot } from "./model-autopilot";
import {
  autoAnswerModelSelect,
  createWebSearchFlow,
  isLikelyModelSelect,
  type WebSearchFlow,
} from "./web-search-config";
import { classifyMissingTool } from "./npm-command";
import { PiBridge, isAppManagedRuntime, resetPiRuntime, resolvePiRuntime, runtimeKind } from "./pi-bridge";
import { reorderPinned } from "./pinned-order";
import { createGateModeFile, ensureGateExtension, removeGateModeFile, writeGateMode } from "./permission-gate";
import { ensureChoiceExtension } from "./choice-extension";
import {
  isModeSwitchTitle,
  MODE_SWITCH_APPROVE_LABELS,
  MODE_SWITCH_DENY_LABELS,
  stripChoicePrefix,
} from "./choice-logic.ts";
import { ensureTaskModeExtension } from "./taskmode-extension";
import { ensureShellEnvExtension } from "./shellenv-extension";
import { prepareShellForSpawn, recheckShell } from "./shell-bootstrap";
import { ensureTodoExtension } from "./todo-extension";
import { registerTuiIpc } from "./tui";
import { readPreview, readRemotePreview, writePreviewHtml } from "./preview-service";
import {
  closePreviewWindow,
  openPreviewWindow,

  previewWindowMoveEnd,
  previewWindowMoveStart,
} from "./preview-window";
import { getAgentDir, getSessionsDir, getTotalUsage, type ProjectSummary, readSessionCompactions, readThreadHistory, scanProjects, searchThreads, searchTrashThreads, type ThreadSearchHit } from "./session-store";
import { repairSessionFile } from "./session-repair";
import { emptyTrash, listTrash, moveToTrash, purgeFromTrash, restoreFromTrash } from "./trash-store";
import {
  getAdditionalSkillPaths,
  getPackageInfo,
  getSkillContent,
  getSkillCommands,
  listMcpServers,
  listPackages,
  listManagedSkills,
  listSkills,
  nameOf,
  probePiStartup,
  removeMcpServer,
  removePackageEntry,
  runPiCli,
  TransferCancelledError,
  setMcpServerDisabled,
  setPackageEnabled,
  setSkillEnabled,
  upsertFeishuMcp,
} from "./plugins";
import { getSkillDetails, getSkillsHubLeaderboard, installSkillFromHub, searchSkillsHub } from "./skills-hub";
import { getMcpMarketDetail, searchMcpMarket } from "./mcp-market";
import { getNpmReadme, searchNpmPackages } from "./npm-registry";
import { removeAutomationTask, runTaskNow, startScheduler } from "./automation";
import { cancelAppRegistration, startAppRegistration } from "./messaging/app-registration";
import { getMessagingState, initMessaging, messagingSetConfig, sanitizeFeishuConfig } from "./messaging/service";
import type { FeishuChannelConfig, WeChatChannelConfig } from "./messaging/types";
import {
  cancelWeChatQrLogin,
  startWeChatQrLogin,
  submitWeChatVerifyCode,
} from "./messaging/wechat-registration";
import { getWeChatState, initWeChatMessaging, wechatSetConfig } from "./messaging/wechat-service";
import { APPROVAL_GRACE_MS, getChannelThread, isChannelOwnedSession, threadUuidFromSessionFile } from "./messaging/channel-threads";
import { ensureChannelCommandInbox, startChannelCommandInboxWatcher } from "./messaging/channel-command";
import { ensureChannelExtension } from "./messaging/channel-extension";
import { buildApprovalDiff } from "./remote/approval-diff";
import { loadOrCreateIdentity, opaqueId } from "./remote/identity";
import { RemoteHost } from "./remote/host";
import { RelayUplink } from "./remote/relay-uplink";
import { FilePreviewService, ProjectService, RemoteEventHub, ThreadService } from "./remote/services";
import { RemoteService, type RemoteBackend } from "./remote/service";
import {
  createSystemNotificationCenter,
  isChoiceRequest,
  isSandboxApprovalRequest,
  sandboxOperationFromTitle,
  type SystemNotificationCenter,
} from "./system-notifications";
import {
  RemoteProtocolError,
  type RemoteFileArtifact,
  type RemoteMessage,
  type RemoteModelOption,
  type RemotePermission,
  type RemoteProject,
  type RemoteSkill,
  type RemoteThreadEventPayload,
  type RemoteThreadSnapshot,
  type RemoteThreadState,
} from "./remote/protocol";



/**
 * Wires the renderer's window.pi.* calls to main-process services and to the
 * per-thread pi RPC bridges. Agent events and extension-UI requests are pushed
 * back to the renderer as `pi:event` / `pi:extui` / `pi:exit` / `pi:error`.
 *
 * The bridge registry stores the *handle* (not just the bridge) so that when a
 * session file path changes (new session / fork) we can re-key the map AND the
 * closure id used for event routing in one step.
 */

interface BridgeHandle {
  bridge: PiBridge;
  getId: () => string;
  setId: (n: string) => void;
  permission: PermissionLevel;
  gateModeFile: string;
}

const bridges = new Map<string, BridgeHandle>();
let systemNotifications: SystemNotificationCenter | null = null;
let activeRemoteHost: RemoteHost | null = null;
let activeRelayUplink: RelayUplink | null = null;

// "扩展自动选模" (Settings → Conversation): keeps pi-web-access's web-search.json in
// sync with each conversation's current model and auto-answers extension
// model-picker dialogs. Lazy so it never depends on config-dir init order.
let webSearchFlowInstance: WebSearchFlow | null = null;
function webSearchFlow(): WebSearchFlow {
  if (!webSearchFlowInstance) webSearchFlowInstance = createWebSearchFlow(getConfigDir());
  return webSearchFlowInstance;
}

/** Re-read the thread's live model and push it into web-search.json (no-op
 * when the feature is switched off). Fire-and-forget: never blocks a turn. */
function refreshWebSearchFlow(bridge: PiBridge): void {
  if (getConfig().extAutoPickModel === false) return;
  void bridge
    .getState()
    .then((s: any) => webSearchFlow().sync(s?.model ?? null))
    .catch(() => {});
}

// Opening a folder makes it available for the current workspace session, but
// it must not silently become a persisted pinned project. Keep empty folders
// visible until they have a session on disk; explicit pinning still goes
// through app:setProjectPinned and remains persisted in the config.
const openedProjects = new Map<string, ProjectSummary>();
let openedProjectOrder: string[] = [];

const IMG_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};
const TEXT_ATTACH_EXTS = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml",
  ".csv", ".tsv", ".log", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".css",
  ".scss", ".html", ".htm", ".py", ".go", ".rs", ".java", ".sh", ".bash", ".sql",
  ".env", ".ini", ".cfg", ".conf", ".vue", ".svelte",
]);

interface Attachment {
  abs: string;
  name: string;
}

const CLIPBOARD_FILE_MAX_BYTES = 50_000_000;
const CLIPBOARD_FILE_DIR = "mpi-clipboard";
const CLIPBOARD_MIME_EXT: Record<string, string> = {
  "text/plain": ".txt",
  "text/csv": ".csv",
  "application/json": ".json",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
};

function stageClipboardFile(args: { name?: string; mimeType?: string; data?: string }): { abs: string; name: string; size: number } {
  const encoded = typeof args?.data === "string" ? args.data : "";
  if (!encoded) throw new Error("Clipboard file is empty");
  if (encoded.length > Math.ceil(CLIPBOARD_FILE_MAX_BYTES * 4 / 3) + 16) {
    throw new Error("Clipboard file is too large (maximum 50 MB)");
  }

  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length) throw new Error("Clipboard file is empty");
  if (bytes.length > CLIPBOARD_FILE_MAX_BYTES) throw new Error("Clipboard file is too large (maximum 50 MB)");

  const rawName = basename(String(args?.name || "pasted-file"))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\.+$/g, "")
    .trim();
  let name = (rawName || "pasted-file").slice(0, 180);
  if (!extname(name)) name += CLIPBOARD_MIME_EXT[String(args?.mimeType || "").toLowerCase()] || ".bin";

  const directory = join(app.getPath("temp"), CLIPBOARD_FILE_DIR);
  mkdirSync(directory, { recursive: true });
  const abs = join(directory, `${randomUUID()}-${name}`);
  writeFileSync(abs, bytes, { flag: "wx" });
  return { abs, name, size: bytes.length };
}

function sameSessionFile(left: string, right: string): boolean {
  if (!left || !right) return false;
  try {
    const a = resolve(left);
    const b = resolve(right);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return left === right;
  }
}

/** Only the session store may be permanently modified from the delete action. */
function assertDeletableSessionFile(file: string): string {
  const requested = file.trim();
  if (!requested || !isAbsolute(requested) || extname(requested).toLowerCase() !== ".jsonl") {
    throw new Error("A session JSONL path is required");
  }

  let storeRoot: string;
  let target: string;
  try {
    storeRoot = realpathSync(resolve(getSessionsDir()));
    target = resolve(requested);
  } catch {
    throw new Error("Thread session file not found");
  }

  const assertInsideStore = (candidate: string) => {
    const rel = relative(storeRoot, candidate);
    if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error("Thread session path is outside the session store");
    }
  };

  assertInsideStore(target);
  if (!existsSync(target) || !statSync(target).isFile()) throw new Error("Thread session file not found");

  // Resolve symlinks before deleting so a link inside the session store cannot
  // redirect the destructive operation elsewhere.
  const realTarget = realpathSync(target);
  assertInsideStore(realTarget);
  if (extname(realTarget).toLowerCase() !== ".jsonl") throw new Error("Only JSONL session files can be deleted");
  return realTarget;
}

async function unlinkSessionWithRetry(file: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await unlink(file);
      return;
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
      lastError = error;
      if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code) || attempt === 4) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100 * (attempt + 1)));
    }
  }
  throw lastError || new Error("Could not delete thread session file");
}

function processAttachments(attachments: Attachment[] | undefined, text: string): { text: string; images: unknown[] } {
  const images: unknown[] = [];
  let extra = "";
  if (attachments && attachments.length) {
    for (const a of attachments) {
      const ext = extname(a.name || a.abs).toLowerCase();
      try {
        if (ext in IMG_MIME) {
          const buf = readFileSync(a.abs);
          images.push({ type: "image", data: buf.toString("base64"), mimeType: IMG_MIME[ext] });
          continue;
        }
        if (TEXT_ATTACH_EXTS.has(ext) || ext === "") {
          const st = statSync(a.abs);
          if (st.size <= 500_000) {
            const content = readFileSync(a.abs, "utf8");
            extra += `\n\n<file name="${a.name}" path="${a.abs}">\n${content}\n</file>`;
            continue;
          }
        }
        extra += `\n\n<file name="${a.name}" path="${a.abs}" note="attached (binary or large; not inlined)" />`;
      } catch (e: any) {
        extra += `\n\n<file name="${a.name}" path="${a.abs}" error="${e?.message || "read failed"}" />`;
      }
    }
  }
  return { text: text + extra, images };
}

function agentContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: any) => (block?.type === "text" ? String(block.text || "") : ""))
    .filter(Boolean)
    .join("\n");
}

function finalAssistantReply(message: any): { text: string } | null {
  if (!message || message.role !== "assistant") return null;
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
  if (stopReason === "error" || stopReason === "aborted") return null;
  if (Array.isArray(message.content) && message.content.some((block: any) => block?.type === "toolCall")) return null;
  return { text: agentContentText(message.content) };
}

function createHandle(
  cwd: string,
  sessionFile: string | undefined,
  name: string | undefined,
  permission: PermissionLevel,
  send: (ch: string, p: unknown) => void,
): BridgeHandle {
  let id = sessionFile || `boot:${randomUUID()}`;
  // Channel session bridge gating — see the extensions list below.
  const isChannelSession = isChannelOwnedSession(sessionFile);
  const gateModeFile = createGateModeFile(getConfigDir(), permission);
  // Resolve which shell backs the bash tool BEFORE spawning, and make pi's own
  // settings agree with it (shell-bootstrap writes shellPath when the shell was
  // found outside pi's search path). The same value feeds the model's
  // environment block via MPI_SHELL_INFO, so prompt and runtime cannot drift.
  const shell = prepareShellForSpawn(join(getAgentDir(), "settings.json"), cwd);
  let turnStarted = false;
  let promptForNotification = name || "";
  let completedReply: { text: string } | null = null;
  const handle: BridgeHandle = {
    bridge: null as unknown as PiBridge,
    getId: () => id,
    setId: (n: string) => {
      if (n && n !== id) {
        bridges.delete(id);
        autopilot.migrateThread(id, n); // keep auto-mode state across boot:uuid → session file
        const cfg = getConfig();
        if (cfg.autoModelThreads?.[id]) {
          const next = { ...cfg.autoModelThreads };
          delete next[id];
          next[n] = true; // persist the flag under the real session file
          updateConfig({ autoModelThreads: next });
        }
        id = n;
        bridges.set(n, handle);
      }
    },
    permission,
    gateModeFile,
  };
  handle.bridge = new PiBridge({
    cwd,
    piCliPath: getConfig().piCliPath,
    sessionFile,
    name,
    // The gate extension is always loaded; its sandbox/full behaviour is decided
    // at runtime by the per-thread mode file, so permission can change live.
    // The todo bridge gives the agent mpi_todo_add / mpi_todo_list (待办任务 panel).
    // The channel session bridge (mpi_channel_* tools) loads only for threads
    // currently owned by a chat channel — desktop/automation sessions never
    // carry it, so they don't pay its ~300 tokens per request. A thread that
    // becomes channel-owned later picks the tools up on its next spawn; until
    // then fast-path commands (/new /list /use + short phrases) still work in
    // the main process.
    extensions: [
      ensureGateExtension(getConfigDir()),
      ensureTodoExtension(getConfigDir()),
      // Shell-environment bridge: tells the model which shell its commands run
      // in (paired with the --exclude-tools powershell passed to this spawn).
      ensureShellEnvExtension(getConfigDir()),
      // 方案选择 bridge: mpi_ask_choice renders clickable option cards in the
      // chat (existing extension-UI select). Interactive threads only —
      // automation spawns its own list without it, so unattended runs never
      // block on a dialog nobody can click.
      ensureChoiceExtension(getConfigDir()),
      // 任务模式 behaviour bridge: appends the active mode's instructions/spec
      // doc to the system prompt every turn (live switching, no restart).
      ensureTaskModeExtension(getConfigDir()),
      ...(isChannelSession ? [ensureChannelExtension(getConfigDir())] : []),
      // App-shipped pi extensions (manifest v2 `pi.extensions`): enabled apps
      // only, pointed straight at their installed dir (see app-store.ts).
      ...getAppExtensionPaths(),
    ],
    // Live paths so a customized todo data location (Settings → 数据管理) is
    // honored from the next spawned bridge on.
    todoPaths: { file: todosFilePath(), inboxDir: ensureInboxDir() },
    choiceConfigFile: join(getConfigDir(), "config.json"),
    taskModeStateDir: join(getConfigDir(), "taskmodes"),
    channelInboxDir: isChannelSession ? ensureChannelCommandInbox() : undefined,
    // Keep pi's runtime in sync with the Plugins inventory, including the
    // singular `.pi/agent/skill` compatibility path and other local roots.
    skills: getAdditionalSkillPaths(cwd),
    // User profile text (Settings → User Profile) is appended to this run's
    // system prompt; read at spawn time so edits apply from new sessions on.
    appendSystemPrompt: getConfig().userProfile?.trim() || undefined,
    shellInfo: shell.info,
    toolFlags: shell.toolFlags,
    gateModeFile,
    onEvent: (e) => {
      const event: any = e;
      if (event?.type === "agent_start") {
        turnStarted = true;
        completedReply = null;
        // pi-web-access re-reads web-search.json on every search, so syncing at
        // turn start covers initial model, manual switches and auto failover.
        refreshWebSearchFlow(handle.bridge);
      }
      if (event?.type === "message_start" && event.message?.role === "user") {
        turnStarted = true;
        promptForNotification = agentContentText(event.message.content).trim();
      }
      if (event?.type === "message_end" && event.message?.role === "assistant") {
        // Intermediate assistant messages contain tool calls. Only retain the
        // final user-facing assistant message for the native completion card.
        completedReply = finalAssistantReply(event.message);
      }

      // P1-12: passive latency/health signals — no-op for non-auto threads.
      autopilot.onAgentEvent(id, event);

      send("pi:event", { threadId: id, event });

      if (event?.type === "agent_settled") {
        const shouldNotify = turnStarted;
        const reply = completedReply;
        const prompt = promptForNotification;
        turnStarted = false;
        completedReply = null;
        if (shouldNotify && reply) {
          systemNotifications?.notifyTaskComplete(id, {
            language: getConfig().language === "zh" ? "zh" : "en",
            prompt,
            reply: reply.text,
          });
        }
      }
    },
    onExtUi: (r) => {
      // "扩展自动选模": a dialog whose options are all provider/model strings is
      // answered with this thread's current model instead of popping up. No
      // match (or feature off) falls through to the normal UI path below.
      if (getConfig().extAutoPickModel !== false && isLikelyModelSelect(r)) {
        void autoAnswerModelSelect(handle.bridge, r as any)
          .then((answered) => {
            if (!answered) send("pi:extui", { threadId: id, request: r });
          })
          .catch(() => send("pi:extui", { threadId: id, request: r }));
        return;
      }
      send("pi:extui", { threadId: id, request: r });
      const lang = getConfig().language === "zh" ? "zh" : "en";
      // The handle id is the session file path once promoted (boot:<uuid>
      // before that); the registry is keyed by the session-file UUID.
      const regKey = id.endsWith(".jsonl") ? threadUuidFromSessionFile(id) : null;
      const entry = regKey ? getChannelThread(regKey) : undefined;
      if (isModeSwitchTitle((r as any)?.title)) {
        // Agent asked to leave an enforced read-only mode and execute its plan.
        // Remember the target; the response interceptor applies it on approval.
        const to = parseModeSwitchTarget((r as any)?.title);
        if (to) pendingModeSwitch.set(String((r as any).id), { threadId: id, to });
        systemNotifications?.notifySandboxApproval(
          id,
          lang,
          lang === "zh" ? "agent 请求切换权限（见 MPI 确认卡片）" : "Agent requested a permission switch (see the MPI card)",
        );
        // Channel-owned threads can't wait for a desktop click — same
        // notify + auto-cancel treatment as sandbox approvals.
        if (entry) {
          void Promise.resolve(
            entry.notifyApproval(
              lang === "zh"
                ? `⚠️ agent 请求切换本会话权限，请在 MPI 中 ${APPROVAL_GRACE_MS / 1000} 秒内确认；无响应将自动拒绝。`
                : `⚠️ The agent requested a permission switch for this thread. Confirm in MPI within ${APPROVAL_GRACE_MS / 1000}s or it will be auto-denied.`,
            ),
          ).catch((err) => console.error("[messaging] mode-switch notify failed:", err));
          setTimeout(() => {
            try {
              handle.bridge.respondExtUi((r as any).id, { cancelled: true });
            } catch (err) {
              console.error("[messaging] mode-switch auto-cancel failed:", err);
            }
          }, APPROVAL_GRACE_MS);
        }
      } else if (isSandboxApprovalRequest(r)) {
        systemNotifications?.notifySandboxApproval(
          id,
          lang,
          sandboxOperationFromTitle((r as any)?.title, lang),
        );
        // Remember extension-tool approvals so a “始终允许该工具” click can be
        // persisted cross-session. Shell/write/edit are never persistable.
        const op = sandboxOperationFromTitle((r as any)?.title, lang);
        if (op && op !== "Shell" && op !== "write" && op !== "edit") {
          pendingTrustTool.set(String((r as any).id), op);
        }
        // Channel-owned threads (Feishu/WeChat) can't wait for a desktop click:
        // tell the user through the channel and auto-deny after the grace
        // period. A late response is harmless — pi ignores responses for ids
        // that are no longer pending, and an exited bridge drops it.
        if (entry) {
          const op = sandboxOperationFromTitle((r as any)?.title, lang);
          void Promise.resolve(
            entry.notifyApproval(
              lang === "zh"
                ? `⚠️ 有操作需要授权：${op}。请在 MPI 中 ${APPROVAL_GRACE_MS / 1000} 秒内批准；无响应将自动拒绝，任务会继续。`
                : `⚠️ Operation needs approval: ${op}. Approve it in MPI within ${APPROVAL_GRACE_MS / 1000}s or it will be auto-denied and the task continues.`,
            ),
          ).catch((err) => console.error("[messaging] approval notify failed:", err));
          setTimeout(() => {
            try {
              handle.bridge.respondExtUi((r as any).id, { cancelled: true });
            } catch (err) {
              console.error("[messaging] auto-deny failed:", err);
            }
          }, APPROVAL_GRACE_MS);
        }
      } else if (isChoiceRequest(r)) {
        // Plan-choice card (mpi_ask_choice): same rules as approvals — notify
        // the desktop, and for channel-owned threads tell the user + auto-
        // cancel after the grace period so the agent falls back to plain text
        // instead of hanging on a click nobody can make.
        systemNotifications?.notifyChoicePending(id, lang, stripChoicePrefix((r as any)?.title ?? ""));
        if (entry) {
          const question = stripChoicePrefix((r as any)?.title ?? "");
          void Promise.resolve(
            entry.notifyApproval(
              lang === "zh"
                ? `🤔 有方案待选择：${question}。请在 MPI 中 ${APPROVAL_GRACE_MS / 1000} 秒内点击选项；无响应将自动取消，我会改用文字列出选项。`
                : `🤔 A plan-choice is waiting: ${question}. Pick an option in MPI within ${APPROVAL_GRACE_MS / 1000}s or it will be auto-cancelled and I'll list the options as text.`,
            ),
          ).catch((err) => console.error("[messaging] choice notify failed:", err));
          setTimeout(() => {
            try {
              handle.bridge.respondExtUi((r as any).id, { cancelled: true });
            } catch (err) {
              console.error("[messaging] choice auto-cancel failed:", err);
            }
          }, APPROVAL_GRACE_MS);
        }
      }
    },
    onExit: (info) => {
      // Only forget the bridge if it is still the one registered under this id
      // (a delayed exit must not evict a bridge that replaced it).
      if (bridges.get(id) === handle) bridges.delete(id);
      if (warmHandle === handle) {
        warmHandle = null;
        if (!info.expected) warmFailures++;
        // eslint-disable-next-line no-console
        console.log(`[pi] warm spare exited (code=${info.code}, expected=${!!info.expected}, failures=${warmFailures})`);
        // Refill unless the spare keeps dying (avoid a crash loop).
        if (warmFailures < 3) setTimeout(() => ensureWarmBridge(), 500);
      }
      removeGateModeFile(gateModeFile);
      // An intentional stop (thread close / app quit) is expected and must not
      // surface as a "pi process exited" error.
      if (!info.expected) send("pi:exit", { threadId: id, ...info });
    },
    onError: (err) => send("pi:error", { threadId: id, message: err.message }),
  });
  return handle;
}

/* ------------------------------------------------------------------ *
 * Warm spare bridge
 * ------------------------------------------------------------------ *
 * pi's cold start takes ~5s on Windows: its ESM module graph is thousands
 * of small files and Windows Defender's real-time filter scans each open
 * synchronously (measured: 3.5s wall time with <100ms CPU — pure I/O wait).
 * Every thread open used to spawn a fresh process and block on it, so
 * clicks appeared dead for 5 seconds.
 *
 * Fix: keep exactly ONE fully-booted pi process on standby. thread:open
 * adopts it when the cwd matches (switching sessions on a warm process
 * measures ~0.5s vs ~5s cold) and refills the spare in the background.
 * Cost: one idle node process (~190MB); it is stopped on app quit.
 */
let warmHandle: BridgeHandle | null = null;
let lastOpenCwd: string | null = null;
let warmFailures = 0;
let warmEnabled = false;
let sendToRenderer: ((ch: string, p: unknown) => void) | null = null;

// ---- Agent-initiated permission switch (mpi_request_mode_switch) ----------
// The extension renders the confirmation card; main performs the actual live
// switch when the user approves. Pending requests are keyed by extui request id.
const pendingModeSwitch = new Map<string, { threadId: string; to: PermissionLevel }>();

/** Reverse lookup of the permission display names used in the dialog title
 * (keep in sync with PERMISSION_NAMES in mpi-choice-ext.ts). */
const MODE_SWITCH_NAME_TO_LEVEL: Record<string, PermissionLevel> = {
  只读: "readonly",
  "Read-only": "readonly",
  严格: "strict",
  Strict: "strict",
  沙盒: "sandbox",
  Sandbox: "sandbox",
  完全权限: "full",
  "Full access": "full",
};

/** Parse the target level out of a mode-switch dialog title. */
function parseModeSwitchTarget(title: unknown): PermissionLevel | null {
  if (typeof title !== "string") return null;
  const firstLine = title.split(/\r?\n/, 1)[0] || "";
  const m = /(?:切换到「(.+?)」权限|switch to\s+"([^"]+)")/.exec(firstLine);
  const name = (m?.[1] || m?.[2] || "").trim();
  return MODE_SWITCH_NAME_TO_LEVEL[name] ?? null;
}

/** Apply an approved agent-initiated switch: flip the gate live, persist it,
 * and clear the enforced task mode so its read-only floor lifts. */
function applyAgentModeSwitch(threadId: string, to: PermissionLevel): boolean {
  const h = bridges.get(threadId);
  if (!h) return false;
  h.permission = to;
  writeGateMode(h.gateModeFile, to);
  let cfg = getConfig();
  if (threadId.endsWith(".jsonl")) {
    updateConfig({ threadPermissions: { ...cfg.threadPermissions, [threadId]: to } });
    cfg = getConfig();
  }
  const uuid = threadUuidFromSessionFile(threadId);
  if (uuid) {
    try {
      unlinkSync(join(getConfigDir(), "taskmodes", `${uuid}.json`));
    } catch {
      /* no state file for this session */
    }
    const modes = { ...(cfg.threadTaskModes || {}) };
    delete modes[uuid];
    updateConfig({ threadTaskModes: modes });
  }
  sendToRenderer?.("pi:modeSwitched", { threadId, permission: to, taskMode: null });
  return true;
}

// ---- Persistent tool trust (“始终允许该工具”) ---------------------------------
// Approval requests for extension tools are remembered by extui request id so
// the response interceptor can persist the choice into config.trustedTools.
const pendingTrustTool = new Map<string, string>();
/** Labels offered by the gate (keep in sync with permission-gate-ext.ts). */
const ALWAYS_ALLOW_LABELS: readonly string[] = ["始终允许该工具（跨会话）", "Always allow this tool (persistent)"];

/**
 * P1-12 auto model switching. Passive health signals come from the per-thread
 * onEvent hook (auto threads only); switches go through each thread's bridge.
 */
const autopilot = new ModelAutopilot({
  getProviders: () => readModelsFile().providers,
  setModel: async (threadId, provider, modelId) => {
    const h = bridges.get(threadId);
    if (!h) throw new Error("Thread not open: " + threadId);
    await h.bridge.setModel(provider, modelId);
  },
  notify: (p) => sendToRenderer?.("pi:autoModel", p),
});

function warmCwd(): string {
  // Prefer the project actually used most recently (persisted), so the first
  // click after an app restart already hits a matching spare.
  return lastOpenCwd || getConfig().lastThreadCwd || (getConfig().pinnedProjects || [])[0] || homedir();
}

/**
 * Directory identity across sources. On Windows the same folder arrives in
 * different spellings depending on who produced it — the folder dialog,
 * pinned config, and the cwd pi recorded inside a session file can differ in
 * drive-letter case and slash direction. Compare normalized, or the warm
 * spare would never match and every open would fall back to a cold start.
 */
function sameDir(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (process.platform === "win32") {
    const norm = (p: string) => p.replace(/[\\/]+/g, "\\").replace(/[\\/]+$/, "").toLowerCase();
    return norm(a) === norm(b);
  }
  const norm = (p: string) => p.replace(/\/+$/, "") || "/";
  return norm(a) === norm(b);
}

/**
 * Keep the renderer's command list aligned with the skills on disk. Pi is the
 * command authority, but older RPC responses and disconnected history loads
 * can omit skill entries. The disk-side list uses the same 0.84.1 discovery
 * rules, so it is safe to use as a reconciliation source and to remove stale
 * skill entries after a skill is disabled.
 */
function synchronizedCommands(raw: unknown, cwd: string): any[] {
  const diskSkills = getSkillCommands(cwd);
  const byName = new Map(diskSkills.map((skill) => [skill.name, skill]));
  const result: any[] = [];
  const seen = new Set<string>();
  const commands = Array.isArray(raw) ? raw : [];

  for (const command of commands) {
    if (!command || typeof command !== "object") continue;
    if ((command as any).source === "skill") {
      const name = String((command as any).name || "");
      const canonical = byName.get(name);
      if (!canonical || seen.has(name)) continue;
      seen.add(name);
      result.push({ ...command, description: canonical.description });
      continue;
    }
    result.push(command);
  }

  // This also covers a Pi RPC response captured before the skill scan finished.
  for (const skill of diskSkills) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    result.push(skill);
  }
  return result;
}

/** Spawn the standby process if there is none. Safe to call anytime. */
export function ensureWarmBridge(): void {
  if (!warmEnabled || warmHandle || !sendToRenderer) return;
  if (warmFailures >= 3) return; // repeated crashes: stop respawning
  const cwd = warmCwd();
  const handle = createHandle(cwd, undefined, undefined, "sandbox", sendToRenderer);
  warmHandle = handle;
  // eslint-disable-next-line no-console
  console.log("[pi] warm spare spawning (cwd=" + cwd + ")");
  handle.bridge
    .start()
    .then(() => handle.bridge.getState()) // wait until pi answers: fully booted
    .then(() => {
      if (warmHandle === handle) {
        // eslint-disable-next-line no-console
        console.log("[pi] warm spare ready — thread opens are now fast");
      }
    })
    .catch((err) => {
      if (warmHandle === handle) warmHandle = null;
      // A spawned-but-dead process is counted by its onExit handler; only
      // count spawn-time failures here to avoid double counting.
      if (!handle.bridge.running) warmFailures++;
      // eslint-disable-next-line no-console
      console.error("[pi] warm bridge failed to start:", (err as Error)?.message || String(err));
    });
}

/** Kill the standby process (runtime changed, quitting, etc.). */
export function dropWarmBridge(): void {
  if (warmHandle) {
    warmHandle.bridge.stop();
    warmHandle = null;
  }
}

async function gatherThread(bridge: PiBridge, threadId: string, permission: PermissionLevel) {
  const state: any = await bridge.getState();
  const [msgRes, modelsRes, cmdsRes, entriesRes]: any[] = await Promise.all([
    bridge.getMessages(),
    bridge.getAvailableModels(),
    bridge.getCommands().catch(() => ({ commands: [] })),
    bridge.getEntries().catch(() => ({ entries: [], leafId: null })),
  ]);
  // Which task mode this session was last set to (config.threadTaskModes is
  // keyed by the same UUID the mpi-taskmode extension uses for its state file).
  const uuid = threadUuidFromSessionFile(threadId) || /^boot:(.+)$/.exec(threadId)?.[1] || null;
  return {
    threadId,
    cwd: bridge.cwd,
    sessionFile: state.sessionFile ?? null,
    sessionName: state.sessionName ?? null,
    model: state.model ?? null,
    thinkingLevel: state.thinkingLevel ?? "off",
    isStreaming: !!state.isStreaming,
    messages: msgRes?.messages ?? [],
    branchMessages: activeBranchMessages(entriesRes),
    models: modelsRes?.models ?? [],
    commands: synchronizedCommands(cmdsRes?.commands, bridge.cwd),
    permission,
    taskMode: uuid ? (getConfig().threadTaskModes || {})[uuid] ?? null : null,
  };
}

/** Resolve visible user/assistant messages on the active entry branch to their
 * stable session ids. Walking parent links avoids targeting an identically
 * worded reply that belongs to an inactive branch. */
function activeBranchMessages(entriesRes: any): { entryId: string; role: "user" | "assistant"; text: string }[] {
  const entries = Array.isArray(entriesRes?.entries) ? entriesRes.entries : [];
  const byId = new Map(entries.map((entry: any) => [entry?.id, entry]));
  const branch: any[] = [];
  let entry: any = entriesRes?.leafId ? byId.get(entriesRes.leafId) : undefined;
  const seen = new Set<string>();
  while (entry?.id && !seen.has(entry.id)) {
    seen.add(entry.id);
    branch.push(entry);
    entry = entry.parentId ? byId.get(entry.parentId) : undefined;
  }
  branch.reverse();
  const result: { entryId: string; role: "user" | "assistant"; text: string }[] = [];
  for (const item of branch) {
    const role = item?.message?.role;
    if (item?.type !== "message" || (role !== "user" && role !== "assistant")) continue;
    const content = item.message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((block: any) => (block?.type === "text" ? block.text || "" : "")).filter(Boolean).join("\n")
          : "";
    result.push({ entryId: item.id, role, text });
  }
  return result;
}

/** Resolve the effective permission level for a thread open request. */
function resolvePermission(sessionFile: string | undefined, requested: PermissionLevel | undefined): PermissionLevel {
  const valid = (value: unknown): value is PermissionLevel => typeof value === "string" && (PERMISSION_LEVELS as readonly string[]).includes(value);
  if (valid(requested)) return requested;
  if (sessionFile) {
    const stored = getConfig().threadPermissions[sessionFile];
    if (valid(stored)) return stored;
  }
  // Brand-new conversations follow the user's configured default.
  return valid(getConfig().defaultPermission) ? getConfig().defaultPermission : "sandbox";
}

/** Stop every local bridge. Bridges with an in-flight turn/compaction are
 * aborted and given a bounded moment to settle first so their session files
 * don't end on a dangling tool call (upstream #9124). Idle bridges stop
 * immediately, so this resolves fast on the common path. */
export function stopAllBridges(): Promise<void> {
  warmEnabled = false; // no respawns while shutting down
  const stops: Promise<void>[] = [];
  for (const h of bridges.values()) {
    try {
      stops.push(h.bridge.stopGraceful());
    } catch {
      /* ignore */
    }
  }
  bridges.clear();
  dropWarmBridge(); // idle standby — immediate kill is fine
  return Promise.all(stops).then(() => undefined);
}

export function stopRemoteHost(): void {
  activeRemoteHost?.stop();
  activeRemoteHost = null;
  activeRelayUplink?.stop();
  activeRelayUplink = null;
}

/** Start/stop/re-point the mobile relay uplink from config (S1, docs/MOBILE-DESIGN.md §5). */
function applyRelayUplinkConfig(remoteHost: RemoteHost): void {
  const cfg = getConfig();
  const wantOn = !!cfg.remoteRelayEnabled && !!cfg.remoteRelayUrl.trim();
  if (!wantOn) {
    activeRelayUplink?.stop();
    remoteHost.setRelay(null);
    return;
  }
  if (!activeRelayUplink) {
    const cryptoMaterial = remoteHost.getRelayCryptoMaterial();
    activeRelayUplink = new RelayUplink({
      relayUrl: cfg.remoteRelayUrl,
      hostId: remoteHost.getStatus().hostId,
      userDataDir: getConfigDir(),
      x25519PrivB64u: cryptoMaterial.x25519PrivB64u,
      x25519PubB64u: cryptoMaterial.x25519PubB64u,
      getHost: () => (activeRemoteHost === remoteHost ? remoteHost : null),
      onStateChange: (status) => { if (sendToRenderer) sendToRenderer("remote:relay-state", status); },
    });
    remoteHost.setRelay(activeRelayUplink);
  } else {
    activeRelayUplink.configure(cfg.remoteRelayUrl);
  }
  if (activeRelayUplink.getStatus().state === "disabled") activeRelayUplink.start();
}

export function registerIpc(getWin: () => BrowserWindow | null): void {
  let remotePublish: ((channel: string, payload: unknown) => void) | null = null;
  const send = (channel: string, payload: unknown) => {
    const w = getWin();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
    remotePublish?.(channel, payload);
  };
  sendToRenderer = send;
  systemNotifications = createSystemNotificationCenter(getWin);
  warmEnabled = true;

  // Long-task monitor: broadcast active transfers (extension installs,
  // Pi core / app update downloads) to the renderer's floating card.
  setTransferBroadcaster((list) => send("pi:transfers", list));
  ipcMain.handle("transfers:snapshot", () => getTransfers());
  ipcMain.handle("transfers:cancel", (_e, id: string) => cancelActiveTransfer(typeof id === "string" ? id : ""));

  // P1-12: sync the autopilot with persisted pool/policy, then run recovery
  // probes at most once per configured interval while auto threads are open.
  autopilot.setConfig(getConfig().autoModels?.pool ?? [], getConfig().autoModels?.policy);
  let lastAutoRecoveryTick = 0;
  setInterval(() => {
    if (!autopilot.hasActiveThreads()) return;
    const intervalMs = (getConfig().autoModels?.policy?.recoveryIntervalMin ?? DEFAULT_POLICY.recoveryIntervalMin) * 60_000;
    if (Date.now() - lastAutoRecoveryTick < intervalMs) return;
    lastAutoRecoveryTick = Date.now();
    void autopilot.recoveryTick().catch(() => {});
  }, 60_000);
  // Pi TUI terminal sessions (interactive pi in a PTY, xterm.js in renderer).
  registerTuiIpc(ipcMain, send);
  // ---- remote companion backend -----------------------------------------
  // The remote surface is deliberately built beside the existing renderer IPC
  // rather than exposing renderer channels to the network. It receives only
  // opaque project/thread ids and calls the same PiBridge registry used by the
  // desktop UI.
  const remoteIdentity = loadOrCreateIdentity(getConfigDir());
  const remoteDrafts = new Map<string, { cwd: string; projectId: string; name?: string; permission: PermissionLevel; sessionFile?: string; localId?: string }>();
  const remoteLocalToId = new Map<string, string>();
  const remoteEventHub = new RemoteEventHub();
  const remoteUiRequests = new Map<string, { threadId: string; localId: string }>();
  let remoteProjectsCache: { expiresAt: number; value: ProjectSummary[] } | null = null;
  let remoteProjectsLoad: Promise<ProjectSummary[]> | null = null;
  const invalidateRemoteProjects = () => {
    remoteProjectsCache = null;
  };

  const remoteProjectId = (cwd: string) => opaqueId(remoteIdentity.hmacSecret, `project:${resolve(cwd).toLowerCase()}`);
  const remoteThreadId = (file: string) => opaqueId(remoteIdentity.hmacSecret, `thread:${resolve(file).toLowerCase()}`);

  function remoteText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((block: any) => (block?.type === "text" ? String(block.text || "") : "")).filter(Boolean).join("\n");
  }

  const REMOTE_FILE_TOOL = /(?:^|[_-])(write|edit|create|save|export|apply[_-]?patch)(?:[_-]|$)/i;
  const REMOTE_COMMAND_TOOL = /(?:^|[_-])(bash|shell|exec|execute|command|run|python)(?:[_-]|$)/i;
  const REMOTE_OUTPUT_EXTENSIONS = "html?|pdf|csv|xlsx?|docx|pptx|json|md|txt|xml|svg|png|jpe?g|gif|webp|zip|tar|gz|mp4|webm|py|js|jsx|ts|tsx|css";
  const REMOTE_ABSOLUTE_OUTPUT_PATH = new RegExp(
    String.raw`(?:[a-zA-Z]:[\\/]|/[a-zA-Z]/)[^"'<>\r\n|?*]+?\.(?:${REMOTE_OUTPUT_EXTENSIONS})`,
    "gi",
  );
  const REMOTE_QUOTED_OUTPUT_PATH = new RegExp(
    String.raw`["']([^"'<>\r\n|?*]+?\.(?:${REMOTE_OUTPUT_EXTENSIONS}))["']`,
    "gi",
  );
  const REMOTE_SIMPLE_OUTPUT_PATH = new RegExp(
    String.raw`(?:^|[\s(])((?:\.{0,2}[\\/])?[\w\u3400-\u9fff@().+ -]+(?:[\\/][\w\u3400-\u9fff@().+ -]+)*\.(?:${REMOTE_OUTPUT_EXTENSIONS}))(?=$|[\s,.;:!?])`,
    "gi",
  );

  function remoteCleanPath(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const cleaned = value.trim().replace(/^["']|["']$/g, "");
    return cleaned || null;
  }

  function remotePathFromArgs(args: unknown): string | null {
    if (typeof args === "string") {
      try {
        return remotePathFromArgs(JSON.parse(args));
      } catch {
        return null;
      }
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) return null;
    const record = args as Record<string, unknown>;
    for (const key of ["path", "filePath", "file_path", "filename", "file"]) {
      const path = remoteCleanPath(record[key]);
      if (path) return path;
    }
    return null;
  }

  function remoteToolName(value: unknown): string {
    return String(value || "")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase();
  }

  function remoteIsFileTool(value: unknown): boolean {
    return REMOTE_FILE_TOOL.test(remoteToolName(value));
  }

  function remoteIsCommandTool(value: unknown): boolean {
    return REMOTE_COMMAND_TOOL.test(remoteToolName(value));
  }

  function remoteRelativeArtifactPath(rawPath: string, cwd: string): string | null {
    const root = resolve(cwd);
    const absolute = /^[a-zA-Z]:[\\/]/.test(rawPath) || rawPath.startsWith("\\\\") || isAbsolute(rawPath)
      ? resolve(rawPath)
      : resolve(root, rawPath);
    const relativePath = relative(root, absolute);
    if (!relativePath || isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) return null;
    const normalized = relativePath.replace(/\\/g, "/");
    if (!normalized || normalized.length > 1_000 || normalized.split("/").includes("..")) return null;
    if (!existsSync(absolute)) return null;
    return normalized;
  }

  function remoteArtifactFromPath(rawPath: string, cwd: string, action: RemoteFileArtifact["action"]): RemoteFileArtifact | null {
    const path = remoteRelativeArtifactPath(rawPath, cwd);
    if (!path) return null;
    const name = basename(path);
    return {
      name: name.slice(0, 260),
      path,
      ext: extname(name).toLowerCase().slice(0, 12),
      action,
    };
  }

  function remoteOutputPathsFromText(text: string): string[] {
    const paths: string[] = [];
    REMOTE_ABSOLUTE_OUTPUT_PATH.lastIndex = 0;
    REMOTE_QUOTED_OUTPUT_PATH.lastIndex = 0;
    REMOTE_SIMPLE_OUTPUT_PATH.lastIndex = 0;
    for (const match of text.matchAll(REMOTE_ABSOLUTE_OUTPUT_PATH)) paths.push(match[0]);
    for (const match of text.matchAll(REMOTE_QUOTED_OUTPUT_PATH)) paths.push(match[1]);
    for (const match of text.matchAll(REMOTE_SIMPLE_OUTPUT_PATH)) paths.push(match[1]);
    return paths;
  }

  function remoteArtifactsByMessage(messages: any[], cwd: string): Map<number, RemoteFileArtifact[]> {
    const toolCalls = new Map<string, { name: string; args: unknown }>();
    const toolResults = new Map<string, { text: string; isError: boolean }>();
    for (const message of messages || []) {
      if (message?.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
          toolCalls.set(block.id, { name: String(block.name || ""), args: block.arguments });
        }
      }
      if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
        toolResults.set(message.toolCallId, {
          text: remoteText(message.content),
          isError: !!message.isError,
        });
      }
    }

    const result = new Map<number, RemoteFileArtifact[]>();
    const round = new Map<string, RemoteFileArtifact>();
    let lastAssistantIndex = -1;
    // A tool round can contain several assistant messages: thinking, one or
    // more tool calls, and finally the user-facing answer. Keep the output on
    // that final visible answer so mobile renders it directly after the text.
    let lastReplyIndex = -1;
    const addToRound = (rawPath: string, action: RemoteFileArtifact["action"]) => {
      const artifact = remoteArtifactFromPath(rawPath, cwd, action);
      if (!artifact) return;
      const key = artifact.path.toLowerCase();
      const previous = round.get(key);
      round.set(key, previous
        ? { ...artifact, action: previous.action === "created" ? "created" : artifact.action }
        : artifact);
    };
    const flushRound = () => {
      const targetIndex = lastReplyIndex >= 0 ? lastReplyIndex : lastAssistantIndex;
      if (targetIndex < 0 || round.size === 0) return;
      result.set(targetIndex, [...round.values()]);
      round.clear();
    };

    for (let index = 0; index < (messages || []).length; index += 1) {
      const message = messages[index];
      if (message?.role === "user") {
        flushRound();
        lastAssistantIndex = -1;
        lastReplyIndex = -1;
        continue;
      }
      if (message?.role !== "assistant") continue;
      lastAssistantIndex = index;
      const hasToolCall = Array.isArray(message.content) && message.content.some((block: any) => block?.type === "toolCall");
      if (remoteText(message.content).trim() && !hasToolCall) lastReplyIndex = index;
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
        const call = toolCalls.get(block.id);
        const toolResult = toolResults.get(block.id);
        if (!call || toolResult?.isError) continue;
        const toolName = remoteToolName(call.name);
        if (remoteIsFileTool(toolName)) {
          // Some Pi versions expose the arguments on the collected call and
          // others only retain them on the content block. Accept both forms.
          const rawPath = remotePathFromArgs(call.args) || remotePathFromArgs(block.arguments);
          if (rawPath) addToRound(rawPath, /edit|patch|replace|update/i.test(toolName) ? "updated" : "created");
        }
        if (remoteIsCommandTool(toolName) && toolResult?.text) {
          for (const rawPath of remoteOutputPathsFromText(toolResult.text)) addToRound(rawPath, "created");
        }
      }
    }
    flushRound();
    return result;
  }

  function remoteSafeString(value: string): string {
    return value
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|private|var|tmp|workspace)\/)[^\s"'<>`]*/gi, "[path]")
      .slice(0, 100_000);
  }

  function modelArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object" && Array.isArray((value as any).models)) {
      return (value as any).models;
    }
    return [];
  }

  function remoteModelOptions(value: unknown): RemoteModelOption[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const options: RemoteModelOption[] = [];
    for (const item of value.slice(0, 200)) {
      if (!item || typeof item !== "object") continue;
      const provider = String((item as any).provider || "").trim().slice(0, 160);
      const id = String((item as any).id || "").trim().slice(0, 240);
      if (!provider || !id) continue;
      const key = `${provider}\u0000${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const option: RemoteModelOption = { provider, id };
      if (typeof (item as any).name === "string" && (item as any).name.trim()) {
        option.name = remoteSafeString((item as any).name.trim()).slice(0, 180);
      }
      if (typeof (item as any).reasoning === "boolean") option.reasoning = (item as any).reasoning;
      options.push(option);
    }
    return options;
  }

  function configuredRemoteModelOptions(): RemoteModelOption[] {
    try {
      const configured = readModelsFile();
      const entries = Object.entries(configured.providers || {}).flatMap(([provider, definition]) =>
        (definition.models || []).map((model: any) => ({ ...model, provider })),
      );
      return remoteModelOptions(entries);
    } catch {
      return [];
    }
  }

  function remoteSkills(value: unknown, cwd: string): RemoteSkill[] {
    const skills: RemoteSkill[] = [];
    const seen = new Set<string>();
    const add = (rawName: unknown, description?: unknown) => {
      const raw = String(rawName || "").trim().replace(/^\/+/, "");
      const withoutPrefix = raw.replace(/^skill:/i, "");
      // Slash invocations are a single safe token. Never forward a path,
      // shell fragment, or arbitrary command text to the phone.
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(withoutPrefix)) return;
      const command = `skill:${withoutPrefix}`;
      if (seen.has(command)) return;
      seen.add(command);
      const skill: RemoteSkill = { name: withoutPrefix, command };
      if (typeof description === "string" && description.trim()) {
        skill.description = remoteSafeString(description.trim()).slice(0, 600);
      }
      skills.push(skill);
    };

    if (Array.isArray(value)) {
      for (const item of value.slice(0, 300)) {
        if (!item || typeof item !== "object" || (item as any).source !== "skill") continue;
        add((item as any).name, (item as any).description);
      }
    }
    // Keep the list useful even when an older Pi RPC omits skill commands.
    for (const skill of listSkills(cwd).slice(0, 300)) {
      if (skill.enabled) add(skill.name, skill.description);
    }
    return skills.slice(0, 200);
  }

  // File mtime values on Windows can contain fractional milliseconds. The
  // versioned remote protocol exposes timestamps as integer milliseconds so
  // Kotlin Long decoders and other strict clients receive stable values.
  function remoteTimestamp(value: unknown): number {
    const timestamp = typeof value === "number" ? value : Number(value);
    return Number.isFinite(timestamp) ? Math.trunc(timestamp) : 0;
  }

  function remoteSafeEventValue(value: unknown, depth = 0): unknown {
    if (depth > 4 || value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "string") return remoteSafeString(value);
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => remoteSafeEventValue(item, depth + 1));
    if (!value || typeof value !== "object") return undefined;
    const blocked = /(?:^|)(?:cwd|path|file|absolute|command|args|arguments|env|secret|token|authorization|credential|input)$/i;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      if (blocked.test(key)) continue;
      const safe = remoteSafeEventValue(item, depth + 1);
      if (safe !== undefined) output[key] = safe;
    }
    return output;
  }

  function remoteUiRequest(request: any): Record<string, unknown> | null {
    const method = typeof request?.method === "string" ? request.method : "";
    // These are fire-and-forget renderer UI updates, not remote approval
    // prompts. Forwarding setStatus/setWidget as a dialog makes the Android
    // client show an empty modal titled "setStatus" and blocks the thread.
    // The remote client currently supports only actionable responses.
    if (!(method === "confirm" || method === "select" || method === "input")) return null;
    // diff：§4.5 write/edit 审批的 unified diff（approval-diff.ts 附加）。
    const allowed = ["id", "method", "title", "message", "options", "placeholder", "prefill", "notifyType", "timeout", "diff"];
    const result: Record<string, unknown> = {};
    for (const key of allowed) {
      if (request[key] === undefined) continue;
      result[key] = remoteSafeEventValue(request[key]);
    }
    return result;
  }

  function remoteMessages(messages: any[], cwd: string): RemoteMessage[] {
    // Keep the initial history response well below the SCTP data-channel
    // message budget. `text` remains available for previews and compatibility,
    // while text blocks preserve the actual thinking/tool/reply order in the
    // mobile renderer.
    let imageBudget = 400_000;
    const source = (messages || []).slice(-80);
    const artifactsByMessage = remoteArtifactsByMessage(source, cwd);
    type RemoteBlock = NonNullable<RemoteMessage["blocks"]>[number];
    const toolResults = new Map<string, { text: string; isError: boolean }>();
    const toolCallIds = new Set<string>();
    for (const message of source) {
      if (message?.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === "toolCall" && typeof block.id === "string") toolCallIds.add(block.id);
        }
      }
      if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
        toolResults.set(message.toolCallId, {
          text: remoteText(message.content).slice(0, 12_000),
          isError: !!message.isError,
        });
      }
    }

    const blocksFor = (message: any): RemoteBlock[] => {
      if (typeof message?.content === "string") {
        const text = message.content.slice(0, 12_000);
        return text ? [{ type: "text", text }] : [];
      }
      if (!Array.isArray(message?.content)) return [];
      return message.content.slice(0, 24).map((block: any): RemoteBlock | null => {
        if (block?.type === "text") return { type: "text", text: String(block.text || "").slice(0, 12_000) };
        if (block?.type === "thinking") return { type: "thinking", text: String(block.thinking || "").slice(0, 12_000) };
        if (block?.type === "toolCall") {
          const result = typeof block.id === "string" ? toolResults.get(block.id) : undefined;
          return {
            type: "tool",
            name: String(block.name || "tool"),
            running: result == null,
            result: result?.text || undefined,
          };
        }
        if (block?.type === "image" && typeof block.data === "string" && block.data.length <= 400_000 && imageBudget >= block.data.length) {
          imageBudget -= block.data.length;
          const mimeType = typeof block.mimeType === "string" && /^image\/(jpeg|png|webp|gif)$/.test(block.mimeType)
            ? block.mimeType
            : "image/jpeg";
          return { type: "image", data: block.data, mimeType };
        }
        return null;
      }).filter((block: RemoteBlock | null): block is RemoteBlock => block !== null);
    };

    const textFor = (message: any): string | undefined => remoteText(message?.content).slice(0, 12_000) || undefined;
    const mergeArtifacts = (current: RemoteFileArtifact[] | undefined, next: RemoteFileArtifact[] | undefined): RemoteFileArtifact[] | undefined => {
      const merged = [...(current || [])];
      const seen = new Set(merged.map((artifact) => artifact.path.toLowerCase()));
      for (const artifact of next || []) {
        if (seen.has(artifact.path.toLowerCase())) continue;
        seen.add(artifact.path.toLowerCase());
        merged.push(artifact);
      }
      return merged.length ? merged : undefined;
    };

    const output: RemoteMessage[] = [];
    let assistantRound: RemoteMessage | null = null;
    let unmatchedToolOutputs: string[] = [];
    const flushAssistantRound = () => {
      if (!assistantRound) return;
      if (unmatchedToolOutputs.length) {
        assistantRound = {
          ...assistantRound,
          blocks: [...(assistantRound.blocks || []), ...unmatchedToolOutputs.map((result): RemoteBlock => ({
            type: "tool",
            name: "Tool output",
            running: false,
            result: result || undefined,
          }))],
        };
        unmatchedToolOutputs = [];
      }
      output.push(assistantRound);
      assistantRound = null;
    };

    const appendAssistant = (message: any, index: number) => {
      const text = textFor(message);
      const blocks = blocksFor(message);
      const artifacts = artifactsByMessage.get(index);
      if (!assistantRound) {
        assistantRound = {
          id: String(message?.id || `assistant-${index}`),
          role: "assistant",
          text,
          blocks: blocks.length ? blocks : undefined,
          artifacts: artifacts?.length ? artifacts : undefined,
          timestamp: typeof message?.timestamp === "number" ? message.timestamp : undefined,
          provider: typeof message?.provider === "string" ? message.provider : undefined,
          model: typeof message?.model === "string" ? message.model : undefined,
          stopReason: typeof message?.stopReason === "string" ? message.stopReason : undefined,
        };
        return;
      }
      assistantRound = {
        ...assistantRound,
        text: [assistantRound.text, text].filter(Boolean).join("\n\n") || undefined,
        blocks: [...(assistantRound.blocks || []), ...blocks].slice(0, 80),
        artifacts: mergeArtifacts(assistantRound.artifacts, artifacts),
        timestamp: assistantRound.timestamp ?? (typeof message?.timestamp === "number" ? message.timestamp : undefined),
        provider: assistantRound.provider || (typeof message?.provider === "string" ? message.provider : undefined),
        model: assistantRound.model || (typeof message?.model === "string" ? message.model : undefined),
        stopReason: typeof message?.stopReason === "string" ? message.stopReason : assistantRound.stopReason,
      };
    };

    source.forEach((message: any, index) => {
      if (message?.role === "assistant") {
        appendAssistant(message, index);
        return;
      }
      if (message?.role === "toolResult") {
        // Tool results belonging to a known call are rendered inside that
        // assistant round by blocksFor(). Keep an unmatched result visible
        // without creating a second avatar for the same round.
        const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
        if (!id || !toolCallIds.has(id)) {
          const result = remoteText(message.content).slice(0, 12_000);
          if (assistantRound) {
            unmatchedToolOutputs.push(result);
          } else if (result) {
            output.push({ id: String(message?.id || `tool-${index}`), role: "tool", text: result });
          }
        }
        return;
      }

      flushAssistantRound();
      const role = message?.role === "user" || message?.role === "system" ? message.role : "system";
      const blocks = blocksFor(message);
      const artifacts = artifactsByMessage.get(index);
      output.push({
        id: String(message?.id || `${role}-${index}`),
        role,
        text: textFor(message),
        blocks: blocks.length ? blocks : undefined,
        artifacts: artifacts?.length ? artifacts : undefined,
        timestamp: typeof message?.timestamp === "number" ? message.timestamp : undefined,
        provider: typeof message?.provider === "string" ? message.provider : undefined,
        model: typeof message?.model === "string" ? message.model : undefined,
        stopReason: typeof message?.stopReason === "string" ? message.stopReason : undefined,
      });
    });
    flushAssistantRound();
    return output;
  }

  async function remoteVisibleProjects(): Promise<ProjectSummary[]> {
    const now = Date.now();
    if (remoteProjectsCache && remoteProjectsCache.expiresAt > now) return remoteProjectsCache.value;
    if (remoteProjectsLoad) return remoteProjectsLoad;
    remoteProjectsLoad = (async () => {
      const scanned = await scanProjects();
      const pinned = getConfig().pinnedProjects || [];
      const archived = new Set((getConfig().archivedProjects || []).map((cwd) => cwd.toLowerCase()));
      const archivedThreads = new Set((getConfig().archivedThreads || []).map((thread) => thread.file.toLowerCase()));
      const visible = scanned
        .filter((project) => !archived.has(project.cwd.toLowerCase()))
        .map((project) => ({ ...project, threads: project.threads.filter((thread) => !archivedThreads.has(thread.file.toLowerCase())) }));
      const byCwd = new Map(visible.map((project) => [project.cwd, project]));
      for (const cwd of pinned) {
        if (archived.has(cwd.toLowerCase()) || byCwd.has(cwd)) continue;
        visible.push({ cwd, name: basename(cwd) || cwd, threads: [] });
      }
      visible.sort((a, b) => (b.threads[0]?.updatedAt || 0) - (a.threads[0]?.updatedAt || 0));
      // The projects screen already fetched this index. Keep it warm while
      // the user moves between threads; writes explicitly invalidate it.
      remoteProjectsCache = { expiresAt: Date.now() + 30_000, value: visible };
      return visible;
    })();
    try {
      return await remoteProjectsLoad;
    } finally {
      remoteProjectsLoad = null;
    }
  }

  async function remoteProject(projectId: string): Promise<ProjectSummary> {
    const project = (await remoteVisibleProjects()).find((candidate) => remoteProjectId(candidate.cwd) === projectId);
    if (!project) throw new RemoteProtocolError("NOT_FOUND", "Project not found");
    return project;
  }

  async function remoteThread(threadId: string): Promise<{ id: string; projectId: string; cwd: string; sessionFile?: string; name?: string; permission?: PermissionLevel; localId?: string }> {
    const draft = remoteDrafts.get(threadId);
    if (draft) return { id: threadId, projectId: draft.projectId, cwd: draft.cwd, sessionFile: draft.sessionFile, name: draft.name, permission: draft.permission, localId: draft.localId };
    for (const project of await remoteVisibleProjects()) {
      for (const thread of project.threads) {
        if (remoteThreadId(thread.file) === threadId) {
          remoteLocalToId.set(thread.file, threadId);
          return {
            id: threadId,
            projectId: remoteProjectId(project.cwd),
            cwd: project.cwd,
            sessionFile: thread.file,
            permission: resolvePermission(thread.file, undefined),
            localId: thread.file,
          };
        }
      }
    }
    throw new RemoteProtocolError("NOT_FOUND", "Thread not found");
  }

  function remoteDraftIdForSessionFile(file: string): string | undefined {
    const normalized = resolve(file).toLowerCase();
    for (const [id, draft] of remoteDrafts) {
      if (draft.sessionFile && resolve(draft.sessionFile).toLowerCase() === normalized) return id;
    }
    return undefined;
  }

  function remoteState(isStreaming: boolean, hasMessages: boolean, error?: string): RemoteThreadState {
    if (error) return "error";
    if (isStreaming) return "running";
    return hasMessages ? "idle" : "draft";
  }

  // The remote wire protocol only carries the two original levels; map newer
  // local modes down to the safe side so mixed-version pairs stay compatible.
  const toRemotePermission = (level: PermissionLevel): RemotePermission => (level === "full" ? "full" : "sandbox");

  async function remoteSnapshot(threadId: string, options: { live?: boolean } = {}): Promise<RemoteThreadSnapshot> {
    const ref = await remoteThread(threadId);
    const configuredModels = configuredRemoteModelOptions();
    const permission = toRemotePermission(ref.sessionFile ? resolvePermission(ref.sessionFile, ref.permission) : (ref.permission || "sandbox"));
    let live = options.live && ref.localId ? bridges.get(ref.localId) : undefined;
    if (options.live && !live) {
      try {
        live = await ensureRemoteBridge(ref);
      } catch {
        live = undefined;
      }
    }
    if (!ref.sessionFile && !live) {
      return {
        id: threadId,
        projectId: ref.projectId,
        title: ref.name || "New thread",
        preview: "",
        updatedAt: Date.now(),
        messageCount: 0,
        state: "draft",
        permission,
        cwdName: basename(ref.cwd) || ref.cwd,
        model: null,
        availableModels: configuredModels,
        skills: [],
        thinkingLevel: "off",
        messages: [],
        nextSeq: 0,
      };
    }
    if (live) {
      const gathered: any = await gatherThread(live.bridge, live.getId(), live.permission);
      const messages = remoteMessages(gathered.messages, ref.cwd);
      return {
        id: threadId,
        projectId: ref.projectId,
        title: gathered.sessionName || messages.find((message) => message.role === "user")?.text?.slice(0, 80) || "Thread",
        preview: messages.find((message) => message.role === "user")?.text?.slice(0, 160) || "",
        updatedAt: Date.now(),
        messageCount: messages.filter((message) => message.role === "user" || message.role === "assistant").length,
        state: remoteState(!!gathered.isStreaming, messages.length > 0),
        permission: toRemotePermission(live.permission),
        cwdName: basename(ref.cwd) || ref.cwd,
        model: gathered.model || null,
        availableModels: remoteModelOptions([...modelArray(gathered.models), ...configuredModels]),
        skills: remoteSkills(gathered.commands, ref.cwd),
        thinkingLevel: gathered.thinkingLevel || "off",
        messages,
        nextSeq: 0,
      };
    }
    if (!ref.sessionFile) throw new RemoteProtocolError("NOT_FOUND", "Thread history is not available");
    const history = await readThreadHistory(ref.sessionFile);
    const messages = remoteMessages(history.messages, ref.cwd);
    return {
      id: threadId,
      projectId: ref.projectId,
      title: history.sessionName || messages.find((message) => message.role === "user")?.text?.slice(0, 80) || "Thread",
      preview: messages.find((message) => message.role === "user")?.text?.slice(0, 160) || "",
      updatedAt: Date.now(),
      messageCount: messages.filter((message) => message.role === "user" || message.role === "assistant").length,
      state: remoteState(false, messages.length > 0),
      permission,
      cwdName: basename(ref.cwd) || ref.cwd,
      model: history.model,
      availableModels: configuredModels,
      skills: [],
      thinkingLevel: history.thinkingLevel || "off",
      messages,
      nextSeq: 0,
    };
  }

  function assertRemotePath(cwd: string, relativePath: string): string {
    if (!relativePath || relativePath.startsWith("/") || relativePath.startsWith("\\") || relativePath.split(/[\\/]/).includes("..")) {
      throw new RemoteProtocolError("FORBIDDEN", "Only project-relative paths are allowed");
    }
    const root = realpathSync(resolve(cwd));
    const target = resolve(root, relativePath);
    let existingParent = target;
    while (!existsSync(existingParent) && existingParent !== root) existingParent = dirname(existingParent);
    const realParent = realpathSync(existingParent);
    if (realParent !== root && !realParent.startsWith(root + sep)) throw new RemoteProtocolError("FORBIDDEN", "Path escapes project root");
    const realTarget = existsSync(target) ? realpathSync(target) : target;
    if (realTarget !== root && !realTarget.startsWith(root + sep)) throw new RemoteProtocolError("FORBIDDEN", "Path escapes project root");
    return target;
  }

  function assertRemotePreviewName(relativePath: string): void {
    const lower = relativePath.toLowerCase();
    if (/(^|[\\/])(?:\.env|credentials|secrets?|id_rsa|id_ed25519)(?:\.|$)/i.test(lower)) {
      throw new RemoteProtocolError("FORBIDDEN", "Sensitive files are not available remotely");
    }
  }

  /** 权限变更推给已配对设备（PWA 头部实时同步）。kind 是开放字符串，旧客户端忽略未知 kind。 */
  const publishRemotePermissionChanged = (sessionFile: string | undefined, level: PermissionLevel) => {
    if (!sessionFile) return;
    const threadId = remoteLocalToId.get(sessionFile) || (sessionFile.includes("\\") || sessionFile.includes("/") ? remoteThreadId(sessionFile) : "");
    if (!threadId) return; // draft / 未知会话——没有稳定 id 可通知
    remoteEventHub.publish(threadId, { kind: "permission_changed", data: { permission: toRemotePermission(level) } });
  };

  async function ensureRemoteBridge(ref: { id: string; cwd: string; sessionFile?: string; name?: string; permission?: PermissionLevel; localId?: string }): Promise<BridgeHandle> {
    const permission = ref.sessionFile ? resolvePermission(ref.sessionFile, ref.permission) : (ref.permission || "sandbox");
    const existingId = ref.localId || ref.sessionFile;
    if (existingId && bridges.has(existingId)) {
      const existing = bridges.get(existingId)!;
      if (existing.permission !== permission) {
        existing.permission = permission;
        writeGateMode(existing.gateModeFile, permission);
        publishRemotePermissionChanged(ref.sessionFile, permission);
      }
      return existing;
    }
    const handle = createHandle(ref.cwd, ref.sessionFile, ref.name, permission, send);
    const localId = handle.getId();
    bridges.set(localId, handle);
    remoteLocalToId.set(localId, ref.id);
    if (ref.sessionFile) remoteLocalToId.set(ref.sessionFile, ref.id);
    try {
      await handle.bridge.start();
    } catch (error) {
      if (bridges.get(localId) === handle) bridges.delete(localId);
      remoteLocalToId.delete(localId);
      if (ref.sessionFile) remoteLocalToId.delete(ref.sessionFile);
      removeGateModeFile(handle.gateModeFile);
      handle.bridge.stop();
      throw error;
    }
    if (ref.sessionFile) {
      ref.localId = handle.getId();
    } else {
      const draft = remoteDrafts.get(ref.id);
      if (draft) draft.localId = handle.getId();
    }
    return handle;
  }

  const projectService = new ProjectService(
    async (): Promise<RemoteProject[]> => {
      const projects = await remoteVisibleProjects();
      return projects.map((project) => ({
        id: remoteProjectId(project.cwd),
        name: project.name,
        threadCount: project.threads.length,
        updatedAt: remoteTimestamp(project.threads[0]?.updatedAt),
      }));
    },
    async (projectId: string) => remoteProject(projectId),
    async (projectId: string) => {
      const project = await remoteProject(projectId);
      return Promise.all(project.threads.map(async (thread) => {
        // Keep the id returned by thread.create stable after its in-memory
        // draft is promoted to a real session file.
        let state: RemoteThreadState = thread.messageCount === 0 ? "draft" : "idle";
        const live = bridges.get(thread.file);
        if (live) {
          try {
            const liveState: any = await live.bridge.getState();
            if (liveState?.isStreaming) state = "running";
          } catch {
            // A thread can finish or close while the list is being read; the
            // persisted summary remains a valid idle/draft fallback.
          }
        }
        return {
          id: remoteDraftIdForSessionFile(thread.file) || remoteThreadId(thread.file),
          projectId,
          title: thread.title,
          preview: thread.preview,
          updatedAt: remoteTimestamp(thread.updatedAt),
          messageCount: thread.messageCount,
          state,
          permission: resolvePermission(thread.file, undefined),
        };
      }));
    },
  );

  const threadService = new ThreadService(
    (threadId) => remoteSnapshot(threadId),
    async (projectId, name, permission = "sandbox") => {
      const project = await remoteProject(projectId);
      const id = `draft-${randomUUID()}`;
      const draft: { cwd: string; projectId: string; name?: string; permission: PermissionLevel; sessionFile?: string; localId?: string } = {
        cwd: project.cwd,
        projectId,
        name,
        permission,
      };
      remoteDrafts.set(id, draft);
      try {
        // A remote-created thread must be a real session immediately. The
        // desktop sidebar is backed by scanProjects(), which only sees Pi's
        // persisted JSONL sessions; leaving this as an in-memory draft made
        // the thread invisible until the first prompt was sent.
        const bridge = await ensureRemoteBridge({ id, ...draft });
        let state: any = await bridge.bridge.getState();
        if (!state?.sessionFile) {
          await bridge.bridge.newSession();
          state = await bridge.bridge.getState();
        }
        if (!state?.sessionFile) throw new Error("Pi did not create a session for the new thread");

        const previousLocalId = bridge.getId();
        draft.sessionFile = state.sessionFile;
        draft.localId = state.sessionFile;
        remoteLocalToId.delete(previousLocalId);
        remoteLocalToId.set(state.sessionFile, id);
        bridge.setId(state.sessionFile);
        const perms = getConfig().threadPermissions;
        if (perms[state.sessionFile] !== permission) {
          updateConfig({ threadPermissions: { ...perms, [state.sessionFile]: permission } });
        }
        invalidateRemoteProjects();
        // The renderer's project index is disk-backed too. Notify it as soon
        // as the session file exists so an already-open sidebar updates.
        send("pi:projects-changed", { cwd: project.cwd, sessionFile: state.sessionFile });
        return remoteSnapshot(id, { live: true });
      } catch (error) {
        remoteDrafts.delete(id);
        const localId = draft.localId;
        const handle = localId ? bridges.get(localId) : undefined;
        if (localId && handle) {
          bridges.delete(localId);
          remoteLocalToId.delete(localId);
          removeGateModeFile(handle.gateModeFile);
          handle.bridge.stop();
        }
        throw error;
      }
    },
    async (threadId, text, images) => {
      const ref = await remoteThread(threadId);
      const bridge = await ensureRemoteBridge(ref);
      await bridge.bridge.prompt(text, images);
      const state: any = await bridge.bridge.getState();
      if (state?.sessionFile) {
        const draft = remoteDrafts.get(threadId);
        if (draft) {
          draft.sessionFile = state.sessionFile;
          draft.localId = state.sessionFile;
        }
        remoteLocalToId.set(state.sessionFile, threadId);
        bridge.setId(state.sessionFile);
        const perms = getConfig().threadPermissions;
        if (perms[state.sessionFile] !== bridge.permission) {
          updateConfig({ threadPermissions: { ...perms, [state.sessionFile]: bridge.permission } });
        }
        if (!ref.sessionFile) send("pi:projects-changed", { cwd: ref.cwd, sessionFile: state.sessionFile });
      }
      invalidateRemoteProjects();
      return { ok: true };
    },
    async (threadId, text, images) => {
      const bridge = await ensureRemoteBridge(await remoteThread(threadId));
      await bridge.bridge.steer(text, images);
      return { ok: true };
    },
    async (threadId, text, images) => {
      const bridge = await ensureRemoteBridge(await remoteThread(threadId));
      await bridge.bridge.followUp(text, images);
      return { ok: true };
    },
    async (threadId) => {
      const ref = await remoteThread(threadId);
      const bridge = [ref.localId, ref.sessionFile]
        .filter((id): id is string => Boolean(id))
        .map((id) => bridges.get(id))
        .find(Boolean);
      if (!bridge) return { ok: true, alreadyStopped: true };
      await bridge.bridge.abort();
      return { ok: true };
    },
  );

  const filePreviewService = new FilePreviewService(
    async (projectId, relativePath) => {
      const project = await remoteProject(projectId);
      // Validate before listing so a path escape is rejected even though listDir re-checks.
      if (relativePath) assertRemotePath(project.cwd, relativePath);
      const rel = relativePath || undefined;
      return listDir(project.cwd, rel)
        .filter((node) => !/(^|[\\/])(?:\.env|credentials|secrets?|id_rsa|id_ed25519)(?:\.|$)/i.test(node.rel))
        .map((node) => ({ name: node.name, rel: node.rel, isDir: node.isDir, ext: node.ext, size: node.size }));
    },
    async (projectId, relativePath) => {
      const project = await remoteProject(projectId);
      assertRemotePreviewName(relativePath);
      const target = assertRemotePath(project.cwd, relativePath);
      const preview = readRemotePreview(target);
      if (!["text", "markdown", "html", "image", "xlsx"].includes(preview.kind)) throw new RemoteProtocolError("UNSUPPORTED", "Only text, Markdown, HTML, image and Excel previews are available remotely");
      const maxRemoteTextChars = preview.kind === "xlsx" ? 1_200_000 : 524_288;
      if (preview.text && preview.text.length > maxRemoteTextChars) {
        if (preview.kind === "xlsx") throw new RemoteProtocolError("PAYLOAD_TOO_LARGE", "Spreadsheet preview is too large");
        preview.text = preview.text.slice(0, maxRemoteTextChars);
      }
      if (preview.base64 && preview.base64.length > 2_800_000) throw new RemoteProtocolError("PAYLOAD_TOO_LARGE", "Preview is too large");
      if (preview.message) preview.message = remoteSafeString(preview.message);
      delete preview.previewUrl;
      return preview;
    },
  );

  const remoteBackend: RemoteBackend = {
    listProjects: () => projectService.list(),
    listThreads: (projectId) => projectService.listThreads(projectId),
    getThread: (threadId, options) => remoteSnapshot(threadId, options),
    createThread: (projectId, name, permission) => threadService.create(projectId, name, permission),
    setPermission: async (threadId, permission) => {
      const ref = await remoteThread(threadId);
      const draft = remoteDrafts.get(threadId);
      if (draft) draft.permission = permission;
      if (ref.sessionFile) {
        const perms = getConfig().threadPermissions;
        updateConfig({ threadPermissions: { ...perms, [ref.sessionFile]: permission } });
      }
      const existingId = ref.localId || ref.sessionFile;
      const handle = existingId ? bridges.get(existingId) : undefined;
      if (handle) {
        handle.permission = permission;
        writeGateMode(handle.gateModeFile, permission);
      }
      publishRemotePermissionChanged(ref.sessionFile, permission);
      return remoteSnapshot(threadId, { live: true });
    },
    setModel: async (threadId, provider, modelId) => {
      const ref = await remoteThread(threadId);
      const handle = await ensureRemoteBridge(ref);
      let available: any = await handle.bridge.getAvailableModels();
      let models = remoteModelOptions([...modelArray(available), ...configuredRemoteModelOptions()]);
      if (!models.some((model) => model.provider === provider && model.id === modelId)) {
        try {
          available = await handle.bridge.refreshModels();
          models = remoteModelOptions([...modelArray(available), ...configuredRemoteModelOptions()]);
        } catch {
          // The configured models fallback remains usable when the host's
          // optional refresh command is unavailable on an older Pi runtime.
        }
      }
      const allowed = models.some((model) => model.provider === provider && model.id === modelId);
      if (!allowed) throw new RemoteProtocolError("MODEL_UNAVAILABLE", "That model is not available on the MPI host");
      await handle.bridge.setModel(provider, modelId);
      return remoteSnapshot(threadId, { live: true });
    },
    prompt: (threadId, text, images) => threadService.prompt(threadId, text, images),
    steer: (threadId, text, images) => threadService.steer(threadId, text, images),
    followUp: (threadId, text, images) => threadService.followUp(threadId, text, images),
    abort: (threadId) => threadService.abort(threadId),
    fileTree: (projectId, relativePath) => filePreviewService.tree(projectId, relativePath),
    filePreview: (projectId, relativePath) => filePreviewService.preview(projectId, relativePath),
    respondUi: async (threadId, requestId, payload) => {
      const pending = remoteUiRequests.get(requestId);
      if (!pending || pending.threadId !== threadId) throw new RemoteProtocolError("NOT_FOUND", "UI request is no longer pending");
      const bridge = bridges.get(pending.localId);
      if (!bridge) throw new RemoteProtocolError("DISCONNECTED", "Thread is no longer connected");
      bridge.bridge.respondExtUi(requestId, payload);
      remoteUiRequests.delete(requestId);
      return { ok: true };
    },
    storePushSubscription: async (deviceId, subscription) => {
      // S7 WebPush：持久化 + 同步给 relay（uplink 未配置时静默 no-op）。
      activeRelayUplink?.storePushSubscription(deviceId, subscription);
      return { ok: true };
    },
    subscribeThread: (threadId, listener) => {
      return remoteEventHub.subscribe(threadId, listener);
    },
  };

  const remoteService = new RemoteService(remoteBackend);

  // ---- messaging channels (Feishu + WeChat) -----------------------------------
  // Reuses the same backend as the Android remote client: chat messages are
  // routed into one dedicated session of the bound project folder.
  // Resolves an opaque/draft thread id to its session-file UUID — the key both
  // the channel registry and the pi-side extension can compute.
  const resolveSessionUuid = async (threadId: string): Promise<string | null> => {
    try {
      const ref = await remoteThread(threadId);
      return ref.sessionFile ? threadUuidFromSessionFile(ref.sessionFile) : null;
    } catch {
      return null; // unknown/deleted thread — leave unregistered
    }
  };
  initMessaging({
    backend: remoteBackend,
    resolveProjectId: (cwd) => remoteProjectId(cwd),
    resolveSessionUuid,
    language: () => getConfig().language,
    onStateChange: (state) => send("pi:messaging", state),
  });
  initWeChatMessaging({
    backend: remoteBackend,
    resolveProjectId: (cwd) => remoteProjectId(cwd),
    resolveSessionUuid,
    language: () => getConfig().language,
    onStateChange: (state) => send("pi:messagingWechat", state),
  });

  const remoteHost = new RemoteHost({
    userDataDir: getConfigDir(),
    signalingUrl: process.env.MPI_REMOTE_SIGNALING_URL || getConfig().remoteSignalingUrl || DEFAULT_REMOTE_SIGNALING_URL,
    stunUrls: [...BUILT_IN_REMOTE_STUN_URLS],
    sendToRenderer: send,
    service: remoteService,
  });
  activeRemoteHost = remoteHost;
  remoteHost.start();
  if (getConfig().remoteSignalingEnabled) remoteHost.enableSignaling(true);
  applyRelayUplinkConfig(remoteHost);

  remotePublish = (channel, payload) => {
    if (!payload || typeof payload !== "object") return;
    const rawThreadId = typeof (payload as any).threadId === "string" ? (payload as any).threadId : "";
    const threadId = remoteLocalToId.get(rawThreadId) || (rawThreadId.includes("\\") || rawThreadId.includes("/") ? remoteThreadId(rawThreadId) : "");
    if (!threadId) return;
    let event: RemoteThreadEventPayload;
    if (channel === "pi:event") {
      const piEvent = (payload as any).event || {};
      event = { kind: String(piEvent.type || "agent.event"), data: { event: remoteSafeEventValue(piEvent) as Record<string, unknown> } };
    } else if (channel === "pi:extui") {
      const request = (payload as any).request || {};
      // §4.5：write/edit 审批能取到新旧内容时附 unified diff（best-effort，永不阻塞）。
      // 自包含 async IIFE：remotePublish 保持同步签名；审批期间 agent 挂起不会发出
      // 后续事件，故 publish 延迟一个微任务+项目扫描不影响帧序。
      void (async () => {
        if (!request.diff && typeof request.title === "string" && /^(?:Permission required|权限确认)[:：]/.test(request.title)) {
          try {
            const ref = await remoteThread(threadId);
            const diff = await buildApprovalDiff(ref.cwd, request.title);
            if (diff) request.diff = diff;
          } catch { /* best-effort */ }
        }
        const safeRequest = remoteUiRequest(request);
        if (!safeRequest) return;
        remoteUiRequests.set(String(request.id || ""), { threadId, localId: rawThreadId });
        remoteEventHub.publish(threadId, { kind: "ui.request", data: { request: safeRequest } });
        // S7 WebPush：审批通知发给所有已配对设备（relay 无订阅则 no-op）。在线
        // 设备会同时看到实时审批卡 + 系统通知——v1 接受这点冗余，换取后台/锁屏
        // 场景的可靠触达。文案按 §12.2 保持通用，不含会话内容。
        const uplink = activeRelayUplink;
        if (uplink) {
          for (const deviceId of uplink.getKnownDeviceIds()) {
            uplink.sendPush(deviceId, { kind: "approval", title: "MPI 需要批准", body: "有会话等待你的确认。", deepLink: `/thread/${threadId}` });
          }
        }
      })();
      return;
    } else if (channel === "pi:exit") {
      event = { kind: "thread.exit", data: { code: (payload as any).code, stderr: remoteSafeString(String((payload as any).stderr || "").slice(-2000)) } };
    } else if (channel === "pi:error") {
      event = { kind: "thread.error", data: { message: remoteSafeString(String((payload as any).message || "remote Pi error")) } };
    } else {
      return;
    }
    remoteEventHub.publish(threadId, event);
  };

  /** wss://host:port/ws → https://host:port（手机能直接打开的 HTTP 源）。 */
  function relayHttpOrigin(relayUrl: string): string | null {
    const trimmed = (relayUrl || "").trim();
    if (!trimmed) return null;
    try {
      const url = new URL(trimmed);
      const scheme = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
      return `${scheme}//${url.host}`;
    } catch {
      return null;
    }
  }

  ipcMain.handle("remote:getStatus", () => remoteHost.getStatus());
  ipcMain.handle("remote:getRelayStatus", () => activeRelayUplink?.getStatus() ?? { state: "disabled" as const, relayUrl: getConfig().remoteRelayUrl, lastError: null });
  ipcMain.handle("remote:createPairing", (_e, args?: { autoApprove?: boolean }) => remoteHost.createPairingTicket({ autoApprove: args?.autoApprove === true }));

  /** 手机 App 安装包信息（relay 静态托管 /download/mpi-android.json）。在主进程取：
   *  relay 是纯静态服务、不发 CORS 头，渲染层的 fetch 会被浏览器挡掉。
   *  另外把清单缓到 userData：中继/tailnet 挂掉时，面板仍能给出 GitHub 备选下载源。 */
  ipcMain.handle("remote:getPhoneApp", async () => {
    const origin = relayHttpOrigin(getConfig().remoteRelayUrl);
    const cacheFile = join(app.getPath("userData"), "mpi-android.json");
    const fromCache = (error: string) => {
      try {
        const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as Record<string, unknown>;
        const version = typeof cached.version === "string" ? cached.version : "";
        const file = typeof cached.file === "string" ? cached.file : "";
        if (!version || !file) throw new Error("cache incomplete");
        return {
          ok: true as const,
          stale: true,
          error,
          version,
          size: typeof cached.size === "number" ? cached.size : 0,
          sha256: typeof cached.sha256 === "string" ? cached.sha256 : "",
          publishedAt: typeof cached.publishedAt === "string" ? cached.publishedAt : "",
          url: origin ? `${origin}/download/${file}` : "",
          github: typeof cached.github === "string" ? cached.github : "",
        };
      } catch {
        return { ok: false as const, error };
      }
    };
    if (!origin) return fromCache("未配置中继地址");
    try {
      const res = await fetch(`${origin}/download/mpi-android.json`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return fromCache(`中继返回 ${res.status}`);
      const data = (await res.json()) as Record<string, unknown>;
      const version = typeof data.version === "string" ? data.version : "";
      const file = typeof data.file === "string" ? data.file : "";
      if (!version || !file) return fromCache("清单格式不正确");
      try {
        writeFileSync(cacheFile, JSON.stringify(data, null, 2));
      } catch { /* 缓存只是锦上添花 */ }
      return {
        ok: true as const,
        stale: false,
        error: null,
        version,
        size: typeof data.size === "number" ? data.size : 0,
        sha256: typeof data.sha256 === "string" ? data.sha256 : "",
        publishedAt: typeof data.publishedAt === "string" ? data.publishedAt : "",
        url: `${origin}/download/${file}`,
        github: typeof data.github === "string" ? data.github : "",
      };
    } catch (error) {
      return fromCache(error instanceof Error ? error.message : String(error));
    }
  });
  ipcMain.handle("remote:enableSignaling", (_e, args?: { manual?: boolean }) => {
    const manual = args?.manual === true;
    const enabled = remoteHost.enableSignaling(manual);
    if (manual) updateConfig({ remoteSignalingEnabled: enabled });
    return enabled;
  });
  ipcMain.handle("remote:disableSignaling", () => {
    remoteHost.disableSignaling();
    updateConfig({ remoteSignalingEnabled: false });
    return { ok: true };
  });
  ipcMain.handle("remote:approvePairing", (_e, connectionId: string) => remoteHost.approvePairing(connectionId));
  ipcMain.handle("remote:rejectPairing", (_e, connectionId: string) => remoteHost.rejectPairing(connectionId));
  ipcMain.handle("remote:revokeDevice", (_e, deviceId: string) => remoteHost.revokeDevice(deviceId));
  ipcMain.handle("remote:transportOpen", (_e, args: { connectionId: string; sessionId?: string }) => remoteHost.transportOpened(args.connectionId, args.sessionId));
  ipcMain.handle("remote:transportClose", (_e, args: { connectionId: string; reason?: string }) => remoteHost.transportClosed(args.connectionId, args.reason));
  ipcMain.handle("remote:transportStatus", (_e, args: { connectionId: string; state?: string; candidateType?: string; localCandidateType?: string; remoteCandidateType?: string }) => {
    remoteHost.transportStatus(args.connectionId, args);
    return { ok: true };
  });
  ipcMain.handle("remote:transportFrame", (_e, args: { connectionId: string; frame: string }) => remoteHost.handleTransportFrame(args.connectionId, args.frame));
  ipcMain.handle("remote:sendSignal", (_e, args: { connectionId: string; payload: Record<string, unknown> }) => remoteHost.sendSignal(args.connectionId, args.payload));
  ipcMain.handle("remote:getTransportConfig", () => ({ stunUrls: [...BUILT_IN_REMOTE_STUN_URLS], directOnly: true }));
  ipcMain.handle("remote:setConfig", (_e, patch: { signalingUrl?: string }) => {
    const signalingUrl = patch.signalingUrl?.trim() || DEFAULT_REMOTE_SIGNALING_URL;
    const next = updateConfig({ remoteSignalingUrl: signalingUrl });
    remoteHost.configure(next.remoteSignalingUrl || DEFAULT_REMOTE_SIGNALING_URL, [...BUILT_IN_REMOTE_STUN_URLS]);
    return { remoteSignalingUrl: next.remoteSignalingUrl };
  });


  // ---- app / config -------------------------------------------------------
  ipcMain.handle("app:getVersion", () => app.getVersion());
  // Auto-launch at system login. On Windows Electron implements this via a
  // shortcut in the Start Menu startup folder; returns the effective state.
  // In dev the shortcut target is the bare Electron binary, so both set and
  // get must carry the app directory (out/main → repo root) as args —
  // otherwise openAtLogin does not match the item that was created.
  const autoLaunchArgs = () => (app.isPackaged ? undefined : [resolve(__dirname, "../..")]);
  ipcMain.handle("app:getAutoLaunch", () => {
    const args = autoLaunchArgs();
    return (args ? app.getLoginItemSettings({ args }) : app.getLoginItemSettings()).openAtLogin;
  });
  ipcMain.handle("app:setAutoLaunch", (_e, enabled: unknown) => {
    const on = !!enabled;
    const args = autoLaunchArgs();
    app.setLoginItemSettings({ openAtLogin: on, ...(args ? { args } : {}) });
    return (args ? app.getLoginItemSettings({ args }) : app.getLoginItemSettings()).openAtLogin;
  });
  // The Feishu app secret never crosses into the renderer: it is masked here
  // and only ever written through messaging:setConfig.
  ipcMain.handle("app:getConfig", () => {
    const cfg = getConfig();
    if (cfg.feishuChannel?.appSecret) return { ...cfg, feishuChannel: { ...cfg.feishuChannel, appSecret: "" } };
    return cfg;
  });
  ipcMain.handle("app:setConfig", (_e, patch) => {
    const prevCli = getConfig().piCliPath;
    const prevProfile = (getConfig().userProfile || "").trim();
    const prevExtAutoPick = getConfig().extAutoPickModel !== false;
    // P1-12: keep the live autopilot in sync when pool/policy change.
    if (patch && typeof patch === "object" && "autoModels" in patch) {
      const am = (patch as any).autoModels;
      autopilot.setConfig(am?.pool ?? [], am?.policy);
    }
    // Channel credentials are managed exclusively by messaging:setConfig.
    let cleanPatch = patch;
    if (cleanPatch && typeof cleanPatch === "object" && "feishuChannel" in cleanPatch) {
      cleanPatch = { ...cleanPatch };
      delete (cleanPatch as Record<string, unknown>).feishuChannel;
    }
    const next = updateConfig(cleanPatch || {});
    if (patch && ("remoteSignalingUrl" in patch || "remoteStunUrls" in patch)) {
      remoteHost.configure(next.remoteSignalingUrl || DEFAULT_REMOTE_SIGNALING_URL, [...BUILT_IN_REMOTE_STUN_URLS]);
    }
    if (patch && ("remoteRelayUrl" in patch || "remoteRelayEnabled" in patch)) applyRelayUplinkConfig(remoteHost);
    if ((next.piCliPath || "") !== (prevCli || "")) {
      resetPiRuntime();
      dropWarmBridge(); // standby was booted from the old runtime
      ensureWarmBridge();
    } else if (((next.userProfile || "").trim() || "") !== prevProfile) {
      dropWarmBridge(); // standby was booted with the old profile text
      ensureWarmBridge();
    }
    // "扩展自动选模" toggle: off → restore web-search.json to its pre-MPI values;
    // on → re-sync immediately from any live thread.
    if (prevExtAutoPick && next.extAutoPickModel === false) {
      try {
        webSearchFlow().restore();
      } catch (err) {
        console.error("[web-search] restore failed:", err);
      }
    } else if (!prevExtAutoPick && next.extAutoPickModel !== false) {
      for (const h of bridges.values()) refreshWebSearchFlow(h.bridge);
    }
    return next;
  });

  // ---- backup & restore (Settings → 数据管理) ---------------------------
  const backupStamp = () => new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "");

  ipcMain.handle("backup:listSessions", () => listBackupProjects());

  ipcMain.handle("backup:exportConfig", async () => {
    const w = getWin();
    const language = getConfig().language;
    const res = await dialog.showSaveDialog(w!, {
      title: language === "zh" ? "导出应用设置" : "Export app settings",
      defaultPath: join(app.getPath("documents"), `mpi-config-backup-${backupStamp()}.json`),
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (res.canceled || !res.filePath) return null;
    try {
      writeFileSync(res.filePath, buildConfigBackup(getConfig(), app.getVersion()));
      return { ok: true, path: res.filePath };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle("backup:pickConfigImport", async () => {
    const w = getWin();
    const language = getConfig().language;
    const res = await dialog.showOpenDialog(w!, {
      title: language === "zh" ? "导入应用设置" : "Import app settings",
      properties: ["openFile"],
      filters: [
        { name: language === "zh" ? "MPI 配置备份 / JSON" : "MPI config backup / JSON", extensions: ["json"] },
      ],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const path = res.filePaths[0];
    try {
      // Read + sanitize only; the renderer confirms, then applies via
      // app:setConfig so warm-bridge / remote-host side effects run once.
      const patch = sanitizeImportedConfig(parseConfigBackup(readFileSync(path, "utf8")));
      const fields = Object.keys(patch);
      if (fields.length === 0) {
        return { ok: false, error: language === "zh" ? "备份文件里没有可识别的设置项。" : "No recognizable settings found in the backup file." };
      }
      return { ok: true, path, fields, patch };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle("backup:exportSessions", async (_e, dirNames: unknown) => {
    const w = getWin();
    const language = getConfig().language;
    const names = Array.isArray(dirNames)
      ? (dirNames.filter((n): n is string => typeof n === "string") as string[])
      : [];
    if (names.length === 0) {
      return { ok: false, error: language === "zh" ? "未选择任何项目。" : "No projects selected." };
    }
    const res = await dialog.showSaveDialog(w!, {
      title: language === "zh" ? "导出会话" : "Export sessions",
      defaultPath: join(app.getPath("documents"), `mpi-sessions-backup-${backupStamp()}.zip`),
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    if (res.canceled || !res.filePath) return null;
    try {
      const count = await exportSessionsZip(res.filePath, names, app.getVersion());
      if (count === 0) {
        return { ok: false, error: language === "zh" ? "所选项目下没有会话文件。" : "No session files found in the selected projects." };
      }
      return { ok: true, path: res.filePath, count };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle("backup:pickSessionImport", async () => {
    const w = getWin();
    const language = getConfig().language;
    const res = await dialog.showOpenDialog(w!, {
      title: language === "zh" ? "导入会话" : "Import sessions",
      properties: ["openFile"],
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const path = res.filePaths[0];
    try {
      const summary = await inspectSessionBackup(path);
      if (summary.total === 0) {
        return { ok: false, error: language === "zh" ? "压缩包里没有找到会话文件（.jsonl）。" : "No session files (.jsonl) found in the archive." };
      }
      return { ok: true, path, ...summary };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle("backup:importSessions", async (_e, args: { path?: string; policy?: "skip" | "overwrite" }) => {
    const language = getConfig().language;
    if (!args || typeof args.path !== "string") {
      return { ok: false, error: language === "zh" ? "缺少备份文件路径。" : "Missing backup file path." };
    }
    try {
      const result = await importSessionZip(args.path, args.policy === "overwrite" ? "overwrite" : "skip");
      invalidateRemoteProjects();
      send("pi:projects-changed", {});
      return { ok: true, ...result };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
  // ---- composer drafts (persisted unsent input, LRU-capped) --------------
  ipcMain.handle("drafts:getAll", () => getAllDrafts());
  ipcMain.handle("drafts:set", (_e, key: string, draft: ComposerDraft) => {
    if (!key || !draft) return;
    persistDraft(key, draft);
  });
  ipcMain.handle("drafts:delete", (_e, key: string) => deleteDraft(key));

  // ---- todos (待办任务) ----------------------------------------------------
  const notifyTodosChanged = () => {
    try {
      getWin()?.webContents.send("pi:todo-changed");
    } catch {
      /* window gone */
    }
  };
  ipcMain.handle("todo:list", () => listTodos());
  ipcMain.handle(
    "todo:add",
    (_e, args?: { cwd?: string; title?: string; note?: string; dueDate?: string | null; dueTime?: string | null }) => {
      const item = addTodo(args || {});
      if (item) notifyTodosChanged();
      return item;
    }
  );
  ipcMain.handle("todo:update", (_e, id: unknown, patch?: TodoPatch) => {
    const item = updateTodo(id, patch || {});
    if (item) notifyTodosChanged();
    return item;
  });
  ipcMain.handle("todo:toggle", (_e, id: unknown) => {
    const item = toggleTodo(id);
    if (item) notifyTodosChanged();
    return item;
  });
  ipcMain.handle("todo:delete", (_e, id: unknown) => {
    const ok = deleteTodo(id);
    if (ok) notifyTodosChanged();
    return ok;
  });
  ipcMain.handle("todo:clearCompleted", (_e, cwd?: string | null) => {
    const removed = clearCompletedTodos(cwd ?? null);
    if (removed > 0) notifyTodosChanged();
    return removed;
  });

  // Attachments: two intake paths — a native file dialog (main reads the files
  // itself, no bytes cross IPC) and renderer paste/drag-drop (ArrayBuffers).
  ipcMain.handle("todo:addFiles", (_e, todoId: unknown) => {
    const win = getWin();
    if (!win || typeof todoId !== "string") return { item: null, added: 0, skipped: [], errors: ["no window"] };
    const language = getConfig().language;
    const result = dialog.showOpenDialogSync(win, {
      title: language === "zh" ? "添加本地文件" : "Add local file",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] },
        { name: "文档", extensions: ["pdf", "txt", "md", "doc", "docx", "xls", "xlsx", "csv", "zip"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    if (!result || result.length === 0) return { item: null, added: 0, skipped: [], errors: [] };
    const inputs = [] as Array<{ name?: string; mime?: string; data: Buffer }>;
    const readErrors: string[] = [];
    for (const p of result.slice(0, 20)) {
      try {
        inputs.push({ name: basename(p), mime: mimeForName(p), data: readFileSync(p) });
      } catch (err) {
        readErrors.push(`${basename(p)}: ${String((err as Error)?.message || err)}`);
      }
    }
    const out = addAttachments(todoId, inputs);
    if (out.added > 0) notifyTodosChanged();
    return { ...out, errors: [...readErrors, ...out.errors] };
  });

  ipcMain.handle(
    "todo:addAttachments",
    (_e, todoId: unknown, files?: Array<{ name?: string; mime?: string; size?: number; data?: ArrayBuffer }>) => {
      if (!Array.isArray(files)) return { item: null, added: 0, errors: ["invalid payload"] };
      const inputs = files.slice(0, 20).map((f) => ({
        name: typeof f?.name === "string" ? f.name : undefined,
        mime: typeof f?.mime === "string" && f.mime ? f.mime : undefined,
        data: f?.data instanceof ArrayBuffer ? Buffer.from(f.data) : Buffer.alloc(0),
      }));
      const out = addAttachments(todoId, inputs);
      if (out.added > 0) notifyTodosChanged();
      return out;
    }
  );

  ipcMain.handle("todo:removeAttachment", (_e, todoId: unknown, attId: unknown) => {
    const item = removeAttachment(todoId, attId);
    if (item) notifyTodosChanged(); // file deletion always happens; metadata may be unchanged
    return item;
  });

  ipcMain.handle("todo:openAttachment", async (_e, file: unknown) => {
    const target = resolveAttachmentFile(file); // null for malformed / missing names
    if (!target) return "附件文件不存在";
    try {
      return shell.openPath(target); // empty string on success, error message otherwise
    } catch (err) {
      return String((err as Error)?.message || err);
    }
  });

  // Agent-side additions arrive as one JSON file per todo in the inbox dir
  // (mpi-todo-ext never writes todos.json). Watch + poll; ingest is idempotent.
  const todoInbox = ensureInboxDir();
  try {
    // No handle kept (same pattern as the channel-command inbox): Node keeps an
    // fs.watch watcher alive until close()/process exit; the poll is the fallback.
    watch(todoInbox, () => {
      if (ingestInbox().length > 0) notifyTodosChanged();
    });
  } catch {
    /* the poll below still covers it */
  }
  const todoInboxPoll = setInterval(() => {
    try {
      if (ingestInbox().length > 0) notifyTodosChanged();
    } catch {
      /* ignore transient fs errors */
    }
  }, 2000);
  todoInboxPoll.unref?.();

  // Channel session commands (mpi_channel_* tools): same watch + poll pattern.
  startChannelCommandInboxWatcher();

  // ---- data storage location (Settings → 数据管理) -------------------------
  // Changing a location only records intent; the actual file moves happen on
  // next launch via runPendingDataMigrations() in index.ts.
  ipcMain.handle("data-migration:status", () => getDataMigrationStatus());
  ipcMain.handle(
    "data-migration:preview",
    (_e, kind: unknown, dir: unknown) => previewMigration(kind === "todos" ? "todos" : "sessions", dir),
  );
  ipcMain.handle("data-migration:set-sessions-dir", (_e, dir: unknown) => setSessionsDir(dir));
  ipcMain.handle("data-migration:set-todos-dir", (_e, dir: unknown) => setTodosDir(dir));

  ipcMain.handle("app:resolveRuntime", async () => {
    try {
      const rt = await resolvePiRuntime(getConfig().piCliPath);
      // eslint-disable-next-line no-console
      console.log("[pi] runtime resolved ->", "node:", rt.node, "| cli:", rt.cli);
      return { ok: true, node: rt.node, cli: rt.cli };
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error("[pi] runtime resolve failed:", e?.message || String(e));
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // ---- projects / sessions ------------------------------------------------
  ipcMain.handle("app:getProjects", async (): Promise<ProjectSummary[]> => {
    const scanned = await scanProjects();
    const cfg = getConfig();
    const pinned = cfg.pinnedProjects || [];
    const pinnedThreads = cfg.pinnedThreads || [];
    const pinnedProjectSet = new Set(pinned.map((cwd) => cwd.toLowerCase()));
    const pinnedThreadSet = new Set(pinnedThreads.map((file) => file.toLowerCase()));
    const pinnedThreadRank = new Map(pinnedThreads.map((file, index) => [file.toLowerCase(), index]));
    const archived = new Set((cfg.archivedProjects || []).map((cwd) => cwd.toLowerCase()));
    const archivedThreads = new Set((cfg.archivedThreads || []).map((thread) => thread.file.toLowerCase()));
    const visibleScanned = scanned
      .filter((project) => !archived.has(project.cwd.toLowerCase()))
      .map((project) => {
        const threads = project.threads
          .filter((thread) => !archivedThreads.has(thread.file.toLowerCase()))
          .map((thread) => ({
            ...thread,
            pinned: pinnedThreadSet.has(thread.file.toLowerCase()),
          }))
          .sort((a, b) => {
            const aPinned = a.pinned ? 0 : 1;
            const bPinned = b.pinned ? 0 : 1;
            if (aPinned !== bPinned) return aPinned - bPinned;
            if (a.pinned && b.pinned) {
              return (
                (pinnedThreadRank.get(a.file.toLowerCase()) ?? Number.MAX_SAFE_INTEGER) -
                (pinnedThreadRank.get(b.file.toLowerCase()) ?? Number.MAX_SAFE_INTEGER)
              );
            }
            return b.updatedAt - a.updatedAt;
          });
        return {
          ...project,
          pinned: pinnedProjectSet.has(project.cwd.toLowerCase()),
          openedAt: openedProjects.get(project.cwd.toLowerCase())?.openedAt,
          threads,
        };
      });
    const visibleOpened = Array.from(openedProjects.values())
      .filter((project) => !archived.has(project.cwd.toLowerCase()))
      .filter((project) => !visibleScanned.some((scannedProject) => sameDir(scannedProject.cwd, project.cwd)))
      .filter((project) => !pinnedProjectSet.has(project.cwd.toLowerCase()))
      .map((project) => ({ ...project, pinned: false, threads: [] }));
    const visiblePinned = pinned.filter((cwd) => !archived.has(cwd.toLowerCase()));
    const byCwd = new Map(visibleScanned.map((p) => [p.cwd.toLowerCase(), p]));
    const result: ProjectSummary[] = [];
    for (const cwd of visiblePinned) {
      const existing = byCwd.get(cwd.toLowerCase());
      if (existing) result.push(existing);
      else result.push({ cwd, name: cwd.split(/[\\/]/).filter(Boolean).pop() || cwd, threads: [], pinned: true });
    }
    const unpinned = [
      ...visibleScanned.filter((project) => !pinnedProjectSet.has(project.cwd.toLowerCase())),
      ...visibleOpened,
    ];
    const openedRank = new Map(openedProjectOrder.map((cwd, index) => [cwd, index]));
    unpinned.sort((a, b) => {
      const aRank = openedRank.get(a.cwd.toLowerCase());
      const bRank = openedRank.get(b.cwd.toLowerCase());
      if (aRank !== undefined || bRank !== undefined) {
        if (aRank === undefined) return 1;
        if (bRank === undefined) return -1;
        return aRank - bRank;
      }
      return 0;
    });
    result.push(...unpinned);
    return result;
  });

  ipcMain.handle("app:searchThreads", async (_e, query: string, includeArchived?: boolean): Promise<ThreadSearchHit[]> => {
    const cfg = getConfig();
    const archivedProjects = new Set((cfg.archivedProjects || []).map((cwd) => cwd.toLowerCase()));
    const archivedThreads = new Set((cfg.archivedThreads || []).map((thread) => thread.file.toLowerCase()));
    if (!includeArchived) {
      return (await searchThreads(query)).filter(
        (hit) => !archivedProjects.has(hit.cwd.toLowerCase()) && !archivedThreads.has(hit.file.toLowerCase()),
      );
    }
    // Include archived sessions: tag them so the UI can offer one-click restore.
    const hits = await searchThreads(query);
    for (const hit of hits) {
      if (archivedProjects.has(hit.cwd.toLowerCase())) hit.state = "project-archived";
      else if (archivedThreads.has(hit.file.toLowerCase())) hit.state = "thread-archived";
    }
    const trashHits = await searchTrashThreads(query);
    return [...hits, ...trashHits]
      .sort((a, b) => b.matchCount - a.matchCount || b.updatedAt - a.updatedAt)
      .slice(0, 50);
  });

  ipcMain.handle("app:getTotalUsage", () => getTotalUsage());

  ipcMain.handle("app:openProject", async (_e, absPath: string) => {
    if (!absPath || !existsSync(absPath) || !statSync(absPath).isDirectory()) {
      throw new Error("Not a directory: " + absPath);
    }
    const name = absPath.split(/[\\/]/).filter(Boolean).pop() || absPath;
    const key = absPath.toLowerCase();
    lastOpenCwd = absPath;
    openedProjects.set(key, { cwd: absPath, name, threads: [], pinned: false, openedAt: Date.now() });
    openedProjectOrder = [key, ...openedProjectOrder.filter((cwd) => cwd !== key)];
    return { cwd: absPath, name };
  });

  ipcMain.handle("app:openFolderInExplorer", async (_e, absPath: string) => {
    if (!absPath || !existsSync(absPath) || !statSync(absPath).isDirectory()) {
      throw new Error("Project folder not found: " + absPath);
    }
    const error = await shell.openPath(absPath);
    if (error) throw new Error(error);
    return { ok: true };
  });

  ipcMain.handle("app:revealFileInExplorer", (_e, absPath: string) => {
    if (!absPath || !existsSync(absPath)) throw new Error("File not found: " + absPath);
    shell.showItemInFolder(absPath);
    return { ok: true };
  });

  ipcMain.handle("app:openPreviewWindow", (_e, absPath: string, opts?: { atCursor?: boolean }) => {
    if (!absPath || !existsSync(absPath)) throw new Error("File not found: " + absPath);
    openPreviewWindow(absPath, !!opts?.atCursor);
    return { ok: true };
  });

  ipcMain.handle("app:closePreviewWindow", (_e, absPath: string) => {
    closePreviewWindow(String(absPath || ""));
    return { ok: true };
  });

  // Absolute path of the bundled user manual (Help → 使用手册 / User manual),
  // picked by UI language, or null when no copy exists.
  ipcMain.handle("app:getUserManualPath", () => {
    const en = getConfig().language === "en";
    const names = en ? ["user-manual-en.md", "user-manual.md"] : ["user-manual.md"];
    for (const name of names) {
      const candidates = [
        join(process.resourcesPath, name), // packaged: extraResources
        join(app.getAppPath(), "resources", name), // dev: repo resources/
      ];
      for (const p of candidates) if (existsSync(p)) return p;
    }
    return null;
  });


  // Caption drag on the frameless floating window (VS-style move + dock).
  ipcMain.handle("app:previewWindowMoveStart", (_e, absPath: string) => {
    previewWindowMoveStart(String(absPath || ""));
    return { ok: true };
  });

  ipcMain.handle("app:previewWindowMoveEnd", (_e, absPath: string) => {
    previewWindowMoveEnd(String(absPath || ""));
    return { ok: true };
  });

  ipcMain.handle("app:setProjectPinned", (_e, args: { cwd?: string; pinned?: boolean }) => {
    const cwd = typeof args?.cwd === "string" ? args.cwd.trim() : "";
    if (!cwd) throw new Error("Project path is required");
    const cfg = getConfig();
    const target = cwd.toLowerCase();
    const next = (cfg.pinnedProjects || []).filter((path) => path.toLowerCase() !== target);
    // New pins append to the END of the pinned zone so existing manual order is kept.
    if (args?.pinned) next.push(cwd);
    return updateConfig({ pinnedProjects: next });
  });

  ipcMain.handle("app:setThreadPinned", (_e, args: { file?: string; pinned?: boolean }) => {
    const file = typeof args?.file === "string" ? args.file.trim() : "";
    if (!file) throw new Error("Thread file is required");
    const cfg = getConfig();
    const target = file.toLowerCase();
    const next = (cfg.pinnedThreads || []).filter((path) => path.toLowerCase() !== target);
    // New pins append to the END of the pinned zone so existing manual order is kept.
    if (args?.pinned) next.push(file);
    return updateConfig({ pinnedThreads: next });
  });

  // Move an entry within its pinned list, or pin it at a rank when absent.
  // The array order IS the display order of the sidebar's pinned zone.
  ipcMain.handle("app:reorderPinned", (_e, args: { kind?: string; id?: string; target?: number }) => {
    const kind = args?.kind === "thread" ? "thread" : args?.kind === "project" ? "project" : null;
    if (!kind) throw new Error("Invalid pinned list");
    const id = typeof args?.id === "string" ? args.id.trim() : "";
    if (!id) throw new Error("Missing id");
    const cfg = getConfig();
    if (kind === "project") {
      return updateConfig({ pinnedProjects: reorderPinned(cfg.pinnedProjects || [], id, Number(args?.target)) });
    }
    return updateConfig({ pinnedThreads: reorderPinned(cfg.pinnedThreads || [], id, Number(args?.target)) });
  });

  // Pre-warm the standby pi process for the project the user is looking at, so
  // a subsequent "new task" adopts an already-booted process (~0.5s) instead of
  // cold-starting (~5s). Re-targets the spare when the active project changes.
  ipcMain.handle("app:prewarm", (_e, cwd: string) => {
    if (!cwd || typeof cwd !== "string") return { ok: false };
    lastOpenCwd = cwd;
    if (warmHandle && !sameDir(warmHandle.bridge.cwd, cwd)) dropWarmBridge();
    ensureWarmBridge();
    return { ok: true };
  });

  ipcMain.handle(
    "app:showOpenDialog",
    async (_e, kind: "folder" | "file" | "files", opts?: { filters?: { name: string; extensions: string[] }[] }) => {
      const w = getWin();
      const properties: any[] =
        kind === "folder"
          ? ["openDirectory", "createDirectory"]
          : kind === "files"
            ? ["openFile", "multiSelections"]
            : ["openFile"];
      const language = getConfig().language;
      // Optional caller-supplied file filters (e.g. the task-mode spec picker
      // restricts to .md so the dialog matches its label).
      const filters = opts?.filters?.length
        ? opts.filters.map((f) => ({ name: f.name, extensions: f.extensions }))
        : undefined;
      const res = await dialog.showOpenDialog(w!, {
        properties,
        ...(filters ? { filters } : {}),
        title: kind === "folder"
          ? language === "zh" ? "打开项目文件夹" : "Open project folder"
          : language === "zh" ? "添加文件" : "Attach files",
      });
      if (res.canceled) return null;
      return kind === "folder" ? res.filePaths[0] : res.filePaths;
    });

  // ---- files / preview ----------------------------------------------------
  ipcMain.handle("app:getFileTree", (_e, cwd: string, rel?: string) => listDir(cwd, rel));
  ipcMain.handle("app:fileExists", (_e, absPath: string) => {
    try {
      return !!absPath && statSync(absPath).isFile();
    } catch {
      return false;
    }
  });
  ipcMain.handle("app:readPreview", (_e, absPath: string, projectRoot?: string) => {
    const payload = readPreview(absPath);
    return payload.kind === "html"
      ? { ...payload, previewUrl: createHtmlPreviewUrl(absPath, projectRoot) }
      : payload;
  });
  ipcMain.handle("app:stageClipboardFile", (_e, args: { name?: string; mimeType?: string; data?: string }) => {
    return stageClipboardFile(args || {});
  });
  ipcMain.handle("app:savePreviewHtml", (_e, args: { absPath?: string; projectRoot?: string; html?: string }) => {
    return writePreviewHtml(args?.absPath || "", args?.projectRoot, args?.html || "");
  });
  ipcMain.handle("app:showFileContextMenu", (event, absPath: string) => {
    if (!absPath || !existsSync(absPath)) return { ok: false, error: "File not found" };
    const language = getConfig().language;
    const menu = Menu.buildFromTemplate([
      {
        label: language === "zh" ? "在资源管理器中显示" : "Show in File Explorer",
        click: () => shell.showItemInFolder(absPath),
      },
      {
        label: language === "zh" ? "使用默认应用打开" : "Open with Default App",
        click: () => void shell.openPath(absPath),
      },
    ]);
    menu.popup({ window: BrowserWindow.fromWebContents(event.sender) || undefined });
    return { ok: true };
  });

  // ---- voice system (STT) --------------------------------------------------
  // Providers are read live so a key rotated in Settings keeps working without
  // re-saving the voice config; the API key itself never crosses IPC.
  ipcMain.handle("voice:transcribe", (_e, args: { dataBase64?: string }) =>
    transcribeAudio(args || {}, { cfg: getConfig().voice, providers: readModelsFile().providers }),
  );
  ipcMain.handle("voice:test", () =>
    testStt({ cfg: getConfig().voice, providers: readModelsFile().providers }),
  );

  // ---- app store (platform: load third-party app packages) --------------
  // Apps are developer-supplied zip packages or unpacked directories; MPI
  // validates the manifest, installs into userData/apps, and hosts the service.
  ipcMain.handle("apps:list", () => listApps());
  ipcMain.handle("apps:installZip", async () => {
    const r = await dialog.showOpenDialog({
      title: "选择应用包 / Choose an app package",
      properties: ["openFile"],
      filters: [{ name: "MPI App", extensions: ["zip"] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return installAppFromZip(r.filePaths[0]);
  });
  ipcMain.handle("apps:installDir", async () => {
    const r = await dialog.showOpenDialog({
      title: "选择应用目录 / Choose an app directory",
      properties: ["openDirectory"],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return installAppFromDir(r.filePaths[0]);
  });
  ipcMain.handle("apps:uninstall", (_e, id: string) => uninstallApp(String(id || "")));
  ipcMain.handle("apps:setEnabled", (_e, args: { id?: string; enabled?: boolean }) =>
    setAppEnabled(String(args?.id || ""), !!args?.enabled),
  );
  ipcMain.handle("apps:getConfig", (_e, id: string) => getAppConfig(String(id || "")));
  ipcMain.handle("apps:saveConfig", (_e, args: { id?: string; values?: Record<string, unknown> }) =>
    saveAppConfig(String(args?.id || ""), (args?.values as Record<string, unknown>) || {}),
  );
  // v2: rolling service log of an installed app (used by the detail view).
  ipcMain.handle("apps:logs", (_e, id: string) => getAppLogs(String(id || "")));
  // v2: restart an enabled app's service (deactivate + activate, no config write).
  ipcMain.handle("apps:restart", (_e, id: string) => restartAppService(String(id || "")));
  // Draft probe for the store's Test Connection button — never touches config.
  ipcMain.handle("apps:testVoice", (_e, args: { id?: string; values?: Record<string, unknown> }) =>
    testAppVoice(String(args?.id || ""), (args?.values as Record<string, unknown>) || {}),
  );
  // ---- voice system (TTS, Edge) -------------------------------------------
  // Free online neural voices. Explicit args win (Settings preview uses the
  // unsaved draft); otherwise the saved voice config supplies voice + rate.
  ipcMain.handle("voice:synthesize", async (_e, args: { text?: string; voice?: string; rate?: number }) => {
    const cfg = getConfig().voice;
    const r = await synthesizeEdge({
      text: args?.text,
      voice: args?.voice || cfg?.ttsEdgeVoice,
      rate: typeof args?.rate === "number" ? args.rate : cfg?.ttsRate,
    });
    // Dev diagnostic: the renderer surfaces r.error in a toast; this line lands
    // in the `npm run dev` terminal for anyone watching it.
    console.log(
      `[tts] edge synth ok=${r.ok} voice=${args?.voice || cfg?.ttsEdgeVoice || "(default)"}` +
        ` bytes=${r.audioBase64 ? Math.round((r.audioBase64.length * 3) / 4) : 0} err=${r.error || "-"}`,
    );
    return r;
  });

  // ---- settings: models.json / settings.json / diagnostics ----------------
  ipcMain.handle("settings:getModels", () => readModelsFile());
  ipcMain.handle(
    "settings:testModel",
    (_e, args: { providerId: string; provider: Record<string, unknown>; modelId: string }) =>
      testModelAvailability(args.providerId, args.provider as any, args.modelId),
  );
  // P1-11: resolve contextWindow for models marked auto but still empty before
  // writing; models with an existing value are never re-resolved.
  ipcMain.handle("settings:saveModels", async (_e, providers: Record<string, unknown>) => {
    const resolved = await autoResolveContextWindows(providers as any);
    writeModelsProviders(resolved);
    // The standby process also caches its model registry. Recreate it now so a
    // new task opened after saving does not adopt a stale pre-save process.
    dropWarmBridge();
    ensureWarmBridge();
    // Return the user-facing form so the Settings panel immediately reflects
    // the canonical `/v1` convention after saving (runtime storage may differ
    // for Anthropic).
    return { ok: true, models: readModelsFile() };
  });
  // P1-11: on-demand contextWindow resolution (Settings “重新探测” button).
  ipcMain.handle(
    "settings:resolveModelContext",
    (_e, args: { providerId: string; provider: Record<string, unknown>; model: Record<string, unknown> }) =>
      resolveModelContext(args.providerId, args.provider as any, args.model as any),
  );
  ipcMain.handle("settings:getThinking", () => readThinking());
  ipcMain.handle("settings:saveThinking", (_e, patch: Record<string, unknown>) => writeThinking(patch as any));
  ipcMain.handle("settings:getDiagnostics", () => getDiagnostics());
  /**
   * Re-probe the shell after the user installed (or uninstalled) Git, and adopt
   * it into pi's settings so the next session actually uses it. Re-resolves
   * after the write so the returned state reports the adopted path.
   */
  ipcMain.handle("settings:recheckShell", () => recheckShell(getSettingsPath()));
  /** Git for Windows download page — the only install route MPI offers. */
  ipcMain.handle("settings:openGitDownload", async () => {
    try {
      await shell.openExternal("https://git-scm.com/downloads/win");
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
  ipcMain.handle("settings:openPath", async (_e, abs: string) => {
    try {
      const err = await shell.openPath(abs);
      return err ? { ok: false, error: err } : { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
  ipcMain.handle("settings:showItem", (_e, abs: string) => {
    try {
      shell.showItemInFolder(abs);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
  ipcMain.handle("settings:openAgentDir", async () => {
    const err = await shell.openPath(getAgentDir());
    return err ? { ok: false, error: err } : { ok: true };
  });
  // expose resolved paths so the renderer can label buttons without guessing
  ipcMain.handle("settings:getPaths", () => ({
    agentDir: getAgentDir(),
    models: getModelsPath(),
    settings: getSettingsPath(),
    auth: getAuthPath(),
  }));

  // ---- threads (pi bridges) ----------------------------------------------
  /**
   * Instant thread load for the UI. Reading the transcript from the .jsonl on
   * disk takes milliseconds, so a clicked thread renders immediately instead of
   * waiting ~5s for a pi process to boot. When a live bridge already backs the
   * session we return its live state instead (connected:true); otherwise we
   * return disk data with connected:false and the renderer connects lazily/in
   * the background via thread:open.
   */
  ipcMain.handle("thread:loadHistory", async (_e, args: { cwd: string; sessionFile: string }) => {
    const { cwd, sessionFile } = args;
    const permission = resolvePermission(sessionFile, undefined);
    const existing = bridges.get(sessionFile);
    if (existing) return { connected: true, ...(await gatherThread(existing.bridge, sessionFile, existing.permission)) };
    const hist = await readThreadHistory(sessionFile);
    return {
      connected: false,
      threadId: sessionFile,
      cwd: hist.cwd || cwd,
      sessionFile,
      sessionName: hist.sessionName,
      model: hist.model,
      thinkingLevel: hist.thinkingLevel || "off",
      isStreaming: false,
      messages: hist.messages,
      branchMessages: hist.branchMessages,
      models: [],
      commands: getSkillCommands(hist.cwd || cwd),
      permission,
    };
  });

  ipcMain.handle("thread:open", async (_e, args: { cwd: string; sessionFile?: string; name?: string; permission?: PermissionLevel }) => {
    const { cwd, sessionFile, name } = args;
    if (sessionFile && bridges.has(sessionFile)) {
      const existing = bridges.get(sessionFile)!;
      return gatherThread(existing.bridge, sessionFile, existing.permission);
    }
    lastOpenCwd = cwd;
    if ((getConfig().lastThreadCwd || "") !== cwd) updateConfig({ lastThreadCwd: cwd });
    const permission = resolvePermission(sessionFile, args.permission);
    let handle: BridgeHandle | null = null;
    let adopted = false;
    const spareAtEntry = !!warmHandle;
    // Try to adopt the warm spare: switching a booted process is ~0.5s vs
    // ~5s for a cold start. A dead spare is dropped, a spare booted for
    // another project is replaced so the standby converges on the project
    // actually in use.
    if (!name && warmHandle) {
      if (!warmHandle.bridge.running) {
        // eslint-disable-next-line no-console
        console.log("[pi] thread:open dropping dead warm spare -> cold start");
        dropWarmBridge();
      } else if (!sameDir(warmHandle.bridge.cwd, cwd)) {
        // eslint-disable-next-line no-console
        console.log(`[pi] thread:open cwd mismatch (warm="${warmHandle.bridge.cwd}" requested="${cwd}") -> cold start, spare respawns for new cwd`);
        dropWarmBridge();
      } else {
        handle = warmHandle;
        warmHandle = null;
        adopted = true;
        warmFailures = 0;
        handle.permission = permission;
        writeGateMode(handle.gateModeFile, permission);
        // eslint-disable-next-line no-console
        console.log("[pi] thread:open adopting warm spare" + (sessionFile ? " (switch_session)" : " (fresh)"));
      }
    }
    if (!handle) {
      if (!spareAtEntry && !name) {
        // eslint-disable-next-line no-console
        console.log("[pi] thread:open cold start (no spare available yet)");
      }
      handle = createHandle(cwd, sessionFile, name, permission, send);
    }
    bridges.set(handle.getId(), handle);
    try {
      await handle.bridge.start(); // no-op for the already-running spare
      if (adopted) {
        if (sessionFile) {
          await handle.bridge.switchSession(sessionFile);
        } else {
          // A warm spare may have opened pi's current session while it was
          // idle. A new task must never inherit that session or its name.
          await handle.bridge.newSession();
        }
      }
      const state: any = await handle.bridge.getState();
      const finalId = state.sessionFile || handle.getId();
      handle.setId(finalId);
      // Persist the chosen level keyed by the real session file so reopening resumes it.
      if (state.sessionFile) {
        const perms = getConfig().threadPermissions;
        if (perms[state.sessionFile] !== permission) updateConfig({ threadPermissions: { ...perms, [state.sessionFile]: permission } });
      }
      const gathered = await gatherThread(handle.bridge, finalId, permission);
      // P1-12: restore per-thread auto mode. New sessions (no messages yet)
      // explicitly pick their initial model — this also fixes the "new session
      // starts on drifted pi global default" quirk for auto threads.
      if (getConfig().autoModelThreads?.[finalId]) {
        const cur = ((gathered.model as any) || { provider: "", id: "" });
        autopilot.setAuto(finalId, true, cur);
        if (cur.id && (gathered.messages ?? []).length === 0) {
          // Fire-and-forget: probes must not block thread open; the switch
          // reaches the renderer via the pi:autoModel notify (carries `to`).
          void autopilot.resolveInitial(finalId, cur).catch(() => {});
        }
      }
      if (!sessionFile) {
        // Opening without a session file is the explicit "New thread" flow.
        // The process may have been a warm spare whose previous session name
        // is still visible in its state; never let that metadata or transcript
        // cross the new-thread boundary.
        return {
          ...gathered,
          autoEnabled: autopilot.isAuto(finalId),
          sessionName: null,
          messages: [],
          branchMessages: [],
          isStreaming: false,
          isNewSession: true,
        };
      }
      return { ...gathered, autoEnabled: autopilot.isAuto(finalId) };
    } catch (e) {
      bridges.delete(handle.getId());
      removeGateModeFile(handle.gateModeFile);
      handle.bridge.stop();
      throw e;
    } finally {
      ensureWarmBridge(); // keep exactly one spare booted for the next open
    }
  });

  ipcMain.handle("thread:setPermission", async (_e, args: { threadId: string; permission: PermissionLevel }) => {
    if (typeof args?.permission !== "string" || !(PERMISSION_LEVELS as readonly string[]).includes(args.permission)) {
      return { ok: false, error: "Invalid permission level" };
    }
    // Persist only for real session files: draft temp ids (opening-*) and boot
    // ids would leave dead keys in config that nothing ever cleans up. Real
    // files get persisted by thread:open / finishBranch once the name is known.
    if (args.threadId.endsWith(".jsonl")) {
      const perms = getConfig().threadPermissions;
      updateConfig({ threadPermissions: { ...perms, [args.threadId]: args.permission } });
    }
    // Flip the running thread's gate mode live; the pi process keeps running.
    const h = bridges.get(args.threadId);
    if (h) {
      h.permission = args.permission;
      writeGateMode(h.gateModeFile, args.permission);
    }
    publishRemotePermissionChanged(args.threadId.endsWith(".jsonl") ? args.threadId : undefined, args.permission);
    return { ok: true };
  });

  // Task-mode behaviour state for the mpi-taskmode extension. Keyed by session
  // UUID (the extension derives it from its own --session file name); written
  // on every mode apply so switching modes takes effect on the next turn with
  // no pi process restart. Empty content deletes the file (= no injection).
  // The chosen mode id is also persisted per UUID in config.threadTaskModes so
  // the UI can restore which mode a thread was on after restart/reopen.
  ipcMain.handle(
    "thread:setTaskMode",
    (_e, args: { threadId: string; modeId?: string; instructions?: string; specFile?: string; enforce?: string }) => {
      const id = typeof args?.threadId === "string" ? args.threadId : "";
      const key = id.endsWith(".jsonl")
        ? threadUuidFromSessionFile(id)
        : /^boot:(.+)$/.exec(id)?.[1] ?? null;
      if (!key) return { ok: true }; // draft thread without a session yet
      const dir = join(getConfigDir(), "taskmodes");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${key}.json`);
      const instructions = typeof args?.instructions === "string" ? args.instructions.trim() : "";
      // Built-in modes ship a portable `@agent/…` spec token; resolve it
      // against pi's agent dir here so the state file always holds a real path
      // (and the seeded mode works on any machine/user).
      const rawSpec = typeof args?.specFile === "string" ? args.specFile.trim() : "";
      const specFile = rawSpec.startsWith("@agent/")
        ? join(getAgentDir(), rawSpec.slice("@agent/".length))
        : isAbsolute(rawSpec)
          ? rawSpec
          : "";
      // Hard read-only floor (research/review): the gate and the taskmode
      // extension both read it from this file; empty content deletes the file.
      const enforce = args?.enforce === "readonly" ? ("readonly" as const) : null;
      if (!instructions && !specFile && !enforce) {
        try {
          unlinkSync(file);
        } catch {
          /* already absent */
        }
      } else {
        writeFileSync(
          file,
          JSON.stringify({ instructions, specFile, ...(enforce ? { enforce } : {}) }),
          "utf8",
        );
      }
      const modes = { ...(getConfig().threadTaskModes || {}) };
      const modeId = typeof args?.modeId === "string" ? args.modeId.trim() : "";
      if (modeId) modes[key] = modeId;
      else delete modes[key];
      updateConfig({ threadTaskModes: modes });
      return { ok: true };
    },
  );

  // One-click repair for permanently bricked sessions (upstream #8720/#8667):
  // rewrites the session JSONL so the provider stops rejecting every turn.
  ipcMain.handle("thread:repair-session", (_e, args: { threadId?: string; sessionFile?: string }) => {
    const h = typeof args?.threadId === "string" ? bridges.get(args.threadId) : undefined;
    if (h?.bridge.hasActiveRun) {
      return { ok: false, changed: 0, details: [] as string[], error: "Thread is busy — wait for the current turn to finish and retry." };
    }
    let file: string;
    try {
      file = assertDeletableSessionFile(typeof args?.sessionFile === "string" ? args.sessionFile : "");
    } catch (e: any) {
      return { ok: false, changed: 0, details: [] as string[], error: e?.message || "invalid session path" };
    }
    return repairSessionFile(file);
  });

  // Compaction bookkeeping for the context popover: how many times this session
  // has been compacted (persisted in the JSONL, so it survives restarts).
  ipcMain.handle("thread:compaction-stats", async (_e, args: { sessionFile?: string }) => {
    const requested = typeof args?.sessionFile === "string" ? args.sessionFile : "";
    if (!requested) return null;
    try {
      assertDeletableSessionFile(requested);
    } catch {
      return null;
    }
    return readSessionCompactions(requested);
  });

  ipcMain.handle(
    "thread:delete",
    async (_e, args: { file?: string; title?: string; cwd?: string } | string) => {
      const meta = typeof args === "string" ? {} : (args || {});
      const target = assertDeletableSessionFile(typeof meta.file === "string" ? meta.file : "");

    // Stop every local bridge that points at this session before unlinking it;
    // otherwise a live Pi process can recreate or continue writing the file.
    for (const [id, handle] of Array.from(bridges.entries())) {
      if (!sameSessionFile(id, target) && !sameSessionFile(handle.getId(), target)) continue;
      bridges.delete(id);
      // Settle an in-flight turn first so the trashed JSONL doesn't end on a
      // dangling tool call (upstream #9124); idle bridges stop immediately.
      if (handle.bridge.hasActiveRun) await handle.bridge.stopGraceful(2500);
      else handle.bridge.stop();
    }
    if (warmHandle && sameSessionFile(warmHandle.getId(), target)) dropWarmBridge();

    // Drop the task-mode state file + config entry for this session's UUID so
    // deleted threads don't leave orphaned injections behind (and a restore
    // from trash doesn't silently re-apply an old mode).
    const uuid = threadUuidFromSessionFile(target);
    if (uuid) {
      try {
        unlinkSync(join(getConfigDir(), "taskmodes", `${uuid}.json`));
      } catch {
        /* no state file for this session */
      }
    }

    const current = getConfig();
    // Trash enabled (default): the JSONL is moved to <userData>/trash and stays
    // restorable. Disabled: historical behavior, unlink immediately.
    let trashed = false;
    if (current.trashEnabled !== false) {
      await moveToTrash({ originalFile: target, title: meta.title, cwd: meta.cwd });
      trashed = true;
    } else {
      await unlinkSessionWithRetry(target);
    }

    const threadPermissions = Object.fromEntries(
      Object.entries(current.threadPermissions || {}).filter(([path]) => !sameSessionFile(path, target)),
    );
    const config = updateConfig({
      pinnedThreads: (current.pinnedThreads || []).filter((path) => !sameSessionFile(path, target)),
      archivedThreads: (current.archivedThreads || []).filter((thread) => !sameSessionFile(thread.file, target)),
      threadPermissions,
      autoModelThreads: Object.fromEntries(
        Object.entries(current.autoModelThreads ?? {}).filter(([path]) => !sameSessionFile(path, target)),
      ),
      threadTaskModes: uuid
        ? Object.fromEntries(Object.entries(current.threadTaskModes ?? {}).filter(([k]) => k !== uuid))
        : current.threadTaskModes,
    });

    for (const [localId] of Array.from(remoteLocalToId.entries())) {
      if (sameSessionFile(localId, target)) remoteLocalToId.delete(localId);
    }
    for (const [remoteId, draft] of Array.from(remoteDrafts.entries())) {
      if (draft.sessionFile && sameSessionFile(draft.sessionFile, target)) remoteDrafts.delete(remoteId);
    }
    invalidateRemoteProjects();
    send("pi:projects-changed", { sessionFile: target });
    return { ok: true, config, trashed };
  });

  ipcMain.handle("trash:list", () => listTrash());

  ipcMain.handle("trash:restore", (_e, id: string) => {
    const entry = restoreFromTrash(typeof id === "string" ? id : "");
    invalidateRemoteProjects();
    send("pi:projects-changed", { sessionFile: entry.originalFile });
    return { ok: true };
  });

  ipcMain.handle("trash:purge", (_e, id: string) => {
    purgeFromTrash(typeof id === "string" ? id : "");
    return { ok: true };
  });

  ipcMain.handle("trash:empty", () => ({ ok: true, count: emptyTrash() }));

  ipcMain.handle("thread:close", (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (h) {
      // Abort + settle in the background so a running tool's result is persisted
      // before the process dies; the UI closes the tab immediately.
      void h.bridge.stopGraceful();
      bridges.delete(threadId);
      autopilot.onThreadClosed(threadId); // auto monitoring stops with the thread
    }
    return true;
  });

  ipcMain.handle("thread:prompt", async (_e, args: { threadId: string; text: string; images?: unknown[]; attachments?: Attachment[] }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open: " + args.threadId);
    const { text, images } = processAttachments(args.attachments, args.text || "");
    const merged = [...(args.images || []), ...images];
    await h.bridge.prompt(text, merged.length ? merged : undefined);
    return { ok: true };
  });

  ipcMain.handle("thread:steer", async (_e, args: { threadId: string; text: string; images?: unknown[]; attachments?: Attachment[] }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open: " + args.threadId);
    const { text, images } = processAttachments(args.attachments, args.text || "");
    const merged = [...(args.images || []), ...images];
    await h.bridge.steer(text, merged.length ? merged : undefined);
    return { ok: true };
  });

  ipcMain.handle("thread:followUp", async (_e, args: { threadId: string; text: string; images?: unknown[]; attachments?: Attachment[] }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open: " + args.threadId);
    const { text, images } = processAttachments(args.attachments, args.text || "");
    const merged = [...(args.images || []), ...images];
    await h.bridge.followUp(text, merged.length ? merged : undefined);
    return { ok: true };
  });

  ipcMain.handle("thread:abort", async (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (h) await h.bridge.abort();
    return true;
  });

  // Manual context compaction (pi /compact). Resolves with the compaction
  // result so the renderer can report token savings; progress itself arrives
  // as compaction_start/compaction_end agent events.
  ipcMain.handle("thread:compact", async (_e, args: { threadId: string; instructions?: string }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open: " + args.threadId);
    const instructions = typeof args.instructions === "string" ? args.instructions.trim() : "";
    return h.bridge.compact(instructions || undefined);
  });

  // P1-12: enable/disable auto mode for a thread. Exiting stops monitoring
  // entirely (non-auto threads keep the original behaviour).
  ipcMain.handle("thread:setAutoModel", async (_e, args: { threadId: string; enabled: boolean }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open");
    const state: any = await h.bridge.getState();
    const model = (state.model as any) || { provider: "", id: "" };
    autopilot.setAuto(args.threadId, !!args.enabled, model);
    const threads = { ...(getConfig().autoModelThreads ?? {}) };
    if (args.enabled) threads[args.threadId] = true;
    else delete threads[args.threadId];
    updateConfig({ autoModelThreads: threads });
    let initial: { provider: string; id: string } | null = null;
    if (args.enabled && model.id) {
      const msgs: any = await h.bridge.getMessages();
      if ((msgs?.messages ?? []).length === 0) {
        try {
          initial = await autopilot.resolveInitial(args.threadId, model);
        } catch {
          /* probes are best effort */
        }
      }
    }
    return { ok: true, initial };
  });

  ipcMain.handle("thread:setModel", async (_e, args: { threadId: string; provider: string; modelId: string }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open");
    // Manual selection exits auto mode for this thread (user-confirmed).
    autopilot.setAuto(args.threadId, false, { provider: args.provider, id: args.modelId });
    const threads = getConfig().autoModelThreads ?? {};
    if (threads[args.threadId]) {
      const next = { ...threads };
      delete next[args.threadId];
      updateConfig({ autoModelThreads: next });
    }
    const model = await h.bridge.setModel(args.provider, args.modelId);
    // Pi clamps the current thinking level when the selected model exposes a
    // narrower thinkingLevelMap. Return the effective value so the renderer's
    // badge stays in sync with the live session instead of showing stale max.
    const state: any = await h.bridge.getState();
    return { model, thinkingLevel: state?.thinkingLevel ?? null };
  });

  ipcMain.handle("thread:refreshModels", async (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (!h) return { models: [] };
    return h.bridge.refreshModels();
  });

  ipcMain.handle("thread:setThinking", async (_e, args: { threadId: string; level: string }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open");
    await h.bridge.setThinkingLevel(args.level);
    const state: any = await h.bridge.getState();
    return { thinkingLevel: state?.thinkingLevel ?? args.level };
  });

  ipcMain.handle("thread:getThinkingLevels", async (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (!h) return { levels: ["off"] };
    return h.bridge.getAvailableThinkingLevels();
  });

  ipcMain.handle("thread:newSession", async (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (!h) throw new Error("Thread not open");
    const res: any = await h.bridge.newSession();
    if (res?.cancelled) return { cancelled: true };
    const state: any = await h.bridge.getState();
    const newId = state.sessionFile || threadId;
    h.setId(newId);
    return { cancelled: false, ...(await gatherThread(h.bridge, newId, h.permission)) };
  });

  ipcMain.handle("thread:getBranchMessages", async (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (!h) return { messages: [] };
    const entries = await h.bridge.getEntries();
    return { messages: activeBranchMessages(entries) };
  });

  const finishBranch = async (h: BridgeHandle, oldId: string, selectedText?: string) => {
    const state: any = await h.bridge.getState();
    const newId = state.sessionFile || oldId;
    h.setId(newId);
    const perms = getConfig().threadPermissions;
    if (state.sessionFile && perms[state.sessionFile] !== h.permission) {
      updateConfig({ threadPermissions: { ...perms, [state.sessionFile]: h.permission } });
    }
    return { ...(await gatherThread(h.bridge, newId, h.permission)), selectedText };
  };

  // Native RPC fork (position "before"): the entry must be a USER message; the
  // response carries its text so the renderer can prefill it in the editor.
  ipcMain.handle("thread:fork", async (_e, args: { threadId: string; entryId: string }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open");
    const previousFile = (await h.bridge.getState() as any)?.sessionFile;
    const res: any = await h.bridge.fork(args.entryId);
    if (res?.cancelled) return { cancelled: true };
    const currentFile = (await h.bridge.getState() as any)?.sessionFile;
    if (!currentFile || currentFile === previousFile) throw new Error("Fork did not create a new session");
    const text = typeof res?.text === "string" && res.text ? res.text : undefined;
    return { cancelled: false, ...(await finishBranch(h, args.threadId, text)) };
  });

  // Native RPC clone: duplicates the current active branch at its leaf — no entry needed.
  ipcMain.handle("thread:clone", async (_e, args: { threadId: string }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open");
    const previousFile = (await h.bridge.getState() as any)?.sessionFile;
    const res: any = await h.bridge.clone();
    if (res?.cancelled) return { cancelled: true };
    const currentFile = (await h.bridge.getState() as any)?.sessionFile;
    if (!currentFile || currentFile === previousFile) throw new Error("Clone did not create a new session");
    return { cancelled: false, ...(await finishBranch(h, args.threadId)) };
  });

  ipcMain.handle("thread:setName", async (_e, args: { threadId: string; name: string }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open");
    return h.bridge.setSessionName(args.name);
  });

  ipcMain.handle("thread:getStats", async (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (!h) return null;
    return h.bridge.getSessionStats();
  });

  ipcMain.handle(
    "thread:extuiResponse",
    (_e, args: { threadId: string; id: string; payload: Record<string, unknown> }) => {
      const h = bridges.get(args.threadId);
      if (h) h.bridge.respondExtUi(args.id, args.payload || {});
      // Agent-initiated permission switch: on approval perform the live
      // switch NOW — before the extension's next tool call hits the gate.
      const pendingSwitch = pendingModeSwitch.get(args.id);
      pendingModeSwitch.delete(args.id);
      if (pendingSwitch) {
        const value = typeof args.payload?.value === "string" ? args.payload.value : "";
        const approved = MODE_SWITCH_APPROVE_LABELS.includes(value);
        const denied = MODE_SWITCH_DENY_LABELS.includes(value);
        if (approved && applyAgentModeSwitch(pendingSwitch.threadId, pendingSwitch.to)) {
          return { ok: true, modeSwitched: pendingSwitch.to };
        }
        // Denied / closed / thread gone → nothing to do; the extension's own
        // result text already tells the agent not to assume approval.
        if (denied || !approved) return { ok: true };
      }
      // “始终允许该工具” on an extension-tool approval card → persist trust so
      // future sessions/threads skip this dialog. The gate picks it up live via
      // its config.json mtime cache.
      const trustedTool = pendingTrustTool.get(args.id);
      pendingTrustTool.delete(args.id);
      let trustedAdded: string | undefined;
      if (trustedTool && ALWAYS_ALLOW_LABELS.includes(String(args.payload?.value ?? ""))) {
        const cur = getConfig();
        updateConfig({ trustedTools: [...new Set([...(cur.trustedTools || []), trustedTool])] });
        trustedAdded = trustedTool;
      }
      return { ok: true, ...(trustedAdded ? { trustedAdded } : {}) };
    },
  );

  // ---- plugins (pi packages + standalone skills) -------------------------
  ipcMain.handle("plugins:getPackages", () => listPackages());
  ipcMain.handle("plugins:setPackageEnabled", (_e, args: { source: string; enabled: boolean }) => {
    setPackageEnabled(args.source, args.enabled);
    dropWarmBridge();
    ensureWarmBridge();
    return { ok: true };
  });
  ipcMain.handle("plugins:installPackage", async (_e, source: string) => {
    let res;
    try {
      res = await runPiCli(["install", source], { transferLabel: "安装扩展包 " + nameOf(source) });
    } catch (e) {
      if (e instanceof TransferCancelledError) return { ok: false, cancelled: true, output: "已取消" };
      throw e;
    }
    const installOutput = (res.stdout + res.stderr).trim();
    if (res.code !== 0) {
      // Never add a failed/partial install to settings: Pi loads configured
      // packages before RPC starts, so one bad entry can brick every thread.
      return {
        ok: false,
        missing: classifyMissingTool(installOutput),
        output: installOutput || `pi install exited with code ${res.code}`,
      };
    }
    const probe = await probePiStartup();
    if (!probe.ok) {
      // Keep the package installed but disable autoload. This is reversible in
      // Settings and immediately restores thread startup.
      setPackageEnabled(source, false);
      dropWarmBridge();
      ensureWarmBridge();
      return {
        ok: false,
        output: [installOutput, "Installed, but Pi could not load the extension. It was disabled automatically.", probe.output]
          .filter(Boolean)
          .join("\n"),
      };
    }
    dropWarmBridge();
    ensureWarmBridge();
    return { ok: true, output: installOutput };
  });
  ipcMain.handle("plugins:removePackage", async (_e, source: string) => {
    let res;
    try {
      res = await runPiCli(["remove", source], { transferLabel: "移除扩展包 " + nameOf(source) });
    } catch (e) {
      if (e instanceof TransferCancelledError) return { ok: false, cancelled: true, output: "已取消" };
      throw e;
    }
    removePackageEntry(source); // ensure it is gone from settings regardless of CLI result
    dropWarmBridge();
    ensureWarmBridge();
    return { ok: true, missing: classifyMissingTool(res.stdout + res.stderr), output: (res.stdout + res.stderr).trim() };
  });
  ipcMain.handle("plugins:getSkills", () => listManagedSkills());
  ipcMain.handle("plugins:getSkillContent", (_e, path: string) => getSkillContent(path));
  ipcMain.handle("plugins:getPackageInfo", (_e, source) => getPackageInfo(typeof source === "string" ? source : ""));
  // Extension package market: search the public npm registry (no auth needed).
  ipcMain.handle("plugins:npmSearch", (_e, query: string) => searchNpmPackages(typeof query === "string" ? query : ""));
  ipcMain.handle("plugins:npmReadme", (_e, name: string) => getNpmReadme(typeof name === "string" ? name : ""));
  // mcpmarket.cn directory search + detail.
  ipcMain.handle("plugins:mcpMarketSearch", (_e, args: { query?: string; page?: number }) =>
    searchMcpMarket(typeof args?.query === "string" ? args.query : "", Number.isFinite(Number(args?.page)) ? Number(args.page) : 1)
  );
  ipcMain.handle("plugins:mcpMarketDetail", (_e, id: string) => getMcpMarketDetail(typeof id === "string" ? id : ""));

  // MCP servers live in <agentDir>/mcp.json (pi-mcp-adapter / pi-mcp-market).
  ipcMain.handle("plugins:getMcpServers", () => listMcpServers());
  ipcMain.handle("plugins:setMcpServerDisabled", (_e, args: { name: string; disabled: boolean }) => {
    setMcpServerDisabled(typeof args?.name === "string" ? args.name : "", !!args?.disabled);
    return { ok: true };
  });
  ipcMain.handle("plugins:removeMcpServer", (_e, name: string) => {
    removeMcpServer(typeof name === "string" ? name : "");
    return { ok: true };
  });
  ipcMain.handle("plugins:setSkillEnabled", (_e, args: { path: string; enabled: boolean }) => {
    setSkillEnabled(args.path, args.enabled);
    // A skill is loaded during pi startup. Recreate the warm spare so newly
    // opened tasks immediately observe enable/disable changes.
    dropWarmBridge();
    ensureWarmBridge();
    return { ok: true };
  });
  // Update installed extension packages. With no source, updates all of them
  // (`pi update --extensions`); with a source, updates just that package. pi
  // checks installed vs latest internally and only touches outdated packages.
  ipcMain.handle("plugins:updatePackages", async (_e, source?: string) => {
    const args = source ? ["update", source] : ["update", "--extensions"];
    let res;
    try {
      res = await runPiCli(args, { transferLabel: source ? "更新扩展包 " + nameOf(source) : "更新全部扩展包" });
    } catch (e) {
      if (e instanceof TransferCancelledError) return { ok: false, cancelled: true, output: "已取消" };
      throw e;
    }
    if (res.code === 0) {
      dropWarmBridge();
      ensureWarmBridge();
    }
    return { ok: res.code === 0, code: res.code, missing: classifyMissingTool(res.stdout + res.stderr), output: (res.stdout + res.stderr).trim() };
  });
  ipcMain.handle("skillsHub:leaderboard", () => getSkillsHubLeaderboard());
  ipcMain.handle("skillsHub:search", (_e, query: string) => searchSkillsHub(typeof query === "string" ? query : ""));
  ipcMain.handle("skillsHub:detail", (_e, skill: Parameters<typeof getSkillDetails>[0]) => getSkillDetails(skill));
  ipcMain.handle("skillsHub:install", async (_e, args: { source: string; skillId: string }) => {
    const result = await installSkillFromHub(args.source, args.skillId);
    if (result.ok) {
      // The official CLI writes to ~/.pi/agent/skills. Recreate the warm
      // bridge so a newly opened task can discover the skill immediately.
      dropWarmBridge();
      ensureWarmBridge();
    }
    return result;
  });

  // ---- automation (scheduled tasks) --------------------------------------
  ipcMain.handle("automation:getTasks", () => reloadConfig().automationTasks);
  ipcMain.handle("automation:saveTask", (_e, task: AutomationTask) => {
    const tasks = reloadConfig().automationTasks;
    const idx = tasks.findIndex((t) => t.id === task.id);
    const next = idx >= 0 ? tasks.map((t) => (t.id === task.id ? { ...t, ...task } : t)) : [...tasks, task];
    updateConfig({ automationTasks: next });
    return { ok: true };
  });
  ipcMain.handle("automation:deleteTask", (_e, id: string) => {
    removeAutomationTask(typeof id === "string" ? id : "");
    return { ok: true };
  });
  ipcMain.handle("automation:runNow", async (_e, id: string) => {
    await runTaskNow(id);
    return { ok: true };
  });

  // ---- messaging channels ----------------------------------------------------
  ipcMain.handle("messaging:getState", () => getMessagingState());
  ipcMain.handle("messaging:setConfig", (_e, patch?: Partial<FeishuChannelConfig>) => messagingSetConfig(patch || {}));

  // One-click app creation via QR scan (registerApp). Credentials are saved
  // in the main process on success; only client_id + user info cross IPC.
  ipcMain.handle("messaging:startAppRegistration", () => {
    startAppRegistration((event) => {
      send("pi:messagingRegistration", event);
      if (event.phase === "success") {
        // Re-apply the just-saved credentials: restarts the channel when it
        // is enabled + bound, and refreshes the renderer's state.
        try {
          send("pi:messaging", messagingSetConfig({}));
        } catch (err) {
          console.error("[messaging] post-registration apply failed:", err);
        }
      }
    });
  });
  ipcMain.handle("messaging:cancelAppRegistration", () => cancelAppRegistration());

  // ---- WeChat (iLink bot) channel --------------------------------------------
  ipcMain.handle("wechat:getState", () => getWeChatState());
  ipcMain.handle("wechat:setConfig", (_e, patch?: Partial<WeChatChannelConfig>) => wechatSetConfig(patch || {}));

  // QR onboarding: credentials are saved in the main process on success; only
  // bot id + user info cross IPC (the token never reaches the renderer).
  ipcMain.handle("wechat:startQrLogin", () => {
    startWeChatQrLogin((event) => {
      send("pi:wechatRegistration", event);
      if (event.phase === "success") {
        // Re-apply the just-saved credentials: restarts the channel when it is
        // enabled + bound, and refreshes the renderer's state.
        try {
          send("pi:messagingWechat", wechatSetConfig({}));
        } catch (err) {
          console.error("[wechat] post-login apply failed:", err);
        }
      }
    });
  });
  ipcMain.handle("wechat:cancelQrLogin", () => cancelWeChatQrLogin());
  ipcMain.handle("wechat:submitVerifyCode", (_e, code?: string) => submitWeChatVerifyCode(code || ""));

  // Enable the official Feishu MCP server with the channel's credentials.
  ipcMain.handle("messaging:enableFeishuMcp", () => {
    const cfg = sanitizeFeishuConfig(getConfig().feishuChannel);
    if (!cfg.appId || !cfg.appSecret) return { ok: false, error: "not_configured" };
    try {
      const res = upsertFeishuMcp(cfg.appId, cfg.appSecret);
      return { ok: true as const, ...res };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ---- update pi core -----------------------------------------------------
  ipcMain.handle("app:checkAppUpdate", () => checkForAppUpdate());
  ipcMain.handle("app:downloadAppUpdate", async () => downloadAppUpdate((p) => send("pi:appUpdate", p)));
  ipcMain.handle("app:installAppUpdate", () => installAppUpdate());
  // Pass the configured piCliPath so the comparison follows the same runtime
  // resolution as app:updatePi (dev mode / custom installs are not managed).
  ipcMain.handle("app:checkCoreUpdate", () => checkForCoreUpdate(getConfig().piCliPath));
  // Changelog opens in its own native window (not an in-app modal): nested
  // modals get trapped by ancestor containing blocks (.set-card:hover
  // transform / .settings-backdrop backdrop-filter) and can't be dismissed.
  ipcMain.handle("app:openChangelogWindow", () => {
    openChangelogWindow();
    return { ok: true };
  });

  ipcMain.handle("app:updatePi", async () => {
    // Resolve first so the source is known for sure (the old guard consulted
    // a cache that was empty when no thread had been opened yet — a race).
    let managed = false;
    let kind = runtimeKind();
    try {
      await resolvePiRuntime(getConfig().piCliPath);
      managed = isAppManagedRuntime();
      kind = runtimeKind();
    } catch {
      managed = false; // fall through to the CLI path, which surfaces the same error
    }

    if (managed) {
      // App-managed runtime (bundled or a previous in-app update): pi's own
      // `update` refuses these installs, so run our updater instead. It
      // installs the new tree under userData/runtime/versions/<version> and
      // switches current.json; new threads pick it up without replacing files
      // held by the currently running app.
      const result = await installCoreUpdate((p) => send("pi:coreUpdate", p));
      if (result.updated) {
        dropWarmBridge(); // standby runs the old version; respawn from the new tree
        ensureWarmBridge();
      }
      return {
        ok: result.ok,
        managed: true,
        kind,
        updated: result.updated,
        from: result.from ?? null,
        to: result.to ?? null,
        output: result.message,
        // Cancelled download surfaces as a neutral toast, not an error.
        ...(!result.ok && /已取消/.test(result.message) ? { cancelled: true } : {}),
      };
    }

    // System-installed pi (npm/pnpm global): it can self-update.
    let res;
    try {
      res = await runPiCli(["update"], { transferLabel: "更新 Pi CLI（系统安装）" });
    } catch (e) {
      if (e instanceof TransferCancelledError) return { ok: false, managed: false, cancelled: true, output: "已取消" };
      throw e;
    }
    resetPiRuntime(); // pick up the new version on next thread open
    return { ok: res.code === 0, managed: false, kind, code: res.code, output: (res.stdout + res.stderr).trim() };
  });

  ipcMain.handle("app:relaunch", () => {
    app.relaunch();
    app.exit(0);
  });

  // ---- dev release (one-click publish, dev mode only) --------------------
  // Pipeline lives in dev-release.ts; long-running child output is streamed
  // to the renderer as "pi:devReleaseLog" lines. The GitHub token never
  // crosses into the renderer — status only reports hasToken.
  ipcMain.handle("app:isDev", () => !app.isPackaged);
  // Repository root (only meaningful in a dev build): where the user-manual
  // skill, changelog.md and resources/user-manual*.md live. The renderer uses
  // it to open the manual-sync session with cwd = repo so the project-level
  // .pi/skills/user-manual skill is discovered.
  ipcMain.handle("app:getDevRepoRoot", () => (app.isPackaged ? null : app.getAppPath()));
  ipcMain.handle("app:devReleaseStatus", () => getDevReleaseStatus());
  // Stream each pipeline line to the main window AND the standalone log
  // window when it is open (the panel's inline box only shows a tail).
  ipcMain.handle("app:devReleaseStart", async () =>
    startDevRelease((line) => {
      send("pi:devReleaseLog", line);
      const lw = getDevReleaseLogWindow();
      if (lw && !lw.isDestroyed()) lw.webContents.send("pi:devReleaseLog", line);
    }),
  );
  ipcMain.handle("app:devReleaseCancel", () => cancelDevRelease());
  ipcMain.handle("app:openDevReleaseLogWindow", () => {
    openDevReleaseLogWindow();
    return { ok: true };
  });
  // Buffered history for the standalone log window (pulled on mount; live
  // lines keep streaming via pi:devReleaseLog afterwards).
  ipcMain.handle("app:getDevReleaseLog", () => getDevReleaseLogBuffer());
  // Data for the release-review conversation (dev panel「发起发版评审」).
  ipcMain.handle("app:getReleaseReview", () => getReleaseReview());

  // ---- feature test panel (dev only) -------------------------------------
  // Registry lives in tests/registry/*.json; the runner spawns L1/L2 commands
  // and streams child output as "pi:testLog" lines. Non-dev refuses outright.
  const requireDev = <T>(fn: () => T): T => {
    if (app.isPackaged) throw new Error("自动化测试面板仅在开发模式可用");
    return fn();
  };
  ipcMain.handle("tests:list", () => requireDev(() => listTests()));
  ipcMain.handle("tests:runLogic", (_e, args: { caseId: string; logicTest: string }) =>
    requireDev(() => runLogicTest(args.logicTest, (line) => send("pi:testLog", { caseId: args.caseId, line }))),
  );
  ipcMain.handle("tests:runScenario", (_e, args: { caseId: string; harnessCaseId: string }) =>
    requireDev(() => runScenarioCase(args.harnessCaseId, (line) => send("pi:testLog", { caseId: args.caseId, line }))),
  );
  ipcMain.handle("tests:readResult", (_e, args: { harnessCaseId: string }) => requireDev(() => readScenarioResult(args.harnessCaseId)));
  ipcMain.handle("tests:history", () => requireDev(() => readScenarioHistory()));

  // ---- edit menu (clipboard on the focused field) ------------------------
  ipcMain.handle("app:editAction", (_e, action: "copy" | "cut" | "paste" | "delete" | "selectAll") => {
    const wc = getWin()?.webContents;
    if (!wc) return { ok: false };
    if (action === "copy") wc.copy();
    else if (action === "cut") wc.cut();
    else if (action === "paste") wc.paste();
    else if (action === "delete") wc.delete();
    else if (action === "selectAll") wc.selectAll();
    return { ok: true };
  });

  // ---- window chrome (frameless) -----------------------------------------
  ipcMain.handle("window:setZoom", (_e, percent: unknown) => {
    const p =
      typeof percent === "number" && Number.isFinite(percent)
        ? Math.min(150, Math.max(50, Math.round(percent)))
        : 100;
    getWin()?.webContents.setZoomLevel(Math.log2(p / 100));
    return updateConfig({ zoomPercent: p });
  });
  ipcMain.handle("window:minimize", () => getWin()?.minimize());
  ipcMain.handle("window:maximize", () => {
    const w = getWin();
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  ipcMain.handle("window:close", () => {
    const w = getWin();
    if (!w || w.isDestroyed()) return false;
    // The custom title-bar close button is a hide-to-tray action. The native
    // BrowserWindow close listener below still covers Alt+F4 and other native
    // close paths.
    w.hide();
    return true;
  });

  // ---- background scheduler ----------------------------------------------
  startScheduler((p) => send("pi:automation", p));

  // ---- warm spare ----------------------------------------------------------
  // Boot one standby pi process so the first thread open is fast too.
  ensureWarmBridge();
}
