import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, screen, shell } from "electron";

const IS_DEV_BUILD = !app.isPackaged;
const APP_USER_MODEL_ID = IS_DEV_BUILD ? "com.mpi.app.dev" : "com.mpi.app";

/** path (lowercased) -> popped-out preview window. */
const windows = new Map<string, BrowserWindow>();

function resolveIcon(): string | undefined {
  const names = process.platform === "win32" ? ["icon.ico", "icon.png"] : ["icon.png"];
  for (const name of names) {
    for (const base of [join(app.getAppPath(), "resources"), (process as any).resourcesPath || ""]) {
      const p = join(base, name);
      if (p && existsSync(p)) return p;
    }
  }
  return undefined;
}

/** Open a file in its own native-framed window. Dedup by path: an existing
 * window for the same file is focused instead of spawning another one. */
export function openPreviewWindow(absPath: string): void {
  const key = absPath.toLowerCase();
  const existing = windows.get(key);
  if (existing && !existing.isDestroyed()) {
    console.log("[preview-dock] focus existing window:", absPath);
    existing.show();
    existing.focus();
    return;
  }
  console.log("[preview-dock] open new window:", absPath);

  const icon = resolveIcon();
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 480,
    minHeight: 360,
    title: absPath.split(/[\\/]/).pop() || "Preview",
    icon,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  if (process.platform === "win32" && icon) {
    // Group the taskbar button with MPI instead of showing Electron's icon.
    win.setAppDetails({ appId: APP_USER_MODEL_ID, appIconPath: icon, appIconIndex: 0 });
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  const hash = `preview=${encodeURIComponent(absPath)}`;
  const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
  if (rendererUrl) win.loadURL(`${rendererUrl}#${hash}`);
  else win.loadFile(join(__dirname, "../renderer/index.html"), { hash });

  win.on("closed", () => windows.delete(key));
  windows.set(key, win);
}

/** Close the popped-out window for a path (no-op when it is not open). Used
 *  when its tab is dragged back into the main preview panel. */
export function closePreviewWindow(absPath: string): void {
  const win = windows.get(absPath.toLowerCase());
  if (!win || win.isDestroyed()) return;
  console.log("[preview-dock] close window:", absPath);
  win.close();
}

// Dock-back detection (Visual Studio style). HTML5 drag payloads do not
// reliably cross BrowserWindow boundaries, so instead of relying on drop data
// we track the pointer while a floating window's tab is being dragged: if it
// is released over the main window, that file docks back into its preview panel.
let pendingDock: { path: string; lastOverMain: boolean } | null = null;
let dockPollTimer: NodeJS.Timeout | null = null;

function findMainWindow(): BrowserWindow | undefined {
  const previewWins = new Set(windows.values());
  return BrowserWindow.getAllWindows().find((w) => !previewWins.has(w));
}

export function previewWindowDragStart(absPath: string): void {
  console.log("[preview-dock] drag start:", absPath);
  pendingDock = { path: absPath, lastOverMain: false };
  if (dockPollTimer) clearInterval(dockPollTimer);
  dockPollTimer = setInterval(() => {
    if (!pendingDock) return;
    const main = findMainWindow();
    if (!main || !main.isVisible()) {
      pendingDock.lastOverMain = false;
      return;
    }
    const p = screen.getCursorScreenPoint();
    const b = main.getBounds();
    pendingDock.lastOverMain =
      p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
  }, 50);
}

export function previewWindowDragEnd(absPath: string): void {
  if (dockPollTimer) {
    clearInterval(dockPollTimer);
    dockPollTimer = null;
  }
  const pending = pendingDock;
  pendingDock = null;
  const main = findMainWindow();
  console.log(
    "[preview-dock] drag end:", absPath,
    "| pending:", !!pending,
    "pathMatch:", pending?.path === absPath,
    "lastOverMain:", pending?.lastOverMain ?? false,
    "mainFound:", !!(main && !main.isDestroyed()),
  );
  if (!pending || pending.path !== absPath || !pending.lastOverMain) return;
  if (main && !main.isDestroyed()) {
    // Ask the main renderer to (re)open this file's preview tab, then close us.
    console.log("[preview-dock] docking back:", pending.path);
    main.webContents.send("preview:dock-request", pending.path);
  }
  closePreviewWindow(absPath);
}
