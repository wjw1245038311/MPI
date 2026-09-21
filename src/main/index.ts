import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { app, BrowserWindow, Menu, shell, Tray } from "electron";
import { loadConfig, getConfig, updateConfig } from "./config";
import { flushDrafts } from "./draft-store";
import { runPendingDataMigrations } from "./data-migration";
import { ensureKnowledgeDirConfigured } from "./knowledge-dir";
import { ensureZhiyaFiles, migrateUserProfileToZhiya, zhiyaMasterDir } from "./zhiya";
import { flushTodos, ingestInbox } from "./todo-store";
import { cleanupOldRuntimes } from "./core-updater";
import { registerHtmlPreviewProtocol, registerHtmlPreviewScheme } from "./html-preview-protocol";
import { registerPdfViewerProtocol, registerPdfViewerScheme } from "./pdf-viewer-protocol";
import { registerTodoAttachmentProtocol, registerTodoAttachmentScheme } from "./todo-attachment-protocol";
import { registerIpc, stopAllBridges, stopRemoteHost } from "./ipc";
import { stopMemoryEndpoint } from "./memory-endpoint";
import { disposeMemoryIndex } from "./memory-service";
import { ensureBackfilled as backfillObservedTools } from "./observed-tools";
import { activateAutostartApps, killAllManagedProcesses } from "./app-store";
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

registerHtmlPreviewScheme();
registerPdfViewerScheme();
registerTodoAttachmentScheme();

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

  mainWindow.on("ready-to-show", () => {
    if (!mainWindow) return;
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
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    // eslint-disable-next-line no-console
    console.error("[renderer] process gone:", details.reason, details.exitCode);
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

  app.whenReady().then(() => {
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
    registerHtmlPreviewProtocol();
    registerPdfViewerProtocol();
    registerTodoAttachmentProtocol();
    // Remove runtime trees superseded by an in-app core update (they may have
    // been locked by pi child processes during the previous run; nothing holds
    // them now). Best effort — leftovers simply wait for the next launch.
    cleanupOldRuntimes();
    registerIpc(getWin);
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
  Promise.all([stopAllBridges(), stopAutomations()])
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
