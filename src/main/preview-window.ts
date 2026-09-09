import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, shell } from "electron";

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
    existing.show();
    existing.focus();
    return;
  }

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
  if (win && !win.isDestroyed()) win.close();
}
