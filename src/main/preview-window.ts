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
  // Frameless on purpose: the renderer draws its own caption (VS-style
  // floating document window) so we can track caption drags and dock back.
  const win = new BrowserWindow({
    frame: false,
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

  win.on("closed", () => {
    windows.delete(key);
    if (moveState?.win === win) {
      moveState = null;
      if (moveTimer) clearInterval(moveTimer);
      moveTimer = null;
    }
  });
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

function findMainWindow(): BrowserWindow | undefined {
  const previewWins = new Set(windows.values());
  return BrowserWindow.getAllWindows().find((w) => !previewWins.has(w));
}

function isCursorOverMainWindow(): boolean {
  const main = findMainWindow();
  if (!main || !main.isVisible()) return false;
  const p = screen.getCursorScreenPoint();
  const b = main.getBounds();
  return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
}

// Caption drag (VS-style): the renderer's custom title bar reports start/end;
// main moves the window with the cursor and, on release over the main window,
// docks the file back into its preview panel.
let moveState: { win: BrowserWindow; offX: number; offY: number; startX: number; startY: number; moved: boolean; sizeW: number; sizeH: number } | null = null;
let moveTimer: NodeJS.Timeout | null = null;

export function previewWindowMoveStart(absPath: string): void {
  const win = windows.get(absPath.toLowerCase());
  if (!win || win.isDestroyed()) return;
  console.log("[preview-dock] caption move start:", absPath);
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const [sizeW, sizeH] = win.getSize();
  moveState = { win, offX: p.x - b.x, offY: p.y - b.y, startX: p.x, startY: p.y, moved: false, sizeW, sizeH };
  win.setAlwaysOnTop(true);
  if (moveTimer) clearInterval(moveTimer);
  moveTimer = setInterval(() => {
    const st = moveState;
    if (!st || st.win.isDestroyed()) return;
    const c = screen.getCursorScreenPoint();
    st.win.setPosition(c.x - st.offX, c.y - st.offY);
    // Windows/Chromium may auto-resize the window when it crosses a monitor
    // with a different DPI scale — lock the size so the page doesn't breathe.
    const [w, h] = st.win.getSize();
    if (w !== st.sizeW || h !== st.sizeH) {
      console.log(`[preview-dock] size drift during move: ${w}x${h} → restoring ${st.sizeW}x${st.sizeH}`);
      st.win.setSize(st.sizeW, st.sizeH);
    }
    if (Math.abs(c.x - st.startX) + Math.abs(c.y - st.startY) > 4) st.moved = true;
  }, 16);
}

export function previewWindowMoveEnd(absPath: string): void {
  if (moveTimer) {
    clearInterval(moveTimer);
    moveTimer = null;
  }
  const st = moveState;
  moveState = null;
  if (!st || st.win.isDestroyed()) return;
  st.win.setAlwaysOnTop(false);
  // VS-style: releasing the caption over the main window asks the renderer to
  // dock — but only when the release point is on its preview tab strip.
  if (st.moved && isCursorOverMainWindow()) {
    const c = screen.getCursorScreenPoint();
    console.log("[preview-dock] caption released over main → candidate:", absPath, `@${Math.round(c.x)},${Math.round(c.y)}`);
    const main = findMainWindow();
    if (main && !main.isDestroyed()) {
      main.webContents.send("preview:dock-candidate", { path: absPath, x: Math.round(c.x), y: Math.round(c.y) });
    }
  } else {
    console.log("[preview-dock] caption move end (no dock):", absPath, "moved:", st.moved);
  }
}

