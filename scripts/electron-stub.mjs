/** Minimal electron stub for node-based tests of main-process modules.
 * Paths come from env so each test controls its own sandbox:
 *   MPI_TEST_APP_PATH   → app.getAppPath() (repo root in dev-style layout)
 *   MPI_TEST_USER_DATA  → app.getPath("userData")
 *   MPI_TEST_TEMP       → app.getPath("temp")（默认 os.tmpdir()；聊天附件测试用它指定沙盒） */
import { tmpdir } from "node:os";

export const app = {
  isPackaged: false,
  getAppPath: () => process.env.MPI_TEST_APP_PATH || "",
  getPath: (name) => {
    if (name === "userData") return process.env.MPI_TEST_USER_DATA;
    if (name === "temp") return process.env.MPI_TEST_TEMP || tmpdir();
    throw new Error(`electron stub: unsupported path "${name}"`);
  },
};

export const protocol = { registerSchemesAsPrivileged: () => {}, handle: () => {} };

export const ipcMain = { handle: () => {} };

/** identity.ts imports this by name; tests run without OS keychain encryption. */
export const safeStorage = {
  isEncryptionAvailable: () => false,
};
