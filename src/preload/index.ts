import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import type {
  AppStoreEntry,
  AppVoiceTestResult,
  ComposerDraft,
  LogicRunResult,
  McpMarketDetail,
  McpMarketPage,
  McpServerInfo,
  NpmPackage,
  PermissionLevel,
  RegistryScan,
  ScenarioHistoryEntry,
  ScenarioRunResult,
  SkillHubSkill,
  TestRunLogLine,
  TransferInfo,
  TodoItem,
  TrashEntry,
} from "../renderer/src/lib/types";

/**
 * The renderer talks to the main process exclusively through this surface.
 * Keep it narrow and typed; the matching declaration lives in index.d.ts.
 */

type Unsub = () => void;
function on(channel: string, cb: (payload: any) => void): Unsub {
  const listener = (_e: IpcRendererEvent, payload: any) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

const api = {
  app: {
    getVersion: () => ipcRenderer.invoke("app:getVersion"),
    getConfig: () => ipcRenderer.invoke("app:getConfig"),
    setConfig: (patch: Record<string, unknown>) => ipcRenderer.invoke("app:setConfig", patch),
    getAutoLaunch: () => ipcRenderer.invoke("app:getAutoLaunch"),
    setAutoLaunch: (enabled: boolean) => ipcRenderer.invoke("app:setAutoLaunch", enabled),
    resolveRuntime: () => ipcRenderer.invoke("app:resolveRuntime"),
    getProjects: () => ipcRenderer.invoke("app:getProjects"),
    searchThreads: (query: string, includeArchived?: boolean) => ipcRenderer.invoke("app:searchThreads", query, includeArchived),
    getTotalUsage: () => ipcRenderer.invoke("app:getTotalUsage"),
    openProject: (absPath: string) => ipcRenderer.invoke("app:openProject", absPath),
    openFolderInExplorer: (absPath: string) => ipcRenderer.invoke("app:openFolderInExplorer", absPath),
    revealFileInExplorer: (absPath: string) => ipcRenderer.invoke("app:revealFileInExplorer", absPath),
    openPreviewWindow: (absPath: string, opts?: { atCursor?: boolean }) =>
      ipcRenderer.invoke("app:openPreviewWindow", absPath, opts),
    getUserManualPath: () => ipcRenderer.invoke("app:getUserManualPath"),
    closePreviewWindow: (absPath: string) => ipcRenderer.invoke("app:closePreviewWindow", absPath),
    previewWindowMoveStart: (absPath: string) => ipcRenderer.invoke("app:previewWindowMoveStart", absPath),
    previewWindowMoveEnd: (absPath: string) => ipcRenderer.invoke("app:previewWindowMoveEnd", absPath),
    onPreviewDockCandidate: (cb: (p: { path: string; x: number; y: number }) => void) =>
      on("preview:dock-candidate", cb),
    prewarm: (cwd: string) => ipcRenderer.invoke("app:prewarm", cwd),
    setProjectPinned: (args: { cwd: string; pinned: boolean }) => ipcRenderer.invoke("app:setProjectPinned", args),
    setThreadPinned: (args: { file: string; pinned: boolean }) => ipcRenderer.invoke("app:setThreadPinned", args),
    reorderPinned: (args: { kind: "project" | "thread"; id: string; target: number }) =>
      ipcRenderer.invoke("app:reorderPinned", args),
    showOpenDialog: (
      kind: "folder" | "file" | "files",
      opts?: { filters?: { name: string; extensions: string[] }[] },
    ) => ipcRenderer.invoke("app:showOpenDialog", kind, opts),
    getFileTree: (cwd: string, rel?: string) => ipcRenderer.invoke("app:getFileTree", cwd, rel),
    fileExists: (absPath: string) => ipcRenderer.invoke("app:fileExists", absPath),
    getPathForFile: (file: File) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return "";
      }
    },
    stageClipboardFile: (args: { name?: string; mimeType?: string; data: string }) =>
      ipcRenderer.invoke("app:stageClipboardFile", args),
    readPreview: (absPath: string, projectRoot?: string) => ipcRenderer.invoke("app:readPreview", absPath, projectRoot),
    savePreviewHtml: (args: { absPath: string; projectRoot?: string; html: string }) =>
      ipcRenderer.invoke("app:savePreviewHtml", args),
    showFileContextMenu: (absPath: string) => ipcRenderer.invoke("app:showFileContextMenu", absPath),
    updatePi: () => ipcRenderer.invoke("app:updatePi"),
    checkAppUpdate: () => ipcRenderer.invoke("app:checkAppUpdate"),
    downloadAppUpdate: () => ipcRenderer.invoke("app:downloadAppUpdate"),
    installAppUpdate: () => ipcRenderer.invoke("app:installAppUpdate"),
    checkCoreUpdate: () => ipcRenderer.invoke("app:checkCoreUpdate"),
    /** Open (or focus) the standalone changelog window. */
    openChangelogWindow: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("app:openChangelogWindow"),
    relaunch: () => ipcRenderer.invoke("app:relaunch"),
    isDev: (): Promise<boolean> => ipcRenderer.invoke("app:isDev"),
    getDevRepoRoot: (): Promise<string | null> => ipcRenderer.invoke("app:getDevRepoRoot"),
    devReleaseStatus: (): Promise<{
      isDev: boolean;
      running: boolean;
      currentVersion: string | null;
      nextVersion: string | null;
      dirtyFiles: string[];
      hasToken: boolean;
    }> => ipcRenderer.invoke("app:devReleaseStatus"),
    devReleaseStart: (): Promise<{ ok: boolean; version?: string; error?: string; cancelled?: boolean }> =>
      ipcRenderer.invoke("app:devReleaseStart"),
    devReleaseCancel: () => ipcRenderer.invoke("app:devReleaseCancel") as Promise<{ ok: boolean; error?: string }>,
    /** Open (or focus) the standalone pipeline-log window. */
    openDevReleaseLogWindow: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("app:openDevReleaseLogWindow"),
    /** Buffered pipeline history for the standalone log window (oldest first). */
    getDevReleaseLog: (): Promise<string[]> => ipcRenderer.invoke("app:getDevReleaseLog"),
    /** Release-review data: next version + working-tree Unreleased content + workspace state. */
    getReleaseReview: () =>
      ipcRenderer.invoke("app:getReleaseReview") as Promise<{
        ok: boolean;
        error?: string;
        cwd?: string;
        currentVersion?: string;
        nextVersion?: string;
        unreleasedMarkdown?: string;
        hasEntries?: boolean;
        dirtyFiles?: string[];
        hasToken?: boolean;
      }>,
    editAction: (action: "copy" | "cut" | "paste" | "delete" | "selectAll") => ipcRenderer.invoke("app:editAction", action),
  },
  transfers: {
    /** Snapshot of in-flight transfers (late-subscriber catch-up). */
    getSnapshot: (): Promise<TransferInfo[]> => ipcRenderer.invoke("transfers:snapshot"),
    on: (cb: (list: TransferInfo[]) => void) => on("pi:transfers", cb),
    cancel: (id: string): Promise<boolean> => ipcRenderer.invoke("transfers:cancel", id),
  },
  drafts: {
    getAll: (): Promise<Record<string, ComposerDraft>> => ipcRenderer.invoke("drafts:getAll"),
    set: (key: string, draft: ComposerDraft) => ipcRenderer.invoke("drafts:set", key, draft),
    delete: (key: string) => ipcRenderer.invoke("drafts:delete", key),
  },
  dataMigration: {
    status: (): Promise<{
      sessionStorageDir: string | null;
      defaultSessionsDir: string;
      effectiveSessionsDir: string;
      todoDataDir: string | null;
      effectiveTodosDir: string;
      pendingSessions: boolean;
      pendingTodos: boolean;
      lastSummary: {
        sessionsMoved?: number;
        sessionBytes?: number;
        todoFilesMoved?: number;
        todoBytes?: number;
        errors: string[];
      } | null;
    }> => ipcRenderer.invoke("data-migration:status"),
    preview: (kind: "sessions" | "todos", dir: string | null) =>
      ipcRenderer.invoke("data-migration:preview", kind, dir) as Promise<{
        ok: boolean;
        pending: boolean;
        count: number;
        bytes: number;
      }>,
    setSessionsDir: (dir: string | null) =>
      ipcRenderer.invoke("data-migration:set-sessions-dir", dir) as Promise<{
        ok: boolean;
        error?: string;
        pending: boolean;
        count: number;
        bytes: number;
      }>,
    setTodosDir: (dir: string | null) =>
      ipcRenderer.invoke("data-migration:set-todos-dir", dir) as Promise<{
        ok: boolean;
        error?: string;
        pending: boolean;
        count: number;
        bytes: number;
      }>,
  },
  todo: {
    list: (): Promise<TodoItem[]> => ipcRenderer.invoke("todo:list"),
    add: (args: { cwd?: string; title?: string; note?: string; dueDate?: string | null; dueTime?: string | null }): Promise<TodoItem | null> =>
      ipcRenderer.invoke("todo:add", args),
    update: (
      id: string,
      patch: { title?: string; note?: string; dueDate?: string | null; dueTime?: string | null }
    ): Promise<TodoItem | null> => ipcRenderer.invoke("todo:update", id, patch),
    toggle: (id: string): Promise<TodoItem | null> => ipcRenderer.invoke("todo:toggle", id),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke("todo:delete", id),
    clearCompleted: (cwd?: string | null): Promise<number> => ipcRenderer.invoke("todo:clearCompleted", cwd ?? null),
    /** Native file dialog; main reads the files itself. */
    addFiles: (id: string): Promise<{ item: TodoItem | null; added: number; skipped: string[]; errors: string[] }> =>
      ipcRenderer.invoke("todo:addFiles", id),
    /** Paste / drag-drop from the renderer (ArrayBuffers cross IPC). */
    addAttachments: (
      id: string,
      files: Array<{ name?: string; mime?: string; size?: number; data: ArrayBuffer }>
    ): Promise<{ item: TodoItem | null; added: number; skipped: string[]; errors: string[] }> => ipcRenderer.invoke("todo:addAttachments", id, files),
    removeAttachment: (id: string, attId: string): Promise<TodoItem | null> =>
      ipcRenderer.invoke("todo:removeAttachment", id, attId),
    /** Open a non-image attachment with the system app; returns "" on success. */
    openAttachment: (file: string): Promise<string> => ipcRenderer.invoke("todo:openAttachment", file),
  },
  plugins: {
    getPackages: () => ipcRenderer.invoke("plugins:getPackages"),
    getPackageInfo: (source: string) => ipcRenderer.invoke("plugins:getPackageInfo", source),
    setPackageEnabled: (source: string, enabled: boolean) => ipcRenderer.invoke("plugins:setPackageEnabled", { source, enabled }),
    installPackage: (source: string) => ipcRenderer.invoke("plugins:installPackage", source),
    removePackage: (source: string) => ipcRenderer.invoke("plugins:removePackage", source),
    getSkills: (cwd?: string) => ipcRenderer.invoke("plugins:getSkills", cwd),
    getSkillContent: (path: string) => ipcRenderer.invoke("plugins:getSkillContent", path),
    setSkillEnabled: (path: string, enabled: boolean) => ipcRenderer.invoke("plugins:setSkillEnabled", { path, enabled }),
    updatePackages: (source?: string) => ipcRenderer.invoke("plugins:updatePackages", source),
    searchNpmPackages: (query: string): Promise<NpmPackage[]> => ipcRenderer.invoke("plugins:npmSearch", query),
    getNpmReadme: (name: string): Promise<string> => ipcRenderer.invoke("plugins:npmReadme", name),
    searchMcpMarket: (query: string, page?: number): Promise<McpMarketPage> =>
      ipcRenderer.invoke("plugins:mcpMarketSearch", { query, page }),
    getMcpMarketDetail: (id: string): Promise<McpMarketDetail> => ipcRenderer.invoke("plugins:mcpMarketDetail", id),
    getMcpServers: (): Promise<McpServerInfo[]> => ipcRenderer.invoke("plugins:getMcpServers"),
    setMcpServerDisabled: (name: string, disabled: boolean) => ipcRenderer.invoke("plugins:setMcpServerDisabled", { name, disabled }),
    removeMcpServer: (name: string) => ipcRenderer.invoke("plugins:removeMcpServer", name),
    getSkillsHubLeaderboard: () => ipcRenderer.invoke("skillsHub:leaderboard"),
    searchSkillsHub: (query: string) => ipcRenderer.invoke("skillsHub:search", query),
    getSkillDetails: (skill: SkillHubSkill) => ipcRenderer.invoke("skillsHub:detail", skill),
    installSkill: (args: { source: string; skillId: string }) => ipcRenderer.invoke("skillsHub:install", args),
  },
  automation: {
    getTasks: () => ipcRenderer.invoke("automation:getTasks"),
    saveTask: (task: unknown) => ipcRenderer.invoke("automation:saveTask", task),
    deleteTask: (id: string) => ipcRenderer.invoke("automation:deleteTask", id),
    runNow: (id: string) => ipcRenderer.invoke("automation:runNow", id),
  },
  tests: {
    // dev-only「自动化测试」面板：注册表在 tests/registry/*.json，运行输出流式返回。
    list: (): Promise<RegistryScan> => ipcRenderer.invoke("tests:list"),
    runLogic: (args: { caseId: string; logicTest: string }): Promise<LogicRunResult> =>
      ipcRenderer.invoke("tests:runLogic", args),
    runScenario: (args: { caseId: string; harnessCaseId: string }): Promise<ScenarioRunResult> =>
      ipcRenderer.invoke("tests:runScenario", args),
    readResult: (args: { harnessCaseId: string }): Promise<ScenarioRunResult> =>
      ipcRenderer.invoke("tests:readResult", args),
    history: (): Promise<ScenarioHistoryEntry[]> => ipcRenderer.invoke("tests:history"),
  },
  messaging: {
    getState: () => ipcRenderer.invoke("messaging:getState"),
    setConfig: (patch: unknown) => ipcRenderer.invoke("messaging:setConfig", patch),
    startAppRegistration: () => ipcRenderer.invoke("messaging:startAppRegistration"),
    cancelAppRegistration: () => ipcRenderer.invoke("messaging:cancelAppRegistration"),
    enableFeishuMcp: (): Promise<{ ok: boolean; error?: string; name?: string; existed?: boolean }> =>
      ipcRenderer.invoke("messaging:enableFeishuMcp"),
  },
  wechat: {
    getState: () => ipcRenderer.invoke("wechat:getState"),
    setConfig: (patch: unknown) => ipcRenderer.invoke("wechat:setConfig", patch),
    startQrLogin: () => ipcRenderer.invoke("wechat:startQrLogin"),
    cancelQrLogin: () => ipcRenderer.invoke("wechat:cancelQrLogin"),
    submitVerifyCode: (code: string) => ipcRenderer.invoke("wechat:submitVerifyCode", code),
  },
  remote: {
    getStatus: () => ipcRenderer.invoke("remote:getStatus"),
    createPairing: (autoApprove = false) => ipcRenderer.invoke("remote:createPairing", { autoApprove }),
    getPhoneApp: () => ipcRenderer.invoke("remote:getPhoneApp"),
    enableSignaling: (manual = false) => ipcRenderer.invoke("remote:enableSignaling", { manual }),
    disableSignaling: () => ipcRenderer.invoke("remote:disableSignaling"),
    approvePairing: (connectionId: string) => ipcRenderer.invoke("remote:approvePairing", connectionId),
    rejectPairing: (connectionId: string) => ipcRenderer.invoke("remote:rejectPairing", connectionId),
    revokeDevice: (deviceId: string) => ipcRenderer.invoke("remote:revokeDevice", deviceId),
    getTransportConfig: () => ipcRenderer.invoke("remote:getTransportConfig"),
    setConfig: (patch: { signalingUrl?: string }) => ipcRenderer.invoke("remote:setConfig", patch),
    getRelayStatus: () => ipcRenderer.invoke("remote:getRelayStatus"),
    onRelayState: (cb: (p: { state: string; relayUrl: string; lastError: string | null }) => void) => on("remote:relay-state", cb),
    transportOpen: (args: { connectionId: string; sessionId?: string }) => ipcRenderer.invoke("remote:transportOpen", args),
    transportClose: (args: { connectionId: string; reason?: string }) => ipcRenderer.invoke("remote:transportClose", args),
    transportStatus: (args: { connectionId: string; state?: string; candidateType?: string; localCandidateType?: string; remoteCandidateType?: string }) =>
      ipcRenderer.invoke("remote:transportStatus", args),
    transportFrame: (args: { connectionId: string; frame: string }) => ipcRenderer.invoke("remote:transportFrame", args),
    sendSignal: (args: { connectionId: string; payload: Record<string, unknown> }) => ipcRenderer.invoke("remote:sendSignal", args),
    onSignal: (cb: (p: { connectionId: string; message: any }) => void) => on("remote:signal", cb),
    onOutbound: (cb: (p: { connectionId: string; frame: string }) => void) => on("remote:outbound", cb),
    onPairingRequest: (cb: (p: { connectionId: string; deviceId: string; deviceName: string }) => void) => on("remote:pairing-request", cb),
  },
  thread: {
    open: (args: { cwd: string; sessionFile?: string; name?: string; permission?: PermissionLevel }) => ipcRenderer.invoke("thread:open", args),
    loadHistory: (args: { cwd: string; sessionFile: string }) => ipcRenderer.invoke("thread:loadHistory", args),
    close: (threadId: string) => ipcRenderer.invoke("thread:close", threadId),
    delete: (args: { file: string; title?: string; cwd?: string }) => ipcRenderer.invoke("thread:delete", args),
    prompt: (args: { threadId: string; text: string; images?: unknown[]; attachments?: { abs: string; name: string }[] }) =>
      ipcRenderer.invoke("thread:prompt", args),
    steer: (args: { threadId: string; text: string; images?: unknown[]; attachments?: { abs: string; name: string }[] }) =>
      ipcRenderer.invoke("thread:steer", args),
    followUp: (args: { threadId: string; text: string; images?: unknown[]; attachments?: { abs: string; name: string }[] }) =>
      ipcRenderer.invoke("thread:followUp", args),
    abort: (threadId: string) => ipcRenderer.invoke("thread:abort", threadId),
    compact: (args: { threadId: string; instructions?: string }) => ipcRenderer.invoke("thread:compact", args),
    repairSession: (args: { threadId?: string; sessionFile: string }) => ipcRenderer.invoke("thread:repair-session", args),
    setModel: (args: { threadId: string; provider: string; modelId: string }) => ipcRenderer.invoke("thread:setModel", args),
    // P1-12 auto mode toggle. Exiting stops monitoring for this thread.
    setAutoModel: (args: { threadId: string; enabled: boolean }) =>
      ipcRenderer.invoke("thread:setAutoModel", args) as Promise<{ ok: boolean; initial?: { provider: string; id: string } | null }>,
    refreshModels: (threadId: string) => ipcRenderer.invoke("thread:refreshModels", threadId),
    setThinking: (args: { threadId: string; level: string }) => ipcRenderer.invoke("thread:setThinking", args),
    getThinkingLevels: (threadId: string) => ipcRenderer.invoke("thread:getThinkingLevels", threadId),
    newSession: (threadId: string) => ipcRenderer.invoke("thread:newSession", threadId),
    getBranchMessages: (threadId: string) => ipcRenderer.invoke("thread:getBranchMessages", threadId),
    fork: (args: { threadId: string; entryId: string }) => ipcRenderer.invoke("thread:fork", args),
    clone: (args: { threadId: string }) => ipcRenderer.invoke("thread:clone", args),
    setName: (args: { threadId: string; name: string }) => ipcRenderer.invoke("thread:setName", args),
    getStats: (threadId: string) => ipcRenderer.invoke("thread:getStats", threadId),
    getCompactionStats: (sessionFile: string) => ipcRenderer.invoke("thread:compaction-stats", { sessionFile }),
    extuiResponse: (args: { threadId: string; id: string; payload: Record<string, unknown> }) =>
      ipcRenderer.invoke("thread:extuiResponse", args),
    setPermission: (args: { threadId: string; permission: PermissionLevel }) => ipcRenderer.invoke("thread:setPermission", args),
    // Task-mode behaviour state (instructions + spec doc + enforce floor) for
    // the mpi-taskmode extension; empty content clears it. Takes effect on the
    // next turn.
    setTaskMode: (args: { threadId: string; modeId?: string; instructions?: string; specFile?: string; enforce?: string }) =>
      ipcRenderer.invoke("thread:setTaskMode", args),
  },
  trash: {
    list: (): Promise<TrashEntry[]> => ipcRenderer.invoke("trash:list"),
    restore: (id: string) => ipcRenderer.invoke("trash:restore", id),
    purge: (id: string) => ipcRenderer.invoke("trash:purge", id),
    empty: () => ipcRenderer.invoke("trash:empty"),
  },
  backup: {
    listSessions: (): Promise<{ dirName: string; count: number; totalBytes: number }[]> =>
      ipcRenderer.invoke("backup:listSessions"),
    /** Save dialog + write. Returns null when the user cancels. */
    exportConfig: (): Promise<null | { ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke("backup:exportConfig"),
    /** Open dialog + read/sanitize only (no side effects). null = canceled. */
    pickConfigImport: (): Promise<
      | null
      | { ok: false; error: string }
      | { ok: true; path: string; fields: string[]; patch: Record<string, unknown> }
    > => ipcRenderer.invoke("backup:pickConfigImport"),
    /** Save dialog + zip the selected session dirs. null = canceled. */
    exportSessions: (dirNames: string[]): Promise<null | { ok: boolean; path?: string; count?: number; error?: string }> =>
      ipcRenderer.invoke("backup:exportSessions", dirNames),
    /** Open dialog + inspect zip without writing. null = canceled. */
    pickSessionImport: (): Promise<
      | null
      | { ok: false; error: string }
      | { ok: true; path: string; total: number; newCount: number; existingCount: number }
    > => ipcRenderer.invoke("backup:pickSessionImport"),
    importSessions: (args: {
      path: string;
      policy: "skip" | "overwrite";
    }): Promise<{ ok: boolean; imported?: number; skipped?: number; overwritten?: number; error?: string }> =>
      ipcRenderer.invoke("backup:importSessions", args),
  },
  voice: {
    /** Transcribe a base64 WAV recording (16 kHz mono) with the configured STT
     * backend. `error` is either an i18n key (voice.stt.*) or an API detail. */
    transcribe: (args: { dataBase64: string }) =>
      ipcRenderer.invoke("voice:transcribe", args) as Promise<{ ok: boolean; text?: string; error?: string }>,
    /** Connectivity probe for the Settings test button (short silent WAV). */
    test: () =>
      ipcRenderer.invoke("voice:test") as Promise<{ ok: boolean; text?: string; error?: string }>,
    /** Synthesize text with an Edge neural voice (base64 MP3). `voice`/`rate`
     * override the saved config (used by the Settings preview of the draft). */
    synthesize: (args: { text: string; voice?: string; rate?: number }) =>
      ipcRenderer.invoke("voice:synthesize", args) as Promise<{
        ok: boolean;
        audioBase64?: string;
        mime?: string;
        error?: string;
      }>,
  },
  apps: {
    /** Installed entries merged with enable/status state. */
    list: (): Promise<AppStoreEntry[]> => ipcRenderer.invoke("apps:list"),
    /** Pick a .zip app package and load it. Returns null when the dialog is cancelled. */
    installZip: (): Promise<AppStoreEntry | null> => ipcRenderer.invoke("apps:installZip"),
    /** Pick an unpacked app directory (developer workflow). Null when cancelled. */
    installDir: (): Promise<AppStoreEntry | null> => ipcRenderer.invoke("apps:installDir"),
    uninstall: (id: string) => ipcRenderer.invoke("apps:uninstall", id),
    setEnabled: (id: string, enabled: boolean): Promise<AppStoreEntry> =>
      ipcRenderer.invoke("apps:setEnabled", { id, enabled }),
    getConfig: (id: string): Promise<Record<string, string>> => ipcRenderer.invoke("apps:getConfig", id),
    saveConfig: (id: string, values: Record<string, string>): Promise<Record<string, string>> =>
      ipcRenderer.invoke("apps:saveConfig", { id, values }),
    /** Draft STT probe with unsaved form values (no config write). */
    testVoice: (id: string, values: Record<string, string>): Promise<AppVoiceTestResult> =>
      ipcRenderer.invoke("apps:testVoice", { id, values }),
    /** v2: rolling service log lines for an installed app. */
    logs: (id: string): Promise<string[]> => ipcRenderer.invoke("apps:logs", id),
    /** v2: restart an enabled app's service (no config rewrite). */
    restart: (id: string): Promise<AppStoreEntry> => ipcRenderer.invoke("apps:restart", id),
  },
  tui: {
    start: (args: { threadId: string; cwd: string; sessionFile?: string | null }) =>
      ipcRenderer.invoke("tui:start", args) as Promise<{ ok: boolean; error?: string; gen?: number }>,
    write: (threadId: string, data: string) => ipcRenderer.invoke("tui:write", { threadId, data }),
    resize: (threadId: string, cols: number, rows: number) =>
      ipcRenderer.invoke("tui:resize", { threadId, cols, rows }),
    // `gen` makes the stop conditional: it only kills the PTY owned by that
    // generation, so a stale effect's cleanup can't kill a newer terminal.
    stop: (threadId: string, gen?: number) => ipcRenderer.invoke("tui:stop", { threadId, gen }),
    onData: (cb: (p: { threadId: string; data: string }) => void) => on("tui:data", cb),
    onExit: (cb: (p: { threadId: string; code: number | null }) => void) => on("tui:exit", cb),
  },
  settings: {
    getModels: () => ipcRenderer.invoke("settings:getModels"),
    testModel: (args: { providerId: string; provider: Record<string, unknown>; modelId: string }) =>
      ipcRenderer.invoke("settings:testModel", args),
    saveModels: (providers: Record<string, unknown>) => ipcRenderer.invoke("settings:saveModels", providers),
    resolveModelContext: (args: { providerId: string; provider: Record<string, unknown>; model: Record<string, unknown> }) =>
      ipcRenderer.invoke("settings:resolveModelContext", args),
    getThinking: () => ipcRenderer.invoke("settings:getThinking"),
    saveThinking: (patch: Record<string, unknown>) => ipcRenderer.invoke("settings:saveThinking", patch),
    getDiagnostics: () => ipcRenderer.invoke("settings:getDiagnostics"),
    recheckShell: () => ipcRenderer.invoke("settings:recheckShell"),
    openGitDownload: () => ipcRenderer.invoke("settings:openGitDownload"),
    getPaths: () => ipcRenderer.invoke("settings:getPaths"),
    openPath: (abs: string) => ipcRenderer.invoke("settings:openPath", abs),
    showItem: (abs: string) => ipcRenderer.invoke("settings:showItem", abs),
    openAgentDir: () => ipcRenderer.invoke("settings:openAgentDir"),
  },
  window: {
    setZoom: (percent: number) => ipcRenderer.invoke("window:setZoom", percent),
    minimize: () => ipcRenderer.invoke("window:minimize"),
    maximize: () => ipcRenderer.invoke("window:maximize"),
    close: () => ipcRenderer.invoke("window:close"),
  },
  diag: {
    // Field diagnostics: one JSON line per call, appended to
    // userData/logs/mpi-diag.log by the main process (see src/main/diag-log.ts).
    log: (line: string) => ipcRenderer.invoke("diag:log", line),
  },
  on: {
    event: (cb: (p: { threadId: string; event: any }) => void) => on("pi:event", cb),
    extui: (cb: (p: { threadId: string; request: any }) => void) => on("pi:extui", cb),
    exit: (cb: (p: { threadId: string; code: number | null; signal: string | null; stderr: string }) => void) => on("pi:exit", cb),
    error: (cb: (p: { threadId: string; message: string }) => void) => on("pi:error", cb),
    focusThread: (cb: (p: { threadId: string }) => void) => on("app:focus-thread", cb),
    // P1-12 auto model switch / warning notifications.
    autoModel: (cb: (p: {
      threadId: string;
      kind: "switch" | "warn";
      from?: { provider: string; id: string };
      to?: { provider: string; id: string };
      reason: string;
      usedPaid?: boolean;
      downgraded?: boolean;
    }) => void) => on("pi:autoModel", cb),
    // Agent-initiated permission switch approved (mpi_request_mode_switch):
    // main already flipped the gate + cleared the enforced task mode.
    modeSwitched: (cb: (p: { threadId: string; permission: PermissionLevel; taskMode: null }) => void) => on("pi:modeSwitched", cb),
    automation: (cb: (p: { type: "start" | "done"; taskId: string; name: string; ok?: boolean; error?: string }) => void) =>
      on("pi:automation", cb),
    messaging: (cb: (p: {
      status: "off" | "connecting" | "connected" | "reconnecting" | "error";
      lastError: string | null;
      configured: boolean;
      appIdMasked: string | null;
      projectCwd: string;
      permission: PermissionLevel;
    }) => void) => on("pi:messaging", cb),
    messagingRegistration: (cb: (p: {
      phase: "qr_ready" | "status" | "success" | "error";
      url?: string;
      expireIn?: number;
      status?: "polling" | "slow_down" | "domain_switched";
      clientId?: string;
      openId?: string;
      code?: string;
      description?: string;
    }) => void) => on("pi:messagingRegistration", cb),
    messagingWechat: (cb: (p: {
      status: "off" | "connecting" | "connected" | "reconnecting" | "error";
      lastError: string | null;
      configured: boolean;
      botIdMasked: string | null;
      projectCwd: string;
      permission: PermissionLevel;
    }) => void) => on("pi:messagingWechat", cb),
    wechatRegistration: (cb: (p: {
      phase: "qr_ready" | "status" | "need_verifycode" | "success" | "error";
      url?: string;
      status?: "polling" | "scanned";
      botId?: string;
      userId?: string;
      code?: string;
      description?: string;
    }) => void) => on("pi:wechatRegistration", cb),
    todoChanged: (cb: () => void) => on("pi:todo-changed", cb),
    projectsChanged: (cb: (p: { cwd?: string; sessionFile?: string }) => void) => on("pi:projects-changed", cb),
    appUpdate: (cb: (p: { stage: string; message: string; pct?: number }) => void) => on("pi:appUpdate", cb),
    coreUpdate: (cb: (p: { stage: string; message: string; pct?: number }) => void) => on("pi:coreUpdate", cb),
    devReleaseLog: (cb: (line: string) => void) => on("pi:devReleaseLog", cb),
    testLog: (cb: (p: TestRunLogLine) => void) => on("pi:testLog", cb),
  },
};

contextBridge.exposeInMainWorld("pi", api);

export type PiApi = typeof api;
