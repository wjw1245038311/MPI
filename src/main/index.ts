import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { app, BrowserWindow, dialog, Menu, shell, Tray } from "electron";
import { loadConfig, getConfig, updateConfig } from "./config";
import { flushDrafts } from "./draft-store";
import { runPendingDataMigrations } from "./data-migration";
import { ensureKnowledgeDirConfigured } from "./knowledge-dir";
import { ensureZhiyaFiles, migrateUserProfileToZhiya, zhiyaMasterDir } from "./zhiya";
import { flushTodos, ingestInbox } from "./todo-store";
import { cleanupOldRuntimes, readManagedPiStatus } from "./core-updater";
import { registerHtmlPreviewProtocol, registerHtmlPreviewScheme } from "./html-preview-protocol";
import { registerPdfViewerProtocol, registerPdfViewerScheme } from "./pdf-viewer-protocol";
import { registerTodoAttachmentProtocol, registerTodoAttachmentScheme } from "./todo-attachment-protocol";
import { registerChatAttachmentProtocol, registerChatAttachmentScheme } from "./chat-attachment-protocol";
import { collectReferencedAttachmentNames } from "./attachment-gc";
import { getSessionsDir, listAllSessionFiles } from "./session-store";
import { threadUuidFromSessionFile } from "./messaging/channel-threads";
import { pruneThreadKeyedMaps } from "./thread-config";
import { pruneChatAttachments } from "./chat-attachment-store";
import { appendDiagLog, diagLogPath } from "./diag-log";
import { writeJsonAtomic } from "./json-store";
import {
  crashGuardSummary,
  emptyCrashGuardState,
  markSoftwareRendering,
  recordGpuCrash,
  recordRendererCrash,
  sanitizeCrashGuardState,
  type CrashGuardState,
} from "./crash-guard";
import { closeSplashWindow, createSplashWindow } from "./splash";
import { registerIpc, stopAllBridges, stopRemoteHost } from "./ipc";

/**
 * 启动耗时基线（2026-10-18）。用户反馈「每次打开要 10 来秒」，但日志里看不出卡在哪。
 * 在 4 个关键边界各记一条 `boot <阶段> <毫秒>`（相对**进程启动**，含模块加载）：
 *   require-done → when-ready → ipc-registered → window-ready-to-show
 * 看差值就知道是主进程初始化慢（含原生模块/asar 加载），还是渲染层首屏慢。
 */
const bootMark = (stage: string) => appendDiagLog(`boot ${stage} ${Math.round(performance.now())}ms`);
import { stopMemoryEndpoint } from "./memory-endpoint";
import { disposeMemoryIndex } from "./memory-service";
import { ensureBackfilled as backfillObservedTools } from "./observed-tools";
import { activateAutostartApps, deactivateAllServices, killAllManagedProcesses } from "./app-store";
import { migrateToBuiltinMcp, normalizeMcpDisabledFlags } from "./plugins";
import { startDevReleaseProgressTail } from "./dev-release-progress";
import { stopAutomations, stopScheduler } from "./automation";
import { stopMessaging } from "./messaging/service";
import { stopWeChatMessaging } from "./messaging/wechat-service";
import { stopAllTuis } from "./tui";

const IS_DEV_BUILD = !app.isPackaged;
const APP_USER_MODEL_ID = IS_DEV_BUILD ? "com.mpi.app.dev" : "com.mpi.app";

// Establish the product identity before Electron creates any windows or jump
// list entries. Packaged builds also carry the matching executable metadata;
// development builds still run as electron.exe at the OS process level.
app.setName(IS_DEV_BUILD ? "MPI Dev" : "MPI");
// Keep `npm run dev` independent from an installed MPI instance. Both
// otherwise share Electron's default userData lock, so the dev process can
// silently hand its launch to the already-running packaged app and show old
// window/tray behavior instead of the source currently being edited.
if (IS_DEV_BUILD) app.setPath("userData", join(app.getPath("appData"), "MPI Dev"));
if (process.platform === "win32") app.setAppUserModelId(APP_USER_MODEL_ID);

/* ---------------------- 崩溃有界恢复（crash-guard） ---------------------- */

/**
 * 见 crash-guard.ts 的文件头。这里只负责「落盘 + 按判定执行」。
 * 状态文件放 userData/crash-guard.json：**跨启动累计**，否则「重启一次就好」的
 * 坏驱动场景永远升级不到软件渲染。
 */
function crashGuardPath(): string {
  return join(app.getPath("userData"), "crash-guard.json");
}

function loadCrashGuard(): CrashGuardState {
  try {
    return sanitizeCrashGuardState(JSON.parse(readFileSync(crashGuardPath(), "utf8")));
  } catch {
    return emptyCrashGuardState();
  }
}

function saveCrashGuard(state: CrashGuardState): void {
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeJsonAtomic(crashGuardPath(), JSON.stringify(state, null, 2));
  } catch (error: any) {
    // 写不进去只影响「下次启动还能不能记住」，不能影响本次运行。
    console.warn("[crash-guard] save failed:", error?.message || String(error));
  }
}

let crashGuard: CrashGuardState = loadCrashGuard();
// disableHardwareAcceleration 必须在 ready 之前调用，所以放在模块顶层。
if (crashGuard.softwareRendering) {
  app.disableHardwareAcceleration();
  // eslint-disable-next-line no-console
  console.warn(`[crash-guard] 已禁用硬件加速（${crashGuard.softwareRenderingReason || "上次启动崩溃恢复"}）`);
}

/** 落盘「下次软件渲染」并重启。只在用户已无法正常操作界面时调用。 */
function relaunchWithSoftwareRendering(reason: string): void {
  crashGuard = markSoftwareRendering(crashGuard, reason);
  saveCrashGuard(crashGuard);
  appendDiagLog(`crash-guard relaunch software-render reason=${reason}`);
  try {
    app.relaunch();
    app.exit(0);
  } catch (error: any) {
    appendDiagLog(`crash-guard relaunch failed: ${error?.message || String(error)}`);
  }
}

/** 渲染进程反复崩溃、软件渲染也救不回来时的最后一步：交给用户，不再自动重启。 */
async function handleRendererGiveUp(crashes: number, reason: string): Promise<void> {
  const zh = getConfig().language === "zh";
  const { response } = await dialog.showMessageBox({
    type: "error",
    title: "MPI",
    message: zh ? "界面进程反复崩溃" : "The UI process keeps crashing",
    detail: zh
      ? `最近 10 分钟内崩溃 ${crashes} 次（${reason}）。已尝试软件渲染仍未稳定。\n\n可以再以软件渲染重启一次；若仍不行，请退出后把日志发给我们：\n${diagLogPath()}`
      : `Crashed ${crashes} times in the last 10 minutes (${reason}), even with software rendering.\n\nYou can restart once more in software rendering, or quit and send us the log:\n${diagLogPath()}`,
    buttons: zh ? ["以软件渲染重启", "退出"] : ["Restart in software rendering", "Quit"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) relaunchWithSoftwareRendering("renderer-crash-give-up");
  else app.quit();
}

/** GPU 子进程崩溃：不 relaunch（界面还活着），只标记下次软件渲染。 */
app.on("child-process-gone", (_event, details) => {
  if (details.type !== "GPU") return;
  const result = recordGpuCrash(crashGuard, Date.now(), String(details.reason));
  crashGuard = result.state;
  appendDiagLog(
    `crash-guard gpu-gone reason=${details.reason} exit=${details.exitCode} inWindow=${result.crashesInWindow} fallback=${result.shouldFallbackToSoftware ? 1 : 0}`,
  );
  if (result.shouldFallbackToSoftware) {
    crashGuard = markSoftwareRendering(crashGuard, "gpu-process-crashed");
    console.warn("[crash-guard] GPU 反复崩溃，下次启动改用软件渲染");
  }
  saveCrashGuard(crashGuard);
});

registerHtmlPreviewScheme();
registerPdfViewerScheme();
registerTodoAttachmentScheme();
// 聊天里的视频附件（渲染层 <video src=chatatt://…>，见 chat-attachment-protocol.ts）
registerChatAttachmentScheme();

// Keep the legacy resources/bundled lookup available for older developer
// builds. New packaged releases carry the standalone runtime archive in the
// installer and extract it into userData on first use.
{
  const candidates = [
    join(app.getAppPath(), "resources", "bundled"),
    join((process as any).resourcesPath || "", "bundled"),
  ];
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, "pi", "dist", "cli.js"))) {
      process.env.PI_BUNDLED_DIR = dir;
      break;
    }
  }
}

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
const getWin = () => mainWindow;

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Resolve the app icon for the live window (dev + packaged).
 *
 * Windows Explorer caches icons per file path: replacing an .ico at a stable
 * path (repo resources/ in dev, install dir on upgrades) keeps showing the old
 * image in the taskbar. Copying to a content-addressed name under userData
 * guarantees a fresh path whenever the icon bytes change. */
function resolveWindowIcon(): string | undefined {
  const names = process.platform === "win32" ? ["icon.ico", "icon.png"] : ["icon.png"];
  const candidates = names.flatMap((name) => [
    join(app.getAppPath(), "resources", name),
    join((process as any).resourcesPath || "", name),
  ]);
  const source = candidates.find((p) => p && existsSync(p));
  if (!source) return undefined;
  try {
    const hash = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 10);
    const dir = join(app.getPath("userData"), "icons");
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `icon-${hash}${extname(source)}`);
    if (!existsSync(dest)) copyFileSync(source, dest);
    // Drop stale copies left behind by previous icon versions.
    for (const f of readdirSync(dir)) {
      if (f !== basename(dest) && /^icon-[0-9a-f]{10}\.(ico|png)$/.test(f)) rmSync(join(dir, f), { force: true });
    }
    return dest;
  } catch {
    return source; // fall back to the original path if copying fails
  }
}

function updateTrayMenu(): void {
  if (!tray) return;
  const zh = getConfig().language === "zh";
  const show = () => showMainWindow();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: zh ? "显示 MPI" : "Show MPI", click: show },
      { type: "separator" },
      {
        label: zh ? "退出 MPI" : "Quit MPI",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray(): void {
  if (tray) return;
  const trayIcon = resolveWindowIcon();
  if (!trayIcon) return;

  tray = new Tray(trayIcon);
  tray.setToolTip("MPI");
  const show = () => showMainWindow();
  tray.on("click", show);
  tray.on("double-click", show);
  tray.on("right-click", updateTrayMenu);
  updateTrayMenu();
}

function createWindow(): void {
  const cfg = getConfig();
  const b = cfg.windowBounds;
  const windowIcon = resolveWindowIcon();
  // 冷启动遮罩：主窗口 ready-to-show 之前占住桌面（见 splash.ts）。
  if (!splashWindow) splashWindow = createSplashWindow();
  const dismissSplash = () => {
    closeSplashWindow(splashWindow);
    splashWindow = null;
  };
  // 兜底：加载失败或 ready-to-show 一直不来时，遮罩不能永远挂着。
  setTimeout(dismissSplash, 20_000);
  mainWindow = new BrowserWindow({
    width: b?.width ?? 1440,
    height: b?.height ?? 920,
    x: b?.x,
    y: b?.y,
    minWidth: 980,
    minHeight: 640,
    show: false,
    frame: false,
    backgroundColor: "#0e0f12",
    title: "MPI",
    icon: windowIcon,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  if (process.platform === "win32" && windowIcon) {
    // setIcon controls the HWND image; setAppDetails controls the Windows
    // taskbar button/group metadata. Development runs use electron.exe, so
    // both are required to avoid inheriting Electron's relaunch icon.
    mainWindow.setAppDetails({
      appId: APP_USER_MODEL_ID,
      appIconPath: windowIcon,
      appIconIndex: 0,
    });
  }

  // Restore the saved window zoom (50–150%); setZoomLevel uses log2(factor).
  mainWindow.webContents.setZoomLevel(Math.log2(cfg.zoomPercent / 100));

  mainWindow.webContents.on("did-fail-load", (_event, _code, _desc, _url, isMainFrame) => {
    // 只关心主框架失败：子 iframe 失败不该收掉启动遮罩。
    if (isMainFrame !== false) dismissSplash();
  });

  mainWindow.on("ready-to-show", () => {
    dismissSplash();
    if (!mainWindow) return;
    bootMark("window-ready-to-show");
    // On Windows, explicitly reapply the ICO after Chromium has created the
    // native HWND. This prevents development and upgraded installs from
    // falling back to Electron's executable icon in the taskbar.
    if (windowIcon) mainWindow.setIcon(windowIcon);
    if (b?.maximized) mainWindow.maximize();
    mainWindow.show();
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Electron does not provide a page context menu automatically. Only editable
  // fields (inputs/textareas/contenteditable) get the standard edit menu — most
  // of the UI is user-select:none, so Copy/Select All elsewhere are meaningless.
  // Ctrl+C still copies real text selections in selectable areas.
  mainWindow.webContents.on("context-menu", (_event, params) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!params.isEditable) return;
    const wc = mainWindow.webContents;
    const zh = getConfig().language === "zh";
    Menu.buildFromTemplate([
      { label: zh ? "剪切" : "Cut", enabled: params.editFlags.canCut, click: () => wc.cut() },
      { label: zh ? "复制" : "Copy", enabled: params.editFlags.canCopy, click: () => wc.copy() },
      { label: zh ? "粘贴" : "Paste", enabled: params.editFlags.canPaste, click: () => wc.paste() },
      { type: "separator" },
      { label: zh ? "全选" : "Select all", enabled: params.editFlags.canSelectAll, click: () => wc.selectAll() },
    ]).popup({ window: mainWindow });
  });

  // Devtools toggle (F12 / Ctrl+Shift+I) — frameless windows have no default shortcut.
  mainWindow.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i")) {
      mainWindow?.webContents.toggleDevTools();
    }
  });
  // Forward renderer console to the main terminal so headless runs are diagnosable.
  mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    const tag = ["log", "warn", "error"][level] || "log";
    // eslint-disable-next-line no-console
    console.log(`[renderer:${tag}] ${message}  (${sourceId}:${line})`);
  });
  // 渲染进程崩溃：有界恢复（crash-guard.ts）。以前这里只打日志，白屏后只能手动杀进程。
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    const at = Date.now();
    const result = recordRendererCrash(crashGuard, at, String(details.reason));
    crashGuard = result.state;
    saveCrashGuard(crashGuard);
    appendDiagLog(
      `crash-guard renderer-gone reason=${details.reason} exit=${details.exitCode} action=${result.action} inWindow=${result.crashesInWindow} ${crashGuardSummary(crashGuard, at)}`,
    );
    console.error("[renderer] process gone:", details.reason, details.exitCode, "→", result.action);

    if (result.action === "give-up") {
      void handleRendererGiveUp(result.crashesInWindow, String(details.reason));
      return;
    }
    // 稍等一下再重启：崩溃瞬间 webContents 往往还在销毁途中，立即 reload 可能无效。
    setTimeout(() => {
      if (result.action === "software-render") {
        relaunchWithSoftwareRendering(`renderer-crash-${result.crashesInWindow}x`);
        return;
      }
      if (!mainWindow || mainWindow.isDestroyed()) return;
      console.warn("[renderer] 自动重载界面（第", result.crashesInWindow, "次崩溃）");
      mainWindow.reload();
    }, 800);
  });

  const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
  if (rendererUrl) mainWindow.loadURL(rendererUrl);
  else mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}

// Single instance -----------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });

  bootMark("require-done");
  app.whenReady().then(() => {
    bootMark("when-ready");
    loadConfig(app.getPath("userData"));
    // Apply data-location migrations recorded by Settings (session store /
    // todo data). Must run before the window opens so the UI reads from the
    // new locations; failures stay pending and retry on the next launch.
    try {
      const summary = runPendingDataMigrations();
      if (summary) console.log("[migration]", JSON.stringify(summary));
    } catch (e: any) {
      console.error("[migration] failed:", e?.message || String(e));
    }
    // 知芽 Zhiya: seed templates (persona/agreement/workspace), pull the latest
    // master files from AgentSetting, and one-time-migrate the legacy Settings →
    // 用户画像 text into persona.md. Must run before registerIpc so the first
    // zhiya:get already sees the migrated content.
    try {
      ensureZhiyaFiles();
      const r = migrateUserProfileToZhiya();
      if (r === "migrated") console.log("[zhiya] legacy userProfile migrated to persona.md");
      const master = zhiyaMasterDir();
      // Detection failure is reported loudly on purpose: "on demand" injection
      // silently degrades into "never" otherwise (design §11.5).
      if (master) console.log("[zhiya] master dir:", master);
      else console.warn("[zhiya] no AgentSetting master dir detected — local copies only");
      // 知识库目录同样"探测一次并写回"：新电脑/未配置实例否则会落空
      console.log("[zhiya] knowledge dir:", ensureKnowledgeDirConfigured());
    } catch (e: any) {
      console.error("[zhiya] init failed:", e?.message || String(e));
    }
    // MCP 交给 pi 内建实现（pi ≥ 0.99）：摘掉第三方 adapter、清掉它写的 `-builtin:mcp`，
    // 并把旧版 MPI 的 `disabled: true` 归一化成内建认的 `enabled: false`。幂等；失败不拦启动。
    try {
      // 只有 pi ≥ 0.99 才有内建 MCP；旧运行时上摘 adapter 等于 MCP 直接消失，所以先按版本分流。
      const piVersion = readManagedPiStatus().version;
      const m = migrateToBuiltinMcp(piVersion);
      if (m.skipped) console.log(`[mcp] 暂不切内建：${m.skipped}`);
      if (m.removedAdapter || m.removedMarket || m.removedFlag) {
        console.log(
          `[mcp] 切到内建 MCP（pi ${piVersion}）：adapter=${m.removedAdapter} market=${m.removedMarket} flag=${m.removedFlag}`,
        );
        appendDiagLog(
          `[mcp] migrate-to-builtin pi=${piVersion} adapter=${m.removedAdapter} market=${m.removedMarket} flag=${m.removedFlag}`,
        );
      }
      const n = normalizeMcpDisabledFlags();
      if (n > 0) console.log(`[mcp] 归一化 ${n} 个条目的 disabled → enabled:false`);
    } catch (e: any) {
      console.error("[mcp] builtin-mcp migration failed:", e?.message || String(e));
    }
    // 会话级映射（config.threadTaskModes / config.threadThinking）只按会话 UUID 累积，
    // 而以前只有「删除会话」这一条路径会回收：实测本机已攒到 143 个对应会话早已不存在的
    // 模式键（从没发过消息的草稿、删掉的会话残留）。启动时按「会话文件还在不在」清一次。
    try {
      const uuids = new Set<string>();
      for (const file of listAllSessionFiles(getSessionsDir())) {
        // 与写入端同一把尺子：config 里的键就是 threadUuidFromSessionFile() 算出来的 UUID。
        const uuid = threadUuidFromSessionFile(file);
        if (uuid) uuids.add(uuid);
      }
      const cfg = getConfig();
      // 三张表的 value 类型不同（string / {provider,id}），用 unknown 统一走清理，
      // 结果再按各自的类型收回（清理只做键过滤，不改 value）。
      const pruned = pruneThreadKeyedMaps<unknown>(
        { threadTaskModes: cfg.threadTaskModes, threadThinking: cfg.threadThinking, threadModels: cfg.threadModels },
        uuids,
      );
      if (pruned.dropped.length > 0) {
        updateConfig({
          threadTaskModes: pruned.threadTaskModes as Record<string, string>,
          threadThinking: pruned.threadThinking as Record<string, string>,
          threadModels: pruned.threadModels as Record<string, { provider: string; id: string }>,
        });
        appendDiagLog(`[thread-config] pruned ${pruned.dropped.length} orphan keys (sessions=${uuids.size})`);
      }
    } catch (e: any) {
      // 清理失败不影响启动：最坏情况就是 config 继续胖一点。
      console.error("[thread-config] prune failed:", e?.message || String(e));
    }
    registerHtmlPreviewProtocol();
    registerPdfViewerProtocol();
    registerTodoAttachmentProtocol();
    registerChatAttachmentProtocol();
    // 聊天附件区按总量上限清理（视频会积累）。
    // P2 起：**只清没有任何会话引用的**——被引用的永不自动删（删了历史消息就只剩占位卡片，
    // 而主机应当是最全的备份）。超上限且无可删对象时不再静默删别人的附件，只报告出来。
    void pruneChatAttachments(undefined, {
      collectReferenced: () => collectReferencedAttachmentNames(),
      onOverCapacity: (report) => {
        const mb = (n: number) => (n / 1048576).toFixed(0);
        appendDiagLog(
          `chat-attachments over-capacity total=${mb(report.totalBytes)}MB max=${mb(report.maxBytes)}MB ` +
            `protected=${mb(report.protectedBytes)}MB liveSet=${report.liveSetAvailable ? 1 : 0}`,
        );
        console.warn(
          `[chat-attachments] 超过上限（${mb(report.totalBytes)}MB / ${mb(report.maxBytes)}MB）：` +
            `${mb(report.protectedBytes)}MB 仍被会话引用，已跳过删除。需要腾空间请手动清理不再看的会话。`,
        );
      },
    });
    // Remove runtime trees superseded by an in-app core update (they may have
    // been locked by pi child processes during the previous run; nothing holds
    // them now). Best effort — leftovers simply wait for the next launch.
    cleanupOldRuntimes();
    registerIpc(getWin);
    bootMark("ipc-registered");
    // One-time backfill of the observed-tools registry from historical session
    // files so the trusted-tools picker is populated on first open. Background,
    // byte-budgeted, best effort.
    void backfillObservedTools().catch((e) => console.warn("[observed-tools] backfill failed:", e));
    // v2: bring enabled app services back up (never rewrites config).
    void activateAutostartApps().catch((e) => console.warn("[app-store] autostart failed:", e));
    // Dev only: tail the release pipeline's JSONL progress file (the CLI runs
    // outside this app) so the long-task monitor shows live upload bytes/speed.
    if (IS_DEV_BUILD) startDevReleaseProgressTail();
    createWindow();
    createTray();
    app.on("activate", () => {
      if (!mainWindow) createWindow();
      else showMainWindow();
    });
  });
}

// Graceful quit: in-flight turns/compactions are aborted and given a bounded
// moment to settle so session files don't end on a dangling tool call
// (upstream #9124). Idle bridges resolve immediately, so the common path stays fast.
let quitInFlight = false;
app.on("before-quit", (e) => {
  // Second pass after the graceful wait below — let the quit proceed.
  if (quitInFlight) return;
  e.preventDefault();
  isQuitting = true;
  // Reap app-managed child processes before the (possibly delayed) graceful wait.
  try {
    killAllManagedProcesses();
  } catch {
    /* ignore */
  }
  try {
    if (tray) {
      tray.destroy();
      tray = null;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      const bounds = mainWindow.getBounds();
      updateConfig({ windowBounds: { ...bounds, maximized: mainWindow.isMaximized() } });
    }
  } catch {
    /* ignore */
  }
  stopScheduler();
  stopRemoteHost();
  flushDrafts(); // synchronous: the coalesced draft write must not be lost
  try {
    ingestInbox(); // pick up any pending agent-side todo additions before exit
  } catch {
    /* ignore */
  }
  flushTodos(); // synchronous: the coalesced todo write must not be lost
  // 记忆池：先关本地端点（删端点文件），再释放索引（解除 zvec 只读句柄，
  // 否则 .zvec 目录会被继续占着，Windows 上删不掉/换名会失败）。失败不拦退出。
  void stopMemoryEndpoint(app.getPath("userData"))
    .catch(() => undefined)
    .finally(() => {
      void disposeMemoryIndex().catch(() => undefined);
    });
  quitInFlight = true;
  // Safety net in case a bridge ever fails to settle (stopGraceful is bounded
  // at ~4s internally; this caps the whole sequence well beyond that).
  const hardStop = setTimeout(() => app.quit(), 8000);
  stopMessaging(); // Feishu channel — drop the long connection before bridges die
  stopWeChatMessaging(); // WeChat (iLink) channel — abort the long-poll
  // 应用商店的服务也要在退出前收掉（见 docs/APP-PLUGIN-DESIGN.md §5）：
  // 否则服务自己的资源（如 HTTP 监听、定时器）会留到进程结束，models.json 里的
  // provider 也会指向一个已经没人监听的端口。给 4s 上限，绝不让某个应用拖住退出。
  const appsStopped = Promise.race([
    deactivateAllServices(),
    new Promise((resolve) => setTimeout(resolve, 4000)),
  ]);
  Promise.all([stopAllBridges(), stopAutomations(), appsStopped])
    .catch(() => undefined)
    .finally(() => {
      clearTimeout(hardStop);
      stopAllTuis(); // interactive pi terminals — immediate kill is fine
      app.quit();
    });
});

app.on("window-all-closed", () => {
  // Safety net: on non-darwin this fires during the quit sequence above, after
  // bridges are already stopped (both calls then no-op).
  stopScheduler();
  stopMessaging();
  stopWeChatMessaging();
  void Promise.all([stopAllBridges(), stopAutomations()]).catch(() => undefined);
  stopAllTuis();
  if (process.platform !== "darwin") app.quit();
});
