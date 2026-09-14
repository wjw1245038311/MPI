/** Minimal electron stub for node-based tests of main-process modules.
 * Paths come from env so each test controls its own sandbox:
 *   MPI_TEST_APP_PATH   → app.getAppPath() (repo root in dev-style layout)
 *   MPI_TEST_USER_DATA  → app.getPath("userData") */
export const app = {
  isPackaged: false,
  getAppPath: () => process.env.MPI_TEST_APP_PATH || "",
  getPath: (name) => {
    if (name === "userData") return process.env.MPI_TEST_USER_DATA;
    throw new Error(`electron stub: unsupported path "${name}"`);
  },
};

export const ipcMain = { handle: () => {} };

/** identity.ts imports this by name; tests run without OS keychain encryption. */
export const safeStorage = {
  isEncryptionAvailable: () => false,
};
