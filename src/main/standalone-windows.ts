import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, shell } from "electron";

const IS_DEV_BUILD = !app.isPackaged;
const APP_USER_MODEL_ID = IS_DEV_BUILD ? "com.mpi.app.dev" : "com.mpi.app";

/** hash -> open standalone window (dedup: an existing one is focused). */
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

interface StandaloneOpts {
  /** location.hash the renderer loads with — main.tsx branches on it. */
  hash: string;
  title: string;
  width: number;
  height: number;
  minWidth?: number;
  minHeight?: number;
}

/** Open a native-framed window that renders one standalone view of the same
 * renderer bundle (see main.tsx hash branches). Draggable/resizable/closable —
 * unlike in-app modals, which get trapped by ancestor containing blocks
 * (.set-card:hover transform / .settings-backdrop backdrop-filter) and cannot
 * be pulled out or reliably dismissed. */
export function openStandaloneWindow(opts: StandaloneOpts): void {
  const existing = windows.get(opts.hash);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return;
  }

  const icon = resolveIcon();
  const win = new BrowserWindow({
    width: opts.width,
    height: opts.height,
    minWidth: opts.minWidth ?? 480,
    minHeight: opts.minHeight ?? 320,
    title: opts.title,
    icon,
    backgroundColor: "#111318",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  if (process.platform === "win32" && icon) {
    win.setAppDetails({ appId: APP_USER_MODEL_ID, appIconPath: icon, appIconIndex: 0 });
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
  if (rendererUrl) win.loadURL(`${rendererUrl}#${opts.hash}`);
  else win.loadFile(join(__dirname, "../renderer/index.html"), { hash: opts.hash });

  win.on("closed", () => {
    windows.delete(opts.hash);
  });
  windows.set(opts.hash, win);
}

/** The open window for a hash (for live broadcasts), or null when closed. */
export function getStandaloneWindow(hash: string): BrowserWindow | null {
  const w = windows.get(hash);
  return w && !w.isDestroyed() ? w : null;
}

/* ------------------------------ named views ----------------------------- */

/** dev release pipeline log (opened from the dev panel in Settings → About). */
export function openDevReleaseLogWindow(): void {
  openStandaloneWindow({ hash: "dev-release-log", title: "MPI dev 发版日志", width: 780, height: 540 });
}

export function getDevReleaseLogWindow(): BrowserWindow | null {
  return getStandaloneWindow("dev-release-log");
}

/** Bundled changelog (opened from the app-update card). */
export function openChangelogWindow(): void {
  openStandaloneWindow({ hash: "changelog", title: "MPI 更新日志", width: 860, height: 640, minWidth: 520, minHeight: 380 });
}
